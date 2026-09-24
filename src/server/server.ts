import express from "express";
import { randomBytes } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VoiceBridge, type VoiceBridgeOptions } from "./voice-bridge.js";
import type { Logger } from "../logger.js";
import { parseTeamSpeakTarget, teamSpeakTargetKey } from "../domain/teamspeak-target.js";
import { createAdminRouter } from "../admin/admin-router.js";
import type { AdminService } from "../admin/admin-service.js";
import { AdminSessionStore } from "../admin/admin-session.js";
import { resolveSafeOpenTarget } from "../security/open-target-policy.js";
import { identityFromString } from "@echosixhiya/teamspeak-client";
import { JoinRateLimiter } from "./join-rate-limit.js";
import { generateTurnUserid, resolveIceServers } from "./ice-credentials.js";
import {
  VISITOR_NUMBER_COOKIE,
  WEBSPEAK_DEVICE_COOKIE,
  readVisitorNumberCookie,
  readDeviceIdCookie,
  collectPublicConfigCookies,
} from "./http-cookies.js";
import { MAX_TEAMSPEAK_NICKNAME_CHARACTERS, MIN_TEAMSPEAK_NICKNAME_CHARACTERS } from "../errors.js";
import type { ConfiguredAccelerationRelay } from "./acceleration-relay.js";

export interface WebServerOptions {
  port: number;
  version?: string;
  logFile?: string;
  staticDir?: string;
  certDir?: string; // path to cert.pem + key.pem for HTTPS
  voiceBridgeOptions: VoiceBridgeOptions;
  adminService: AdminService;
  logger: Logger;
  nextVisitorNumber?: () => number;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const logger = options.logger.child({ component: "web" });

  let server: ReturnType<typeof createHttpsServer> | ReturnType<typeof createHttpServer>;

  if (options.certDir) {
    const cert = readFileSync(path.join(options.certDir, "cert.pem"));
    const key = readFileSync(path.join(options.certDir, "key.pem"));
    server = createHttpsServer({ cert, key }, app);
    logger.info("HTTPS enabled");
  } else {
    server = createHttpServer(app);
  }

  app.use(express.json({ limit: "100kb" }));

  const voiceBridge = new VoiceBridge(options.voiceBridgeOptions, logger);
  const adminSessions = new AdminSessionStore();
  const joinRateLimiter = new JoinRateLimiter();
  const startedAt = Date.now();

  const healthHandler: express.RequestHandler = (_request, response) => {
    response.json({ status: "ok", version: options.version ?? "0.1.0" });
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  app.get("/api/public-config", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const acceleration = resolveAccelerationOptions(options.voiceBridgeOptions.acceleration);
    // 设备标识：请求里带合法 32 位 hex 就复用，否则新签发一个。仅在新签发时
    // 回写 Cookie，避免每次请求都重复 Set-Cookie。
    const existingDeviceId = readDeviceIdCookie(request.header("cookie"));
    const deviceId = existingDeviceId ?? randomBytes(16).toString("hex");
    const newDeviceId = existingDeviceId ? null : deviceId;
    const rawVisitorNumber = readVisitorNumberCookie(request.header("cookie"));
    let visitorNumber = rawVisitorNumber;
    let newVisitorNumber: number | null = null;
    if (visitorNumber === null && options.nextVisitorNumber) {
      try {
        visitorNumber = options.nextVisitorNumber();
        newVisitorNumber = visitorNumber;
      } catch (error: unknown) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Visitor number could not be assigned");
      }
    }
    // 访客编号与设备标识可能同时是新签发的，必须用数组一次性下发 ——
    // 连续两次 setHeader("Set-Cookie", ...) 会让后一条覆盖前一条。
    const cookiesToSet = collectPublicConfigCookies({
      visitorNumber: newVisitorNumber,
      deviceId: newDeviceId,
      secure: Boolean(options.certDir),
    });
    if (cookiesToSet.length > 0) {
      response.setHeader("Set-Cookie", cookiesToSet);
    }
    // 浏览器侧的 WebRTC ICE 配置由服务端下发，避免前端硬编码部署相关的地址。
    // TURN userid 由设备标识前 12 位派生，使同一设备在 Cookie 有效期内拿到
    // 稳定且独享的 TURN 配额；resolveIceServers 会为本次下发签发新鲜临时凭据
    // （见 ice-credentials.ts）。
    const clientTurnUserid = generateTurnUserid(deviceId.slice(0, 12));
    const iceServers = resolveIceServers(clientTurnUserid);
    response.json({
      ...options.adminService.getPublicConfig(),
      visitorNumber,
      accelerationAvailable: acceleration.length > 0,
      accelerationRelays: acceleration.map((relay) => ({ id: relay.id, name: relay.name })),
      iceServers,
    });
  });

  app.post("/api/join-ticket", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!request.is("application/json") || !isSameOrigin(request)) {
      response.status(403).json({ ok: false, code: "ORIGIN_REJECTED" });
      return;
    }
    if (!options.adminService.isInitialized()) {
      response.status(503).json({ ok: false, code: "NOT_INITIALIZED" });
      return;
    }
    if (!joinRateLimiter.allow(request.socket.remoteAddress ?? "unknown")) {
      response.status(429).json({ ok: false, code: "RATE_LIMITED" });
      return;
    }
    const body = isRecord(request.body) ? request.body : {};
    // 按**码点**截断到上限，不用 String.prototype.slice —— 后者按 UTF-16 单元切，
    // 会把 emoji 之类的代理对切一半，产出一个非法字符再发给 TeamSpeak。
    const nickname = typeof body.nickname === "string"
      ? [...body.nickname.trim()].slice(0, MAX_TEAMSPEAK_NICKNAME_CHARACTERS).join("")
      : "";
    const requestedChannel = typeof body.channel === "string" ? body.channel.trim().slice(0, 100) : "";
    const inviteToken = typeof body.invite === "string" ? body.invite.trim().slice(0, 128) : "";
    const requestedIdentity = typeof body.identity === "string" && body.identity.length <= 8192 ? body.identity : "";
    let identity: string | undefined;
    if (requestedIdentity) {
      try {
        identityFromString(requestedIdentity);
        identity = requestedIdentity;
      } catch {
        // A stale/corrupt local identity must not block a normal ephemeral join.
      }
    }
    // 昵称长度在这里挡住，别让它走到 TS 握手 —— TS3 对不合规的 clientinit 参数是静默
    // 丢弃，网关只能等满 15 秒握手超时，用户收到的是「连接超时，请检查网络」。
    // 前端也有一份同样的校验（见 useVoiceWebSocket.ts），这里是服务端的兜底。
    // 只查下限：上限已经由上面的截断保证，再查一遍是死代码。
    if ([...nickname].length < MIN_TEAMSPEAK_NICKNAME_CHARACTERS) {
      response.status(400).json({ ok: false, code: "INVALID_NICKNAME" });
      return;
    }

    const policy = options.adminService.getConnectionPolicy();
    const managedInvite = inviteToken ? options.adminService.consumeManagedInvite(inviteToken) : null;
    if (inviteToken && !managedInvite) {
      response.status(400).json({ ok: false, code: "INVITE_INVALID" });
      return;
    }
    let target = managedInvite?.target ?? policy.defaultTarget;
    let serverPassword = managedInvite?.serverPassword ?? policy.serverPassword;
    const channel = requestedChannel || managedInvite?.channel || "";
    const requestedRelayId = typeof body.accelerationRelayId === "string" ? body.accelerationRelayId.trim().slice(0, 110) : "";
    const accelerationRequested = body.accelerated === true || Boolean(requestedRelayId);
    const acceleration = resolveAccelerationOptions(options.voiceBridgeOptions.acceleration);
    if (accelerationRequested && acceleration.length === 0) {
      response.status(400).json({ ok: false, code: "ACCELERATION_UNAVAILABLE" });
      return;
    }
    if (requestedRelayId && !acceleration.some((relay) => relay.id === requestedRelayId)) {
      response.status(400).json({ ok: false, code: "ACCELERATION_UNAVAILABLE" });
      return;
    }
    if (!managedInvite) {
      try {
        if (policy.accessMode === "open" && typeof body.target === "string" && body.target.trim()) {
          target = parseTeamSpeakTarget(body.target);
          const isDefault = teamSpeakTargetKey(target) === teamSpeakTargetKey(policy.defaultTarget);
          // Open mode must protect the gateway even when a user submits the
          // same address configured as the administrator's default target.
          // The default target only controls which server is prefilled; it is
          // not a trust boundary and must not bypass SSRF protection.
          target = await resolveSafeOpenTarget(target);
          if (!isDefault) serverPassword = typeof body.serverPassword === "string" ? body.serverPassword.slice(0, 512) : "";
          else if (typeof body.serverPassword === "string" && body.serverPassword.trim()) serverPassword = body.serverPassword.slice(0, 512);
        } else if (policy.accessMode === "fixed" && typeof body.serverPassword === "string" && body.serverPassword.trim()) {
          // The fixed target remains administrator-controlled, but a user may
          // retry its server password after the gateway reports that one is
          // required. The target itself is never taken from this request.
          serverPassword = body.serverPassword.slice(0, 512);
        }
      } catch {
        response.status(400).json({ ok: false, code: "TARGET_NOT_ALLOWED" });
        return;
      }
    }

    const ticket = options.voiceBridgeOptions.joinTickets.create({
      target,
      serverPassword,
      nickname,
      ...(channel ? { channel } : {}),
      ...(identity ? { identity, rememberIdentity: true } : body.rememberIdentity === true ? { rememberIdentity: true } : {}),
      ...(accelerationRequested ? { accelerated: true, ...(requestedRelayId ? { accelerationRelayId: requestedRelayId } : {}) } : {}),
    });
    response.status(201).json({ ok: true, ticket });
  });

  app.use("/api/admin", createAdminRouter({
    service: options.adminService,
    sessions: adminSessions,
    logger,
    getActiveSessions: () => voiceBridge.getActiveCount(),
    getPeakSessions: () => voiceBridge.getPeakCount(),
    getCreatedSessions: () => voiceBridge.getCreatedCount(),
    getSessionSummaries: () => voiceBridge.getSessionSummaries(),
    terminateSession: (id) => voiceBridge.terminateSession(id),
    version: options.version,
    logFile: options.logFile,
    startedAt,
  }));

  // Serve static frontend
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  voiceBridge.attach(server);

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(options.port, () => {
          logger.info({ port: options.port }, "Web server started");
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      await voiceBridge.shutdown();
      adminSessions.clear();
      // server.close() 的回调只在**所有**连接关闭后才触发。反向代理 / SSH 隧道
      // 会长期持有 keep-alive 长连接（实测阿里云上春川2 的隧道常驻两条），
      // 回调因此永不触发、进程永不退出 —— 生产上表现为 systemd 等满
      // TimeoutStopSec(90s) 后 SIGKILL。先关空闲连接，再给一个兜底上限强制关闭。
      return new Promise((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, 2000);
        timer.unref?.();
        server.close(finish);
        server.closeIdleConnections?.();
      });
    },
  };
}

function resolveAccelerationOptions(
  configured: ConfiguredAccelerationRelay[] | (() => ConfiguredAccelerationRelay[]) | undefined,
): ConfiguredAccelerationRelay[] {
  const value = typeof configured === "function" ? configured() : configured;
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSameOrigin(request: express.Request): boolean {
  const origin = request.header("origin");
  const host = request.header("host");
  try {
    return Boolean(origin && host && new URL(origin).host === host);
  } catch {
    return false;
  }
}
