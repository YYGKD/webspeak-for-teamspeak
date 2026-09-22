import { reactive, ref } from "vue";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import { loadLocalPreferences, saveLocalPreferences } from "../services/local-persistence.js";

const micCaptureWorkletUrl = "/mic-capture-worklet.js";
const SCREEN_SHARE_NEGOTIATION_TIMEOUT_MS = 15_000;
const DEFAULT_SCREEN_SHARE_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:turn.teamspeak.com:3478" },
  { urls: "stun:turn2.teamspeak.com:3478" },
];
let screenShareIceServers: RTCIceServer[] = DEFAULT_SCREEN_SHARE_ICE_SERVERS;

function normalizeScreenShareIceServers(raw: unknown): RTCIceServer[] {
  if (!Array.isArray(raw)) return DEFAULT_SCREEN_SHARE_ICE_SERVERS;
  const normalized: RTCIceServer[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const rawUrls = value.urls;
    const urls = (Array.isArray(rawUrls) ? rawUrls : [rawUrls])
      .filter((url): url is string => typeof url === "string" && /^(?:stun|stuns|turn|turns):/i.test(url.trim()))
      .map((url) => url.trim())
      .filter(Boolean);
    const uniqueUrls = [...new Set(urls)];
    if (!uniqueUrls.length) continue;
    const username = typeof value.username === "string" ? value.username : undefined;
    const credential = typeof value.credential === "string" ? value.credential : undefined;
    const key = JSON.stringify([uniqueUrls, username ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      urls: uniqueUrls.length === 1 ? uniqueUrls[0] : uniqueUrls,
      ...(username !== undefined ? { username } : {}),
      ...(credential !== undefined ? { credential } : {}),
    });
    if (normalized.length >= 8) break;
  }
  return normalized.length ? normalized : DEFAULT_SCREEN_SHARE_ICE_SERVERS;
}

/**
 * ICE/STUN 服务器。
 *
 * 留空时浏览器只能给出内网 host candidate，移动网络与对称 NAT 下连不上，
 * 会静默回退到 WS 兼容通道（TCP，延迟与抖动都差得多）。
 * 默认值与服务端 webrtc-audio.ts 的 DEFAULT_STUN_URLS 保持一致；
 * 生产环境建议自建 coturn 后两边一并替换。
 */
/**
 * 浏览器侧的 WebRTC ICE 配置。
 *
 * 由服务端通过 /api/public-config 下发（见 WebClient.vue 的 loadPublicConfig），
 * 这样 STUN 地址只在服务端配置一次，前端不硬编码部署相关的地址。
 * 这里的默认值只在拿不到配置时兜底。
 */
let activeIceServers: RTCIceServer[] = [
  { urls: "stun:stun.miwifi.com:3478" },
  { urls: "stun:stun.chat.bilibili.com:3478" },
];

/** 由应用启动时用 /api/public-config 的结果调用。空数组会被忽略。 */
export function setWebRtcIceServers(servers: RTCIceServer[]): void {
  if (servers.length) activeIceServers = servers;
}

/**
 * SFU 的默认 slot 数。服务端会在 connected 消息里下发真实值（WEBSPEAK_SFU_SLOTS），
 * 这里只是拿不到时的兜底 —— 两边必须一致，否则 m-line 数量对不上。
 */
const DEFAULT_WEBRTC_SLOT_COUNT = 8;

/** 本地说话指示的能量门限（与旧服务端 SPEAKER_ACTIVITY_RMS 同量级）。 */
const SFU_ACTIVITY_RMS = 0.01;
const SFU_ACTIVITY_INTERVAL_MS = 100;

/** 一个 slot 的播放节点：source → gain → analyser → destination。 */
interface SfuSlotNode {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  buffer: Float32Array;
  /** 该 slot 当前承载的 TeamSpeak clientId；未分配时为 null。 */
  clientId: number | null;
  /** 诊断用：保留流引用以便查看轨道状态。 */
  stream: MediaStream;
  /**
   * 静音的 <audio> 元素，唯一作用是让 Chrome 启动这条 WebRTC 接收流。
   * 真正出声的是 WebAudio 图。见 attachSfuSlot 里的说明。
   */
  element: HTMLAudioElement;
}

export interface VoiceState {
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  reconnectFailed: boolean;
  tsClientId: number;
  error: string;
  errorCode: string;
  /**
   * Non-fatal audio diagnostics. Unlike error/errorCode these never take over
   * the connect form: they explain a degraded microphone or playback path while
   * the voice room itself stays joined and usable.
   */
  microphoneError: string;
  microphoneErrorCode: string;
  audioNotice: string;
  audioNoticeCode: string;
  channelSwitchedChannelId: string;
}

export interface ScreenShareStream {
  streamId: string;
  source: "browser" | "teamspeak";
  ownerPeerId: string;
  ownerClientId?: number;
  ownerNickname: string;
  name: string;
  audio: boolean;
  createdAt: number;
  viewerCount: number;
  viewers: ScreenShareViewer[];
}

export interface ScreenShareViewer {
  peerId: string;
  nickname: string;
  avatar?: string;
}

export interface ScreenShareCaptureSettings {
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate?: number;
}

export interface ScreenShareCaptureStats {
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

export interface ScreenSharePeerStats {
  peerId: string;
  role: "owner" | "viewer";
  direction: "outbound" | "inbound";
  connectionState: string;
  iceConnectionState: string;
  codec: string | null;
  candidateType: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitrateKbps: number | null;
  packetsLost: number | null;
  packetsTotal: number | null;
  lossPercent: number | null;
  framesDropped: number | null;
  jitterMs: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  qualityLimitationReason: string | null;
}

export interface ScreenShareWebRtcStats {
  updatedAt: number | null;
  capture: ScreenShareCaptureStats | null;
  peers: ScreenSharePeerStats[];
}

export interface ScreenShareSignal {
  kind: "offer" | "answer" | "iceCandidate" | "close";
  sdp?: string;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface ChannelMember {
  id: number;
  nickname: string;
  uid?: string;
  avatar?: string;
  isSelf?: boolean;
  away?: boolean;
  awayMessage?: string;
  inputMuted?: boolean;
  outputMuted?: boolean;
  channelCommander?: boolean;
}

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export interface AudioOutputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export type AudioPermission = "unknown" | "granted" | "denied";

export interface MicrophoneProcessingSettings {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  rnnoise: boolean | null;
}

type SinkAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export interface ChannelInfo {
  id: string;
  parentID: string;
  order?: string;
  name: string;
  description?: string;
  members?: { id: number; nickname: string; uid?: string; avatar?: string; away?: boolean; awayMessage?: string; inputMuted?: boolean; outputMuted?: boolean; channelCommander?: boolean }[];
}

/**
 * 单个频道的详情（按需向网关请求 `channelinfo cid=N`）。
 * 说明字段不在 channelList 里：欢迎序列不带它、SDK 的 listChannels 又把它写死成空串，
 * 所以只有这一条路可取，见 src/server/ts-client.ts 的 getChannelInfo。
 */
export interface ChannelInfoDetails {
  id: string;
  name: string;
  topic: string;
  description: string;
}

export interface ChatMessage {
  id: string;
  scope: "channel" | "server" | "private" | "system";
  targetId?: string;
  conversationId?: string;
  senderId?: number;
  senderUid?: string;
  invokerName: string;
  message: string;
  timestamp: number;
  isSelf?: boolean;
}

export interface ServerEvent {
  id: string;
  kind: string;
  message: string;
  timestamp: number;
}

export interface LatencyProbeResult {
  /**
   * 整段 WebSocket 往返：浏览器发出 latencyProbe 到收到 latencyPong。
   *
   * 服务端在回 pong 之前会先等 TeamSpeak 的 `version` 探测（voice-bridge.ts
   * 的 latencyProbe 分支），所以这里**包含** teamSpeakLatencyMs，不是纯
   * 控制通道往返。它只适合用来判断"这条控制通道还活着"，不要拿它当媒体路径
   * 延迟展示 —— 媒体路径请用 sampleMediaPath()。
   */
  browserRttMs: number;
  teamSpeakLatencyMs: number | null;
  teamSpeakReachable: boolean;
  teamSpeakErrorCode?: string;
}

/** WebRTC 媒体路径（浏览器 ↔ 网关）的实时指标。 */
export interface MediaPathStats {
  /** 被选中的 ICE 候选对上的 RTT，单位毫秒；没有候选对时为 null。 */
  rttMs: number | null;
  /** 会话累计的入站 RTP 丢包数。 */
  packetsLost: number;
  /** 会话累计的入站 RTP 收包数。 */
  packetsReceived: number;
  /** 累计丢包率（0-100），没有任何收包时为 null。 */
  lossPercent: number | null;
  /** 入站 RTP 抖动，单位毫秒。 */
  jitterMs: number | null;
}

const MAX_VISIBLE_ERROR_CODE_LENGTH = 64;
const CLIENT_ERROR_CODE_ALIASES: Record<string, string> = {
  PASSWORD_REQUIRED: "SERVER_PASSWORD_REQUIRED",
  INVALID_PASSWORD: "INVALID_SERVER_PASSWORD",
  AUTHENTICATION_FAILED: "INVALID_SERVER_PASSWORD",
  GATEWAY_FULL: "SERVER_REJECTED",
  TS_CONNECT_FAILED: "CONNECTION_FAILED",
  TEAM_SPEAK_CONNECT_FAILED: "CONNECTION_FAILED",
};

/** Keep codes useful to the user without allowing an unbounded server value into the UI. */
function safeClientErrorCode(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, MAX_VISIBLE_ERROR_CODE_LENGTH);
}

function normalizedClientErrorCode(value: unknown, fallback = "CONNECTION_FAILED"): string {
  const safe = safeClientErrorCode(value);
  return CLIENT_ERROR_CODE_ALIASES[safe] ?? (safe || fallback);
}

function safeClientErrorDetail(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// TeamSpeak 对非法昵称没有独立错误码：长度违规统一报 invalid parameter size
// （服务器错误 id 1541），该特征串是网关能转发的唯一机器可读线索，因此把匹配器
// 与解释文案放在一起，保证两者同步演进。
/**
 * TeamSpeak has no dedicated error for a nickname it refuses: a nickname outside
 * its length rules is answered with "invalid parameter size" and server error id
 * 1541. That signature is the only machine-readable hint the gateway can forward,
 * so keep the matcher next to the message builder that explains it to the user.
 */
const NICKNAME_LENGTH_SIGNATURE = /invalid[\s_-]*parameter[\s_-]*size|\bid[\s=:]*1541\b|nickname.{0,30}(?:length|size)/i;

/** Shown whenever TeamSpeak refuses the nickname because of its length. */
const NICKNAME_LENGTH_MESSAGE = "昵称长度不符合 TeamSpeak 服务器要求，至少 3 个字符，请修改后重试";

/**
 * TS3 对昵称的硬性要求：至少 3 个**字符**。
 *
 * 注意是字符不是字节 —— `奶龙` 是 6 个字节但只有 2 个字符，照样被拒。
 * 必须在前端预校验：服务端那边 TS3 会在握手阶段静默丢弃（TS 日志里连一条记录都没有），
 * 网关只能等到自己的内部超时才报错，用户拿到的是「连接超时，请检查网络」——
 * 被带偏到网络上排查，而真实原因只是昵称短了一个字。
 */
/**
 * 成员音量滑块的默认值（0..4，即 0%..400%）。
 *
 * 200% 而不是 100%：TeamSpeak 侧的语音通常偏轻，默认给一档增益，用户不用每进一个
 * 房间都手动拉。上限仍然是 400%，单个人可以再往上调。注意这是**增益**，遇到本来
 * 就录得很响的人会削波 —— 那种情况用户会自己往下拉。
 *
 * 所有读取成员音量的地方都必须用这个常量，否则会出现「滑块显示 200%、实际播放按
 * 100%」这种默认值漂移。
 */
export const DEFAULT_MEMBER_VOLUME = 2;

const MIN_NICKNAME_CHARACTERS = 3;

/** 连接阶段「正在连接…」的兜底上限。见 armConnectWatchdog。 */
const CONNECT_WATCHDOG_MS = 25_000;
const CONNECT_WATCHDOG_MESSAGE = "连接超时：服务器在 25 秒内没有响应，请重试";

/**
 * How long the join-ticket request may take before it is aborted.
 *
 * Kept well below CONNECT_WATCHDOG_MS so a stalled request produces its own,
 * precise error instead of racing the watchdog: the request used to have no
 * timeout at all, so a slow gateway tripped the watchdog first and then still
 * opened the socket once the fetch finally resolved.
 */
const JOIN_TICKET_TIMEOUT_MS = 15_000;

/**
 * Upper bound on a reconnect wait.
 *
 * The gateway retries a dropped TeamSpeak transport for 5 minutes and then sends
 * reconnectFailed (RECONNECT_WINDOW_MS in src/server/reconnect-policy.ts), so
 * this only fires when the gateway never answers at all — its TeamSpeak
 * connect() hanging, or a half-open socket the browser never sees close. Without
 * it the UI sits on "reconnecting" indefinitely: the initial connect has a
 * watchdog, the reconnect path had none.
 */
const RECONNECT_WATCHDOG_MS = 6 * 60_000;

/**
 * Browsers only hand out a DOMException name for getUserMedia failures (and an
 * often-English message that used to reach the UI verbatim). Map every name the
 * browsers actually raise to a sentence the user can act on, and keep the
 * DOMException name as the stable failure code.
 */
const MICROPHONE_FAILURE_REASONS: Record<string, string> = {
  NOTALLOWEDERROR: "浏览器未授予麦克风权限",
  PERMISSIONDENIEDERROR: "浏览器未授予麦克风权限",
  PERMISSION_DISMISSED: "浏览器未授予麦克风权限",
  SECURITYERROR: "浏览器阻止了麦克风访问",
  NOTFOUNDERROR: "未找到可用的麦克风",
  DEVICESNOTFOUNDERROR: "未找到可用的麦克风",
  OVERCONSTRAINEDERROR: "所选麦克风当前不可用",
  NOTREADABLEERROR: "麦克风可能正被其他程序占用",
  TRACKSTARTERROR: "麦克风可能正被其他程序占用",
  ABORTERROR: "麦克风启动被中断，请重试",
  INVALIDSTATEERROR: "麦克风启动被中断，请重试",
  TYPEFERROR: "麦克风访问参数被系统拒绝",
};

const MICROPHONE_FAILURE_FALLBACK = "麦克风不可用，请检查浏览器权限与音频设备";

const MICROPHONE_FAILURE_CODE_PREFIX = "MIC_";

/** Turn a getUserMedia / DOMException failure into a stable code plus a readable sentence. */
export function normalizeMicrophoneFailure(error: unknown): { code: string; message: string } {
  const rawName = error instanceof Error ? String(error.name || "") : "";
  const name = safeClientErrorCode(rawName).slice(0, 40);
  const reason = MICROPHONE_FAILURE_REASONS[name] ?? MICROPHONE_FAILURE_FALLBACK;
  return { code: `${MICROPHONE_FAILURE_CODE_PREFIX}${name || "UNAVAILABLE"}`, message: `麦克风访问失败：${reason}` };
}

/**
 * Every code this client can render for a failed connection. A code is regarded
 * as "explainable" only when it appears here, which is also what keeps the
 * gateway close codes from being replaced by an unknown close reason.
 */
const CONNECTION_FAILURE_MESSAGES: Record<string, string> = {
  ORIGIN_REJECTED: "请求来源不受信任，请从正确的网站入口重新打开",
  NOT_INITIALIZED: "WebSpeak 尚未完成配置，请联系管理员",
  RATE_LIMITED: "请求过于频繁，请稍后重试",
  INVALID_TARGET: "TeamSpeak 服务器地址无效",
  INVALID_NICKNAME: NICKNAME_LENGTH_MESSAGE,
  HOST_NOT_FOUND: "找不到 TeamSpeak 服务器主机名，请检查地址",
  UNREACHABLE: "无法到达 TeamSpeak 服务器，请检查网络或地址",
  CONNECTION_REFUSED: "TeamSpeak 服务器拒绝了连接，请检查端口和服务状态",
  CONNECTION_RESET: "TeamSpeak 连接被服务器或网络重置，请稍后重试",
  TIMEOUT: "连接 TeamSpeak 超时，请检查网络或服务器状态",
  // 服务器接了连接但不完成握手。网关和 TS 同机，所以这几乎不可能是"网络问题"，
  // 更常见的是服务器拒绝了我们发去的参数（首要是昵称）或者正在限流。
  HANDSHAKE_TIMEOUT: "TeamSpeak 服务器接受了连接但没有完成握手：常见原因是昵称不符合服务器要求（3-30 个字符），或服务器正在限流。请更换昵称或稍后重试",
  SERVER_PASSWORD_REQUIRED: "该服务器需要密码，请输入密码后重试",
  INVALID_SERVER_PASSWORD: "服务器密码错误，请重新输入",
  PROTOCOL_NEGOTIATION_FAILED: "TeamSpeak 协议协商失败",
  SERVER_REJECTED: "TeamSpeak 服务器拒绝了连接",
  CHANNEL_PASSWORD_REQUIRED: "该频道需要密码",
  NICKNAME_IN_USE: "该昵称已被服务器上的其他用户占用，请更换昵称",
  IDENTITY_SECURITY_LEVEL_TOO_LOW: "你的身份安全等级低于该服务器要求，请提升后重试",
  IDENTITY_LIMIT_REACHED: "该身份建立的连接数已达上限，请关闭其他连接后重试",
  CLIENT_VERSION_OUTDATED: "客户端版本过旧，服务器拒绝连接，请升级后重试",
  FLOOD_PROTECTION: "操作过于频繁，已被服务器洪水防护暂时拒绝，请稍后重试",
  BANNED: "你已被该服务器封禁，无法连接",
  KICKED: "你已被服务器移出",
  SERVER_SHUTTING_DOWN: "TeamSpeak 服务器正在关闭，暂时无法连接",
  CONNECTION_INITIALISATION_FAILED: "TeamSpeak 服务器未能完成连接初始化，请检查地址、端口或稍后重试",
  SERVER_FULL: "服务器当前已满，请稍后重试",
  INVALID_PARAMETER: "TeamSpeak 服务器拒绝了参数，通常是昵称长度或格式不合规",
  IDENTITY_IN_USE: "此 TeamSpeak 身份已在另一个浏览器页面使用，请关闭另一条连接或取消“保持身份”后重试",
  CONNECTION_FAILED: "TeamSpeak 连接失败，请检查地址、网络或服务器状态",
  // Gateway close codes: these replace the generic "connection failed" when the
  // gateway drops the socket itself (see GATEWAY_CLOSE_CODE_CODES).
  JOIN_TICKET_REQUIRED: "语音会话票据缺失或已过期，请返回列表重新进入语音空间",
  IDENTITY_INVALID: "语音网关拒绝了本次连接：身份无效，请取消“保持身份”后重新进入",
  IDENTITY_REJECTED: "语音网关拒绝了本次连接：身份无效或无法在此页面使用，请取消“保持身份”后重新进入",
  ACCELERATION_UNAVAILABLE: "当前中继加速不可用，请关闭加速后重试或联系管理员",
  GATEWAY_NETWORK_LOST: "与语音网关的网络连接异常中断（掉线或代理断开），并非 TeamSpeak 服务器拒绝连接，请检查网络后重新进入",
  GATEWAY_SESSION_ENDED: "语音网关会话意外结束，请重新进入语音空间",
  TEAM_SPEAK_CLIENT_UNAVAILABLE: "语音网关未能创建 TeamSpeak 客户端（服务器可能已关闭或地址不可达），请确认服务器地址或稍后重试",
  // 客户端侧的超时（与网关给出的失败区分开：这些不是 TeamSpeak 拒绝，而是本次
  // 尝试根本没走完）。
  REQUEST_TIMEOUT: "向语音网关申请会话票据超时，请检查网络后重试",
  RECONNECT_TIMEOUT: "重连语音网关超时：网关长时间没有响应，请重新进入语音空间",
  // 网关以 1000（正常关闭）拆掉会话时，原因在关闭帧的 reason 里。见 onclose。
  SESSION_TERMINATED_BY_ADMIN: "管理员已结束你的语音会话",
  GATEWAY_SHUTTING_DOWN: "语音网关正在重启，请稍后重新进入语音空间",
  GATEWAY_HEARTBEAT_LOST: "与语音网关的连接已失去响应，请重新进入语音空间",
};

/**
 * 刷新后自动回到房间用的会话记录。
 *
 * 放在 **sessionStorage**（不是 localStorage）是有意的：sessionStorage 按标签页隔离
 * 且刷新保留、关标签页清除。所以「刷新」会拿到记录 → 自动重连；「新开一个标签页」
 * 拿不到记录 → 走正常的加入流程，不会去抢同一个 TS 身份。
 *
 * 记录只在**显式离开**或**服务端明确判死**时清除（见 clearActiveSession 的调用点），
 * 所以刷新时它还在 —— 这正是恢复的依据。
 */
interface ActiveSessionRecord {
  target: string;
  channel: string;
  nickname: string;
  serverPassword: string;
  identity?: string;
  rememberIdentity: boolean;
  accelerated: boolean;
  accelerationRelayId: string;
  /** 真正连上过才算「可恢复」：只发起过连接就刷新，不应该自动重连。 */
  established: boolean;
}

const ACTIVE_SESSION_KEY = "webspeak:active-session";

function writeActiveSession(record: ActiveSessionRecord): void {
  try {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(record));
  } catch {
    // 隐私模式或配额满：刷新恢复不可用，但不该影响正常连接。
  }
}

function clearActiveSession(): void {
  try {
    sessionStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // 同上：清理失败不是错误。
  }
}

function readActiveSession(): ActiveSessionRecord | null {
  let parsed: unknown;
  try {
    const raw = sessionStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Partial<ActiveSessionRecord>;
  if (typeof record.target !== "string" || !record.target.trim()) return null;
  if (typeof record.nickname !== "string" || !record.nickname.trim()) return null;
  return {
    target: record.target,
    channel: typeof record.channel === "string" ? record.channel : "",
    nickname: record.nickname,
    serverPassword: typeof record.serverPassword === "string" ? record.serverPassword : "",
    ...(typeof record.identity === "string" ? { identity: record.identity } : {}),
    rememberIdentity: record.rememberIdentity === true,
    accelerated: record.accelerated === true,
    accelerationRelayId: typeof record.accelerationRelayId === "string" ? record.accelerationRelayId : "",
    established: record.established === true,
  };
}

export function useVoiceWebSocket() {
  const ws = ref<WebSocket | null>(null);
  const state = reactive<VoiceState>({ connected: false, connecting: false, reconnecting: false, reconnectAttempt: 0, reconnectFailed: false, tsClientId: 0, error: "", errorCode: "", microphoneError: "", microphoneErrorCode: "", audioNotice: "", audioNoticeCode: "", channelSwitchedChannelId: "" });
  const members = reactive<ChannelMember[]>([]);
  const channels = reactive<ChannelInfo[]>([]);
  const chatMessages = reactive<ChatMessage[]>([]);
  const serverEvents = reactive<ServerEvent[]>([]);
  const pokeNotifications = reactive<{ id: string; invokerId: number; invokerUid: string; invokerName: string; message: string; timestamp: number }[]>([]);
  let connectionSequence = 0;
  let lastConnection: { target: string; channel: string; nickname: string; serverPassword: string; identity?: string; rememberIdentity: boolean; accelerated: boolean; accelerationRelayId: string } | null = null;
  let latencyProbeSequence = 0;
  const pendingLatencyProbes = new Map<string, { startedAt: number; resolve: (result: LatencyProbeResult | null) => void; timer: ReturnType<typeof setTimeout> }>();
  let commandSequence = 0;
  const pendingCommands = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let channelInfoSequence = 0;
  const pendingChannelInfos = new Map<string, { resolve: (details: ChannelInfoDetails | null) => void; timer: ReturnType<typeof setTimeout> }>();
  // 频道说明几乎不变（只有管理员改频道时才会动），按 cid 缓存，切回同一频道不再请求。
  // 会话结束/重置时清空，避免把 A 服务器的 cid 说明显示到 B 服务器。
  const channelInfos = reactive<Record<string, ChannelInfoDetails>>({});
  let webrtcPeer: RTCPeerConnection | null = null;
  // SFU：每个 slot 一个播放节点，slot 归属由服务端的 speakerMap 消息驱动。
  // 不再有"单个混音流"的概念 —— 说话人各自一路，浏览器侧做音量与活动检测。
  const sfuSlotNodes = new Map<number, SfuSlotNode>();
  const sfuSlotByTransceiver = new Map<RTCRtpTransceiver, number>();
  let sfuActivityTimer: ReturnType<typeof setInterval> | null = null;
  // 最近一次服务端下发的 slot → clientId 映射。
  // 必须缓存：服务端在 answer 之后就可能开始转发并下发 speakerMap，而浏览器要等
  // setRemoteDescription 完成才触发 ontrack。若 speakerMap 先到，建节点时就得
  // 用它回填，否则 slot 永远绑不上成员。
  let lastSpeakerMap: Record<string, number> = {};
  /** 诊断用：最近收到的服务端消息类型。 */
  const recentMessageTypes: string[] = [];
  const webrtcSlotCount = ref(DEFAULT_WEBRTC_SLOT_COUNT);
  let webrtcPlaybackRetryCleanup: (() => void) | null = null;
  let webrtcNegotiationPromise: Promise<void> | null = null;
  let webrtcFallbackStarted = false;
  const webrtcActive = ref(false);
  const identityMaterial = ref("");
  const storedVolumesByUid = reactive<Record<string, number>>({});
  let microphoneStartPromise: Promise<void> | null = null;

  // WebRTC carries audio when the gateway advertises it. The bounded PCM
  // WebSocket path remains the compatibility fallback for older browsers and
  // for deployments where the gateway's built-in UDP media range is unavailable.
  let audioCtx: SinkAudioContext | null = null;
  let micStream: MediaStream | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let workletContext: AudioContext | null = null;
  let workletModulePromise: Promise<void> | null = null;
  let rnnoiseNode: RnnoiseWorkletNode | null = null;
  let rnnoiseWorkletModulePromise: Promise<void> | null = null;
  let rnnoiseWasmPromise: Promise<ArrayBuffer> | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let micGain: GainNode | null = null;
  let silentGain: GainNode | null = null;
  let processedMicDestination: MediaStreamAudioDestinationNode | null = null;
  const accompanimentActive = ref(false);
  const accompanimentSupported = ref(typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia));
  const accompanimentErrorCode = ref<"" | "unsupported" | "needsWebRtc" | "noAudio" | "permission">("");
  let accompanimentStream: MediaStream | null = null;
  const screenShareStreams = reactive<ScreenShareStream[]>([]);
  const screenShareActive = ref(false);
  const screenShareStarting = ref(false);
  const screenShareActiveStreamId = ref("");
  const screenShareViewing = ref(false);
  const screenShareViewingStreamId = ref("");
  const screenShareRemoteStream = ref<MediaStream | null>(null);
  const screenShareError = ref("");
  const screenShareErrorCode = ref("");
  const screenShareRemoteVolume = ref(1);
  let screenShareLocalStream: MediaStream | null = null;
  const screenSharePeers = new Map<string, RTCPeerConnection>();
  const screenSharePeerRoles = new Map<string, "owner" | "viewer">();
  const screenShareWebRtcStats = reactive<ScreenShareWebRtcStats>({ updatedAt: null, capture: null, peers: [] });
  const screenShareStatsPrevious = new Map<string, { sampledAt: number; bytes: number | null; frames: number | null }>();
  let screenShareStatsTimer: ReturnType<typeof setInterval> | null = null;
  let screenShareStatsCollecting = false;
  const screenSharePendingIce = new Map<string, RTCIceCandidateInit[]>();
  const screenSharePeerStreams = new Map<string, MediaStream>();
  const screenSharePeerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let screenShareRequestSequence = 0;
  let screenSharePendingStartId = "";
  let screenShareStartCancelled = false;
  let screenShareStartGeneration = 0;
  let webrtcMixDestination: MediaStreamAudioDestinationNode | null = null;
  let webrtcMixMicSource: MediaStreamAudioSourceNode | null = null;
  let webrtcMixMicGain: GainNode | null = null;
  let webrtcMixAccompanimentSource: MediaStreamAudioSourceNode | null = null;
  let webrtcMicMonitorSource: MediaStreamAudioSourceNode | null = null;
  let webrtcMicMonitorAnalyser: AnalyserNode | null = null;
  let webrtcMicMonitorGain: GainNode | null = null;
  let webrtcMicMonitorTimer: ReturnType<typeof setInterval> | null = null;
  const inputDevices = reactive<AudioInputDevice[]>([]);
  const outputDevices = reactive<AudioOutputDevice[]>([]);
  const selectedInputDeviceId = ref(typeof localStorage !== "undefined" ? localStorage.getItem("webspeak:input-device") ?? "" : "");
  const selectedOutputDeviceId = ref(typeof localStorage !== "undefined" ? localStorage.getItem("webspeak:output-device") ?? "" : "");
  const outputDeviceSupported = ref(false);
  const audioPermission = ref<AudioPermission>("unknown");
  const microphoneProcessing = reactive<MicrophoneProcessingSettings>({
    echoCancellation: null,
    noiseSuppression: null,
    autoGainControl: null,
    rnnoise: null,
  });
  const audioContextState = ref<AudioContextState | "unknown">("unknown");
  const micLevel = ref(0);
  const microphoneTestActive = ref(false);
  const testAudioUrl = ref("");
  let testRecorder: MediaRecorder | null = null;
  let testRecorderTimer: ReturnType<typeof setTimeout> | null = null;
  const microphoneMuted = ref(false);
  const noiseSuppressionEnabled = ref(true);
  const inputVolume = ref(1);
  const outputVolume = ref(1);
  const outputMuted = ref(false);
  const notificationVolume = ref(0.5);
  const voxThreshold = ref(0.008);
  let voxAttack = 0;
  let voxRelease = 0;
  const VOX_HOLD = 15;
  const VOX_ATTACK_FRAMES = 1;
  let convBuf = new Int16Array(1024);
  let accumBuf = new Int16Array(2048);
  let accumLen = 0;

  // Playback is kept per client so frames from multiple speakers cannot
  // interleave into one decoder or one scheduling queue.
  const remoteDecoders = new Map<number, AudioDecoder>();
  const remoteDecoderGenerations = new Map<number, number>();
  let nextRemoteDecoderGeneration = 0;
  const remotePlayTimes = new Map<number, number>();
  const remotePlaybackSources = new Map<number, Set<AudioBufferSourceNode>>();
  const remoteGains = new Map<number, GainNode>();
  const remoteDecodeTimestamps = new Map<number, number>();
  const volumes = reactive<Record<number, number>>({});
  const speakingIds = reactive(new Set<number>());
  const whisperTargetIds = reactive(new Set<number>());
  const whisperActive = ref(false);
  const speakingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const SPEAKING_HOLD_MS = 360;
  const AUDIO_FRAME_SAMPLES = 960;
  const AUDIO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * 2;
  const MAX_AUDIO_BUFFERED_FRAMES = 10;
  const MAX_AUDIO_BUFFERED_BYTES = AUDIO_FRAME_BYTES * MAX_AUDIO_BUFFERED_FRAMES;
  // Keep the WebSocket playback buffer below the 100 ms latency target. A
  // 20 ms frame plus three queued decoder frames leaves only a short cushion
  // for jitter; stale audio is discarded instead of being played late.
  const MAX_REMOTE_PLAY_AHEAD_SECONDS = 0.08;
  const MAX_REMOTE_DECODE_QUEUE_FRAMES = 3;

  async function saveAudioPreferences(): Promise<void> {
    await saveLocalPreferences({
      schemaVersion: 1,
      preferredInputDeviceId: selectedInputDeviceId.value,
      inputDeviceId: selectedInputDeviceId.value,
      microphoneMuted: microphoneMuted.value,
      noiseSuppressionEnabled: noiseSuppressionEnabled.value,
      voxThreshold: voxThreshold.value,
      inputGain: inputVolume.value,
      outputVolume: outputVolume.value,
      notificationVolume: notificationVolume.value,
      preferredOutputDeviceId: selectedOutputDeviceId.value,
      volumesByUid: { ...storedVolumesByUid },
    });
  }

  function syncKnownMemberVolumes(): void {
    for (const member of members) {
      if (!member.uid) continue;
      const saved = storedVolumesByUid[member.uid];
      if (saved !== undefined) volumes[member.id] = Math.max(0, Math.min(4, saved));
    }
  }

  const audioPreferencesReady = loadLocalPreferences().then((preferences) => {
    if (!selectedInputDeviceId.value) selectedInputDeviceId.value = preferences.preferredInputDeviceId ?? preferences.inputDeviceId ?? "";
    if (typeof preferences.microphoneMuted === "boolean") microphoneMuted.value = preferences.microphoneMuted;
    if (typeof preferences.noiseSuppressionEnabled === "boolean") noiseSuppressionEnabled.value = preferences.noiseSuppressionEnabled;
    if (typeof preferences.voxThreshold === "number") voxThreshold.value = clamp(preferences.voxThreshold, 0.001, 0.08);
    if (typeof preferences.inputGain === "number") inputVolume.value = Math.max(0, Math.min(1, preferences.inputGain));
    if (typeof preferences.outputVolume === "number") outputVolume.value = Math.max(0, Math.min(1, preferences.outputVolume));
    if (!selectedOutputDeviceId.value) selectedOutputDeviceId.value = preferences.preferredOutputDeviceId ?? "";
    if (typeof preferences.notificationVolume === "number") notificationVolume.value = clamp(preferences.notificationVolume, 0, 1);
    Object.assign(storedVolumesByUid, preferences.volumesByUid ?? {});
    syncKnownMemberVolumes();
  });

  function markSpeaking(clientId: number): void {
    if (!clientId) return;
    speakingIds.add(clientId);
    const previous = speakingTimers.get(clientId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      speakingIds.delete(clientId);
      speakingTimers.delete(clientId);
    }, SPEAKING_HOLD_MS);
    speakingTimers.set(clientId, timer);
  }

  function clearSpeaking(clientId: number): void {
    const timer = speakingTimers.get(clientId);
    if (timer) clearTimeout(timer);
    speakingTimers.delete(clientId);
    speakingIds.delete(clientId);
  }

  function clearSpeakingState(): void {
    for (const timer of speakingTimers.values()) clearTimeout(timer);
    speakingTimers.clear();
    speakingIds.clear();
  }

  function effectiveOutputVolume(): number {
    return outputMuted.value ? 0 : outputVolume.value;
  }

  function applyOutputVolume(): void {
    const level = effectiveOutputVolume();
    for (const [clientId, gain] of remoteGains) gain.gain.value = (volumes[clientId] ?? DEFAULT_MEMBER_VOLUME) * level;
    syncSfuVolumes();
  }

  function getAudioCtx(): SinkAudioContext {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: 48000 }) as SinkAudioContext;
      audioContextState.value = audioCtx.state;
      audioCtx.addEventListener("statechange", () => {
        if (audioCtx) audioContextState.value = audioCtx.state;
      });
      outputDeviceSupported.value = typeof audioCtx.setSinkId === "function"
        || typeof (HTMLMediaElement.prototype as SinkAudioElement).setSinkId === "function";
      if (selectedOutputDeviceId.value && outputDeviceSupported.value) {
        void setAudioSink(audioCtx, selectedOutputDeviceId.value).catch(() => undefined);
      }
    }
    return audioCtx;
  }

  function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
  }

  /**
   * Microphone failures are a degraded state, not a connection failure: the room
   * stays joined, so they get their own slot instead of taking over `error`.
   */
  function setMicrophoneError(error: unknown): string {
    const failure = normalizeMicrophoneFailure(error);
    state.microphoneErrorCode = failure.code;
    state.microphoneError = failure.message;
    return failure.message;
  }

  function clearMicrophoneError(): void {
    state.microphoneError = "";
    state.microphoneErrorCode = "";
  }

  /** Non-fatal audio notice (WebRTC fallback, blocked autoplay, device list failure...). */
  function setAudioNotice(code: string, message: string): void {
    state.audioNoticeCode = safeClientErrorCode(code) || "AUDIO_NOTICE";
    state.audioNotice = message;
  }

  function clearAudioNotice(code?: string): void {
    if (code && state.audioNoticeCode !== safeClientErrorCode(code)) return;
    state.audioNotice = "";
    state.audioNoticeCode = "";
  }

  /** A suspended AudioContext silently swallows capture: say so instead of pretending. */
  function syncAudioContextNotice(): void {
    if (audioCtx && audioCtx.state === "suspended") {
      setAudioNotice("AUDIO_CONTEXT_SUSPENDED", "浏览器的音频处理被暂停（需要一次页面交互），麦克风与扬声器可能无声：请点击页面任意位置后重试");
    } else {
      clearAudioNotice("AUDIO_CONTEXT_SUSPENDED");
    }
  }

  function audioNoticeMessage(code: string, detail?: unknown): string {
    const detailText = safeClientErrorDetail(detail);
    if (code === "AUDIO_ENCODER_UNAVAILABLE") {
      return `麦克风声音未能发送：语音网关的音频编码器不可用（错误代码：${code}）${detailText ? `：${detailText}` : ""}，请联系管理员`;
    }
    return `音频链路异常（错误代码：${code}）${detailText ? `：${detailText}` : ""}，麦克风声音可能没有发送给其他成员`;
  }

  async function setAudioSink(ctx: SinkAudioContext, deviceId: string): Promise<void> {
    const mediaSinkSupported = typeof (HTMLMediaElement.prototype as SinkAudioElement).setSinkId === "function";
    if (!ctx.setSinkId && !mediaSinkSupported) {
      outputDeviceSupported.value = false;
      if (deviceId) throw new Error("当前浏览器不支持扬声器设备选择，将使用默认输出设备");
      return;
    }
    outputDeviceSupported.value = true;
    if (ctx.setSinkId) await ctx.setSinkId(deviceId || "default");
  }

  function checkSupport(): string | null {
    if (typeof window === "undefined") return null;
    if (!window.isSecureContext) return "语音功能需要 HTTPS 安全连接";
    if (!navigator.mediaDevices?.getUserMedia) return "当前浏览器不支持麦克风访问";
    if (typeof AudioContext === "undefined") return "当前浏览器不支持 Web Audio 音频处理";
    // 这里刻意**不**要求 WebCodecs（AudioDecoder）。
    // 只有兼容（WS）通道需要它 —— 服务端发来的 Opus 得靠 AudioDecoder 解成 PCM
    // 才能播；WebRTC 通道下 Opus 由浏览器原生解码器在 NetEq 里解，完全不碰 WebCodecs。
    // 放在这里当硬门槛，会把缺 WebCodecs 的浏览器（较老的 Safari、部分 Firefox /
    // WebView）整个挡在门外，哪怕 WebRTC 路径完全可用。
    // 真正的判定放在"要走兼容通道"的那一刻，见 compatibilityPlaybackUnavailable()。
    return null;
  }

  /**
   * 兼容（WS）通道能不能出声。
   *
   * 它靠 WebCodecs 的 AudioDecoder 把服务端发来的 Opus 解成 PCM。缺这个能力时
   * 上行仍然可用（麦克风由服务端编码），但用户听不到任何人 —— 必须在降级的那一刻
   * 明确告知，而不是让他自己猜"是不是没人在说话"。
   */
  function compatibilityPlaybackUnavailable(): boolean {
    return typeof AudioDecoder === "undefined";
  }

  const COMPATIBILITY_PLAYBACK_NOTICE = "当前浏览器缺少音频解码能力（WebCodecs），兼容传输下你将听不到其他人的声音；请更新浏览器后重试";

  function microphoneConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      sampleRate: { ideal: 48000 },
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: noiseSuppressionEnabled.value,
      // Keep the microphone's natural dynamics. Browser AGC can make speech
      // pump in volume, especially while background noise changes.
      autoGainControl: false,
    };
    if (selectedInputDeviceId.value) constraints.deviceId = { exact: selectedInputDeviceId.value };
    return constraints;
  }

  async function refreshAudioDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      inputDevices.length = 0;
      outputDevices.length = 0;
      setAudioNotice("DEVICE_LIST_UNAVAILABLE", "无法读取音频设备列表，将使用浏览器默认音频设备：请在系统或浏览器隐私设置中允许读取设备信息");
      return;
    }
    let devices: MediaDeviceInfo[];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
      clearAudioNotice("DEVICE_LIST_UNAVAILABLE");
    } catch {
      // enumerateDevices rejects when the device list is blocked (for example in a
      // locked-down iframe). Use the browser defaults and explain the limitation.
      inputDevices.length = 0;
      outputDevices.length = 0;
      setAudioNotice("DEVICE_LIST_UNAVAILABLE", "无法读取音频设备列表，将使用浏览器默认音频设备：请在系统或浏览器隐私设置中允许读取设备信息");
      return;
    }
    const microphones = devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({ deviceId: device.deviceId, label: device.label, groupId: device.groupId }));
    const speakers = devices
      .filter((device) => device.kind === "audiooutput")
      .map((device) => ({ deviceId: device.deviceId, label: device.label, groupId: device.groupId }));
    inputDevices.splice(0, inputDevices.length, ...microphones);
    outputDevices.splice(0, outputDevices.length, ...speakers);
    if (selectedInputDeviceId.value && !microphones.some((device) => device.deviceId === selectedInputDeviceId.value)) {
      selectedInputDeviceId.value = "";
      localStorage.setItem("webspeak:input-device", selectedInputDeviceId.value);
      void saveAudioPreferences();
      if (micStream) void startMicrophone().catch(() => undefined);
    }
    if (selectedOutputDeviceId.value && !speakers.some((device) => device.deviceId === selectedOutputDeviceId.value)) {
      selectedOutputDeviceId.value = "";
      localStorage.setItem("webspeak:output-device", "");
      void saveAudioPreferences();
      if (audioCtx && outputDeviceSupported.value) void setAudioSink(audioCtx, "").catch(() => undefined);
    }
  }

  async function refreshInputDevices(): Promise<void> {
    await refreshAudioDevices();
  }

  async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode | null> {
    if (typeof AudioWorkletNode === "undefined" || !ctx.audioWorklet) {
      microphoneProcessing.rnnoise = false;
      return null;
    }
    try {
      if (!rnnoiseWasmPromise) {
        rnnoiseWasmPromise = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((error) => {
          rnnoiseWasmPromise = null;
          throw error;
        });
      }
      if (!rnnoiseWorkletModulePromise) {
        rnnoiseWorkletModulePromise = ctx.audioWorklet.addModule(rnnoiseWorkletUrl).catch((error) => {
          rnnoiseWorkletModulePromise = null;
          throw error;
        });
      }
      const [wasmBinary] = await Promise.all([rnnoiseWasmPromise, rnnoiseWorkletModulePromise]);
      const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
      microphoneProcessing.rnnoise = true;
      return node;
    } catch {
      // Native browser NS remains active as a fallback. RNNoise is an optional
      // enhancement and must never prevent a microphone from starting.
      microphoneProcessing.rnnoise = false;
      return null;
    }
  }

  async function startMicrophone(): Promise<void> {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* the audio context notice explains the silence */ }
    }
    // Acquire the replacement stream before tearing down the current graph so
    // changing devices does not interrupt an active microphone on failure.
    let nextStream: MediaStream;
    try {
      nextStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
      audioPermission.value = "granted";
      clearMicrophoneError();
    } catch (error) {
      if (error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)) audioPermission.value = "denied";
      // Never let the raw DOMException (usually an English message) reach the UI:
      // record a readable failure first, then let the caller decide how to show it.
      setMicrophoneError(error);
      throw error;
    }
    const microphoneTrack = nextStream.getAudioTracks()[0];
    const settings = microphoneTrack?.getSettings();
    microphoneProcessing.echoCancellation = typeof settings?.echoCancellation === "boolean" ? settings.echoCancellation : null;
    microphoneProcessing.noiseSuppression = typeof settings?.noiseSuppression === "boolean" ? settings.noiseSuppression : null;
    microphoneProcessing.autoGainControl = typeof settings?.autoGainControl === "boolean" ? settings.autoGainControl : null;
    stopMicrophone(false);
    micStream = nextStream;

    micSource = ctx.createMediaStreamSource(micStream);
    rnnoiseNode = noiseSuppressionEnabled.value ? await createRnnoiseNode(ctx) : null;
    if (!noiseSuppressionEnabled.value) microphoneProcessing.rnnoise = false;
    const processedSource: AudioNode = rnnoiseNode ?? micSource;
    if (rnnoiseNode) micSource.connect(rnnoiseNode);
    processedMicDestination = ctx.createMediaStreamDestination();
    processedMicDestination.channelCount = 1;
    processedMicDestination.channelCountMode = "explicit";
    processedSource.connect(processedMicDestination);
    micGain = ctx.createGain();
    micGain.gain.value = inputVolume.value;
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    const handleCaptureChunk = (input: Float32Array, rms?: number): void => {
      if (!input.length) return;
      micLevel.value = Math.min(1, (rms ?? Math.sqrt(input.reduce((sum, sample) => sum + sample * sample, 0) / input.length)) * 6);
      const socket = ws.value;
      const shouldSend = !microphoneMuted.value
        && !microphoneTestActive.value
        && !webrtcActive.value
        && socket?.readyState === WebSocket.OPEN
        && voxGate(input);
      if (!shouldSend) {
        accumLen = 0;
        if (microphoneMuted.value) {
          voxAttack = 0;
          voxRelease = 0;
        }
        return;
      }
      if (!socket) {
        accumLen = 0;
        return;
      }
      const bufferedBytes = socket.bufferedAmount;
      if (bufferedBytes > MAX_AUDIO_BUFFERED_BYTES) {
        accumLen = 0;
        return;
      }

      if (convBuf.length < input.length) convBuf = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]!));
        convBuf[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      const need = accumLen + input.length;
      if (accumBuf.length < need) accumBuf = new Int16Array(Math.max(need, accumBuf.length * 2));
      accumBuf.set(convBuf.subarray(0, input.length), accumLen);
      accumLen = need;

      let offset = 0;
      while (offset + AUDIO_FRAME_SAMPLES <= accumLen && socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= MAX_AUDIO_BUFFERED_BYTES) {
        socket.send(accumBuf.slice(offset, offset + AUDIO_FRAME_SAMPLES).buffer);
        offset += AUDIO_FRAME_SAMPLES;
      }
      if (offset > 0) markSpeaking(state.tsClientId);
      accumLen -= offset;
      if (offset > 0) accumBuf.set(accumBuf.subarray(offset, offset + accumLen), 0);
    };

    if (typeof AudioWorkletNode !== "undefined" && ctx.audioWorklet) {
      try {
        if (workletContext !== ctx || !workletModulePromise) {
          workletContext = ctx;
          workletModulePromise = ctx.audioWorklet.addModule(micCaptureWorkletUrl);
        }
        await workletModulePromise;
        workletNode = new AudioWorkletNode(ctx, "webspeak-mic-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        workletNode.port.onmessage = (event: MessageEvent<{ samples?: Float32Array; rms?: number }>) => {
          const samples = event.data?.samples;
          if (samples instanceof Float32Array) handleCaptureChunk(samples, event.data.rms);
        };
      } catch {
        workletNode?.disconnect();
        workletNode = null;
        workletContext = null;
        workletModulePromise = null;
      }
    }

    if (!workletNode) {
      scriptNode = ctx.createScriptProcessor(1024, 1, 1);
      scriptNode.onaudioprocess = (event) => handleCaptureChunk(event.inputBuffer.getChannelData(0));
    }

    processedSource.connect(micGain);
    const captureNode = workletNode ?? scriptNode!;
    micGain.connect(captureNode);
    captureNode.connect(silentGain);
    silentGain.connect(ctx.destination);
    await refreshAudioDevices();
    syncAudioContextNotice();
  }

  // 导出给 WebClient：开麦前先 await 此函数完成真实采集，避免出现“假成功”
  async function ensureMicrophone(): Promise<void> {
    if (micStream) return;
    if (!microphoneStartPromise) {
      microphoneStartPromise = startMicrophone().finally(() => {
        microphoneStartPromise = null;
      });
    }
    await microphoneStartPromise;
  }

  function voxGate(samples: Float32Array): boolean {
    let sum = 0;
    const count = Math.min(256, samples.length);
    for (let i = 0; i < count; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / count);
    if (rms >= voxThreshold.value) {
      voxAttack = Math.min(VOX_ATTACK_FRAMES, voxAttack + 1);
      voxRelease = VOX_HOLD;
      return voxAttack >= VOX_ATTACK_FRAMES;
    }
    voxAttack = 0;
    if (voxRelease > 0) {
      voxRelease--;
      return true;
    }
    return false;
  }

  function stopWebRtcMix(): void {
    webrtcMixAccompanimentSource?.disconnect();
    webrtcMixMicSource?.disconnect();
    webrtcMixMicGain?.disconnect();
    webrtcMixDestination?.disconnect();
    webrtcMixAccompanimentSource = null;
    webrtcMixMicSource = null;
    webrtcMixMicGain = null;
    webrtcMixDestination = null;
  }

  function releaseAccompanimentStream(): void {
    accompanimentStream?.getTracks().forEach((track) => track.stop());
    accompanimentStream = null;
    accompanimentActive.value = false;
  }

  function createWebRtcMixStream(): MediaStream {
    const ctx = getAudioCtx();
    stopWebRtcMix();
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    destination.channelCountMode = "explicit";
    // 麦克风是可选的：没有麦克风时这条轨就是纯静音（只有伴奏时才接伴奏）。
    // slot0 仍然按 sendrecv 协商，服务端的 m-line 数量与方向不受影响。
    if (micStream) {
      // Use the browser-native processed track plus the browser-side RNNoise
      // graph. Display/application audio is added separately below and never
      // passes through this microphone denoiser.
      const microphoneStream = processedMicDestination?.stream ?? micStream;
      const microphoneSource = ctx.createMediaStreamSource(microphoneStream);
      const microphoneGain = ctx.createGain();
      microphoneGain.gain.value = microphoneMuted.value ? 0 : inputVolume.value;
      microphoneSource.connect(microphoneGain);
      microphoneGain.connect(destination);
      webrtcMixMicSource = microphoneSource;
      webrtcMixMicGain = microphoneGain;
    }

    webrtcMixDestination = destination;

    const accompanimentTrack = accompanimentStream?.getAudioTracks()[0];
    if (accompanimentTrack) {
      const accompanimentSource = ctx.createMediaStreamSource(accompanimentStream!);
      // Keep the captured application audio at its source level. Do not add
      // a fixed attenuation/gain node: it makes music sound quieter than the
      // source and encourages later "compensation" steps to pump its volume.
      accompanimentSource.connect(destination);
      webrtcMixAccompanimentSource = accompanimentSource;
    }
    return destination.stream;
  }

  async function replaceWebRtcAudioTrack(): Promise<void> {
    if (!webrtcPeer || !micStream) return;
    const sender = webrtcPeer.getSenders().find((candidate) => candidate.track?.kind === "audio");
    if (!sender) throw new Error("WebRTC 音频轨道尚未就绪");
    const mixedStream = createWebRtcMixStream();
    const mixedTrack = mixedStream.getAudioTracks()[0];
    if (!mixedTrack) throw new Error("混合音频轨道创建失败");
    await sender.replaceTrack(mixedTrack);
  }

  async function startAccompaniment(): Promise<void> {
    accompanimentErrorCode.value = "";
    if (!accompanimentSupported.value) {
      accompanimentErrorCode.value = "unsupported";
      throw new Error("伴奏共享不可用");
    }
    if (!webrtcActive.value || !webrtcPeer || !micStream) {
      accompanimentErrorCode.value = "needsWebRtc";
      throw new Error("伴奏功能需要启用 WebRTC");
    }

    const captureProcessingConstraints: MediaTrackConstraints = {
      // Display/application audio must not pass through browser voice
      // processing. Those processors are designed for speech and can change
      // music level from frame to frame (AGC), suppress quiet passages, or
      // cancel sustained tones.
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
    };
    const audioConstraints = { ...captureProcessingConstraints } as MediaTrackConstraints & { restrictOwnAudio?: boolean };
    const supportedConstraints = navigator.mediaDevices.getSupportedConstraints?.() as Record<string, boolean> | undefined;
    if (supportedConstraints?.restrictOwnAudio) audioConstraints.restrictOwnAudio = true;
    const options = {
      video: { displaySurface: "browser" },
      audio: audioConstraints,
      selfBrowserSurface: "exclude",
      systemAudio: "include",
      windowAudio: "window",
    } as unknown as DisplayMediaStreamOptions;

    let nextStream: MediaStream;
    try {
      nextStream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      accompanimentErrorCode.value = "permission";
      throw error;
    }
    const audioTrack = nextStream.getAudioTracks()[0];
    nextStream.getVideoTracks().forEach((track) => track.stop());
    if (!audioTrack) {
      nextStream.getTracks().forEach((track) => track.stop());
      accompanimentErrorCode.value = "noAudio";
      throw new Error("所选来源没有可共享音频");
    }

    try {
      // Do not pass the Chromium-only restrictOwnAudio hint to
      // applyConstraints: rejecting an unknown key could otherwise cause the
      // browser to discard all three standard processing-off constraints.
      await audioTrack.applyConstraints(captureProcessingConstraints);
    } catch {
      // Some browsers expose display audio but reject one or more optional
      // processing constraints. The capture can still proceed without
      // introducing a WebSpeak-side gain stage.
    }
    if ("contentHint" in audioTrack) audioTrack.contentHint = "music";

    accompanimentStream?.getTracks().forEach((track) => track.stop());
    accompanimentStream = nextStream;
    accompanimentActive.value = true;
    sendCmd("setAccompanimentActive", { active: true });
    audioTrack.addEventListener("ended", () => { void stopAccompaniment(); }, { once: true });
    try {
      await replaceWebRtcAudioTrack();
    } catch (error) {
      releaseAccompanimentStream();
      sendCmd("setAccompanimentActive", { active: false });
      stopWebRtcMix();
      accompanimentErrorCode.value = "permission";
      throw error;
    }
  }

  async function stopAccompaniment(): Promise<void> {
    accompanimentErrorCode.value = "";
    releaseAccompanimentStream();
    if (webrtcActive.value) sendCmd("setAccompanimentActive", { active: false });
    if (webrtcActive.value && webrtcPeer && micStream) await replaceWebRtcAudioTrack();
    else stopWebRtcMix();
  }

  async function startWebRtcTransport(sequence: number, socket: WebSocket): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") throw new Error("当前浏览器不支持 WebRTC");
    // 麦克风尽力而为：拿不到也继续协商（slot0 发静音）。否则"只想听"的用户
    // （例如只听音乐机器人）会因为麦克风被拒、没有设备或非安全上下文被迫退回
    // 兼容传输 —— 那条路径的过期音频丢弃策略对连续音频明显更差，音乐听起来
    // 就是一断一续。
    try {
      await ensureMicrophone();
    } catch {
      // startMicrophone 已记录 microphoneError，界面照旧提示；
      // 这里只降级成"没有上行"，不影响下行实时音频。
    }
    if (sequence !== connectionSequence || socket.readyState !== WebSocket.OPEN) return;
    const microphoneTrack = micStream?.getAudioTracks()[0] ?? null;

    stopCaptureGraph();
    const peer = new RTCPeerConnection({ iceServers: activeIceServers });
    webrtcPeer = peer;
    webrtcFallbackStarted = false;
    if (microphoneTrack) microphoneTrack.enabled = !microphoneMuted.value;
    const mixedStream = createWebRtcMixStream();
    const mixedTrack = mixedStream.getAudioTracks()[0];
    if (!mixedTrack) throw new Error("混合音频轨道创建失败");
    // SFU：一次性谈好 K 条 audio m-line。slot0 承载上行麦克风 + 一路下行，
    // 其余只收。说话人进出只改变 slot 归属，不触发重协商。
    const slotCount = webrtcSlotCount.value;
    sfuSlotByTransceiver.clear();
    for (let slot = 0; slot < slotCount; slot++) {
      const transceiver = slot === 0
        ? peer.addTransceiver(mixedTrack, { direction: "sendrecv" })
        : peer.addTransceiver("audio", { direction: "recvonly" });
      sfuSlotByTransceiver.set(transceiver, slot);
    }
    peer.ontrack = (event) => {
      const slot = sfuSlotByTransceiver.get(event.transceiver);
      if (slot === undefined) return;
      // 必须按 track 单独建流：服务端的 sender 没有设置 msid，浏览器会把所有
      // 远端轨道放进同一个默认 MediaStream。若直接复用 event.streams[0]，
      // 8 个 slot 会共用同一条含 8 条轨道的流，slot 之间就区分不开了。
      attachSfuSlot(slot, new MediaStream([event.track]));
    };
    startSfuActivityMonitor();
    if (micStream && microphoneTrack) startWebRtcMicMonitor(getAudioCtx(), micStream, microphoneTrack);
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") void fallbackFromWebRtc(sequence, socket, "WEBRTC_CONNECTION_FAILED");
    };

    const negotiation = (async () => {
      webrtcActive.value = true;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      if (sequence !== connectionSequence || webrtcPeer !== peer || socket.readyState !== WebSocket.OPEN) return;
      const description = peer.localDescription;
      if (!description) throw new Error("WebRTC offer was not created");
      socket.send(JSON.stringify({ type: "webrtcOffer", payload: {
        sdp: { type: description.type, sdp: description.sdp },
        muted: microphoneMuted.value,
        accompanimentActive: accompanimentActive.value,
      } }));
      window.setTimeout(() => {
        if (webrtcPeer === peer && !peer.remoteDescription) void fallbackFromWebRtc(sequence, socket, "WEBRTC_ANSWER_TIMEOUT");
      }, 8_000);
    })();
    webrtcNegotiationPromise = negotiation;
    try {
      await negotiation;
    } catch (error) {
      if (webrtcPeer === peer) await fallbackFromWebRtc(sequence, socket, "WEBRTC_NEGOTIATION_FAILED");
      throw error;
    } finally {
      if (webrtcNegotiationPromise === negotiation) webrtcNegotiationPromise = null;
    }
  }

  async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      };
      const onStateChange = () => {
        if (peer.iceGatheringState === "complete") finish();
      };
      const timer = window.setTimeout(finish, 5_000);
      peer.addEventListener("icegatheringstatechange", onStateChange);
    });
  }

  async function applyWebRtcAnswer(description: unknown): Promise<void> {
    if (!webrtcPeer || !isSessionDescription(description, "answer")) return;
    try {
      await webrtcPeer.setRemoteDescription(description);
      webrtcActive.value = true;
      syncWebRtcMemberVolumes();
    } catch {
      if (lastConnection && ws.value) await fallbackFromWebRtc(connectionSequence, ws.value, "WEBRTC_ANSWER_REJECTED");
    }
  }

  async function fallbackFromWebRtc(sequence: number, socket: WebSocket, reasonCode = "WEBRTC_UNAVAILABLE"): Promise<void> {
    if (sequence !== connectionSequence || webrtcFallbackStarted) return;
    webrtcFallbackStarted = true;
    webrtcActive.value = false;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "webrtcStop" }));
    stopWebRtcTransport();
    if (socket.readyState === WebSocket.OPEN && state.connected) {
      // Degrading to the compatibility transport must be visible: the user is
      // still connected, but with different latency and audio quality.
      if (compatibilityPlaybackUnavailable()) {
        setAudioNotice("COMPATIBILITY_PLAYBACK_UNSUPPORTED", COMPATIBILITY_PLAYBACK_NOTICE);
      } else {
        setAudioNotice("WEBRTC_FALLBACK", `实时语音（WebRTC）不可用（错误代码：${safeClientErrorCode(reasonCode) || "WEBRTC_UNAVAILABLE"}），已切换为兼容传输：延迟与音质可能下降`);
      }
      try { await startMicrophone(); } catch (error: unknown) {
        setMicrophoneError(error);
      }
    }
  }

  function stopWebRtcTransport(): void {
    const peer = webrtcPeer;
    webrtcPeer = null;
    webrtcActive.value = false;
    webrtcNegotiationPromise = null;
    releaseAccompanimentStream();
    stopWebRtcMix();
    stopWebRtcMicMonitor();
    stopSfuSlots();
    if (peer) void peer.close();
  }

  /** 为一个 slot 建立播放节点。重复调用会先拆掉旧的。 */
  function attachSfuSlot(slot: number, stream: MediaStream): void {
    detachSfuSlot(slot);
    const ctx = getAudioCtx();
    // 本地活动检测与播放共用同一条图：AudioContext 被挂起时既没有声音、
    // 也不会误报"正在说话"，失败模式是自洽的。
    void ctx.resume().catch(() => undefined);
    let element: HTMLAudioElement | null = null;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);

      /**
       * 必须额外挂一个 media element 在这条远端轨道上。
       *
       * Chrome 只在远端轨道被挂到 HTMLMediaElement 时才会启动这条 WebRTC 接收流
       * （接收流的播放由音频设备模块拉取驱动，元素就是那个"请求播放"的 sink）。
       * 只挂 WebAudio 的 MediaStreamAudioSourceNode 不算 sink —— 实测此时
       * inbound-rtp 的 packetsReceived 正常增长，但 totalSamplesReceived 与
       * jitterBufferEmittedCount 恒为 0、media-playout 恒为 0、分析器读到全 0，
       * 表现就是"包收得到但一点声音都没有"。服务端此时一切正常。
       *
       * 元素保持 muted：真正出声的是上面那条 WebAudio 图（它承担成员音量、
       * 总音量和电平分析），元素只负责让接收流跑起来。muted 还顺带避开了
       * 自动播放策略 —— 静音媒体无需用户手势即可 play()。
       */
      element = new Audio();
      element.autoplay = true;
      element.muted = true;
      element.srcObject = stream;
      void element.play().catch(() => undefined);

      sfuSlotNodes.set(slot, {
        source,
        gain,
        analyser,
        buffer: new Float32Array(analyser.fftSize),
        // 用已缓存的映射回填，覆盖 speakerMap 早于 ontrack 到达的情况。
        clientId: lastSpeakerMap[String(slot)] ?? null,
        stream,
        element,
      });
      syncSfuVolumes();
    } catch {
      // 轨道可能在协商竞态里已经被关闭，忽略即可。
      if (element) {
        element.pause();
        element.srcObject = null;
      }
    }
  }

  function detachSfuSlot(slot: number): void {
    const node = sfuSlotNodes.get(slot);
    if (!node) return;
    if (node.clientId !== null) clearSpeaking(node.clientId);
    try {
      node.element.pause();
      node.element.srcObject = null;
      node.source.disconnect();
      node.gain.disconnect();
      node.analyser.disconnect();
    } catch {
      // 已经断开。
    }
    sfuSlotNodes.delete(slot);
  }

  function stopSfuSlots(): void {
    if (sfuActivityTimer !== null) {
      clearInterval(sfuActivityTimer);
      sfuActivityTimer = null;
    }
    for (const slot of [...sfuSlotNodes.keys()]) detachSfuSlot(slot);
    sfuSlotByTransceiver.clear();
  }


  /** 把成员音量与总输出音量应用到每个 slot。 */
  function syncSfuVolumes(): void {
    const level = effectiveOutputVolume();
    for (const node of sfuSlotNodes.values()) {
      const memberVolume = node.clientId === null ? 1 : (volumes[node.clientId] ?? DEFAULT_MEMBER_VOLUME);
      node.gain.gain.value = Math.max(0, memberVolume * level);
    }
  }

  /**
   * 本地说话指示。
   *
   * SFU 不解码，服务端无法再上报 voiceActivity —— 浏览器手里有每一路的真实
   * 音频，直接分析能量即可，比服务端估算更准。
   */
  function startSfuActivityMonitor(): void {
    if (sfuActivityTimer !== null) clearInterval(sfuActivityTimer);
    sfuActivityTimer = setInterval(() => {
      for (const node of sfuSlotNodes.values()) {
        if (node.clientId === null) continue;
        node.analyser.getFloatTimeDomainData(node.buffer);
        let sum = 0;
        for (const value of node.buffer) sum += value * value;
        if (Math.sqrt(sum / node.buffer.length) >= SFU_ACTIVITY_RMS) markSpeaking(node.clientId);
      }
    }, SFU_ACTIVITY_INTERVAL_MS);
  }

  /** 服务端下发 slot → clientId 映射时调用。 */
  function applySpeakerMap(slots: Record<string, number>): void {
    lastSpeakerMap = slots;
    for (const node of sfuSlotNodes.values()) {
      if (node.clientId !== null) clearSpeaking(node.clientId);
      node.clientId = null;
    }
    for (const [slotText, clientId] of Object.entries(slots)) {
      const node = sfuSlotNodes.get(Number(slotText));
      if (!node || !Number.isInteger(clientId) || clientId <= 0) continue;
      node.clientId = clientId;
    }
    syncSfuVolumes();
  }

  function startWebRtcMicMonitor(ctx: AudioContext, stream: MediaStream, track: MediaStreamTrack): void {
    stopWebRtcMicMonitor(false);
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silent);
      silent.connect(ctx.destination);
      const samples = new Float32Array(analyser.fftSize);
      webrtcMicMonitorSource = source;
      webrtcMicMonitorAnalyser = analyser;
      webrtcMicMonitorGain = silent;
      webrtcMicMonitorTimer = setInterval(() => {
        if (!webrtcMicMonitorAnalyser) return;
        webrtcMicMonitorAnalyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        micLevel.value = Math.min(1, rms * 6);
        if (!microphoneMuted.value && track.enabled && rms >= voxThreshold.value) markSpeaking(state.tsClientId);
        else if (state.tsClientId) clearSpeaking(state.tsClientId);
      }, 50);
    } catch {
      stopWebRtcMicMonitor(false);
    }
  }

  function stopWebRtcMicMonitor(resetLevel = true): void {
    if (webrtcMicMonitorTimer) clearInterval(webrtcMicMonitorTimer);
    webrtcMicMonitorTimer = null;
    webrtcMicMonitorSource?.disconnect();
    webrtcMicMonitorAnalyser?.disconnect();
    webrtcMicMonitorGain?.disconnect();
    webrtcMicMonitorSource = null;
    webrtcMicMonitorAnalyser = null;
    webrtcMicMonitorGain = null;
    if (resetLevel) micLevel.value = 0;
  }

  function isSessionDescription(value: unknown, type: "answer"): value is RTCSessionDescriptionInit {
    return Boolean(value) && typeof value === "object"
      && (value as { type?: unknown }).type === type
      && typeof (value as { sdp?: unknown }).sdp === "string";
  }

  function stopCaptureGraph(): void {
    accumLen = 0;
    voxAttack = 0;
    voxRelease = 0;
    micLevel.value = 0;
    scriptNode?.disconnect();
    workletNode?.port.close();
    workletNode?.disconnect();
    micGain?.disconnect();
    silentGain?.disconnect();
    scriptNode = null;
    workletNode = null;
    micGain = null;
    silentGain = null;
  }

  function stopMicrophoneProcessingGraph(): void {
    rnnoiseNode?.destroy();
    rnnoiseNode?.disconnect();
    rnnoiseNode = null;
    micSource?.disconnect();
    processedMicDestination?.disconnect();
    processedMicDestination?.stream.getTracks().forEach((track) => track.stop());
    micSource = null;
    processedMicDestination = null;
  }

  function stopMicrophone(closeContext = true): void {
    stopCaptureGraph();
    stopMicrophoneProcessingGraph();
    releaseAccompanimentStream();
    stopWebRtcMix();
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;
    if (closeContext) {
      audioCtx?.close();
      audioCtx = null;
      workletContext = null;
      workletModulePromise = null;
      rnnoiseWorkletModulePromise = null;
    }
  }

  async function prepareInputDevices(): Promise<void> {
    if (!micStream) await startMicrophone();
    else await refreshAudioDevices();
  }

  /**
   * Rebuild the audio path after an input-device change failed.
   *
   * Both callers stop the WebRTC transport *before* touching the microphone, so
   * a failure left the session in a state that looks connected but carries no
   * audio at all:
   *  - the local peer is closed, but the gateway only stops forwarding TeamSpeak
   *    audio to it when it receives `webrtcStop` (or the socket closes), so the
   *    downlink stayed pointed at a dead peer and the user heard nobody;
   *  - the WebRTC uplink path is gone as well.
   * Restore the microphone with the previous device, tell the gateway to drop the
   * stale peer, and rebuild realtime audio only if the microphone came back.
   */
  async function recoverAudioAfterFailedInputChange(restartWebRtc: boolean): Promise<void> {
    const socket = ws.value;
    const canUseSocket = Boolean(socket && socket.readyState === WebSocket.OPEN);
    if (restartWebRtc && canUseSocket) {
      try { socket!.send(JSON.stringify({ type: "webrtcStop" })); } catch { /* socket is going away */ }
    }
    stopWebRtcTransport();
    try {
      await startMicrophone();
    } catch (error) {
      // startMicrophone already recorded the readable reason; keep it so the UI
      // can say why there is no voice instead of pretending everything is fine.
      setMicrophoneError(error);
    }
    if (restartWebRtc && canUseSocket && !state.microphoneError) {
      try {
        await startWebRtcTransport(connectionSequence, socket!);
      } catch {
        // startWebRtcTransport falls back to the compatibility transport itself.
      }
    }
    if (state.microphoneError) {
      setAudioNotice("AUDIO_PATH_REBUILD_FAILED", "音频处理重建失败：麦克风未能恢复，请检查设备与浏览器权限");
    } else if (restartWebRtc && canUseSocket && !webrtcActive.value) {
      setAudioNotice("AUDIO_REALTIME_NOT_RESTORED", "音频处理重建失败：已退回兼容传输，实时语音未能恢复，请重新进入语音空间");
    }
  }

  async function setInputDevice(deviceId: string): Promise<void> {
    const previousDeviceId = selectedInputDeviceId.value;
    const shouldRestartWebRtc = webrtcActive.value && Boolean(ws.value);
    selectedInputDeviceId.value = deviceId;
    localStorage.setItem("webspeak:input-device", deviceId);
    void saveAudioPreferences();
    try {
      if (shouldRestartWebRtc) stopWebRtcTransport();
      if (micStream) await startMicrophone();
      if (shouldRestartWebRtc && ws.value) {
        stopWebRtcTransport();
        await startWebRtcTransport(connectionSequence, ws.value);
      }
      await refreshAudioDevices();
    } catch (error) {
      selectedInputDeviceId.value = previousDeviceId;
      localStorage.setItem("webspeak:input-device", previousDeviceId);
      await recoverAudioAfterFailedInputChange(shouldRestartWebRtc);
      throw error;
    }
  }

  async function startMicrophoneTest(): Promise<void> {
    microphoneTestActive.value = true;
    if (testAudioUrl.value) {
      URL.revokeObjectURL(testAudioUrl.value);
      testAudioUrl.value = "";
    }
    try {
      await prepareInputDevices();
      if (typeof MediaRecorder !== "undefined" && micStream) {
        const chunks: Blob[] = [];
        const recorder = new MediaRecorder(micStream);
        testRecorder = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = () => {
          if (chunks.length) {
            testAudioUrl.value = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
          }
          if (testRecorder === recorder) testRecorder = null;
        };
        recorder.start();
        testRecorderTimer = setTimeout(() => stopMicrophoneTest(), 5_000);
      }
    } catch (error) {
      microphoneTestActive.value = false;
      throw error;
    }
  }

  function stopMicrophoneTest(): void {
    microphoneTestActive.value = false;
    if (testRecorderTimer) clearTimeout(testRecorderTimer);
    testRecorderTimer = null;
    if (testRecorder && testRecorder.state !== "inactive") testRecorder.stop();
    if (!state.connected) stopMicrophone();
  }

  async function setOutputDevice(deviceId: string): Promise<void> {
    const previousDeviceId = selectedOutputDeviceId.value;
    if (deviceId && !outputDevices.some((device) => device.deviceId === deviceId)) {
      throw new Error("所选扬声器当前不可用");
    }
    selectedOutputDeviceId.value = deviceId;
    localStorage.setItem("webspeak:output-device", deviceId);
    try {
      await setAudioSink(getAudioCtx(), deviceId);
      await saveAudioPreferences();
    } catch (error) {
      selectedOutputDeviceId.value = previousDeviceId;
      localStorage.setItem("webspeak:output-device", previousDeviceId);
      throw error;
    }
  }

  function playNotification(kind: "connected" | "disconnected" | "poke" | "private" | "reconnectFailed"): void {
    if (notificationVolume.value <= 0 || outputMuted.value || effectiveOutputVolume() <= 0 || typeof window === "undefined") return;
    try {
      const ctx = getAudioCtx();
      if (ctx.state === "suspended") return;
      const frequencies: Record<typeof kind, number[]> = {
        connected: [660, 880],
        disconnected: [440, 330],
        poke: [740, 980],
        private: [600, 760],
        reconnectFailed: [300, 220],
      };
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;
      oscillator.frequency.setValueAtTime(frequencies[kind][0], now);
      oscillator.frequency.setValueAtTime(frequencies[kind][1], now + 0.08);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, notificationVolume.value * effectiveOutputVolume() * 0.12), now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
    } catch {
      // Notification sounds are best effort and must never affect the session.
    }
  }

  /**
   * 每个说话人最近一帧的时长（秒），由解码结果测得。
   *
   * 兼容传输的播放上限 80ms 是按 20ms 帧定的；TeamSpeak 的 Opus Music
   * （codec 5）用 60ms 帧 —— 一帧就占 60ms、两帧 120ms，固定上限会让每一帧
   * 都被判成"过期"并重置播放，听感就是一断一续。
   */
  const remoteFrameSeconds = new Map<number, number>();

  /** 播放上限：固定 80ms，但至少容纳该说话人的两帧。 */
  function remotePlayAheadLimit(clientId: number): number {
    return Math.max(MAX_REMOTE_PLAY_AHEAD_SECONDS, (remoteFrameSeconds.get(clientId) ?? 0) * 2);
  }

  function playAudioFrame(clientId: number, opusData: Uint8Array): void {
    if (opusData.length < 3) return;
    let decoder = remoteDecoders.get(clientId);
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const scheduledUntil = remotePlayTimes.get(clientId) ?? now;
    const decodeQueueSize = decoder?.decodeQueueSize ?? 0;
    if (
      decoder &&
      (scheduledUntil > now + remotePlayAheadLimit(clientId) || decodeQueueSize >= MAX_REMOTE_DECODE_QUEUE_FRAMES)
    ) {
      resetRemotePlayback(clientId);
      decoder = undefined;
    }

    if (!decoder) {
      const gainNode = ctx.createGain();
      gainNode.gain.value = (volumes[clientId] ?? DEFAULT_MEMBER_VOLUME) * effectiveOutputVolume();
      gainNode.connect(ctx.destination);
      remoteGains.set(clientId, gainNode);
      const generation = ++nextRemoteDecoderGeneration;
      const nextDecoder = new AudioDecoder({
        output: (chunk: AudioData) => {
          if (remoteDecoderGenerations.get(clientId) !== generation) {
            chunk.close();
            return;
          }
          try {
            const { sampleRate, numberOfChannels, numberOfFrames } = chunk;
            // 记录真实帧长：Opus Music（60ms）与 Opus Voice（20ms）共用这条路径。
            remoteFrameSeconds.set(clientId, numberOfFrames / sampleRate);
            const buffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
            for (let ch = 0; ch < numberOfChannels; ch++) {
              const data = new Float32Array(numberOfFrames);
              chunk.copyTo(data, { planeIndex: ch, format: "f32-planar" });
              buffer.copyToChannel(data, ch);
            }
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(gainNode);
            let sources = remotePlaybackSources.get(clientId);
            if (!sources) {
              sources = new Set<AudioBufferSourceNode>();
              remotePlaybackSources.set(clientId, sources);
            }
            sources.add(source);
            source.addEventListener("ended", () => {
              source.disconnect();
              sources?.delete(source);
              if (sources?.size === 0) remotePlaybackSources.delete(clientId);
            }, { once: true });
            let playTime = remotePlayTimes.get(clientId) ?? ctx.currentTime;
            if (playTime < ctx.currentTime) playTime = ctx.currentTime;
            if (playTime + numberOfFrames / sampleRate > ctx.currentTime + remotePlayAheadLimit(clientId)) {
              source.disconnect();
              sources.delete(source);
              if (sources.size === 0) remotePlaybackSources.delete(clientId);
              chunk.close();
              resetRemotePlayback(clientId);
              return;
            }
            source.start(playTime);
            remotePlayTimes.set(clientId, playTime + numberOfFrames / sampleRate);
          } catch {
            // A decoder can finish while the audio context is being torn down.
          }
          chunk.close();
        },
        error: () => {
          if (remoteDecoderGenerations.get(clientId) === generation) {
            remoteDecoderGenerations.delete(clientId);
            remoteDecoders.delete(clientId);
          }
        },
      });
      nextDecoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
      decoder = nextDecoder;
      remoteDecoderGenerations.set(clientId, generation);
      remoteDecoders.set(clientId, decoder);
    }

    try {
      const timestamp = remoteDecodeTimestamps.get(clientId) ?? 0;
      // 解码时间轴也按真实帧长推进（20ms 只是首帧前的默认值）。
      const frameMicros = Math.round((remoteFrameSeconds.get(clientId) ?? 0.02) * 1_000_000);
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp, duration: frameMicros, data: opusData }));
      remoteDecodeTimestamps.set(clientId, timestamp + frameMicros);
    } catch {
      // Ignore malformed frames; the next valid frame can still be decoded.
    }
  }

  function clearRemotePlayback(clientId: number): void {
    const decoder = remoteDecoders.get(clientId);
    if (decoder) {
      try { decoder.close(); } catch { /* already closed */ }
    }
    remoteDecoders.delete(clientId);
    remoteDecoderGenerations.delete(clientId);
    remotePlayTimes.delete(clientId);
    remoteDecodeTimestamps.delete(clientId);
    const sources = remotePlaybackSources.get(clientId);
    if (sources) {
      for (const source of sources) {
        try { source.stop(); } catch { /* already ended */ }
        source.disconnect();
      }
      remotePlaybackSources.delete(clientId);
    }
    // The per-client GainNode stays wired to ctx.destination until it is
    // disconnected. Only the full disconnect() used to clean it up, so every
    // decoder reset (queue overflow) and every memberLeave leaked one orphaned
    // GainNode per client for the rest of the session.
    const gain = remoteGains.get(clientId);
    if (gain) {
      gain.disconnect();
      remoteGains.delete(clientId);
    }
  }

  function resetRemotePlayback(clientId: number): void {
    clearRemotePlayback(clientId);
  }

  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;

  function clearConnectWatchdog(): void {
    if (connectWatchdog !== null) {
      clearTimeout(connectWatchdog);
      connectWatchdog = null;
    }
  }

  /**
   * 给「正在连接…」一个明确的终点。
   *
   * 正常情况下网关十几秒内就会给出 connected 或 connectionFailed。但它也可能一句话都不说
   * （进程刚重启、请求卡在中间态、或者像 TS3 握手那样只有超时而无解释），
   * 那时用户会无限停在「正在连接…」上：没有进度、没有错误、只能自己猜。
   */
  function armConnectWatchdog(sequence: number): void {
    clearConnectWatchdog();
    connectWatchdog = setTimeout(() => {
      connectWatchdog = null;
      if (sequence !== connectionSequence || state.connected || !state.connecting) return;
      // The watchdog has to *end* the attempt, not just describe it. It used to
      // only set the error, so a join-ticket fetch that resolved after the
      // deadline still opened the socket and connected — the user was told the
      // connection timed out and then silently joined anyway. disconnect() bumps
      // connectionSequence, which turns every late continuation (fetch result,
      // socket open, socket message) into a no-op, and preserveConnection keeps
      // the form filled in for a retry.
      disconnect(true);
      state.errorCode = "CONNECT_TIMEOUT";
      state.error = CONNECT_WATCHDOG_MESSAGE;
    }, CONNECT_WATCHDOG_MS);
  }

  let reconnectWatchdog: ReturnType<typeof setTimeout> | null = null;

  function clearReconnectWatchdog(): void {
    if (reconnectWatchdog !== null) {
      clearTimeout(reconnectWatchdog);
      reconnectWatchdog = null;
    }
  }

  /**
   * Give the reconnect wait a deadline. See RECONNECT_WATCHDOG_MS.
   *
   * Re-arming is a no-op while one is pending, so the deadline covers the whole
   * reconnect rather than restarting on every attempt message.
   */
  function armReconnectWatchdog(): void {
    if (reconnectWatchdog !== null) return;
    reconnectWatchdog = setTimeout(() => {
      reconnectWatchdog = null;
      if (!state.reconnecting) return;
      // reconnectFailed (not a plain error) so the room keeps its "reconnect now"
      // affordance instead of dropping the user back to the join form.
      state.reconnecting = false;
      state.reconnectFailed = true;
      state.errorCode = "RECONNECT_TIMEOUT";
      state.error = connectionFailureMessage("RECONNECT_TIMEOUT");
    }, RECONNECT_WATCHDOG_MS);
  }

  /** 会话真正建立后才把记录标成「可恢复」。 */
  function markActiveSessionEstablished(): void {
    if (!lastConnection) return;
    writeActiveSession({ ...lastConnection, established: true });
  }

  /**
   * 把「我现在在哪个频道」回写给恢复记录。
   *
   * 记录里的 channel 是加入页当时填的频道名；进房间后点频道树切换，那个值就过期了
   * —— 那样刷新会把人送回默认频道，而不是他真正待着的频道。频道树每次变化
   * （自己切频道、别人进出都会触发 channelList）时按「自己所在频道」回写一次。
   *
   * 只认频道名不认 id：网关的 ensureChannel 就是按名字匹配的
   * （voice-bridge.ts:442-455），保持同一口径，不必动服务端。
   */
  function refreshRestorableChannel(): void {
    if (!lastConnection || !state.connected) return;
    const selfId = state.tsClientId;
    if (!selfId) return;
    const own = channels.find((channel) => channel.members?.some((member) => member.id === selfId));
    const name = own?.name?.trim();
    if (!name || name === lastConnection.channel) return;
    lastConnection = { ...lastConnection, channel: name };
    markActiveSessionEstablished();
  }

  function connect(target: string, channel: string, nickname: string, serverPassword = "", identity = "", rememberIdentity = false, inviteToken = "", accelerated = false, accelerationRelayId = ""): void {
    disconnect(true);
    lastConnection = { target, channel, nickname, serverPassword, ...(identity ? { identity } : {}), rememberIdentity, accelerated, accelerationRelayId };
    identityMaterial.value = identity;
    // 记住这次会话，供刷新后自动回到房间。走邀请链接加入的不记：邀请可能是一次性的
    // （maxUses=1），刷新后自动重连只会撞一句「邀请已失效」，不如让用户看到预填好的表单。
    if (!inviteToken) {
      writeActiveSession({ target, channel, nickname, serverPassword, ...(identity ? { identity } : {}), rememberIdentity, accelerated, accelerationRelayId, established: false });
    }
    const sequence = ++connectionSequence;
    state.error = "";
    state.errorCode = "";
    // Audio diagnostics belong to the previous session, never to the new one.
    clearMicrophoneError();
    clearAudioNotice();
    // 昵称长度预校验：交给服务端的话要等 15 秒才收到一句误导性的「检查网络」。
    if ([...nickname.trim()].length < MIN_NICKNAME_CHARACTERS) {
      state.errorCode = "INVALID_NICKNAME";
      state.error = NICKNAME_LENGTH_MESSAGE;
      return;
    }
    state.connecting = true;
    state.reconnecting = false;
    state.reconnectAttempt = 0;
    state.reconnectFailed = false;
    // 两件事都要做，而且顺序有讲究：
    //  1) 先武装看门狗 —— 它要覆盖「连音频偏好都还没加载完」这种卡住的情况。
    //     它触发时会 disconnect(true)，把 connectionSequence 抬上去。
    //  2) 等音频偏好就绪再开连接（v0.2.4 的要求：屏幕共享的采集参数要先读出来）。
    //     下面的 sequence 守卫正好让看门狗超时后的晚到回调自动作废，两者配合。
    armConnectWatchdog(sequence);
    void audioPreferencesReady.then(() => {
      if (sequence !== connectionSequence) return;
      void openTicketedConnection(sequence, target, channel, nickname, serverPassword, inviteToken, accelerated);
    });
  }

  async function openTicketedConnection(sequence: number, target: string, channel: string, nickname: string, serverPassword: string, inviteToken: string, accelerated: boolean): Promise<void> {
    // Bound the request: without this a stalled gateway left the fetch pending
    // until the connect watchdog fired, and the late response still connected.
    const controller = new AbortController();
    const ticketTimeout = window.setTimeout(() => controller.abort(), JOIN_TICKET_TIMEOUT_MS);
    try {
      const response = await fetch("/api/join-ticket", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ target, nickname, channel, serverPassword, ...(inviteToken ? { invite: inviteToken } : {}), ...(accelerated ? { accelerated: true, ...(lastConnection?.accelerationRelayId ? { accelerationRelayId: lastConnection.accelerationRelayId } : {}) } : {}), ...(lastConnection?.rememberIdentity && lastConnection.identity ? { identity: lastConnection.identity } : {}), ...(lastConnection?.rememberIdentity ? { rememberIdentity: true } : {}) }),
      });
      const result = await response.json().catch(() => ({})) as { ticket?: unknown; code?: unknown; detail?: unknown };
      if (!response.ok || typeof result.ticket !== "string") {
        const failureCode = normalizedClientErrorCode(result.code);
        const failure = new Error(joinTicketReason(failureCode, result.detail));
        Object.assign(failure, { code: failureCode });
        throw failure;
      }
      if (sequence !== connectionSequence) return;
      openVoiceSocket(sequence, result.ticket);
    } catch (error: unknown) {
      if (sequence !== connectionSequence) return;
      state.connecting = false;
      // An aborted fetch reports an English DOMException message; use the
      // explainable code instead of letting it reach the UI.
      const aborted = error instanceof Error && error.name === "AbortError";
      const errorRecord = error && typeof error === "object" ? error as { code?: unknown } : {};
      state.errorCode = aborted ? "REQUEST_TIMEOUT" : normalizedClientErrorCode(errorRecord.code, "REQUEST_FAILED");
      state.error = aborted || !(error instanceof Error)
        ? connectionFailureMessage(state.errorCode)
        : error.message;
    } finally {
      window.clearTimeout(ticketTimeout);
    }
  }

  function openVoiceSocket(sequence: number, ticket: string): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws/voice?ticket=${encodeURIComponent(ticket)}`);
    socket.binaryType = "arraybuffer";
    ws.value = socket;
    socket.onopen = () => {
      if (sequence !== connectionSequence) {
        socket.close(1000);
        return;
      }
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          handleMessage(JSON.parse(event.data));
        } catch {
          // Ignore malformed control frames.
        }
      } else {
        handleAudioFrame(new Uint8Array(event.data));
      }
    };
    socket.onclose = (event) => {
      if (sequence !== connectionSequence) return;
      clearConnectWatchdog();
      clearReconnectWatchdog();
      clearLatencyProbes();
      rejectPendingCommands(new Error("语音连接已关闭"));
      resetChannelInfos();
      state.connected = false;
      state.connecting = false;
      state.reconnecting = false;
      // Prefer the close code over the generic WebSocket error event. The
      // gateway uses a dedicated code when a remembered identity is already
      // active in another browser page.
      if (!state.reconnectFailed && !state.errorCode) {
        // The gateway tears a session down with 1000 and puts its own reason in
        // the close frame (admin-terminated, gateway-shutdown, heartbeat-timeout).
        // Because the code is 1000 those used to produce no message at all, so an
        // admin ending the session looked exactly like the user's own disconnect.
        // A user-initiated disconnect never reaches here: disconnect() bumps
        // connectionSequence before closing.
        const reasonCode = event.code === 1000 ? GATEWAY_CLOSE_REASON_CODES[event.reason] : undefined;
        if (reasonCode) {
          state.errorCode = reasonCode;
          state.error = connectionFailureMessage(reasonCode);
          // 管理员结束了这条会话：刷新不该再自动回到房间（会被再踢一次）。
          if (reasonCode === "SESSION_TERMINATED_BY_ADMIN") clearActiveSession();
        } else if (event.code !== 1000) {
          state.errorCode = closeErrorCode(event.code, event.reason);
          state.error = closeReason(event.code, event.reason);
        }
      }
      stopWebRtcTransport();
      stopMicrophone();
      clearMicrophoneError();
      clearAudioNotice();
      whisperTargetIds.clear();
      whisperActive.value = false;
    };
    socket.onerror = () => {
      // The following close event contains the actionable close code. Do not
      // overwrite it with a generic browser WebSocket error first.
    };
  }

  function joinTicketReason(code: string, detail?: unknown): string {
    const messages: Record<string, string> = {
      ORIGIN_REJECTED: "请求来源不受信任，请从正确的网站入口重新打开",
      NOT_INITIALIZED: "WebSpeak 尚未完成配置，请联系管理员",
      RATE_LIMITED: "请求过于频繁，请稍后重试",
      TARGET_NOT_ALLOWED: "此 TeamSpeak 服务器地址不允许连接",
      ACCELERATION_UNAVAILABLE: "当前中继加速不可用，请关闭加速或联系管理员",
      INVALID_NICKNAME: "请输入有效的昵称",
      INVITE_INVALID: "邀请链接已失效或已被撤销",
    };
    const normalized = normalizedClientErrorCode(code);
    return messages[normalized] ?? connectionFailureMessage(normalized, detail);
  }

  // 网关关闭码 → 前端可解释错误码的映射：4000-4003 是网关/会话级，4004/4005 是
  // TeamSpeak 拒绝与身份冲突，4006 是中继加速，1006/1011 是传输级掉线，绝不能
  // 被误当成 TeamSpeak 服务器拒绝。
  /**
   * Gateway close codes. 4000-4003 are gateway/session level, 4004/4005 are a
   * TeamSpeak rejection and an identity conflict, 4006 is the acceleration relay,
   * and 1006 is a transport-level drop that must not be blamed on TeamSpeak.
   */
  const GATEWAY_CLOSE_CODE_CODES: Record<number, string> = {
    4000: "CONNECTION_FAILED",
    4001: "JOIN_TICKET_REQUIRED",
    4002: "INVALID_TARGET",
    4003: "IDENTITY_REJECTED",
    4004: "SERVER_REJECTED",
    4005: "IDENTITY_IN_USE",
    4006: "ACCELERATION_UNAVAILABLE",
    1006: "GATEWAY_NETWORK_LOST",
    1011: "GATEWAY_SESSION_ENDED",
  };

  /**
   * Gateway teardown reasons that arrive inside a *normal* (1000) close frame.
   *
   * voice-bridge closes with 1000 and the SessionTeardownReason as the reason
   * string for everything it decides itself. Only the ones the user can act on
   * are mapped; the rest (websocket-close, client-disconnect) are the user's own
   * doing and stay silent.
   */
  const GATEWAY_CLOSE_REASON_CODES: Record<string, string> = {
    "admin-terminated": "SESSION_TERMINATED_BY_ADMIN",
    "gateway-shutdown": "GATEWAY_SHUTTING_DOWN",
    "heartbeat-timeout": "GATEWAY_HEARTBEAT_LOST",
  };

  function closeErrorCode(code: number, reason = ""): string {
    const closeCode = normalizedClientErrorCode(reason, "");
    // The gateway repeats the failure code in the close reason. Trust it when the
    // browser can explain that code, otherwise fall back to the numeric close code
    // so even a silent close maps to an actionable message.
    if (closeCode && CONNECTION_FAILURE_MESSAGES[closeCode]) return closeCode;
    return GATEWAY_CLOSE_CODE_CODES[code] ?? "CONNECTION_FAILED";
  }

  function connectionFailureMessage(code: string, detail?: unknown): string {
    const messages = CONNECTION_FAILURE_MESSAGES;
    const normalized = normalizedClientErrorCode(code);
    if (messages[normalized]) return messages[normalized];
    const safeCode = safeClientErrorCode(normalized);
    const safeDetail = safeClientErrorDetail(detail);
    // The gateway classifies a refused nickname before it reaches the browser,
    // but translate the raw TeamSpeak signature too: a nickname problem must
    // never end up as the generic "check your network" fallback.
    if (safeDetail && NICKNAME_LENGTH_SIGNATURE.test(safeDetail)) return NICKNAME_LENGTH_MESSAGE;
    return `TeamSpeak 连接失败（错误代码：${safeCode}）${safeDetail ? `：${safeDetail}` : ""}，请检查输入、网络或服务器状态`;
  }

  function closeReason(code: number, reason = ""): string {
    const failureCode = closeErrorCode(code, reason);
    if (code === 4004 && failureCode === "SERVER_REJECTED") return "服务器当前已满或拒绝了连接，请稍后重试";
    return connectionFailureMessage(failureCode);
  }

  function disconnect(preserveConnection = false): void {
    connectionSequence++;
    clearConnectWatchdog();
    clearLatencyProbes();
    rejectPendingCommands(new Error("语音连接已关闭"));
    resetChannelInfos();
    const keepRememberedIdentity = lastConnection?.rememberIdentity === true;
    if (!preserveConnection) {
      lastConnection = null;
      // 显式离开（点「离开」或组件卸载）：刷新不该再把人拉回房间。
      clearActiveSession();
    }
    stopMicrophone();
    clearMicrophoneError();
    clearAudioNotice();
    stopScreenShareTransport(!preserveConnection);
    const socket = ws.value;
    ws.value = null;
    stopWebRtcTransport();
    clearReconnectWatchdog();
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
    state.connected = false;
    state.connecting = false;
    state.reconnecting = false;
    state.reconnectAttempt = 0;
    state.reconnectFailed = false;
    state.tsClientId = 0;
    state.errorCode = "";
    state.channelSwitchedChannelId = "";
    if (!keepRememberedIdentity) identityMaterial.value = "";
    members.length = 0;
    channels.length = 0;
    chatMessages.length = 0;
    for (const clientId of new Set([...remoteDecoders.keys(), ...remotePlaybackSources.keys()])) clearRemotePlayback(clientId);
    remoteDecoderGenerations.clear();
    remotePlayTimes.clear();
    remoteDecodeTimestamps.clear();
    for (const gain of remoteGains.values()) gain.disconnect();
    remoteGains.clear();
    clearSpeakingState();
    whisperTargetIds.clear();
    whisperActive.value = false;
    for (const key of Object.keys(volumes)) delete volumes[Number(key)];
  }

  function clearLatencyProbes(): void {
    for (const [sequence, pending] of pendingLatencyProbes) {
      clearTimeout(pending.timer);
      pendingLatencyProbes.delete(sequence);
      pending.resolve(null);
    }
  }

  function rejectPendingCommands(error: Error): void {
    for (const [requestId, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pendingCommands.delete(requestId);
      pending.reject(error);
    }
  }

  function sendScreenShareMessage(message: Record<string, unknown>): void {
    if (ws.value?.readyState === WebSocket.OPEN) ws.value.send(JSON.stringify(message));
  }

  type ScreenShareStatsRecord = Record<string, unknown>;

  function screenShareStatsRecord(value: unknown): ScreenShareStatsRecord {
    return value && typeof value === "object" ? value as ScreenShareStatsRecord : {};
  }

  function screenShareStatsNumber(stats: ScreenShareStatsRecord | undefined, key: string): number | null {
    const value = stats?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function screenShareStatsString(stats: ScreenShareStatsRecord | undefined, key: string): string | null {
    const value = stats?.[key];
    return typeof value === "string" && value ? value : null;
  }

  function screenShareVideoStatsKind(stats: ScreenShareStatsRecord): string {
    return screenShareStatsString(stats, "kind") ?? screenShareStatsString(stats, "mediaType") ?? "";
  }

  function screenShareStatsCapture(): ScreenShareCaptureStats | null {
    const track = screenShareLocalStream?.getVideoTracks()[0];
    if (!track) return null;
    const settings = track.getSettings();
    return {
      width: typeof settings.width === "number" ? settings.width : null,
      height: typeof settings.height === "number" ? settings.height : null,
      frameRate: typeof settings.frameRate === "number" ? settings.frameRate : null,
    };
  }

  async function collectScreenSharePeerStats(peerId: string, peer: RTCPeerConnection, role: "owner" | "viewer"): Promise<ScreenSharePeerStats | null> {
    try {
      const report = await peer.getStats();
      const records = new Map<string, ScreenShareStatsRecord>();
      let mediaStats: ScreenShareStatsRecord | undefined;
      let remoteInboundStats: ScreenShareStatsRecord | undefined;
      let trackStats: ScreenShareStatsRecord | undefined;
      let candidatePairStats: ScreenShareStatsRecord | undefined;
      report.forEach((raw) => {
        const stats = screenShareStatsRecord(raw);
        const id = screenShareStatsString(stats, "id");
        if (id) records.set(id, stats);
        const type = screenShareStatsString(stats, "type");
        const kind = screenShareVideoStatsKind(stats);
        if (type === "outbound-rtp" && kind === "video" && role === "owner") mediaStats = stats;
        if (type === "inbound-rtp" && kind === "video" && role === "viewer") mediaStats = stats;
        if (type === "remote-inbound-rtp" && kind === "video" && role === "owner") remoteInboundStats = stats;
        if (type === "track" && kind === "video") trackStats = stats;
        if (type === "candidate-pair" && (stats.selected === true || stats.nominated === true || screenShareStatsString(stats, "state") === "succeeded")) candidatePairStats = stats;
      });

      const codecId = screenShareStatsString(mediaStats, "codecId");
      const codecStats = codecId ? records.get(codecId) : undefined;
      const localCandidateId = screenShareStatsString(candidatePairStats, "localCandidateId");
      const localCandidate = localCandidateId ? records.get(localCandidateId) : undefined;
      const remoteCandidateId = screenShareStatsString(candidatePairStats, "remoteCandidateId");
      const remoteCandidate = remoteCandidateId ? records.get(remoteCandidateId) : undefined;
      const remoteStats = role === "owner" ? remoteInboundStats : undefined;
      const frames = screenShareStatsNumber(mediaStats, role === "owner" ? "framesEncoded" : "framesDecoded")
        ?? screenShareStatsNumber(mediaStats, role === "owner" ? "framesSent" : "framesReceived");
      const bytes = screenShareStatsNumber(mediaStats, role === "owner" ? "bytesSent" : "bytesReceived");
      const now = performance.now();
      const previous = screenShareStatsPrevious.get(peerId);
      const elapsedMs = previous ? now - previous.sampledAt : 0;
      const derivedFrameRate = previous && elapsedMs >= 250 && frames !== null && previous.frames !== null
        ? Math.max(0, ((frames - previous.frames) * 1_000) / elapsedMs)
        : null;
      const derivedBitrateKbps = previous && elapsedMs >= 250 && bytes !== null && previous.bytes !== null
        ? Math.max(0, ((bytes - previous.bytes) * 8) / elapsedMs)
        : null;
      screenShareStatsPrevious.set(peerId, { sampledAt: now, bytes, frames });

      const packetsLost = screenShareStatsNumber(remoteStats ?? mediaStats, "packetsLost");
      const packetsTransferred = screenShareStatsNumber(mediaStats, role === "owner" ? "packetsSent" : "packetsReceived");
      const packetsTotal = packetsTransferred === null || packetsLost === null ? null : packetsTransferred + packetsLost;
      const lossPercent = packetsTotal && packetsTotal > 0 && packetsLost !== null ? (packetsLost / packetsTotal) * 100 : null;
      const currentRoundTripTime = screenShareStatsNumber(remoteStats, "roundTripTime") ?? screenShareStatsNumber(candidatePairStats, "currentRoundTripTime");
      const jitter = screenShareStatsNumber(remoteStats ?? mediaStats, "jitter");
      const directFrameRate = screenShareStatsNumber(mediaStats, "framesPerSecond") ?? screenShareStatsNumber(trackStats, "framesPerSecond");
      const directBitrateKbps = screenShareStatsNumber(mediaStats, "bitrate") !== null ? (screenShareStatsNumber(mediaStats, "bitrate") as number) / 1_000 : null;
      return {
        peerId,
        role,
        direction: role === "owner" ? "outbound" : "inbound",
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        codec: screenShareStatsString(codecStats, "mimeType"),
        candidateType: screenShareStatsString(localCandidate, "candidateType") ?? screenShareStatsString(remoteCandidate, "candidateType"),
        width: screenShareStatsNumber(mediaStats, "frameWidth") ?? screenShareStatsNumber(trackStats, "frameWidth"),
        height: screenShareStatsNumber(mediaStats, "frameHeight") ?? screenShareStatsNumber(trackStats, "frameHeight"),
        frameRate: directFrameRate !== null && directFrameRate > 0 ? directFrameRate : derivedFrameRate,
        bitrateKbps: directBitrateKbps ?? derivedBitrateKbps,
        packetsLost,
        packetsTotal,
        lossPercent,
        framesDropped: screenShareStatsNumber(mediaStats, "framesDropped") ?? screenShareStatsNumber(trackStats, "framesDropped"),
        jitterMs: jitter === null ? null : jitter * 1_000,
        roundTripTimeMs: currentRoundTripTime === null ? null : currentRoundTripTime * 1_000,
        availableOutgoingBitrateKbps: screenShareStatsNumber(candidatePairStats, "availableOutgoingBitrate") === null
          ? null
          : (screenShareStatsNumber(candidatePairStats, "availableOutgoingBitrate") as number) / 1_000,
        qualityLimitationReason: screenShareStatsString(mediaStats, "qualityLimitationReason"),
      };
    } catch {
      return null;
    }
  }

  async function collectScreenShareWebRtcStats(): Promise<void> {
    if (screenShareStatsCollecting || !screenSharePeers.size) return;
    screenShareStatsCollecting = true;
    try {
      const peers = await Promise.all([...screenSharePeers.entries()].map(async ([peerId, peer]) => {
        const role = screenSharePeerRoles.get(peerId) ?? "viewer";
        return collectScreenSharePeerStats(peerId, peer, role);
      }));
      screenShareWebRtcStats.capture = screenShareStatsCapture();
      screenShareWebRtcStats.peers = peers.filter((stats): stats is ScreenSharePeerStats => stats !== null);
      screenShareWebRtcStats.updatedAt = Date.now();
    } finally {
      screenShareStatsCollecting = false;
    }
  }

  function startScreenShareStatsPolling(): void {
    if (screenShareStatsTimer) return;
    void collectScreenShareWebRtcStats();
    screenShareStatsTimer = setInterval(() => { void collectScreenShareWebRtcStats(); }, 1_000);
  }

  function stopScreenShareStatsPolling(): void {
    if (screenShareStatsTimer) {
      clearInterval(screenShareStatsTimer);
      screenShareStatsTimer = null;
    }
    screenShareStatsPrevious.clear();
    screenShareWebRtcStats.updatedAt = null;
    screenShareWebRtcStats.capture = null;
    screenShareWebRtcStats.peers = [];
  }

  function clearScreenSharePeerTimer(peerId: string): void {
    const timer = screenSharePeerTimers.get(peerId);
    if (!timer) return;
    clearTimeout(timer);
    screenSharePeerTimers.delete(peerId);
  }

  function armScreenSharePeerTimer(peerId: string): void {
    clearScreenSharePeerTimer(peerId);
    screenSharePeerTimers.set(peerId, setTimeout(() => {
      screenSharePeerTimers.delete(peerId);
      if (!screenSharePeers.has(peerId)) return;
      failScreenSharePeer(peerId, "屏幕共享直连协商超时，请确认双方网络允许浏览器直连");
    }, SCREEN_SHARE_NEGOTIATION_TIMEOUT_MS));
  }

  function closeScreenSharePeer(peerId: string): void {
    clearScreenSharePeerTimer(peerId);
    const peer = screenSharePeers.get(peerId);
    screenSharePeers.delete(peerId);
    screenSharePeerRoles.delete(peerId);
    screenShareStatsPrevious.delete(peerId);
    screenSharePendingIce.delete(peerId);
    screenSharePeerStreams.delete(peerId);
    try { peer?.close(); } catch { /* closing an already closed peer is harmless */ }
    if (!screenSharePeers.size) stopScreenShareStatsPolling();
  }

  function closeAllScreenSharePeers(): void {
    for (const peerId of [...screenSharePeers.keys()]) closeScreenSharePeer(peerId);
  }

  function setScreenShareP2PError(message = "直连 P2P 失败，当前网络无法建立浏览器之间的直接连接") {
    screenShareErrorCode.value = "";
    screenShareError.value = message;
  }

  function failScreenSharePeer(peerId: string, message?: string): void {
    const viewingStream = screenShareStreams.find((stream) => stream.streamId === screenShareViewingStreamId.value && stream.ownerPeerId === peerId);
    if (viewingStream) sendScreenShareMessage({ type: "screenShareLeave", streamId: viewingStream.streamId });
    closeScreenSharePeer(peerId);
    if (viewingStream) {
      screenShareViewing.value = false;
      screenShareViewingStreamId.value = "";
      screenShareRemoteStream.value = null;
    }
    setScreenShareP2PError(message);
  }

  function createScreenSharePeer(streamId: string, peerId: string, role: "owner" | "viewer"): RTCPeerConnection {
    const existing = screenSharePeers.get(peerId);
    if (existing) return existing;
    // STUN discovers server-reflexive candidates; it does not carry media.
    // TURN is accepted only when explicitly configured by the deployment, and
    // would use that external TURN service rather than the WebSpeak gateway.
    const peer = new RTCPeerConnection({ iceServers: screenShareIceServers });
    screenSharePeers.set(peerId, peer);
    screenSharePeerRoles.set(peerId, role);
    startScreenShareStatsPolling();
    if (role === "owner") {
      for (const track of screenShareLocalStream?.getTracks() ?? []) peer.addTrack(track, screenShareLocalStream!);
    } else {
      peer.addTransceiver("video", { direction: "recvonly" });
      const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
      if (stream?.audio) peer.addTransceiver("audio", { direction: "recvonly" });
    }
    preferScreenShareCodecs(peer);
    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate;
      sendScreenShareMessage({
        type: "screenShareSignal",
        streamId,
        targetPeerId: peerId,
        signal: {
          kind: "iceCandidate",
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      });
    };
    peer.ontrack = (event) => {
      if (role !== "viewer") return;
      clearScreenSharePeerTimer(peerId);
      const remote = event.streams[0] ?? screenSharePeerStreams.get(peerId) ?? new MediaStream();
      if (!event.streams[0]) remote.addTrack(event.track);
      screenSharePeerStreams.set(peerId, remote);
      screenShareRemoteStream.value = remote;
      screenShareViewing.value = true;
    };
    peer.onconnectionstatechange = () => {
      // `completed` belongs to RTCIceConnectionState, not the aggregate
      // RTCPeerConnection.connectionState. Treating it as a connection state
      // both trips the type checker and can hide the actual failed/closed
      // transitions we need to handle here.
      if (peer.connectionState === "connected") {
        clearScreenSharePeerTimer(peerId);
      } else if (peer.connectionState === "failed") {
        failScreenSharePeer(peerId);
      }
      if (peer.connectionState === "closed" && screenSharePeers.get(peerId) === peer) closeScreenSharePeer(peerId);
    };
    return peer;
  }

  /**
   * 屏幕共享的码率上限阶梯（按采集像素数选档）。
   *
   * 不设上限时浏览器会退回一个偏保守的屏幕内容目标码率，1080p 跑 30/60fps
   * 明显不够 —— 实测表现就是「帧率上不去，降到 720p 帧率才涨」。
   * 这里的值是**天花板而不是目标**：拥塞控制仍会在链路撑不住时把实际码率压下来，
   * 所以给足余量是安全的。
   */
  function screenShareBitrateCeiling(width: number | null, height: number | null): number {
    const pixels = (width ?? 0) * (height ?? 0);
    if (pixels >= 1920 * 1080) return 6_000_000;
    if (pixels >= 1280 * 720) return 3_500_000;
    if (pixels > 0) return 2_000_000;
    return 3_500_000;
  }

  /**
   * 调屏幕共享发送端的编码参数。必须在 setLocalDescription 之后调用 ——
   * encodings 只有协商出编解码器之后才非空，之前调 setParameters 拿不到可写的数组。
   *
   * 两件事：
   *  - degradationPreference 默认是 balanced：带宽一紧张先牺牲帧率。直播看起来就是卡，
   *    所以固定成 maintain-framerate（保帧率、必要时降分辨率）。
   *  - 补上按分辨率的 maxBitrate 天花板 + 采集端的帧率上限。
   */
  async function applyScreenShareSenderParameters(peer: RTCPeerConnection): Promise<void> {
    try {
      const track = screenShareLocalStream?.getVideoTracks()[0];
      if (!track) return;
      const sender = peer.getSenders().find((candidate) => candidate.track === track);
      if (!sender) return;
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) return;
      const settings = track.getSettings();
      const width = typeof settings.width === "number" ? settings.width : null;
      const height = typeof settings.height === "number" ? settings.height : null;
      const frameRate = typeof settings.frameRate === "number" ? Math.round(settings.frameRate) : null;
      const ceiling = screenShareBitrateCeiling(width, height);
      parameters.degradationPreference = "maintain-framerate";
      parameters.encodings = parameters.encodings.map((encoding) => ({
        ...encoding,
        maxBitrate: ceiling,
        ...(frameRate ? { maxFramerate: frameRate } : {}),
      }));
      await sender.setParameters(parameters);
    } catch {
      // 老浏览器可能拒绝 degradationPreference 或重写 encodings；
      // 失败就退回浏览器默认，不影响出画面。
    }
  }

  function preferScreenShareCodecs(peer: RTCPeerConnection): void {
    const transceiver = peer.getTransceivers().find((candidate) => candidate.sender.track?.kind === "video" || candidate.receiver.track?.kind === "video");
    const capabilities = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null;
    if (!transceiver?.setCodecPreferences || !capabilities?.codecs?.length) return;
    const vp8 = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/vp8");
    if (!vp8.length) return;
    const remaining = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() !== "video/vp8");
    try { transceiver.setCodecPreferences([...vp8, ...remaining]); } catch { /* older browsers may reject codec preference changes */ }
  }

  async function flushScreenShareCandidates(peerId: string, peer: RTCPeerConnection): Promise<void> {
    const pending = screenSharePendingIce.get(peerId) ?? [];
    screenSharePendingIce.delete(peerId);
    for (const candidate of pending) {
      try { await peer.addIceCandidate(candidate); } catch { /* an obsolete candidate can be ignored */ }
    }
  }

  async function startScreenShareViewer(stream: ScreenShareStream): Promise<void> {
    closeAllScreenSharePeers();
    screenShareRemoteStream.value = null;
    screenShareViewing.value = true;
    screenShareViewingStreamId.value = stream.streamId;
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    const peer = createScreenSharePeer(stream.streamId, stream.ownerPeerId, "viewer");
    if (stream.source === "teamspeak") {
      armScreenSharePeerTimer(stream.ownerPeerId);
      return;
    }
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      armScreenSharePeerTimer(stream.ownerPeerId);
      sendScreenShareMessage({
        type: "screenShareSignal",
        streamId: stream.streamId,
        targetPeerId: stream.ownerPeerId,
        signal: { kind: "offer", sdp: peer.localDescription?.sdp ?? offer.sdp ?? "" },
      });
    } catch {
      failScreenSharePeer(stream.ownerPeerId, "无法创建屏幕共享直连请求，请重试");
    }
  }

  async function startNativeScreenShareViewer(streamId: string, peerId: string): Promise<void> {
    const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
    if (!stream || stream.source !== "browser" || screenShareActiveStreamId.value !== streamId || stream.ownerPeerId !== screenShareLocalPeerId()) return;
    closeScreenSharePeer(peerId);
    const peer = createScreenSharePeer(streamId, peerId, "owner");
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      void applyScreenShareSenderParameters(peer);
      armScreenSharePeerTimer(peerId);
      sendScreenShareMessage({
        type: "screenShareSignal",
        streamId,
        targetPeerId: peerId,
        signal: { kind: "offer", sdp: peer.localDescription?.sdp ?? offer.sdp ?? "" },
      });
    } catch {
      failScreenSharePeer(peerId, "无法为 TeamSpeak 观看端创建屏幕共享直连");
    }
  }

  async function handleScreenShareSignal(streamId: string, fromPeerId: string, signal: ScreenShareSignal): Promise<void> {
    const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
    if (!stream) return;
    if (signal.kind === "close") {
      closeScreenSharePeer(fromPeerId);
      if (screenShareViewingStreamId.value === streamId) {
        screenShareViewing.value = false;
        screenShareViewingStreamId.value = "";
        screenShareRemoteStream.value = null;
      }
      return;
    }
    if (signal.kind === "iceCandidate") {
      if (!signal.candidate) return;
      const peer = screenSharePeers.get(fromPeerId);
      const candidate: RTCIceCandidateInit = {
        candidate: signal.candidate,
        ...(signal.sdpMid !== undefined ? { sdpMid: signal.sdpMid } : {}),
        ...(signal.sdpMLineIndex !== undefined ? { sdpMLineIndex: signal.sdpMLineIndex } : {}),
      };
      if (!peer?.remoteDescription) {
        screenSharePendingIce.set(fromPeerId, [...(screenSharePendingIce.get(fromPeerId) ?? []), candidate]);
        return;
      }
      try { await peer.addIceCandidate(candidate); } catch { /* stale ICE is not fatal */ }
      return;
    }

    if (stream.source === "teamspeak" && screenShareViewingStreamId.value === streamId && fromPeerId === stream.ownerPeerId && signal.kind === "offer") {
      const peer = screenSharePeers.get(fromPeerId) ?? createScreenSharePeer(streamId, fromPeerId, "viewer");
      if (!signal.sdp) return;
      armScreenSharePeerTimer(fromPeerId);
      try {
        await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await flushScreenShareCandidates(fromPeerId, peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendScreenShareMessage({ type: "screenShareSignal", streamId, targetPeerId: fromPeerId, signal: { kind: "answer", sdp: answer.sdp ?? "" } });
      } catch {
        failScreenSharePeer(fromPeerId, "无法回复 TeamSpeak 屏幕共享的直连请求");
      }
      return;
    }

    if (stream.source === "browser" && screenShareActiveStreamId.value === streamId && stream.ownerPeerId === screenShareLocalPeerId() && fromPeerId.startsWith("ts-viewer-") && signal.kind === "answer") {
      const peer = screenSharePeers.get(fromPeerId);
      if (!peer || !signal.sdp) return;
      try {
        await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        await flushScreenShareCandidates(fromPeerId, peer);
      } catch {
        failScreenSharePeer(fromPeerId, "TeamSpeak 观看端无法完成屏幕共享直连协商");
      }
      return;
    }

    if (stream.source === "browser" && stream.ownerPeerId === fromPeerId && signal.kind === "answer") {
      const peer = screenSharePeers.get(fromPeerId);
      if (!peer || !signal.sdp) return;
      try {
        await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        await flushScreenShareCandidates(fromPeerId, peer);
      } catch {
        failScreenSharePeer(fromPeerId, "观看端无法完成屏幕共享直连协商");
      }
      return;
    }

    if (screenShareActiveStreamId.value === streamId && stream.ownerPeerId === screenShareLocalPeerId()) {
      const peer = screenSharePeers.get(fromPeerId) ?? createScreenSharePeer(streamId, fromPeerId, "owner");
      if (signal.kind !== "offer" || !signal.sdp) return;
      armScreenSharePeerTimer(fromPeerId);
      try {
        await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await flushScreenShareCandidates(fromPeerId, peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        void applyScreenShareSenderParameters(peer);
        sendScreenShareMessage({ type: "screenShareSignal", streamId, targetPeerId: fromPeerId, signal: { kind: "answer", sdp: answer.sdp ?? "" } });
      } catch {
        setScreenShareP2PError("共享端无法完成观看者的直连协商");
      }
    }
  }

  // The owner peer id is generated by the gateway and is returned in the
  // screenShareStarted event; the active stream's owner id is therefore the
  // only stable local-owner marker available to the browser.
  function screenShareLocalPeerId(): string {
    const active = screenShareStreams.find((stream) => stream.streamId === screenShareActiveStreamId.value);
    return active?.ownerPeerId ?? "";
  }

  async function startScreenShare(audio = true, settings?: ScreenShareCaptureSettings): Promise<void> {
    if (ws.value?.readyState !== WebSocket.OPEN || screenShareActive.value || screenShareStarting.value) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      screenShareError.value = "当前浏览器不支持屏幕共享";
      return;
    }
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    const startGeneration = ++screenShareStartGeneration;
    screenShareStarting.value = true;
    screenShareStartCancelled = false;
    const videoConstraints: MediaTrackConstraints = {
      ...(settings?.maxWidth && settings?.maxHeight ? {
        width: { ideal: settings.maxWidth, max: settings.maxWidth },
        height: { ideal: settings.maxHeight, max: settings.maxHeight },
      } : {}),
      ...(settings?.maxFrameRate ? { frameRate: { ideal: settings.maxFrameRate, max: settings.maxFrameRate } } : {}),
    };
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio });
      if (startGeneration !== screenShareStartGeneration || !screenShareStarting.value || screenShareStartCancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("NO_VIDEO_TRACK");
      try {
        // Apply the cap once more after the browser's source picker returns.
        // Some Chromium versions treat getDisplayMedia constraints as hints
        // and only enforce the final capture size on the selected track.
        await videoTrack.applyConstraints(videoConstraints);
      } catch {
        // The selected source can still be shared when a browser refuses an
        // optional display-capture constraint; the actual settings remain
        // visible in the WebRTC diagnostics panel.
      }
      screenShareLocalStream = stream;
      // 显示采集轨默认按「文本/细节」语义编码 —— 清晰度优先，帧率第一个被牺牲。
      // 用户选了 >=30fps 说明要的是流畅（放视频/游戏），设成 motion；
      // 选低帧率通常是在共享文档/代码，保留 text 让文字更锐利。
      if ("contentHint" in videoTrack) {
        videoTrack.contentHint = (settings?.maxFrameRate ?? 30) >= 30 ? "motion" : "text";
      }
      screenShareRequestSequence = (screenShareRequestSequence + 1) % 1_000_000;
      screenSharePendingStartId = `screen-start-${screenShareRequestSequence}`;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => { void stopScreenShare(); }, { once: true });
      sendScreenShareMessage({ type: "screenShareStart", requestId: screenSharePendingStartId, audio: stream.getAudioTracks().length > 0, name: "我的屏幕" });
    } catch (error: unknown) {
      if (startGeneration !== screenShareStartGeneration) return;
      screenShareLocalStream?.getTracks().forEach((track) => track.stop());
      screenShareLocalStream = null;
      screenShareStarting.value = false;
      screenSharePendingStartId = "";
      screenShareStartCancelled = false;
      if (error instanceof DOMException && error.name === "NotAllowedError") screenShareError.value = "你取消了屏幕共享或浏览器未授予权限";
      else screenShareError.value = "无法开始屏幕共享，请检查浏览器权限";
    }
  }

  function stopScreenShare(): void {
    screenShareStartGeneration += 1;
    if (screenShareStarting.value) screenShareStartCancelled = true;
    if (screenShareActive.value && screenShareActiveStreamId.value) sendScreenShareMessage({ type: "screenShareStop", streamId: screenShareActiveStreamId.value });
    closeAllScreenSharePeers();
    screenShareLocalStream?.getTracks().forEach((track) => track.stop());
    screenShareLocalStream = null;
    screenShareStarting.value = false;
    screenSharePendingStartId = "";
    screenShareStartCancelled = false;
    screenShareActive.value = false;
    screenShareActiveStreamId.value = "";
  }

  function joinScreenShare(streamId: string): void {
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    if (screenShareViewingStreamId.value && screenShareViewingStreamId.value !== streamId) leaveScreenShare();
    screenShareRequestSequence = (screenShareRequestSequence + 1) % 1_000_000;
    sendScreenShareMessage({ type: "screenShareJoin", streamId, requestId: `screen-join-${screenShareRequestSequence}` });
  }

  function leaveScreenShare(): void {
    if (screenShareViewingStreamId.value) sendScreenShareMessage({ type: "screenShareLeave", streamId: screenShareViewingStreamId.value });
    closeAllScreenSharePeers();
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
  }

  function stopScreenShareTransport(sendStop: boolean): void {
    screenShareStartGeneration += 1;
    if (sendStop && screenShareActive.value && screenShareActiveStreamId.value) sendScreenShareMessage({ type: "screenShareStop", streamId: screenShareActiveStreamId.value });
    if (screenShareStarting.value) screenShareStartCancelled = true;
    closeAllScreenSharePeers();
    screenShareLocalStream?.getTracks().forEach((track) => track.stop());
    screenShareLocalStream = null;
    screenShareStarting.value = false;
    screenSharePendingStartId = "";
    screenShareStartCancelled = false;
    screenShareActive.value = false;
    screenShareActiveStreamId.value = "";
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
    screenShareStreams.length = 0;
  }

  function upsertScreenShareStream(raw: unknown): ScreenShareStream | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<ScreenShareStream>;
    if (typeof value.streamId !== "string" || typeof value.ownerPeerId !== "string") return null;
    const stream: ScreenShareStream = {
      streamId: value.streamId,
      source: value.source === "teamspeak" ? "teamspeak" : "browser",
      ownerPeerId: value.ownerPeerId,
      ...(typeof value.ownerClientId === "number" ? { ownerClientId: value.ownerClientId } : {}),
      ownerNickname: typeof value.ownerNickname === "string" ? value.ownerNickname : "TeamSpeak 用户",
      name: typeof value.name === "string" ? value.name : "屏幕共享",
      audio: value.audio === true,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
      viewerCount: typeof value.viewerCount === "number" ? value.viewerCount : 0,
      viewers: normalizeScreenShareViewers(value.viewers),
    };
    const index = screenShareStreams.findIndex((candidate) => candidate.streamId === stream.streamId);
    if (index >= 0) screenShareStreams.splice(index, 1, stream);
    else screenShareStreams.push(stream);
    return stream;
  }

  function normalizeScreenShareViewers(raw: unknown): ScreenShareViewer[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((viewer): viewer is ScreenShareViewer => Boolean(viewer) && typeof viewer === "object" && typeof (viewer as ScreenShareViewer).peerId === "string" && typeof (viewer as ScreenShareViewer).nickname === "string")
      .slice(0, 64)
      .map((viewer) => ({
        peerId: viewer.peerId.slice(0, 128),
        nickname: viewer.nickname.slice(0, 120),
        ...(typeof viewer.avatar === "string" && viewer.avatar.length <= 128 * 1024 ? { avatar: viewer.avatar } : {}),
      }));
  }

  function handleMessage(msg: any): void {
    recentMessageTypes.push(String(msg?.type));
    if (recentMessageTypes.length > 15) recentMessageTypes.shift();
    switch (msg.type) {
      case "connected":
        const wasReconnecting = state.reconnecting;
        clearConnectWatchdog();
        clearReconnectWatchdog();
        state.connected = true;
        markActiveSessionEstablished();
        state.connecting = false;
        state.reconnecting = false;
        state.reconnectAttempt = 0;
        state.reconnectFailed = false;
        state.error = "";
        state.errorCode = "";
        state.channelSwitchedChannelId = "";
        state.tsClientId = Number(msg.tsClientId) || 0;
        // The mute preference is local to the browser, while TeamSpeak shows
        // the gateway's own client_input_muted flag to other clients. Send it
        // as soon as the session is ready so a muted reconnect is visible to
        // native TeamSpeak users even before WebRTC negotiation completes.
        sendCmd("setMicrophoneMuted", { muted: microphoneMuted.value });
        screenShareIceServers = normalizeScreenShareIceServers(msg.screenShareIceServers);
        applyWhisperState(msg.whisperTargetIds, msg.whisperActive);
        if (Array.isArray(msg.members)) {
          members.length = 0;
          for (const member of msg.members) {
            members.push({ ...member, isSelf: Number(member.id) === state.tsClientId });
          }
          syncKnownMemberVolumes();
        }
        serverEvents.length = 0;
        if (Array.isArray(msg.serverEventLog)) serverEvents.push(...msg.serverEventLog);
        if (typeof msg.identity === "string" && msg.identity.length <= 8192) {
          identityMaterial.value = msg.identity;
          if (lastConnection) lastConnection.identity = msg.identity;
        }
        // SFU 的 slot 数必须与服务端一致，否则 offer 的 m-line 数量对不上。
        if (typeof msg.webrtcSlotCount === "number" && Number.isInteger(msg.webrtcSlotCount) && msg.webrtcSlotCount >= 1) {
          webrtcSlotCount.value = msg.webrtcSlotCount;
        }
        if (wasReconnecting) {
          const start = msg.webrtcAvailable === true && typeof RTCPeerConnection !== "undefined"
            ? (ws.value ? startWebRtcTransport(connectionSequence, ws.value) : Promise.resolve())
            : ensureMicrophone();
          // A failed microphone must not look like a failed connection: record it
          // as an audio diagnostic so the room stays visible with a clear reason.
          start.catch((error: unknown) => { setMicrophoneError(error); });
        } else if (msg.webrtcAvailable === true && typeof RTCPeerConnection !== "undefined" && ws.value) {
          void startWebRtcTransport(connectionSequence, ws.value).catch((error: unknown) => { setMicrophoneError(error); });
        } else {
          // 走兼容（WS）通道：缺 WebCodecs 时上行还在、但听不到任何人，必须先说清楚。
          if (compatibilityPlaybackUnavailable()) {
            setAudioNotice("COMPATIBILITY_PLAYBACK_UNSUPPORTED", COMPATIBILITY_PLAYBACK_NOTICE);
          }
          void ensureMicrophone().catch((error: unknown) => { setMicrophoneError(error); });
        }
        sendScreenShareMessage({ type: "screenShareList" });
        break;
      case "screenShareList":
        screenShareStreams.length = 0;
        if (Array.isArray(msg.streams)) for (const raw of msg.streams) upsertScreenShareStream(raw);
        break;
      case "screenShareStarted": {
        const stream = upsertScreenShareStream(msg.stream);
        if (!stream) break;
        if (msg.owner === true) {
          const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
          const isCurrentStart = Boolean(screenSharePendingStartId) && requestId === screenSharePendingStartId && !screenShareStartCancelled;
          screenSharePendingStartId = "";
          screenShareStarting.value = false;
          if (!isCurrentStart) {
            sendScreenShareMessage({ type: "screenShareStop", streamId: stream.streamId });
            screenShareLocalStream?.getTracks().forEach((track) => track.stop());
            screenShareLocalStream = null;
            const staleIndex = screenShareStreams.findIndex((candidate) => candidate.streamId === stream.streamId);
            if (staleIndex >= 0) screenShareStreams.splice(staleIndex, 1);
            break;
          }
          screenShareActive.value = true;
          screenShareActiveStreamId.value = stream.streamId;
        }
        break;
      }
      case "screenShareViewerCount": {
        const stream = screenShareStreams.find((candidate) => candidate.streamId === String(msg.streamId || ""));
        if (stream) {
          if (typeof msg.viewerCount === "number") stream.viewerCount = Math.max(0, Math.floor(msg.viewerCount));
          if (Array.isArray(msg.viewers)) stream.viewers = normalizeScreenShareViewers(msg.viewers);
        }
        break;
      }
      case "screenShareStopped": {
        const streamId = String(msg.streamId || "");
        const index = screenShareStreams.findIndex((candidate) => candidate.streamId === streamId);
        if (index >= 0) screenShareStreams.splice(index, 1);
        if (screenShareActiveStreamId.value === streamId) {
          closeAllScreenSharePeers();
          screenShareStarting.value = false;
          screenSharePendingStartId = "";
          screenShareStartCancelled = false;
          screenShareActive.value = false;
          screenShareActiveStreamId.value = "";
          screenShareLocalStream?.getTracks().forEach((track) => track.stop());
          screenShareLocalStream = null;
        }
        if (screenShareViewingStreamId.value === streamId) {
          closeAllScreenSharePeers();
          screenShareViewing.value = false;
          screenShareViewingStreamId.value = "";
          screenShareRemoteStream.value = null;
        }
        break;
      }
      case "screenShareJoined": {
        const stream = upsertScreenShareStream(msg.stream);
        if (!stream) break;
        void startScreenShareViewer(stream);
        break;
      }
      case "screenShareNativeViewerJoined":
        if (typeof msg.streamId === "string" && typeof msg.viewerPeerId === "string") {
          void startNativeScreenShareViewer(msg.streamId, msg.viewerPeerId);
        }
        break;
      case "screenShareSignal":
        if (typeof msg.streamId === "string" && typeof msg.fromPeerId === "string" && msg.signal) {
          void handleScreenShareSignal(msg.streamId, msg.fromPeerId, msg.signal as ScreenShareSignal);
        }
        break;
      case "screenShareViewerLeft":
        if (typeof msg.viewerPeerId === "string") closeScreenSharePeer(msg.viewerPeerId);
        break;
      case "screenShareLeft":
        if (screenShareViewingStreamId.value === String(msg.streamId || "")) leaveScreenShare();
        break;
      case "screenShareError":
        screenShareErrorCode.value = typeof msg.code === "string" ? msg.code : "";
        screenShareError.value = String(msg.message || "屏幕共享操作失败");
        if (screenShareStarting.value) {
          screenShareStarting.value = false;
          screenSharePendingStartId = "";
          screenShareStartCancelled = false;
          screenShareLocalStream?.getTracks().forEach((track) => track.stop());
          screenShareLocalStream = null;
        }
        if (screenShareViewing.value) {
          if (screenShareViewingStreamId.value) sendScreenShareMessage({ type: "screenShareLeave", streamId: screenShareViewingStreamId.value });
          closeAllScreenSharePeers();
          screenShareViewing.value = false;
          screenShareViewingStreamId.value = "";
          screenShareRemoteStream.value = null;
        }
        break;
      case "memberEnter":
        if (!members.some((member) => member.id === msg.id)) {
          members.push({ id: msg.id, nickname: msg.nickname, uid: typeof msg.uid === "string" ? msg.uid : undefined, avatar: typeof msg.avatar === "string" ? msg.avatar : undefined, isSelf: Boolean(msg.isSelf) });
          syncKnownMemberVolumes();
        }
        break;
      case "memberLeave": {
        const clientId = Number(msg.id);
        clearSpeaking(clientId);
        clearRemotePlayback(clientId);
        const index = members.findIndex((member) => member.id === clientId);
        if (index >= 0) members.splice(index, 1);
        break;
      }
      case "channelList":
        channels.length = 0;
        if (Array.isArray(msg.channels)) {
          for (const channel of msg.channels) channels.push(channel);
        }
        syncKnownMemberVolumes();
        refreshRestorableChannel();
        break;
      case "memberAvatar": {
        const clientId = Number(msg.id);
        const uid = typeof msg.uid === "string" ? msg.uid : "";
        const avatar = typeof msg.avatar === "string" ? msg.avatar : "";
        const member = members.find((candidate) => candidate.id === clientId && (!uid || candidate.uid === uid));
        if (member) member.avatar = avatar || undefined;
        for (const channel of channels) {
          const channelMember = channel.members?.find((candidate) => candidate.id === clientId && (!uid || candidate.uid === uid));
          if (channelMember) channelMember.avatar = avatar || undefined;
        }
        break;
      }
      case "chatMessage":
        if (Number(msg.invokerId) === state.tsClientId) break;
        const incomingScope = msg.scope === "private" || msg.scope === "server" || msg.scope === "channel" ? msg.scope : "system";
        const rawTargetId = typeof msg.targetId === "string" || typeof msg.targetId === "number" ? String(msg.targetId) : undefined;
        // Older gateways and TeamSpeak channel notifications may use 0 as
        // the broadcast sentinel. It must not be compared with a channel id.
        const incomingTargetId = rawTargetId && rawTargetId !== "0" ? rawTargetId : undefined;
        chatMessages.push({
          id: `remote-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          scope: incomingScope,
          ...(incomingTargetId ? { targetId: incomingTargetId } : {}),
          ...(incomingScope === "private" ? { conversationId: String(Number(msg.invokerId) || 0) } : {}),
          senderId: Number(msg.invokerId) || undefined,
          senderUid: typeof msg.senderUid === "string" ? msg.senderUid : undefined,
          invokerName: String(msg.invokerName || "Unknown"),
          message: String(msg.message || ""),
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
        });
        break;
      case "serverEvent":
        if (msg.event && typeof msg.event.id === "string") serverEvents.push(msg.event as ServerEvent);
        break;
      case "pokeReceived":
        pokeNotifications.push({
          id: `poke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          invokerId: Number(msg.invokerId) || 0,
          invokerUid: typeof msg.invokerUid === "string" ? msg.invokerUid : "",
          invokerName: String(msg.invokerName || "Unknown"),
          message: String(msg.message || ""),
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
        });
        break;
      case "channelSwitched":
        state.channelSwitchedChannelId = typeof msg.channelId === "string" || typeof msg.channelId === "number" ? String(msg.channelId) : "";
        state.error = "";
        state.errorCode = "";
        break;
      case "latencyPong": {
        const sequence = typeof msg.sequence === "string" ? msg.sequence : "";
        const pending = pendingLatencyProbes.get(sequence);
        if (!pending) break;
        pendingLatencyProbes.delete(sequence);
        clearTimeout(pending.timer);
        pending.resolve({
          browserRttMs: Math.max(0, Math.round(performance.now() - pending.startedAt)),
          teamSpeakLatencyMs: typeof msg.teamSpeakLatencyMs === "number" ? msg.teamSpeakLatencyMs : null,
          teamSpeakReachable: msg.teamSpeakReachable === true,
          ...(typeof msg.teamSpeakErrorCode === "string" ? { teamSpeakErrorCode: msg.teamSpeakErrorCode } : {}),
        });
        break;
      }
      case "disconnected":
        state.connected = false;
        state.connecting = false;
        state.reconnecting = Boolean(msg.recoverable !== false);
        state.reconnectFailed = false;
        if (!state.reconnecting) state.error = "TeamSpeak 连接已断开";
        else armReconnectWatchdog();
        stopWebRtcTransport();
        stopScreenShareTransport(false);
        stopMicrophone();
        whisperTargetIds.clear();
        whisperActive.value = false;
        break;
      case "reconnecting":
        state.connected = false;
        state.connecting = false;
        state.reconnecting = true;
        state.reconnectFailed = false;
        state.reconnectAttempt = Number(msg.attempt) || state.reconnectAttempt + 1;
        armReconnectWatchdog();
        stopWebRtcTransport();
        stopScreenShareTransport(false);
        stopMicrophone();
        whisperTargetIds.clear();
        whisperActive.value = false;
        break;
      case "reconnected":
        clearReconnectWatchdog();
        state.reconnecting = false;
        state.reconnectFailed = false;
        break;
      case "reconnectFailed":
        clearReconnectWatchdog();
        // 重连窗口已耗尽：这条会话结束了，刷新不该再自动重连（否则会反复撞同一面墙）。
        clearActiveSession();
        state.connected = false;
        state.connecting = false;
        state.reconnecting = false;
        state.reconnectFailed = true;
        state.errorCode = normalizedClientErrorCode(msg.code);
        state.error = connectionFailureMessage(state.errorCode, msg.detail);
        stopScreenShareTransport(false);
        whisperTargetIds.clear();
        whisperActive.value = false;
        break;
      case "connectionFailed":
        clearConnectWatchdog();
        clearReconnectWatchdog();
        // 服务端明确说这次连接失败了（密码错、被封禁、身份被占用、服务器满…）：
        // 刷新后自动重连只会再失败一次，所以清掉恢复记录，让用户看到表单和原因。
        clearActiveSession();
        state.connected = false;
        state.connecting = false;
        state.reconnecting = false;
        // This is the first connection attempt, not a failed reconnect. Keep
        // the user on the welcome form instead of showing an empty voice room.
        state.reconnectFailed = false;
        state.errorCode = normalizedClientErrorCode(msg.code);
        state.error = connectionFailureMessage(state.errorCode, msg.detail);
        stopScreenShareTransport(false);
        whisperTargetIds.clear();
        whisperActive.value = false;
        break;
      case "whisperTargets":
        applyWhisperState(msg.targetIds, msg.active);
        break;
      case "webrtcAnswer":
        void applyWebRtcAnswer(msg.payload?.sdp);
        break;
      case "webrtcError":
        if (ws.value) void fallbackFromWebRtc(connectionSequence, ws.value, safeClientErrorCode(msg.code) || "WEBRTC_NEGOTIATION_FAILED");
        break;
      case "audioError": {
        // The gateway could not encode our microphone audio (for example its Opus
        // encoder is unavailable): say it instead of dropping frames silently.
        const audioCode = safeClientErrorCode(msg.code) || "AUDIO_ERROR";
        setAudioNotice(audioCode, audioNoticeMessage(audioCode, msg.detail));
        break;
      }
      case "speakerMap":
        // SFU：服务端下发 slot → clientId 映射。slot 数固定，说话人进出只改
        // 归属，不重协商。
        if (msg.slots && typeof msg.slots === "object" && !Array.isArray(msg.slots)) {
          const slots: Record<string, number> = {};
          for (const [slotText, clientId] of Object.entries(msg.slots as Record<string, unknown>)) {
            if (typeof clientId === "number" && Number.isInteger(clientId) && clientId > 0) slots[slotText] = clientId;
          }
          applySpeakerMap(slots);
        }
        break;
      case "voiceActivity":
        if (Array.isArray(msg.clientIds)) {
          for (const clientId of msg.clientIds) {
            if (typeof clientId === "number" && Number.isInteger(clientId) && clientId > 0) markSpeaking(clientId);
          }
        }
        break;
      case "commandCompleted": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        const pending = requestId ? pendingCommands.get(requestId) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(requestId);
          pending.resolve();
        }
        break;
      }
      case "error":
        state.errorCode = normalizedClientErrorCode(msg.error?.code, "OPERATION_FAILED");
        state.error = protocolErrorMessage(state.errorCode, String(msg.error?.message || msg.message || "操作失败"));
        {
          const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
          const pending = requestId ? pendingCommands.get(requestId) : undefined;
          if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(requestId);
            const error = new Error(state.error);
            Object.assign(error, { code: state.errorCode });
            pending.reject(error);
          }
        }
        break;
      case "channelInfo":
      case "channelInfoUnavailable": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        const pending = requestId ? pendingChannelInfos.get(requestId) : undefined;
        if (!pending) break;
        clearTimeout(pending.timer);
        pendingChannelInfos.delete(requestId);
        const channelId = typeof msg.channelId === "string" ? msg.channelId : "";
        if (msg.type === "channelInfoUnavailable" || !channelId) {
          pending.resolve(null);
          break;
        }
        const details: ChannelInfoDetails = {
          id: channelId,
          name: typeof msg.name === "string" ? msg.name : "",
          topic: typeof msg.topic === "string" ? msg.topic : "",
          description: typeof msg.description === "string" ? msg.description : "",
        };
        channelInfos[channelId] = details;
        pending.resolve(details);
        break;
      }
    }
  }

  function handleAudioFrame(data: Uint8Array): void {
    // WebRTC carries the realtime downlink after negotiation. Ignore any
    // in-flight fallback WebSocket packets so a transport switch cannot
    // produce duplicate or delayed playback.
    if (webrtcActive.value) return;
    if (data.length < 4) return;
    const clientId = (data[1] << 8) | data[2];
    if (clientId === state.tsClientId) return;
    markSpeaking(clientId);
    playAudioFrame(clientId, data.slice(3));
  }

  function sendCmd(type: string, payload: Record<string, unknown> = {}, requestId = ""): void {
    if (ws.value?.readyState === WebSocket.OPEN) ws.value.send(JSON.stringify({ type, payload, ...(requestId ? { requestId } : {}) }));
  }

  function sendCommandAndWait(type: string, payload: Record<string, unknown>, timeoutMs = 8_000): Promise<void> {
    if (ws.value?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("语音连接尚未就绪"));
    const requestId = `command-${Date.now().toString(36)}-${(commandSequence++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(requestId);
        reject(new Error("操作超时，请稍后重试"));
      }, timeoutMs);
      pendingCommands.set(requestId, { resolve, reject, timer });
      sendCmd(type, payload, requestId);
    });
  }

  function switchChannel(channelId: string, password = ""): void {
    state.error = "";
    state.errorCode = "";
    state.channelSwitchedChannelId = "";
    sendCmd("switchChannel", { channelId, ...(password ? { password } : {}) });
  }

  function moveClient(clientId: number, channelId: string, password = ""): Promise<void> {
    return sendCommandAndWait("moveClient", { clientId, channelId, ...(password ? { password } : {}) });
  }

  /**
   * 取单个频道的详情（含「频道说明」）。
   *
   * 与 sendCommandAndWait 的区别：说明是可选信息，失败不应冒泡成全局错误提示，
   * 所以这里自带缓存、超时和"拿不到就返回 null"的语义，由调用方决定空态展示。
   */
  function requestChannelInfo(channelId: string, timeoutMs = 8_000): Promise<ChannelInfoDetails | null> {
    const cached = channelInfos[channelId];
    if (cached) return Promise.resolve(cached);
    const socket = ws.value;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const requestId = `channel-info-${Date.now().toString(36)}-${(channelInfoSequence++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingChannelInfos.delete(requestId);
        resolve(null);
      }, timeoutMs);
      pendingChannelInfos.set(requestId, { resolve, timer });
      sendCmd("channelInfo", { channelId }, requestId);
    });
  }

  function clearChannelInfoRequests(details: ChannelInfoDetails | null = null): void {
    for (const [requestId, pending] of pendingChannelInfos) {
      clearTimeout(pending.timer);
      pendingChannelInfos.delete(requestId);
      pending.resolve(details);
    }
  }

  function resetChannelInfos(): void {
    clearChannelInfoRequests();
    for (const channelId of Object.keys(channelInfos)) delete channelInfos[channelId];
  }

  function measureLatency(timeoutMs = 2_200): Promise<LatencyProbeResult | null> {
    const socket = ws.value;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const sequence = `latency-${Date.now().toString(36)}-${(latencyProbeSequence++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingLatencyProbes.delete(sequence);
        resolve(null);
      }, timeoutMs);
      pendingLatencyProbes.set(sequence, { startedAt: performance.now(), resolve, timer });
      sendCmd("latencyProbe", { sequence });
    });
  }

  /**
   * 采样 WebRTC 媒体路径指标。
   *
   * RTT 取自被选中的 ICE 候选对（`currentRoundTripTime`），也就是浏览器与网关
   * 实际走的那条 UDP 路径；丢包与抖动取自入站 RTP 的累计计数器。这条路径与
   * WebSocket 控制通道完全独立 —— WebRTC 启用后音频不再经过 WebSocket。
   *
   * 返回 null 表示当前没有可测的媒体路径：WebRTC 未启用（兼容传输），或尚未
   * 协商出候选对。调用方应把 null 当作"不可测"而不是"延迟为 0"。
   */
  async function sampleMediaPath(): Promise<MediaPathStats | null> {
    const peer = webrtcPeer;
    if (!peer || !webrtcActive.value) return null;
    try {
      const report = await peer.getStats();
      const pairRtts: number[] = [];
      const jitters: number[] = [];
      let packetsLost = 0;
      let packetsReceived = 0;
      report.forEach((entry: Record<string, unknown>) => {
        if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated === true && typeof entry.currentRoundTripTime === "number") {
          pairRtts.push(entry.currentRoundTripTime * 1000);
        } else if (entry.type === "inbound-rtp" && entry.kind === "audio") {
          if (typeof entry.packetsLost === "number") packetsLost += entry.packetsLost;
          if (typeof entry.packetsReceived === "number") packetsReceived += entry.packetsReceived;
          if (typeof entry.jitter === "number") jitters.push(entry.jitter * 1000);
        }
      });
      const totalPackets = packetsLost + packetsReceived;
      return {
        rttMs: pairRtts.length ? Math.round(Math.min(...pairRtts)) : null,
        packetsLost,
        packetsReceived,
        lossPercent: totalPackets > 0 ? Math.round((packetsLost / totalPackets) * 100) : null,
        jitterMs: jitters.length ? Math.round(Math.max(...jitters)) : null,
      };
    } catch {
      // peer 正在关闭时 getStats() 会抛错。这只是一次采样失败，不是错误状态。
      return null;
    }
  }

  function sendTextMessage(message: string, targetId = ""): void {
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > 500) return;
    sendCmd("sendTextMessage", { message: trimmed });
    chatMessages.push({
      id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      scope: "channel",
      ...(targetId ? { targetId } : {}),
      senderId: state.tsClientId,
      invokerName: "你",
      message: trimmed,
      timestamp: Date.now(),
      isSelf: true,
    });
  }

  function sendServerMessage(message: string): void {
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > 500) return;
    sendCmd("sendServerMessage", { message: trimmed });
    chatMessages.push({ id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, scope: "server", senderId: state.tsClientId, invokerName: "你", message: trimmed, timestamp: Date.now(), isSelf: true });
  }

  function sendPrivateMessage(clientId: number, message: string, targetId = ""): void {
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > 500) return;
    sendCmd("sendPrivateMessage", { clientId, message: trimmed });
    chatMessages.push({ id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, scope: "private", targetId, conversationId: String(clientId), senderId: state.tsClientId, invokerName: "你", message: trimmed, timestamp: Date.now(), isSelf: true });
  }

  function sendPoke(clientId: number, message = ""): void {
    sendCmd("poke", { clientId, message: message.trim().slice(0, 200) });
  }

  function setAway(away: boolean, message = ""): void {
    sendCmd("setAway", { away, message: message.trim().slice(0, 200) });
  }

  function setWhisperTargets(clientIds: number[]): void {
    const targets = [...new Set(clientIds)].filter((clientId) => Number.isInteger(clientId) && clientId > 0 && clientId <= 65535 && clientId !== state.tsClientId).slice(0, 8);
    whisperTargetIds.clear();
    for (const clientId of targets) whisperTargetIds.add(clientId);
    if (!targets.length) whisperActive.value = false;
    sendCmd("setWhisperTargets", { targetIds: targets });
  }

  function setWhisperActive(active: boolean): void {
    if (active && !whisperTargetIds.size) return;
    whisperActive.value = active;
    sendCmd("setWhisperActive", { active });
  }

  function applyWhisperState(targetIds: unknown, active: unknown): void {
    whisperTargetIds.clear();
    if (Array.isArray(targetIds)) {
      for (const clientId of targetIds) {
        if (typeof clientId === "number" && Number.isInteger(clientId) && clientId > 0 && clientId <= 65535 && clientId !== state.tsClientId) whisperTargetIds.add(clientId);
      }
    }
    whisperActive.value = active === true && whisperTargetIds.size > 0;
  }

  function reconnectNow(): void {
    if (!lastConnection || state.connecting) return;
    connect(lastConnection.target, lastConnection.channel, lastConnection.nickname, lastConnection.serverPassword, lastConnection.rememberIdentity ? identityMaterial.value || lastConnection.identity : "", lastConnection.rememberIdentity, "", lastConnection.accelerated, lastConnection.accelerationRelayId);
  }

  function setMicrophoneMuted(muted: boolean): void {
    microphoneMuted.value = muted;
    voxAttack = 0;
    voxRelease = 0;
    accumLen = 0;
    if (webrtcActive.value) micStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    if (webrtcMixMicGain) webrtcMixMicGain.gain.value = muted ? 0 : inputVolume.value;
    // 会话可能是在"没有麦克风"的情况下走 WebRTC 开始的（只听模式）。
    // 这次开麦时把麦克风取回来，并替换 slot0 上那条静音轨。
    if (!muted && !micStream) {
      void ensureMicrophone()
        .then(() => (webrtcActive.value ? replaceWebRtcAudioTrack() : undefined))
        .catch(() => undefined);
    }
    sendCmd("setMicrophoneMuted", { muted });
    if (muted && state.tsClientId) clearSpeaking(state.tsClientId);
    void saveAudioPreferences();
  }

  function clearError(): void {
    state.error = "";
    state.errorCode = "";
  }

  function protocolErrorMessage(code: string, fallback: string): string {
    const messages: Record<string, string> = {
      INVALID_JSON: "消息格式无效",
      INVALID_MESSAGE: "消息格式无效",
      INVALID_REQUEST_ID: "请求标识无效",
      UNKNOWN_MESSAGE_TYPE: "不支持的操作",
      INVALID_PAYLOAD: "操作参数无效",
      INVALID_CHANNEL_ID: "频道标识无效",
      INVALID_CHANNEL_PASSWORD: "频道密码无效",
      INVALID_CLIENT_ID: "成员标识无效",
      INVALID_TEXT_MESSAGE: "文字消息无效",
      INVALID_POKE_MESSAGE: "戳一戳消息无效",
      INVALID_AWAY_STATUS: "离开状态无效",
      INVALID_AUDIO_FRAME: "音频帧格式无效",
      INVALID_MEMBER_VOLUME: "成员音量无效",
      INVALID_WHISPER_TARGETS: "私语目标无效",
      INVALID_WHISPER_STATE: "私语状态无效",
      NO_WHISPER_TARGETS: "请先选择私语目标",
      SESSION_NOT_READY: "TeamSpeak 会话尚未就绪",
      CHANNEL_SWITCH_FAILED: "频道切换失败",
      CHANNEL_PASSWORD_REQUIRED: "该频道需要密码",
      CHANNEL_FULL: "该频道已满",
      CANNOT_MOVE_SELF: "不能移动自己的客户端",
      CHANNEL_NOT_FOUND: "目标频道不可用",
      NICKNAME_IN_USE: "该昵称已被占用，请更换昵称",
      CLIENT_VERSION_OUTDATED: "客户端版本过旧，服务器拒绝了该操作",
      FLOOD_PROTECTION: "操作过于频繁，请稍后重试",
      BANNED: "你已被该服务器封禁",
      KICKED: "你已被服务器移出",
      PERMISSION_DENIED: "你没有执行此操作的权限",
      CLIENT_NOT_FOUND: "成员已离线",
      OPERATION_FAILED: "操作失败",
    };
    const normalized = normalizedClientErrorCode(code, "OPERATION_FAILED");
    if (messages[normalized]) return messages[normalized];
    const safeCode = safeClientErrorCode(normalized);
    const safeFallback = safeClientErrorDetail(fallback);
    return `操作失败（错误代码：${safeCode}）${safeFallback ? `：${safeFallback}` : ""}`;
  }

  function setVolume(clientId: number, volume: number): void {
    const normalized = Math.max(0, Math.min(4, volume));
    volumes[clientId] = normalized;
    const member = members.find((candidate) => candidate.id === clientId);
    if (member?.uid) {
      storedVolumesByUid[member.uid] = normalized;
      void saveAudioPreferences();
    }
    const gain = remoteGains.get(clientId);
    if (gain) gain.gain.value = normalized * effectiveOutputVolume();
    // SFU 下每个说话人一路 slot，成员音量落在该 slot 的 GainNode 上。只写
    // volumes 不会立刻改变声音 —— 必须重算各 slot 的增益。缺这一步时，改音量
    // 要等到下一次 applyOutputVolume()（例如切换自己的输出静音）才生效。
    syncSfuVolumes();
    if (webrtcPeer || webrtcActive.value) sendCmd("setMemberVolume", { clientId, volume: normalized });
  }

  /**
   * 成员音量在浏览器侧生效 —— SFU 下服务端不参与混音，不再需要把每个成员的
   * 音量发给服务端。
   */
  function syncWebRtcMemberVolumes(): void {
    if (!webrtcActive.value) return;
    syncSfuVolumes();
  }

  function setInputVolume(volume: number): void {
    inputVolume.value = Math.max(0, Math.min(1, volume));
    if (micGain) micGain.gain.value = inputVolume.value;
    if (webrtcMixMicGain) webrtcMixMicGain.gain.value = microphoneMuted.value ? 0 : inputVolume.value;
    void saveAudioPreferences();
  }

  async function setNoiseSuppressionEnabled(enabled: boolean): Promise<void> {
    if (noiseSuppressionEnabled.value === enabled) return;
    const shouldRestartWebRtc = webrtcActive.value && Boolean(ws.value);
    noiseSuppressionEnabled.value = enabled;
    void saveAudioPreferences();
    if (!micStream) return;
    try {
      if (shouldRestartWebRtc) stopWebRtcTransport();
      await startMicrophone();
      if (shouldRestartWebRtc && ws.value) await startWebRtcTransport(connectionSequence, ws.value);
    } catch (error) {
      // Same trap as setInputDevice: the transport was already torn down above,
      // so a failure here must rebuild the path (including telling the gateway to
      // drop the stale peer) rather than only reporting the error.
      setMicrophoneError(error);
      await recoverAudioAfterFailedInputChange(shouldRestartWebRtc);
    }
  }

  function setOutputVolume(volume: number): void {
    outputVolume.value = Math.max(0, Math.min(1, volume));
    applyOutputVolume();
    void saveAudioPreferences();
  }

  function toggleOutputMute(): void {
    outputMuted.value = !outputMuted.value;
    applyOutputVolume();
  }

  function setVoxThreshold(threshold: number): void {
    voxThreshold.value = clamp(threshold, 0.001, 0.08);
    void saveAudioPreferences();
  }

  function setNotificationVolume(volume: number): void {
    notificationVolume.value = clamp(volume, 0, 1);
    void saveAudioPreferences();
  }

  /**
   * 只读诊断出口。
   *
   * 出问题时从 DOM 上看不出播放状态（SFU 的 `<audio>` 元素是静音的 sink，
   * 真正出声的是 WebAudio 图），把它挂到 window 上，便于在浏览器控制台或
   * 自动化测试里直接读到 slot 绑定、增益与实时能量。不参与任何逻辑。
   */
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "__webspeakSfu", {
      configurable: true,
      get: () => ({
        speakerMap: { ...lastSpeakerMap },
        recentMessages: [...recentMessageTypes],
        audioContextState: audioCtx?.state ?? "none",
        slotCount: webrtcSlotCount.value,
        webrtcActive: webrtcActive.value,
        /** 浏览器侧实际协商的 SDP 与收发器状态。 */
        negotiation: () => {
          if (!webrtcPeer) return null;
          return {
            transceivers: webrtcPeer.getTransceivers().map((t) => ({
              mid: t.mid,
              direction: t.direction,
              currentDirection: t.currentDirection,
              senderTrack: t.sender?.track?.kind ?? null,
              receiverTrack: t.receiver?.track?.kind ?? null,
            })),
            offerSdp: webrtcPeer.localDescription?.sdp ?? null,
            answerSdp: webrtcPeer.remoteDescription?.sdp ?? null,
          };
        },
        /** 读取 WebRTC 接收统计，用来确认下行 RTP 是否真的到达浏览器。 */
        peerStats: async () => {
          if (!webrtcPeer) return null;
          const report = await webrtcPeer.getStats();
          const inbound: Array<Record<string, unknown>> = [];
          const pairs: Array<Record<string, unknown>> = [];
          let mediaPlayout: Record<string, unknown> | null = null;
          let outbound: Record<string, unknown> | null = null;
          report.forEach((entry: Record<string, unknown>) => {
            if (entry.type === "inbound-rtp") {
              inbound.push({
                mid: entry.mid,
                kind: entry.kind,
                ssrc: entry.ssrc,
                packetsReceived: entry.packetsReceived,
                bytesReceived: entry.bytesReceived,
                packetsLost: entry.packetsLost,
                jitter: entry.jitter,
                totalSamplesReceived: entry.totalSamplesReceived,
                concealedSamples: entry.concealedSamples,
                // 换源（slot 复用）时时间戳若不连续，这里会明显增长 ——
                // 比 concealedSamples 更能反映"换人后对端有没有被卡一下"。
                removedSamplesForAcceleration: entry.removedSamplesForAcceleration,
                insertedSamplesForDeceleration: entry.insertedSamplesForDeceleration,
                // 不受 NetEq 的 decoded_output_played_ 闸门影响：为 0 而
                // packetsReceived 在涨 ⇒ 接收流从未被拉取（缺 sink），
                // 而不是 RTP 层有问题。
                jitterBufferEmittedCount: entry.jitterBufferEmittedCount,
                jitterBufferDelay: entry.jitterBufferDelay,
                totalAudioEnergy: entry.totalAudioEnergy,
              });
            } else if (entry.type === "media-playout") {
              mediaPlayout = {
                totalSamplesDuration: entry.totalSamplesDuration,
                totalSamplesCount: entry.totalSamplesCount,
              };
            } else if (entry.type === "outbound-rtp" && entry.kind === "audio") {
              outbound = { packetsSent: entry.packetsSent, bytesSent: entry.bytesSent };
            } else if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated) {
              pairs.push({ bytesReceived: entry.bytesReceived, bytesSent: entry.bytesSent });
            }
          });
          return { inbound, pairs, mediaPlayout, outbound };
        },
        /**
         * 用 <audio> 元素播放某个 slot 的流，读 Chrome 的解码字节数。
         * 用来判断"轨道里有没有可解码的音频"—— 比分析器更能区分
         * "没收到音频"和"WebAudio 图有问题"。
         */
        probeElement: async (slot: number) => {
          const node = sfuSlotNodes.get(slot);
          if (!node) return { error: "no such slot" };
          const el = document.createElement("audio");
          el.autoplay = true;
          el.muted = true; // 静音播放，避免真的出声
          el.srcObject = node.stream;
          document.body.append(el);
          await el.play().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 2500));
          const anyEl = el as HTMLAudioElement & { webkitAudioDecodedByteCount?: number };
          const result = {
            decodedBytes: anyEl.webkitAudioDecodedByteCount ?? null,
            paused: el.paused,
            readyState: el.readyState,
            error: el.error ? `${el.error.code}` : null,
          };
          el.pause();
          el.srcObject = null;
          el.remove();
          return result;
        },
        /** 重建某个 slot 的音频节点（排查节点创建过早的情况）。 */
        rebuildSlot: (slot: number) => {
          const node = sfuSlotNodes.get(slot);
          if (!node) return false;
          const stream = node.stream;
          detachSfuSlot(slot);
          attachSfuSlot(slot, stream);
          return true;
        },
        /**
         * 用一条全新的独立音频链路测某个 slot 的能量。
         * 用来区分"轨道本身没有音频"和"应用的音频图有问题"。
         */
        measureSlot: async (slot: number) => {
          const node = sfuSlotNodes.get(slot);
          if (!node) return { error: "no such slot" };
          const track = node.stream.getAudioTracks()[0];
          const probe = new AudioContext({ sampleRate: 48000 });
          await probe.resume().catch(() => undefined);
          const src = probe.createMediaStreamSource(node.stream);
          const an = probe.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);
          const buf = new Float32Array(an.fftSize);
          let peak = 0;
          for (let i = 0; i < 24; i++) {
            await new Promise((r) => setTimeout(r, 50));
            an.getFloatTimeDomainData(buf);
            for (const v of buf) if (Math.abs(v) > peak) peak = Math.abs(v);
          }
          const result = {
            peak: Number(peak.toFixed(5)),
            probeState: probe.state,
            trackMuted: track?.muted ?? null,
            trackReadyState: track?.readyState ?? null,
            trackSettings: track?.getSettings?.() ?? null,
            trackCount: node.stream.getAudioTracks().length,
          };
          await probe.close().catch(() => undefined);
          return result;
        },
        slots: [...sfuSlotNodes].map(([slot, node]) => {
          node.analyser.getFloatTimeDomainData(node.buffer);
          let sum = 0;
          for (const value of node.buffer) sum += value * value;
          return {
            slot,
            clientId: node.clientId,
            gain: Number(node.gain.gain.value.toFixed(3)),
            rms: Number(Math.sqrt(sum / node.buffer.length).toFixed(4)),
            // sink 元素是否真的在播 —— 它为 false 时接收流不会被拉取，声音必然为 0。
            sinkPaused: node.element.paused,
            sinkReadyState: node.element.readyState,
            tracks: node.stream.getTracks().map((track) => ({
              kind: track.kind,
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
            })),
          };
        }),
      }),
    });
  }

  return {
    ws,
    state,
    /**
     * 刷新后可以自动回到的房间（只有真正连上过、且没有被显式离开/判死时才有）。
     * 由组件在挂载时读一次，用于自动重连。
     */
    readRestorableSession: (): ActiveSessionRecord | null => {
      const record = readActiveSession();
      return record?.established ? record : null;
    },
    members,
    channels,
    /** 按 cid 缓存的频道详情（含「频道说明」），由 requestChannelInfo 填充。 */
    channelInfos,
    requestChannelInfo,
    chatMessages,
    serverEvents,
    pokeNotifications,
    microphoneMuted,
    noiseSuppressionEnabled,
    inputVolume,
    outputVolume,
    outputMuted,
    notificationVolume,
    voxThreshold,
    inputDevices,
    outputDevices,
    selectedInputDeviceId,
    selectedOutputDeviceId,
    outputDeviceSupported,
    audioPermission,
    microphoneProcessing,
    audioContextState,
    identityMaterial,
    micLevel,
    microphoneTestActive,
    testAudioUrl,
    speakingIds,
    whisperTargetIds,
    whisperActive,
    volumes,
    accompanimentActive,
    accompanimentSupported,
    accompanimentErrorCode,
    screenShareStreams,
    screenShareActive,
    screenShareStarting,
    screenShareActiveStreamId,
    screenShareViewing,
    screenShareViewingStreamId,
    screenShareRemoteStream,
    screenShareError,
    screenShareErrorCode,
    screenShareRemoteVolume,
    screenShareWebRtcStats,
    setVolume,
    setInputVolume,
    setNoiseSuppressionEnabled,
    setOutputVolume,
    toggleOutputMute,
    setVoxThreshold,
    setNotificationVolume,
    prepareInputDevices,
    refreshAudioDevices,
    setInputDevice,
    setOutputDevice,
    startMicrophoneTest,
    stopMicrophoneTest,
    playNotification,
    connect,
    reconnectNow,
    disconnect,
    switchChannel,
    moveClient,
    sendTextMessage,
    sendServerMessage,
    sendPrivateMessage,
    sendPoke,
    setAway,
    setWhisperTargets,
    setWhisperActive,
    setMicrophoneMuted,
    ensureMicrophone,
    startAccompaniment,
    stopAccompaniment,
    startScreenShare,
    stopScreenShare,
    joinScreenShare,
    leaveScreenShare,
    checkSupport,
    clearError,
    measureLatency,
    sampleMediaPath,
    webrtcActive,
  };
}
