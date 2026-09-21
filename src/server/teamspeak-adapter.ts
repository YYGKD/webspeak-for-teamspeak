import {
  Client as TeamSpeakClient,
  generateIdentity,
  type ClientOptions,
  type Identity,
} from "@echosixhiya/teamspeak-client";
import type { Logger } from "../logger.js";
import { WEBSPEAK_ERROR_MESSAGES, WebSpeakError, normalizeTeamSpeakError } from "../errors.js";
import { formatTeamSpeakTarget, teamSpeakTargetKey, type TeamSpeakTarget } from "../domain/teamspeak-target.js";

export type TeamSpeakProtocol = "ts3" | "ts6";

interface CacheEntry {
  protocol: TeamSpeakProtocol;
  lastSuccessfulAt: number;
}

/** Process-local optimization; protocol is never persisted as user config. */
export class EndpointProtocolCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly maxEntries = 128,
  ) {}

  get(target: TeamSpeakTarget, now = Date.now()): TeamSpeakProtocol | undefined {
    const key = teamSpeakTargetKey(target);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.lastSuccessfulAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.protocol;
  }

  set(target: TeamSpeakTarget, protocol: TeamSpeakProtocol, now = Date.now()): void {
    const key = teamSpeakTargetKey(target);
    this.entries.delete(key);
    this.entries.set(key, { protocol, lastSuccessfulAt: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const endpointProtocolCache = new EndpointProtocolCache();

const TEAM_SPEAK_CONNECT_TIMEOUT_MS = 15_000;

export interface TeamSpeakAdapterOptions {
  target: TeamSpeakTarget;
  nickname: string;
  identity?: Identity;
  serverPassword?: string;
  defaultChannel?: string;
  channelPassword?: string;
}

/**
 * The SDK performs the wire-level TS3/TS6 negotiation itself. This adapter is
 * the only application boundary that knows about that SDK and records the
 * successfully observed server generation for later connections.
 */
export class TeamSpeakAdapter {
  readonly client: TeamSpeakClient;
  readonly identity: Identity;
  private detectedProtocol: TeamSpeakProtocol | null = null;

  constructor(
    options: TeamSpeakAdapterOptions,
    private readonly logger: Logger,
    private readonly protocolCache: EndpointProtocolCache = endpointProtocolCache,
  ) {
    this.identity = options.identity ?? generateIdentity(8);
    const clientOptions: ClientOptions = {
      serverPassword: options.serverPassword,
      defaultChannel: options.defaultChannel,
      defaultChannelPassword: options.channelPassword,
      logger: {
        debug: (msg: string) => this.logger.debug(msg),
        info: (msg: string) => this.logger.info(msg),
        warn: (msg: string) => this.logger.warn(msg),
        error: (msg: string) => this.logger.error(msg),
      },
    };
    this.client = new TeamSpeakClient(
      this.identity,
      formatTeamSpeakTarget(options.target),
      options.nickname,
      clientOptions,
    );
    this.target = options.target;
  }

  private readonly target: TeamSpeakTarget;

  async connect(): Promise<void> {
    const cachedProtocol = this.protocolCache.get(this.target);
    this.logger.info({ target: formatTeamSpeakTarget(this.target), cachedProtocol }, "Connecting through TeamSpeak adapter");
    const budget = AbortSignal.timeout(TEAM_SPEAK_CONNECT_TIMEOUT_MS);
    // 只有"传输已建立"之后的超时才叫握手超时。传输层自己没连上时 budget 也可能
    // 已经到点，那种情况是网络问题，不能算成服务器拒绝了我们。
    let transportUp = false;
    try {
      await this.client.connect();
      transportUp = true;
      await this.client.waitConnected(budget);
    } catch (error: unknown) {
      await this.client.disconnect().catch(() => undefined);
      // budget.aborted 能精确区分两种"超时"：
      //  · 我们的握手预算到点 —— 服务器收到了请求却不回话。TS3 对不合规的 clientinit
      //    参数（例如昵称短于 3 个字符）就是静默丢弃，服务端日志里连一条记录都没有。
      //  · 真正的网络超时 —— 传输层就没通。
      // 两者的用户提示完全不同，混成一个 TIMEOUT 会让人去查网络。
      if (transportUp && budget.aborted) {
        throw new WebSpeakError("handshake_timeout", WEBSPEAK_ERROR_MESSAGES.handshake_timeout, true, error);
      }
      throw normalizeTeamSpeakError(error);
    }

    const observedProtocol = await this.detectProtocol();
    this.detectedProtocol = observedProtocol ?? cachedProtocol ?? null;
    if (observedProtocol) this.protocolCache.set(this.target, observedProtocol);
  }

  get protocol(): TeamSpeakProtocol | null {
    return this.detectedProtocol;
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
    } catch {
      // Teardown must remain safe when the transport has already gone away.
    }
  }

  private async detectProtocol(): Promise<TeamSpeakProtocol | null> {
    try {
      const rows = await this.client.execCommandWithResponse("version", 3000);
      const versionText = rows
        .flatMap((row) => Object.values(row))
        .filter((value): value is string => typeof value === "string")
        .join(" ");
      return detectTeamSpeakProtocol(versionText);
    } catch {
      // Version discovery is an optimization; connection success is enough to proceed.
      return null;
    }
  }
}

export function detectTeamSpeakProtocol(versionText: string): TeamSpeakProtocol | null {
  const text = versionText.trim().toLocaleLowerCase();
  if (/teamspeak\s*6|(?:^|\D)6\.\d+/.test(text)) return "ts6";
  if (/teamspeak\s*3|(?:^|\D)3\.\d+/.test(text)) return "ts3";
  return null;
}
