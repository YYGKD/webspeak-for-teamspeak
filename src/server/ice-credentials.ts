/**
 * ICE/TURN 凭据派生与下发（S2 媒体内核抽取的独立模块）。
 *
 * 迁移后本模块独立于任何媒体引擎，继续服务：
 *   - `/api/public-config` 下发给浏览器（含 STUN + TURN 临时凭据）；
 *   - 屏幕共享临时凭据派发；
 *   - 服务端自用 peer（如需要）的独立 TURN 配额桶。
 *
 * TURN 凭据采用 coturn 的 REST 方案（临时凭据），避免向每个访问者下发长期有效的
 * 固定用户名密码 —— 那等于公开一个开放中继。
 */
import { createHmac, randomBytes } from "node:crypto";
import { resolveTurnConfig } from "./webrtc-config.js";
import type { IceCredentialMode, IceServerKind } from "./webrtc-config.js";

/**
 * STUN 服务器地址。默认是公共 STUN，生产部署应通过 WEBSPEAK_STUN_URLS
 * 指向自建 STUN（逗号分隔），这样源码里不出现部署相关的 IP。
 *
 * 浏览器需要靠 STUN 发现自己的公网映射地址（srflx candidate）；没有它，
 * 移动网络与对称 NAT 下会连不上并静默回退到 WS 兼容通道。
 */
const DEFAULT_STUN_URLS = ["stun:stun.miwifi.com:3478", "stun:stun.chat.bilibili.com:3478"];

/** 当前生效的 STUN 地址列表。也用于通过 /api/public-config 下发给浏览器。 */
export function resolveStunUrls(): string[] {
  const raw = process.env.WEBSPEAK_STUN_URLS?.trim();
  return (raw ? raw.split(",") : DEFAULT_STUN_URLS).map((url) => url.trim()).filter(Boolean);
}

/** 一条 iceServer 配置：STUN 只有 urls，TURN 还带临时凭据。 */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * TURN userid 的统一派生契约：`webspeak_<12 位 hex>`。
 *
 * coturn 的 REST 方案里 username 是 `<过期 unix 秒>:<userid>`，userid 段纯粹是
 * 配额/审计标识（可按 userid 做独立限速与统计），不参与 HMAC 校验，但必须满足
 * coturn 的 user-quota 分桶语义 —— 每个 userid 一份独立配额。因此这里固定成
 * 短小的 `webspeak_<hex>` 形态，避免不同来源拼出撞车的 userid。
 *
 * 传入合法的 12 位纯十六进制串时直接采用（调用方可借此复用已有标识）；缺失或
 * 不合法则回退生成随机 12 位 hex，保证返回值恒匹配 /^webspeak_[0-9a-f]{12}$/。
 */
export function generateTurnUserid(rawSuffix?: string): string {
  const suffix = rawSuffix && /^[0-9a-f]{12}$/.test(rawSuffix) ? rawSuffix : randomBytes(6).toString("hex");
  return `webspeak_${suffix}`;
}

/**
 * 为一次下发签发 TURN 临时凭据（coturn 的 REST API 方案）。
 *
 * username   = "<过期 unix 秒>:<userid>"
 * credential = base64(HMAC-SHA1(static-auth-secret, username))
 *
 * coturn 收到后会自己算一遍 HMAC 并检查时间戳，所以既不需要在服务端存用户表，
 * 也不会有长期有效的密码流出去。见 webrtc-config.ts 里 resolveTurnConfig 的说明。
 */
export function buildTurnCredentials(
  secret: string,
  ttlSeconds: number,
  userid?: string,
): { username: string; credential: string } {
  const uid = userid && /^webspeak_[0-9a-f]{12}$/.test(userid) ? userid : generateTurnUserid();
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${uid}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

/**
 * 下发给浏览器的完整 ICE 配置：STUN + （配置了的话）TURN。
 *
 * 每次调用都重新签发 TURN 凭据 —— 调用方（/api/public-config）已设 no-store，
 * 每个页面加载拿到的是新鲜凭据。可选 userid 透传给凭据签发，用于给不同来源
 * （如服务端自用 peer）分配独立的 TURN 配额；缺省时自动随机生成。
 *
 * 纯 STUN 只能让浏览器发现自己的公网映射；对称 NAT 或 UDP 被封的网络下没有
 * 可用候选对，只能回退到 WS 兼容通道（延迟与音质下降）。TURN 就是给这类
 * 网络兜底的中继。
 */
export function resolveIceServers(userid?: string): IceServerConfig[] {
  const servers: IceServerConfig[] = resolveStunUrls().map((urls) => ({ urls: [urls] }));
  const turn = resolveTurnConfig();
  if (turn) servers.push({ urls: turn.urls, ...buildTurnCredentials(turn.secret, turn.ttlSeconds, userid) });
  return servers;
}

/**
 * One administrator-configured ICE entry, as read from the `ice_servers` table.
 *
 * `credential` is already decrypted by the caller — this module stays free of the
 * persistence layer and of the master key, so it can be unit-tested directly
 * (see scripts/ice-config-test.mjs).
 */
export interface IceServerEntry {
  kind: IceServerKind;
  /** Comma-separated ICE URLs, exactly as stored. */
  urls: string;
  credentialMode: IceCredentialMode;
  /** Only meaningful for `static` entries. */
  username: string;
  /** Static password (plaintext) or REST shared secret (plaintext); null when absent. */
  credential: string | null;
  ttlSeconds: number;
}

/**
 * Assemble the browser-facing ICE list from administrator-configured entries.
 *
 * Output shape deliberately matches resolveIceServers(): STUN URLs become one
 * entry each, a TURN entry keeps all of its URLs together. That way the browser
 * sees the same shape whether the config came from the admin console or from the
 * environment, and the screen-share path's normalizer (screen-share.ts) behaves
 * identically for both.
 *
 * Failure modes are closed, not open:
 *   - an entry with no usable URL is skipped;
 *   - a TURN entry with a missing credential is skipped rather than emitted as a
 *     relay the browser cannot authenticate against (a dead TURN candidate only
 *     delays ICE convergence);
 *   - `stun` / `credentialMode: "none"` entries never carry credentials.
 */
export function resolveIceServersFromEntries(
  entries: readonly IceServerEntry[],
  userid?: string,
): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  for (const entry of entries) {
    const urls = entry.urls.split(",").map((url) => url.trim()).filter(Boolean);
    if (!urls.length) continue;
    if (entry.kind === "stun" || entry.credentialMode === "none") {
      for (const url of urls) servers.push({ urls: [url] });
      continue;
    }
    if (!entry.credential) continue;
    if (entry.credentialMode === "static") {
      servers.push({ urls, username: entry.username, credential: entry.credential });
      continue;
    }
    servers.push({ urls, ...buildTurnCredentials(entry.credential, entry.ttlSeconds, userid) });
  }
  return servers;
}
