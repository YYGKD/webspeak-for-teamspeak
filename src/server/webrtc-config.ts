/** Default WebRTC media port range used by WebSpeak and its Docker image. */
export const DEFAULT_WEBRTC_UDP_PORT_RANGE: [number, number] = [40000, 40099];

// Kept as a public alias for callers that used the original fixed-range name.
export const WEBRTC_UDP_PORT_RANGE = DEFAULT_WEBRTC_UDP_PORT_RANGE;
export const WEBRTC_UDP_PORT_MIN = 1024;
export const WEBRTC_UDP_PORT_MAX = 65535;

/**
 * SFU 预分配的音频 slot 数。
 *
 * 每个 slot 是一条协商好的 audio m-line，说话人被分配到空闲 slot 上转发，
 * 因此说话人进出**不触发重协商**。取值需要 ≥ 同一频道里可能同时说话的人数；
 * slot 用尽时会淘汰最久未活跃的说话人（会被静默）。
 *
 * 可用 WEBSPEAK_SFU_SLOTS 覆盖（1-32）。
 */
export const DEFAULT_WEBRTC_SLOT_COUNT = 8;

export function resolveWebRtcSlotCount(): number {
  const raw = process.env.WEBSPEAK_SFU_SLOTS?.trim();
  const value = raw ? Number(raw) : DEFAULT_WEBRTC_SLOT_COUNT;
  return Number.isInteger(value) && value >= 1 && value <= 32 ? value : DEFAULT_WEBRTC_SLOT_COUNT;
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

const DEFAULT_TURN_TTL_SECONDS = 1800;

export function resolveTurnConfig(): WebRtcTurnConfig | null {
  const urls = (process.env.WEBSPEAK_TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) return null;
  const secret = process.env.WEBSPEAK_TURN_SECRET?.trim() ?? "";
  if (!secret) return null;
  const raw = Number(process.env.WEBSPEAK_TURN_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(raw) && raw >= 60 && raw <= 86_400 ? Math.floor(raw) : DEFAULT_TURN_TTL_SECONDS;
  return { urls, secret, ttlSeconds };
}
