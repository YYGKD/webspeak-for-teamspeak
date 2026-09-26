import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Logger } from "../logger.js";
import { loadConfig } from "../config.js";
import { formatTeamSpeakTarget, parseTeamSpeakTarget, type TeamSpeakTarget } from "../domain/teamspeak-target.js";
import { type AccessMode, type IceServerWrite, type ManagedInviteRecord, type PersistedIceServer, type PersistedRelayNode, type SettingsUpdate, WebSpeakDatabase } from "../persistence/database.js";
import { hashAdminPassword, validateAdminPassword, verifyAdminPassword } from "../security/admin-password.js";
import { decryptSecret, encryptSecret } from "../security/secret-crypto.js";
import { probeTeamSpeak, TeamSpeakProbeError } from "../server/teamspeak-probe.js";
import { pingTeamSpeakHost } from "../server/network-probe.js";
import { DEFAULT_ACCELERATION_RELAY_PORT, type ConfiguredAccelerationRelay } from "../server/acceleration-relay.js";
import { DEFAULT_TURN_TTL_SECONDS, DEFAULT_WEBRTC_UDP_PORT_RANGE, ICE_SERVER_MAX_ENTRIES, ICE_TTL_SECONDS_MAX, ICE_TTL_SECONDS_MIN, ICE_URL_PREFIXES, WEBRTC_UDP_PORT_MAX, WEBRTC_UDP_PORT_MIN, type IceCredentialMode, type IceServerKind, type WebRtcAudioOptions } from "../server/webrtc-config.js";
import { resolveIceServers, resolveIceServersFromEntries, type IceServerConfig, type IceServerEntry } from "../server/ice-credentials.js";
import { DEFAULT_WELCOME_TEXTS, resolveWelcomeTexts } from "../site-copy.js";

export interface AdminSettingsInput {
  target: string;
  serverPassword?: string;
  passwordAction?: "keep" | "replace" | "remove";
  accessMode: AccessMode;
  siteName: string;
  welcomeText: string;
  welcomeTextEn?: string;
  welcomeTextDe?: string;
  welcomeTextRu?: string;
  welcomeTextJa?: string;
  webRtcEnabled: boolean;
  webRtcUdpStart?: number;
  webRtcUdpEnd?: number;
  relaySettingsAction?: "keep" | "replace" | "remove";
  relayEnabled?: boolean;
  relayName?: string;
  relayTarget?: string;
  relayToken?: string;
  relayTokenAction?: "keep" | "replace" | "remove";
  relayNodes?: RelayNodeInput[];
  iceServers?: IceServerInput[];
}

export interface RelayNodeInput {
  id?: string;
  name: string;
  target: string;
  enabled: boolean;
  token?: string;
  tokenAction?: "keep" | "replace" | "remove";
}

/**
 * One ICE entry as submitted by the admin console.
 *
 * `credential` is plaintext on the way in and is encrypted before it is stored;
 * `credentialAction` mirrors the three-state password contract used elsewhere
 * (keep / replace / remove) so an untouched entry never has to re-send its secret.
 */
export interface IceServerInput {
  id?: string;
  kind: IceServerKind;
  urls: string;
  credentialMode?: IceCredentialMode;
  username?: string;
  credential?: string;
  credentialAction?: "keep" | "replace" | "remove";
  ttlSeconds?: number;
  enabled: boolean;
}

export interface ConnectionPolicy {
  defaultTarget: TeamSpeakTarget;
  serverPassword: string;
  accessMode: AccessMode;
}

export interface ManagedInviteInput {
  channel: string;
  expiresInHours: number;
  maxUses: number;
}

export interface ManagedInviteView {
  id: string;
  target: string;
  channel: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  createdAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "exhausted" | "revoked";
}

type ProbeFunction = typeof probeTeamSpeak;

export class AdminService {
  constructor(
    readonly database: WebSpeakDatabase,
    private readonly masterSecret: Buffer,
    private readonly logger: Logger,
    private readonly legacyConfigPath: string,
    private readonly probe: ProbeFunction = probeTeamSpeak,
    private readonly version = "0.1.0",
  ) {}

  async initialize(): Promise<void> {
    this.importLegacyConfigOnce();
    if (!this.database.hasAdmin()) {
      const credential = await hashAdminPassword("admin", { username: "admin", mustChangePassword: true, allowWeakPassword: true });
      this.database.initializeAdmin(credential, this.toSettingsUpdate(this.database.getSettings()));
      this.logger.warn("Default admin account created. Change the password on first login.");
    }
  }

  isInitialized(): boolean {
    return this.database.hasAdmin();
  }

  async verifyPassword(username: string, password: string): Promise<boolean> {
    const credential = this.database.getAdminCredential();
    return credential?.username === username && await verifyAdminPassword(password, credential);
  }

  isPasswordChangeRequired(): boolean {
    return this.database.getAdminCredential()?.mustChangePassword === true;
  }

  async changePassword(password: string): Promise<void> {
    const credential = this.database.getAdminCredential();
    if (!credential) throw new AdminInputError("NOT_INITIALIZED", "The administrator account is not initialized");
    const passwordError = validateAdminPassword(password);
    if (passwordError) throw new AdminInputError("INVALID_ADMIN_PASSWORD", passwordError);
    const replacement = await hashAdminPassword(password, { username: credential.username, mustChangePassword: false });
    this.database.updateAdminCredential(replacement);
    this.database.addAudit("ADMIN_PASSWORD_CHANGED");
  }

  getPublicConfig(): Record<string, unknown> {
    const settings = this.database.getSettings();
    const welcomeTexts = resolveWelcomeTexts({
      zh: settings.welcomeText,
      en: settings.welcomeTextEn,
      de: settings.welcomeTextDe,
      ru: settings.welcomeTextRu,
      ja: settings.welcomeTextJa,
    });
    return {
      version: this.version,
      initialized: this.isInitialized(),
      siteName: settings.siteName,
      // Keep the old fields for older clients, but return the complete,
      // already-fallback-resolved map for current clients.
      welcomeText: welcomeTexts.zh,
      welcomeTextEn: welcomeTexts.en,
      welcomeTexts,
      accessMode: settings.accessMode,
      target: formatTeamSpeakTarget({ host: settings.tsHost, port: settings.tsPort }),
    };
  }

  getAdminSettings(): Record<string, unknown> {
    const settings = this.database.getSettings();
    return {
      target: formatTeamSpeakTarget({ host: settings.tsHost, port: settings.tsPort }),
      hasPassword: Boolean(settings.tsPasswordEncrypted),
      accessMode: settings.accessMode,
      siteName: settings.siteName,
      welcomeText: settings.welcomeText,
      welcomeTextEn: settings.welcomeTextEn,
      welcomeTextDe: settings.welcomeTextDe,
      welcomeTextRu: settings.welcomeTextRu,
      welcomeTextJa: settings.welcomeTextJa,
      welcomeDefaults: DEFAULT_WELCOME_TEXTS,
      lastTestAt: settings.lastTestAt,
      lastTestLatencyMs: settings.lastTestLatencyMs,
      lastTestError: settings.lastTestError,
      webRtcEnabled: settings.webRtcEnabled,
      webRtcUdpStart: settings.webRtcUdpStart,
      webRtcUdpEnd: settings.webRtcUdpEnd,
      relayConfigured: settings.relayConfigured,
      relayEnabled: settings.relayEnabled,
      relayName: settings.relayName,
      relayTarget: settings.relayHost ? formatRelayTarget(settings.relayHost, settings.relayPort) : "",
      hasRelayToken: Boolean(settings.relayTokenEncrypted),
      relayNodes: this.getRelayNodeViews(),
      iceServers: this.getIceServerViews(),
      internalPort: 3040,
      updatedAt: settings.updatedAt,
    };
  }

  getWebRtcAudioOptions(): WebRtcAudioOptions {
    const settings = this.database.getSettings();
    return {
      enabled: settings.webRtcEnabled,
      udpPortRange: [settings.webRtcUdpStart, settings.webRtcUdpEnd],
    };
  }

  getAccelerationRelayOptions(): ConfiguredAccelerationRelay[] {
    const relays: ConfiguredAccelerationRelay[] = [];
    for (const node of this.database.listRelayNodes()) {
      if (!node.enabled || !node.host || !node.tokenEncrypted) continue;
      try {
        const token = decryptSecret(node.tokenEncrypted, this.masterSecret);
        relays.push({ id: node.id, name: node.name, relayHost: node.host, relayPort: node.port, token });
      } catch (error: unknown) {
        this.logger.error({ err: error instanceof Error ? error.message : String(error), relayId: node.id }, "Stored acceleration relay token could not be decrypted");
      }
    }
    return relays;
  }

  getAccelerationRelayName(): string | undefined {
    return this.getAccelerationRelayOptions()[0]?.name;
  }

  /**
   * The browser-facing ICE list, in precedence order:
   *
   *   1. enabled entries from the `ice_servers` table (admin console wins);
   *   2. the environment (WEBSPEAK_STUN_URLS / WEBSPEAK_TURN_*);
   *   3. built-in public STUN defaults.
   *
   * Step 2 exists so an existing deployment keeps working untouched after the
   * upgrade — nothing is written to the new table by the migration, so the console
   * only takes over once an administrator actually saves something. Clearing the
   * table in the console deliberately falls back to the environment rather than to
   * "no ICE at all".
   *
   * A stored entry whose secret fails to decrypt is skipped with a log line rather
   * than aborting the whole list: one broken credential must not cost every client
   * its STUN.
   */
  getResolvedIceServers(userid?: string): IceServerConfig[] {
    const entries = this.enabledIceServerEntries();
    if (entries.length) return resolveIceServersFromEntries(entries, userid);
    return resolveIceServers(userid);
  }

  private enabledIceServerEntries(): IceServerEntry[] {
    const entries: IceServerEntry[] = [];
    for (const row of this.database.listIceServers()) {
      if (!row.enabled) continue;
      let credential: string | null = null;
      if (row.credentialEncrypted) {
        try {
          credential = decryptSecret(row.credentialEncrypted, this.masterSecret);
        } catch (error: unknown) {
          this.logger.error(
            { err: error instanceof Error ? error.message : String(error), iceServerId: row.id },
            "Stored ICE credential could not be decrypted; the entry is skipped",
          );
          continue;
        }
      }
      entries.push({
        kind: row.kind,
        urls: row.urls,
        credentialMode: row.credentialMode,
        username: row.username,
        credential,
        ttlSeconds: row.ttlSeconds,
      });
    }
    return entries;
  }

  updateSettings(input: AdminSettingsInput): void {
    const current = this.database.getSettings();
    const relayNodes = input.relayNodes === undefined ? undefined : this.normalizeRelayNodes(input.relayNodes);
    const iceServers = input.iceServers === undefined ? undefined : this.normalizeIceServers(input.iceServers);
    const settings = this.normalizeSettings(input, current, relayNodes);
    const targetChanged = current.tsHost !== settings.tsHost || current.tsPort !== settings.tsPort;
    // The settings row, the relay node table and the cleared connection-test
    // result are one configuration change. Written as three separate statements
    // (the previous shape) a failure in the middle left relay_nodes describing
    // the previous setup while the settings row already described the new one.
    // Decide what to write here; commit it atomically in one place.
    const relayNodesToWrite = relayNodes !== undefined
      ? relayNodes
      : input.relaySettingsAction && input.relaySettingsAction !== "keep"
        ? this.legacyRelayNodesFromSettings(settings)
        : null;
    this.database.updateSettings(settings, {
      ...(relayNodesToWrite ? { relayNodes: relayNodesToWrite } : {}),
      // `iceServers: []` clears the table and hands the decision back to the
      // environment; omitted means "leave the stored entries alone".
      ...(iceServers !== undefined ? { iceServers } : {}),
      ...(targetChanged ? { clearConnectionTest: true } : {}),
    });
    if (iceServers !== undefined) {
      // The settings row already logs SETTINGS_CHANGED, but an ICE change deserves
      // its own record: a `static` entry publishes a reusable relay credential to
      // every visitor (see ice-credentials.ts), so "who turned that on, and when"
      // must stay answerable. Only modes are recorded — never a URL or a secret.
      this.database.addAudit("ICE_SERVERS_CHANGED", {
        total: iceServers.length,
        enabled: iceServers.filter((entry) => entry.enabled).length,
        staticCredentials: iceServers.filter((entry) => entry.enabled && entry.credentialMode === "static").length,
        modes: iceServers.map((entry) => `${entry.kind}:${entry.credentialMode}`),
      });
    }
  }

  getConnectionPolicy(): ConnectionPolicy {
    const settings = this.database.getSettings();
    let serverPassword = "";
    try {
      serverPassword = decryptSecret(settings.tsPasswordEncrypted, this.masterSecret);
    } catch (error: unknown) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error) }, "Stored TeamSpeak password could not be decrypted");
    }
    return {
      defaultTarget: { host: settings.tsHost, port: settings.tsPort },
      serverPassword,
      accessMode: settings.accessMode,
    };
  }

  async testConnection(targetText: string, password: string, persistResult: boolean): Promise<{ ok: boolean; checkType: "network" | "protocol"; passwordVerified: boolean; latencyMs: number; serverName: string | null; requiresPassword: boolean; packetLossPercent?: number; attempts?: number; successfulAttempts?: number; errorCode?: string }> {
    let target: TeamSpeakTarget;
    try {
      target = parseTeamSpeakTarget(targetText);
    } catch {
      throw new AdminInputError("INVALID_TARGET", "TeamSpeak target is invalid");
    }
    try {
      // The admin connection test must not create a temporary TeamSpeak
      // client: that client becomes visible in the target channel. Use the
      // WebSpeak host's ICMP route measurement instead. The injected probe is
      // retained for unit tests and explicit protocol-probe callers.
      if (this.probe === probeTeamSpeak) {
        const result = await pingTeamSpeakHost(target.host, { attempts: 4 });
        const publicResult = {
          ok: result.ok,
          checkType: "network" as const,
          passwordVerified: false,
          latencyMs: result.latencyMs ?? 0,
          serverName: null,
          requiresPassword: false,
          packetLossPercent: result.packetLossPercent,
          attempts: result.attempts,
          successfulAttempts: result.successfulAttempts,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        };
        if (persistResult) {
          this.database.recordConnectionTest({ protocol: null, latencyMs: result.latencyMs, error: result.ok ? null : (result.errorCode ?? "UNREACHABLE") });
          this.database.addAudit(result.ok ? "CONNECTION_TEST_SUCCEEDED" : "CONNECTION_TEST_FAILED", {
            latencyMs: result.latencyMs,
            packetLossPercent: result.packetLossPercent,
            ...(result.errorCode ? { code: result.errorCode } : {}),
          });
        }
        return publicResult;
      }
      const result = await this.probe(target, password, this.logger);
      if (persistResult) {
        this.database.recordConnectionTest({ protocol: result.protocol, latencyMs: result.latencyMs, error: null });
        this.database.addAudit("CONNECTION_TEST_SUCCEEDED", { protocol: result.protocol, latencyMs: result.latencyMs });
      }
      const { protocol: _protocol, ...publicResult } = result;
      return { ...publicResult, checkType: "protocol", passwordVerified: true };
    } catch (error: unknown) {
      const probeError = error instanceof TeamSpeakProbeError
        ? error
        : new TeamSpeakProbeError("INTERNAL_ERROR", "Connection test failed", error);
      if (persistResult) {
        this.database.recordConnectionTest({ protocol: null, latencyMs: null, error: probeError.code });
        this.database.addAudit("CONNECTION_TEST_FAILED", { code: probeError.code });
      }
      throw probeError;
    }
  }

  getOverview(activeSessions: number, peakSessions: number, startedAt: number): Record<string, unknown> {
    const settings = this.database.getSettings();
    return {
      gateway: {
        status: "running",
        version: this.version,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      },
      teamSpeak: {
        target: formatTeamSpeakTarget({ host: settings.tsHost, port: settings.tsPort }),
        status: settings.lastTestError ? "unreachable" : settings.lastTestAt ? "reachable" : "unknown",
        lastTestAt: settings.lastTestAt,
        latencyMs: settings.lastTestLatencyMs,
        lastError: settings.lastTestError,
      },
      sessions: { active: activeSessions, peak: peakSessions, limit: 100 },
      recentEvents: this.database.recentAudit(),
      legacyConfigImported: this.database.getMeta("legacy_import_notice_pending") === "1",
    };
  }

  createManagedInvite(input: ManagedInviteInput): { invite: ManagedInviteView; token: string } {
    const channel = input.channel.trim();
    if (channel.length > 100) throw new AdminInputError("INVALID_INVITE_CHANNEL", "Invite channel cannot exceed 100 characters");
    if (!Number.isFinite(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > 720) {
      throw new AdminInputError("INVALID_INVITE_EXPIRY", "Invite expiry must be between 1 and 720 hours");
    }
    if (!Number.isInteger(input.maxUses) || input.maxUses < 0 || input.maxUses > 10000) {
      throw new AdminInputError("INVALID_INVITE_USES", "Invite max uses must be between 0 and 10000");
    }
    const settings = this.database.getSettings();
    const token = randomBytes(32).toString("base64url");
    const record = this.database.createManagedInvite({
      id: `invite-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      tokenHash: hashInviteToken(token),
      targetHost: settings.tsHost,
      targetPort: settings.tsPort,
      serverPasswordEncrypted: settings.tsPasswordEncrypted,
      channel,
      expiresAt: new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000).toISOString(),
      maxUses: input.maxUses,
    });
    this.database.addAudit("INVITE_CREATED", { id: record.id, channel, maxUses: input.maxUses });
    return { invite: this.toInviteView(record), token };
  }

  listManagedInvites(): ManagedInviteView[] {
    return this.database.listManagedInvites().map((record) => this.toInviteView(record));
  }

  revokeManagedInvite(id: string): boolean {
    if (!/^invite-[a-z0-9-]+$/i.test(id) || id.length > 100) throw new AdminInputError("INVALID_INVITE_ID", "Invite id is invalid");
    const revoked = this.database.revokeManagedInvite(id);
    if (revoked) this.database.addAudit("INVITE_REVOKED", { id });
    return revoked;
  }

  consumeManagedInvite(token: string): { target: TeamSpeakTarget; serverPassword: string; channel: string } | null {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
    const record = this.database.consumeManagedInvite(hashInviteToken(token));
    if (!record) return null;
    let serverPassword = "";
    try {
      serverPassword = decryptSecret(record.serverPasswordEncrypted, this.masterSecret);
    } catch (error: unknown) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error), inviteId: record.id }, "Managed invite password could not be decrypted");
    }
    this.database.addAudit("INVITE_CONSUMED", { id: record.id });
    return { target: { host: record.targetHost, port: record.targetPort }, serverPassword, channel: record.channel };
  }

  dismissLegacyImportNotice(): void {
    this.database.setMeta("legacy_import_notice_pending", "0");
  }

  private normalizeSettings(input: AdminSettingsInput, current: ReturnType<WebSpeakDatabase["getSettings"]>, relayNodes?: PersistedRelayNode[]): SettingsUpdate {
    let target: TeamSpeakTarget;
    try {
      target = parseTeamSpeakTarget(input.target);
    } catch {
      throw new AdminInputError("INVALID_TARGET", "TeamSpeak target is invalid");
    }
    const siteName = input.siteName.trim();
    const welcomeText = input.welcomeText.trim();
    const welcomeTextEn = typeof input.welcomeTextEn === "string" ? input.welcomeTextEn.trim() : current.welcomeTextEn;
    const welcomeTextDe = typeof input.welcomeTextDe === "string" ? input.welcomeTextDe.trim() : current.welcomeTextDe;
    const welcomeTextRu = typeof input.welcomeTextRu === "string" ? input.welcomeTextRu.trim() : current.welcomeTextRu;
    const welcomeTextJa = typeof input.welcomeTextJa === "string" ? input.welcomeTextJa.trim() : current.welcomeTextJa;
    if (!siteName || siteName.length > 80) throw new AdminInputError("INVALID_SITE_NAME", "Site name must contain 1 to 80 characters");
    if (welcomeText.length > 500) throw new AdminInputError("INVALID_WELCOME_TEXT", "Welcome text cannot exceed 500 characters");
    if (welcomeTextEn.length > 500) throw new AdminInputError("INVALID_WELCOME_TEXT_EN", "English welcome text cannot exceed 500 characters");
    if (welcomeTextDe.length > 500) throw new AdminInputError("INVALID_WELCOME_TEXT_DE", "German welcome text cannot exceed 500 characters");
    if (welcomeTextRu.length > 500) throw new AdminInputError("INVALID_WELCOME_TEXT_RU", "Russian welcome text cannot exceed 500 characters");
    if (welcomeTextJa.length > 500) throw new AdminInputError("INVALID_WELCOME_TEXT_JA", "Japanese welcome text cannot exceed 500 characters");
    if (input.accessMode !== "fixed" && input.accessMode !== "open") {
      throw new AdminInputError("INVALID_ACCESS_MODE", "Access mode is invalid");
    }
    if (typeof input.webRtcEnabled !== "boolean") {
      throw new AdminInputError("INVALID_WEBRTC_ENABLED", "WebRTC enabled value is invalid");
    }
    const webRtcUdpStart = input.webRtcUdpStart ?? current.webRtcUdpStart ?? DEFAULT_WEBRTC_UDP_PORT_RANGE[0];
    const webRtcUdpEnd = input.webRtcUdpEnd ?? current.webRtcUdpEnd ?? DEFAULT_WEBRTC_UDP_PORT_RANGE[1];
    if (!Number.isInteger(webRtcUdpStart) || webRtcUdpStart < WEBRTC_UDP_PORT_MIN || webRtcUdpStart > WEBRTC_UDP_PORT_MAX) {
      throw new AdminInputError("INVALID_WEBRTC_PORT_RANGE", "WebRTC UDP start port must be between 1024 and 65535");
    }
    if (!Number.isInteger(webRtcUdpEnd) || webRtcUdpEnd < WEBRTC_UDP_PORT_MIN || webRtcUdpEnd > WEBRTC_UDP_PORT_MAX) {
      throw new AdminInputError("INVALID_WEBRTC_PORT_RANGE", "WebRTC UDP end port must be between 1024 and 65535");
    }
    if (webRtcUdpStart > webRtcUdpEnd) {
      throw new AdminInputError("INVALID_WEBRTC_PORT_RANGE", "WebRTC UDP start port must not exceed the end port");
    }
    if (current.webRtcEnabled && (webRtcUdpStart !== current.webRtcUdpStart || webRtcUdpEnd !== current.webRtcUdpEnd)) {
      throw new AdminInputError("WEBRTC_PORT_LOCKED", "Disable WebRTC and save before changing its UDP port range");
    }

    let encryptedPassword = current.tsPasswordEncrypted;
    const action = input.passwordAction ?? (input.serverPassword === undefined ? "keep" : "replace");
    if (action === "remove") encryptedPassword = null;
    if (action === "replace") encryptedPassword = input.serverPassword ? encryptSecret(input.serverPassword, this.masterSecret) : null;

    let relayConfigured = current.relayConfigured;
    let relayEnabled = current.relayEnabled;
    let relayName = current.relayName;
    let relayHost = current.relayHost;
    let relayPort = current.relayPort || DEFAULT_ACCELERATION_RELAY_PORT;
    let relayTokenEncrypted = current.relayTokenEncrypted;
    const relaySettingsAction = input.relaySettingsAction ?? "keep";
    if (relaySettingsAction === "remove") {
      relayConfigured = true;
      relayEnabled = false;
      relayName = "";
      relayHost = "";
      relayPort = DEFAULT_ACCELERATION_RELAY_PORT;
      relayTokenEncrypted = null;
    } else if (relaySettingsAction === "replace") {
      const relayTarget = (input.relayTarget ?? "").trim();
      relayEnabled = input.relayEnabled === true;
      relayName = (input.relayName ?? "").trim();
      if (relayName.length > 80) throw new AdminInputError("INVALID_RELAY_NAME", "Relay name must contain 80 characters or fewer");
      if (relayEnabled && !relayName) throw new AdminInputError("INVALID_RELAY_NAME", "Relay name is required when the relay is enabled");
      if (relayEnabled && !relayTarget) throw new AdminInputError("INVALID_RELAY_TARGET", "Relay target is required when the relay is enabled");
      if (relayTarget) {
        try {
          const relay = parseTeamSpeakTarget(relayTarget, DEFAULT_ACCELERATION_RELAY_PORT);
          relayHost = relay.host;
          relayPort = relay.port;
        } catch {
          throw new AdminInputError("INVALID_RELAY_TARGET", "Relay target is invalid");
        }
      } else {
        relayHost = "";
        relayPort = DEFAULT_ACCELERATION_RELAY_PORT;
      }
      const relayTokenAction = input.relayTokenAction ?? (input.relayToken === undefined ? "keep" : "replace");
      if (relayTokenAction === "remove") relayTokenEncrypted = null;
      if (relayTokenAction === "replace") relayTokenEncrypted = input.relayToken ? encryptSecret(input.relayToken, this.masterSecret) : null;
      if (relayEnabled && !relayTokenEncrypted) throw new AdminInputError("INVALID_RELAY_TOKEN", "Relay token is required when the relay is enabled");
      relayConfigured = true;
    }
    if (relayNodes) {
      const primary = relayNodes.find((node) => node.enabled) ?? relayNodes[0];
      relayConfigured = relayNodes.length > 0;
      relayEnabled = primary?.enabled === true;
      relayName = primary?.name ?? "";
      relayHost = primary?.host ?? "";
      relayPort = primary?.port ?? DEFAULT_ACCELERATION_RELAY_PORT;
      relayTokenEncrypted = primary?.tokenEncrypted ?? null;
    }
    return {
      siteName,
      welcomeText,
      welcomeTextEn,
      welcomeTextDe,
      welcomeTextRu,
      welcomeTextJa,
      accessMode: input.accessMode,
      tsHost: target.host,
      tsPort: target.port,
      tsPasswordEncrypted: encryptedPassword,
      webRtcEnabled: input.webRtcEnabled,
      webRtcUdpStart,
      webRtcUdpEnd,
      relayConfigured,
      relayEnabled,
      relayName,
      relayHost,
      relayPort,
      relayTokenEncrypted,
    };
  }

  private normalizeRelayNodes(inputs: RelayNodeInput[]): PersistedRelayNode[] {
    if (!Array.isArray(inputs) || inputs.length > 16) throw new AdminInputError("INVALID_RELAY_NODES", "At most 16 relay nodes may be configured");
    const current = new Map(this.database.listRelayNodes().map((node) => [node.id, node]));
    const seen = new Set<string>();
    const now = new Date().toISOString();
    return inputs.map((input) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const targetText = typeof input.target === "string" ? input.target.trim() : "";
      if (!name || name.length > 80) throw new AdminInputError("INVALID_RELAY_NAME", "Relay name must contain 1 to 80 characters");
      if (!targetText || targetText.length > 300) throw new AdminInputError("INVALID_RELAY_TARGET", "Relay target is invalid");
      let target: TeamSpeakTarget;
      try { target = parseTeamSpeakTarget(targetText, DEFAULT_ACCELERATION_RELAY_PORT); }
      catch { throw new AdminInputError("INVALID_RELAY_TARGET", "Relay target is invalid"); }
      const id = typeof input.id === "string" && /^relay-[a-z0-9-]{1,100}$/i.test(input.id)
        ? input.id
        : `relay-${randomBytes(8).toString("hex")}`;
      if (seen.has(id)) throw new AdminInputError("INVALID_RELAY_ID", "Relay id must be unique");
      seen.add(id);
      const previous = current.get(id);
      const tokenAction = input.tokenAction ?? (input.token === undefined ? "keep" : "replace");
      let tokenEncrypted = previous?.tokenEncrypted ?? null;
      if (tokenAction === "remove") tokenEncrypted = null;
      if (tokenAction === "replace") {
        const token = typeof input.token === "string" ? input.token.trim() : "";
        tokenEncrypted = token ? encryptSecret(token, this.masterSecret) : null;
      }
      if (input.enabled === true && (!tokenEncrypted || !this.canDecryptToken(tokenEncrypted))) {
        throw new AdminInputError("INVALID_RELAY_TOKEN", "A relay token of at least 16 characters is required when the relay is enabled");
      }
      return {
        id,
        name,
        enabled: input.enabled === true,
        host: target.host,
        port: target.port,
        tokenEncrypted,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
    });
  }

  private canDecryptToken(encrypted: string): boolean {
    try {
      return decryptSecret(encrypted, this.masterSecret).length >= 16;
    } catch {
      return false;
    }
  }

  private getRelayNodeViews(): Array<{ id: string; name: string; enabled: boolean; target: string; hasToken: boolean }> {
    return this.database.listRelayNodes().map((node) => ({
      id: node.id,
      name: node.name,
      enabled: node.enabled,
      target: formatRelayTarget(node.host, node.port),
      hasToken: Boolean(node.tokenEncrypted),
    }));
  }

  /**
   * The admin-facing view of an ICE entry. `hasCredential` replaces the secret —
   * the plaintext password / shared secret must never travel back to a browser,
   * and the admin console only needs to know whether one is stored.
   */
  private getIceServerViews(): Array<{
    id: string;
    kind: IceServerKind;
    urls: string;
    credentialMode: IceCredentialMode;
    username: string;
    hasCredential: boolean;
    ttlSeconds: number;
    enabled: boolean;
  }> {
    return this.database.listIceServers().map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      urls: entry.urls,
      credentialMode: entry.credentialMode,
      username: entry.username,
      hasCredential: Boolean(entry.credentialEncrypted),
      ttlSeconds: entry.ttlSeconds,
      enabled: entry.enabled,
    }));
  }

  /**
   * Validate and encrypt the submitted ICE entries.
   *
   * Rejections are loud on purpose: a silently dropped or silently truncated entry
   * looks identical to a working configuration until a client fails to connect.
   * The rules mirror what the browser and screen-share normalizer accept, so a
   * saved configuration is exactly what reaches a client.
   */
  private normalizeIceServers(inputs: IceServerInput[]): IceServerWrite[] {
    if (!Array.isArray(inputs)) throw new AdminInputError("INVALID_ICE_SERVERS", "ICE servers must be a list");
    const current = new Map(this.database.listIceServers().map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const normalized = inputs.map((input) => {
      const kind: IceServerKind = input.kind === "turn" ? "turn" : "stun";
      const urls = typeof input.urls === "string" ? input.urls.trim() : "";
      const urlList = urls.split(",").map((url) => url.trim()).filter(Boolean);
      if (!urlList.length) throw new AdminInputError("INVALID_ICE_URLS", "At least one ICE URL is required");
      for (const url of urlList) {
        if (url.length > 512) throw new AdminInputError("INVALID_ICE_URLS", "An ICE URL must contain 512 characters or fewer");
        if (!ICE_URL_PREFIXES.some((prefix) => url.toLowerCase().startsWith(prefix))) {
          throw new AdminInputError("INVALID_ICE_URLS", `ICE URL must start with stun:, stuns:, turn: or turns: (got "${url}")`);
        }
        const port = iceUrlPort(url);
        if (port !== null && (port < 1 || port > 65535)) {
          throw new AdminInputError("INVALID_ICE_URLS", `ICE URL port must be between 1 and 65535 (got "${url}")`);
        }
        // Browsers block port 53 for ICE, so such a candidate never resolves and
        // only delays ICE convergence.
        if (port === 53) throw new AdminInputError("INVALID_ICE_URLS", `ICE URL must not use port 53 (got "${url}")`);
        // `turns:` is TLS over TCP; a udp transport parameter contradicts the scheme.
        if (url.toLowerCase().startsWith("turns:") && /transport=udp/i.test(url)) {
          throw new AdminInputError("INVALID_ICE_URLS", `turns: URLs must not request transport=udp (got "${url}")`);
        }
      }

      const requestedMode = input.credentialMode === "static" || input.credentialMode === "rest" ? input.credentialMode : "none";
      // A credential-less TURN entry is almost always a half-filled form, and an
      // open relay is exactly what this project's docs warn against — require an
      // explicit scheme instead of emitting a relay the browser cannot authenticate.
      if (kind === "turn" && requestedMode === "none") {
        throw new AdminInputError("INVALID_ICE_CREDENTIAL_MODE", "A TURN entry must use either a static credential or a coturn REST shared secret");
      }
      const credentialMode: IceCredentialMode = kind === "stun" ? "none" : requestedMode;

      const id = typeof input.id === "string" && /^ice-[a-z0-9-]{1,100}$/i.test(input.id)
        ? input.id
        : `ice-${randomBytes(8).toString("hex")}`;
      if (seen.has(id)) throw new AdminInputError("INVALID_ICE_ID", "ICE entry id must be unique");
      seen.add(id);

      const previous = current.get(id);
      const credentialAction = input.credentialAction ?? (input.credential === undefined ? "keep" : "replace");
      let credentialEncrypted = previous?.credentialEncrypted ?? null;
      if (credentialAction === "remove") credentialEncrypted = null;
      if (credentialAction === "replace") {
        // Trim like the relay token does: credentials are pasted from a provider
        // dashboard and a stray newline would otherwise break authentication
        // silently.
        const value = typeof input.credential === "string" ? input.credential.trim() : "";
        if (value.length > 512) throw new AdminInputError("INVALID_ICE_CREDENTIAL", "An ICE credential must contain 512 characters or fewer");
        credentialEncrypted = value ? encryptSecret(value, this.masterSecret) : null;
      }

      let username = "";
      let ttlSeconds = previous?.ttlSeconds ?? DEFAULT_TURN_TTL_SECONDS;
      if (credentialMode === "static") {
        username = typeof input.username === "string" ? input.username.trim() : "";
        if (!username || username.length > 512) {
          throw new AdminInputError("INVALID_ICE_USERNAME", "A static credential requires a username of 1 to 512 characters");
        }
        ttlSeconds = DEFAULT_TURN_TTL_SECONDS;
      } else if (credentialMode === "rest") {
        ttlSeconds = readIceTtlSeconds(input.ttlSeconds, previous?.ttlSeconds);
      } else {
        // A STUN entry (or an explicit "none" TURN entry) must not keep a stale
        // secret in the database after the administrator switches the entry's kind
        // or scheme.
        credentialEncrypted = null;
      }

      if (credentialMode === "static" && !credentialEncrypted) {
        throw new AdminInputError("INVALID_ICE_CREDENTIAL", "A password is required for a static credential");
      }
      // The 16-character floor applies to the REST shared secret only. That secret
      // is ours to choose and RFC 8489 §9.2 asks for at least 128 bits of
      // randomness in it. A static password is issued by the provider and is often
      // short (ExpressTURN hands out 8-character ones), so requiring length there
      // would reject perfectly valid configurations.
      if (credentialMode === "rest" && (!credentialEncrypted || !this.canDecryptIceCredential(credentialEncrypted))) {
        throw new AdminInputError("INVALID_ICE_CREDENTIAL", "A shared secret of at least 16 characters is required for the coturn REST scheme");
      }

      return {
        id,
        kind,
        urls: urlList.join(","),
        credentialMode,
        username,
        credentialEncrypted,
        ttlSeconds,
        enabled: input.enabled === true,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
    });

    // STUN URLs become one browser entry each, so a handful of multi-URL entries
    // could still overflow the client-side list. Count the way the resolver emits.
    const emitted = normalized.reduce(
      (total, entry) => total + (entry.kind === "stun" ? entry.urls.split(",").filter(Boolean).length : 1),
      0,
    );
    if (emitted > ICE_SERVER_MAX_ENTRIES) {
      throw new AdminInputError("TOO_MANY_ICE_SERVERS", `At most ${ICE_SERVER_MAX_ENTRIES} ICE entries may be configured`);
    }
    return normalized;
  }

  private canDecryptIceCredential(encrypted: string): boolean {
    try {
      return decryptSecret(encrypted, this.masterSecret).length >= 16;
    } catch {
      return false;
    }
  }

  private legacyRelayNodesFromSettings(settings: SettingsUpdate): PersistedRelayNode[] {
    if (!settings.relayConfigured || !settings.relayHost || !settings.relayTokenEncrypted) return [];
    const previous = this.database.listRelayNodes()[0];
    const now = new Date().toISOString();
    return [{
      id: previous?.id ?? "relay-default",
      name: settings.relayName || "中继加速",
      enabled: settings.relayEnabled,
      host: settings.relayHost,
      port: settings.relayPort || DEFAULT_ACCELERATION_RELAY_PORT,
      tokenEncrypted: settings.relayTokenEncrypted,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }];
  }

  private toInviteView(record: ManagedInviteRecord): ManagedInviteView {
    const now = Date.now();
    const expired = Date.parse(record.expiresAt) <= now;
    const exhausted = record.maxUses > 0 && record.useCount >= record.maxUses;
    return {
      id: record.id,
      target: formatTeamSpeakTarget({ host: record.targetHost, port: record.targetPort }),
      channel: record.channel,
      expiresAt: record.expiresAt,
      maxUses: record.maxUses,
      useCount: record.useCount,
      createdAt: record.createdAt,
      revokedAt: record.revokedAt,
      status: record.revokedAt ? "revoked" : expired ? "expired" : exhausted ? "exhausted" : "active",
    };
  }

  private toSettingsUpdate(settings: ReturnType<WebSpeakDatabase["getSettings"]>): SettingsUpdate {
    return {
      siteName: settings.siteName,
      welcomeText: settings.welcomeText,
      welcomeTextEn: settings.welcomeTextEn,
      welcomeTextDe: settings.welcomeTextDe,
      welcomeTextRu: settings.welcomeTextRu,
      welcomeTextJa: settings.welcomeTextJa,
      accessMode: settings.accessMode,
      tsHost: settings.tsHost,
      tsPort: settings.tsPort,
      tsPasswordEncrypted: settings.tsPasswordEncrypted,
      webRtcEnabled: settings.webRtcEnabled,
      webRtcUdpStart: settings.webRtcUdpStart,
      webRtcUdpEnd: settings.webRtcUdpEnd,
      relayConfigured: settings.relayConfigured,
      relayEnabled: settings.relayEnabled,
      relayName: settings.relayName,
      relayHost: settings.relayHost,
      relayPort: settings.relayPort,
      relayTokenEncrypted: settings.relayTokenEncrypted,
    };
  }

  private importLegacyConfigOnce(): void {
    if (this.database.getMeta("legacy_config_checked") === "1") return;
    if (existsSync(this.legacyConfigPath)) {
      const legacy = loadConfig(this.legacyConfigPath);
      const current = this.database.getSettings();
      this.database.updateSettings({
        siteName: current.siteName,
        welcomeText: current.welcomeText,
        welcomeTextEn: current.welcomeTextEn,
        welcomeTextDe: current.welcomeTextDe,
        welcomeTextRu: current.welcomeTextRu,
        welcomeTextJa: current.welcomeTextJa,
        accessMode: current.accessMode,
        tsHost: legacy.tsHost,
        tsPort: legacy.tsPort,
        tsPasswordEncrypted: legacy.tsServerPassword ? encryptSecret(legacy.tsServerPassword, this.masterSecret) : null,
        webRtcEnabled: current.webRtcEnabled,
        webRtcUdpStart: current.webRtcUdpStart,
        webRtcUdpEnd: current.webRtcUdpEnd,
        relayConfigured: current.relayConfigured,
        relayEnabled: current.relayEnabled,
        relayName: current.relayName,
        relayHost: current.relayHost,
        relayPort: current.relayPort,
        relayTokenEncrypted: current.relayTokenEncrypted,
      }, { auditEvent: "LEGACY_CONFIG_IMPORTED" });
      this.database.setMeta("legacy_config_imported", "1");
      this.database.setMeta("legacy_import_notice_pending", "1");
      this.logger.info("Legacy config imported; WebSpeak settings are now managed from /admin");
    }
    this.database.setMeta("legacy_config_checked", "1");
  }
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function formatRelayTarget(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}#${port}`;
}

/**
 * Extract the explicit port from an ICE URL, or null when the URL omits it
 * (RFC 7065 then defaults to 3478, or 5349 for `turns:`).
 *
 * Handles the IPv6 literal form (`turn:[::1]:3478`) because the port is the last
 * colon-delimited segment either way; a bracketed host with no port ends in `]`
 * and therefore yields null.
 */
function iceUrlPort(url: string): number | null {
  const withoutScheme = url.replace(/^(?:stun|stuns|turn|turns):/i, "").split("?")[0];
  const match = /:(\d+)$/.exec(withoutScheme);
  return match ? Number(match[1]) : null;
}

/**
 * TTL for the coturn REST scheme. Out-of-range values are rejected rather than
 * clamped: the admin console is a form, and silently rewriting a number the
 * administrator typed hides a mistake until a credential expires early.
 */
function readIceTtlSeconds(value: unknown, fallback: number | undefined): number {
  if (value === undefined || value === null || value === "") return fallback ?? DEFAULT_TURN_TTL_SECONDS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < ICE_TTL_SECONDS_MIN || parsed > ICE_TTL_SECONDS_MAX) {
    throw new AdminInputError(
      "INVALID_ICE_TTL",
      `Credential lifetime must be an integer between ${ICE_TTL_SECONDS_MIN} and ${ICE_TTL_SECONDS_MAX} seconds`,
    );
  }
  return parsed;
}

export class AdminInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AdminInputError";
  }
}
