/** Default WebRTC media port range used by WebSpeak and its Docker image. */
export const DEFAULT_WEBRTC_UDP_PORT_RANGE: [number, number] = [40000, 40099];

// Kept as a public alias for callers that used the original fixed-range name.
export const WEBRTC_UDP_PORT_RANGE = DEFAULT_WEBRTC_UDP_PORT_RANGE;
export const WEBRTC_UDP_PORT_MIN = 1024;
export const WEBRTC_UDP_PORT_MAX = 65535;

/**
 * 浏览器 WebRTC 语音的开关与端口段配置（由管理员控制台持久化）。
 *
 * S6 起媒体由 mediasoup 单引擎托管，说话人不再预分配音频 m-line，因此这里
 * 不再有坑位数量概念；`udpPortRange` 仅保留为管理端既有设置的类型契约。
 */
export interface WebRtcAudioOptions {
  enabled: boolean;
  udpPortRange?: [number, number];
}

/**
 * TURN 中继配置（用于对称 NAT / UDP 被封的网络）。
 *
 * 靠三个环境变量开启，全部来自 root-only 的 EnvironmentFile：
 *   WEBSPEAK_TURN_URLS        逗号分隔，例如 turn:1.2.3.4:3478?transport=udp,turn:1.2.3.4:3478?transport=tcp
 *   WEBSPEAK_TURN_SECRET      coturn 的 static-auth-secret，用于签发临时凭据
 *   WEBSPEAK_TURN_TTL_SECONDS 临时凭据有效期（默认 1800，限制 60..86400）
 *
 * **为什么用临时凭据而不是固定用户名密码**：`/api/public-config` 会把 iceServers
 * 下发给每一个访问者，固定凭据等于公开一个开放中继 —— 任何人都能拿它拿你的
 * 服务器带宽和 IP 做跳板。临时凭据有有效期，泄露窗口有限。
 *
 * 配了 URL 但没配 secret 时返回 null（**失败关闭**）：宁可退回纯 STUN，
 * 也不要下发一个连不上的 TURN（那只会拖慢 ICE 收敛）。
 */
export interface WebRtcTurnConfig {
  urls: string[];
  secret: string;
  ttlSeconds: number;
}

/** Default lifetime for a coturn REST credential when the administrator does not set one. */
export const DEFAULT_TURN_TTL_SECONDS = 1800;

/**
 * STUN entries carry no credentials; TURN entries carry one of the two schemes below.
 *
 * Defined here rather than in the persistence layer because the admin console, the
 * database schema and the ICE assembler all speak the same two unions — keeping
 * them in the shared WebRTC config contract module avoids a server → persistence
 * import in the reverse direction.
 */
export type IceServerKind = "stun" | "turn";

/**
 * How a TURN entry authenticates.
 *
 *   none   — only valid for `stun` entries; nothing is sent to the browser.
 *   static — a long-term username/password issued by the provider, handed to the
 *            browser verbatim. Deliberately high risk: the credential is public to
 *            every visitor, so anyone who reads it can spend the provider's quota.
 *   rest   — coturn's time-limited scheme (draft-uberti-behave-turn-rest): the
 *            shared secret stays on the server and a fresh `<expiry>:<userid>` +
 *            HMAC-SHA1 credential is minted per page load.
 */
export type IceCredentialMode = "none" | "static" | "rest";

/** Accepted URL prefixes for an ICE entry. `stuns:`/`turns:` are the TLS forms. */
export const ICE_URL_PREFIXES = ["stun:", "stuns:", "turn:", "turns:"] as const;

/** TTL bounds for the `rest` scheme, matching the coturn contract in resolveTurnConfig(). */
export const ICE_TTL_SECONDS_MIN = 60;
export const ICE_TTL_SECONDS_MAX = 86_400;

/**
 * Upper bound on how many ICE entries may reach a browser, counted the way
 * resolveIceServersFromEntries() emits them (a STUN URL becomes one entry, a TURN
 * block stays one entry).
 *
 * The screen-share path already truncates at this size (screen-share.ts), so
 * validating against the same number at save time turns a silent truncation into a
 * rejected save. Both sides read this constant so they cannot drift apart.
 */
export const ICE_SERVER_MAX_ENTRIES = 8;

export function resolveTurnConfig(): WebRtcTurnConfig | null {
  const urls = (process.env.WEBSPEAK_TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) return null;
  const secret = process.env.WEBSPEAK_TURN_SECRET?.trim() ?? "";
  if (!secret) return null;
  const raw = Number(process.env.WEBSPEAK_TURN_TTL_SECONDS);
  const ttlSeconds =
    Number.isFinite(raw) && raw >= ICE_TTL_SECONDS_MIN && raw <= ICE_TTL_SECONDS_MAX
      ? Math.floor(raw)
      : DEFAULT_TURN_TTL_SECONDS;
  return { urls, secret, ttlSeconds };
}
