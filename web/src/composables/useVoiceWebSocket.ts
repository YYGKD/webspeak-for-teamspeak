import { reactive, ref } from "vue";
/**
 * 必须**惰性**加载降噪包：它的模块顶层就有
 * `class RnnoiseWorkletNode extends AudioWorkletNode {}`，在没有 AudioWorklet
 * 的内核（旧 WebKit、关闭了 AudioWorklet 的加固配置、部分 WebView）里，
 * 静态 import 会在应用启动时直接抛 `ReferenceError: AudioWorkletNode is not
 * defined`，把整个页面打挂 —— 那样 `startMicrophone` 里的 ScriptProcessor
 * 兜底永远没有机会执行。这里只保留**类型**导入（编译期擦除，不产生运行时
 * 依赖），真正的模块在 `createRnnoiseNode()` 里按需 `await import()`，
 * 那里已经有 try/catch，降噪失败只会退化成浏览器原生降噪。
 */
import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import { loadLocalPreferences, saveLocalPreferences } from "../services/local-persistence.js";
import { MediaClient } from "../services/media-client.js";
import { getBrowserCapabilities, getBrowserSupportReport } from "../services/browser-support.js";
import type { BrowserCapabilities, BrowserSupportReport } from "../services/browser-support.js";
import type {
  AppData,
  DtlsParameters,
  MediaConsumer,
  MediaKind,
  MediaProducer,
  MediaSignaling,
  MediaTransportParams,
  RouterRtpCapabilities,
  RtpParameters,
} from "../services/media-client.js";

const micCaptureWorkletUrl = "/mic-capture-worklet.js";
const SCREEN_SHARE_NEGOTIATION_TIMEOUT_MS = 15_000;
/** M2 send 方向就绪守卫的等待上限：屏幕双轨 produce 前等待上行 sendTransport 建链。 */
const SCREEN_SHARE_SEND_READY_TIMEOUT_MS = 12_000;
/** M2 recv 方向就绪守卫的等待上限：观众端双轨 consume 前等待下行 recvTransport 建链。 */
const SCREEN_SHARE_RECV_READY_TIMEOUT_MS = 12_000;
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
 * 默认值与服务端 ice-credentials.ts 的 DEFAULT_STUN_URLS 保持一致；
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

/** 本地说话指示的能量门限（与旧服务端 SPEAKER_ACTIVITY_RMS 同量级）。 */
const SPEAKER_ACTIVITY_RMS = 0.01;
const SPEAKER_ACTIVITY_INTERVAL_MS = 100;

/** `speakerProducerClosed` 到达后的淡出时长（秒）与节点释放延迟（毫秒）。 */
const SPEAKER_FADE_OUT_SECONDS = 0.12;
const SPEAKER_FADE_OUT_RELEASE_MS = 160;

/** 单条媒体信令请求的兜底超时。 */
const MEDIA_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 一个说话人的播放子图：source → gain → analyser → destination。
 *
 * key 是 TS3 `clientId`（不再是"槽位号"）—— 说话人进来就建、离开就拆。
 */
interface SpeakerPlaybackNode {
  consumer: MediaConsumer;
  sourceNode: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  analyserNode: AnalyserNode;
  /** 该节点对应的服务端 producerId，用来过滤迟到的关闭事件。 */
  producerId: string;
  /** 电平分析用的复用缓冲。 */
  buffer: Float32Array;
  /** 诊断用：保留流引用以便查看轨道状态。 */
  stream: MediaStream;
  /**
   * 静音的 <audio> 元素，唯一作用是让 Chrome 启动这条 WebRTC 接收流。
   * 真正出声的是 WebAudio 图。见 attachSpeakerNode 里的说明。
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
  /**
   * R7：观众专属的 SFU 管道 Producer ID（`pipeToRouter keepId:false` 生成的新 UUID），
   * 由 `screenShareJoined` / `screenShareProducers` 定向下发，广播态描述（如
   * `screenShareList`）绝不携带。仅在显式携带时覆盖，避免被列表刷新冲掉。
   */
  videoProducerId?: string;
  audioProducerId?: string;
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

/**
 * 跨内核的「远端音频到底有没有解码出来」判据。
 *
 * `webkitAudioDecodedByteCount` 只有 Blink/WebKit 有，Gecko 没有等价计数器。
 * 但三个内核都通过 `getStats()` 暴露 inbound-rtp 的 `totalAudioEnergy` /
 * `audioLevel`：前者是累计值，只要在增长就说明解码器确实在产出音频，
 * 后者是瞬时电平。用它补上 Gecko 的诊断盲区。
 */
async function readConsumerAudioEnergy(
  consumer: MediaConsumer,
  enabled: boolean,
): Promise<{ totalAudioEnergy: number | null; audioLevel: number | null; bytesReceived: number | null } | null> {
  if (!enabled) return null;
  try {
    const report = await consumer.getStats();
    let result: { totalAudioEnergy: number | null; audioLevel: number | null; bytesReceived: number | null } | null = null;
    report.forEach((entry: Record<string, unknown>) => {
      if (entry.type !== "inbound-rtp" || entry.kind !== "audio") return;
      result = {
        totalAudioEnergy: typeof entry.totalAudioEnergy === "number" ? entry.totalAudioEnergy : null,
        audioLevel: typeof entry.audioLevel === "number" ? entry.audioLevel : null,
        bytesReceived: typeof entry.bytesReceived === "number" ? entry.bytesReceived : null,
      };
    });
    return result;
  } catch {
    // Consumer 正在关闭时 getStats() 会抛错：只是一次采样失败。
    return null;
  }
}

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
  // mediasoup：Device + 双向 WebRtcTransport；说话人按 clientId 动态消费。
  let mediaClient: MediaClient | null = null;
  let micProducer: MediaProducer | null = null;
  /** 动态播放图：key = TS3 clientId。说话人进出即建/拆，不再有固定槽位。 */
  const speakerNodes = new Map<number, SpeakerPlaybackNode>();
  let speakerActivityTimer: ReturnType<typeof setInterval> | null = null;
  /** 消费尚未完成就被关闭的 producerId，覆盖 newSpeakerProducer/speakerProducerClosed 竞态。 */
  const closedSpeakerProducers = new Set<string>();
  /**
   * 媒体会话就绪前到达的 newSpeakerProducer 先入队，transport 建好后补消费。
   * 对齐旧实现里"说话人映射早于轨道到达"的缓存处理：说话人可能在我们
   * 协商 transport 期间就已经在说话。
   */
  const pendingSpeakerProducers: Array<{ clientId: number; producerId: string }> = [];
  /** 媒体信令请求/应答关联表（requestId → pending）。 */
  const pendingMediaRequests = new Map<string, {
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let mediaRequestSequence = 0;
  /** 诊断用：最近收到的服务端消息类型。 */
  const recentMessageTypes: string[] = [];
  let webrtcNegotiationPromise: Promise<void> | null = null;
  // Bounded ladder backoff for WebRTC negotiation retries. The counter is reset
  // only when a new connection starts (see connect()); stopWebRtcTransport() must
  // never reset it, otherwise every retry would zero the counter and loop forever.
  const BACKOFF_DELAYS = [2000, 5000];
  let webRtcRetryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const webrtcActive = ref(false);
  const identityMaterial = ref("");
  const storedVolumesByUid = reactive<Record<string, number>>({});
  let microphoneStartPromise: Promise<void> | null = null;

  // WebRTC（mediasoup）是唯一的音频传输路径：网关宣告可用后由浏览器原生编解码器
  // 承载上下行，不再有 PCM WebSocket 兼容通道。
  let audioCtx: SinkAudioContext | null = null;
  let micStream: MediaStream | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let workletContext: AudioContext | null = null;
  let workletModulePromise: Promise<void> | null = null;
  let rnnoiseNode: RnnoiseWorkletNode | null = null;
  let rnnoiseWorkletModulePromise: Promise<void> | null = null;
  let rnnoiseWasmPromise: Promise<ArrayBuffer> | null = null;
  /** 降噪包的 in-flight 动态 import；成功后一直复用。 */
  let noiseSuppressorPromise: Promise<typeof import("@sapphi-red/web-noise-suppressor")> | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let micGain: GainNode | null = null;
  let silentGain: GainNode | null = null;
  let processedMicDestination: MediaStreamAudioDestinationNode | null = null;
  const accompanimentActive = ref(false);
  // 伴奏共享 = 显示采集 + 显示音频轨。Gecko/WebKit 的 getDisplayMedia 只给视频轨，
  // 所以只判断 getDisplayMedia 存在是不够的：那会让用户走到「选了来源却没有声音」的死路。
  const accompanimentSupported = ref(
    typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getDisplayMedia)
    && getBrowserCapabilities().displayAudioCapture,
  );
  const accompanimentErrorCode = ref<"" | "unsupported" | "needsWebRtc" | "noAudio" | "permission">("");
  let accompanimentStream: MediaStream | null = null;
  const screenShareStreams = reactive<ScreenShareStream[]>([]);
  const screenShareActive = ref(false);
  const screenShareStarting = ref(false);
  const screenShareActiveStreamId = ref("");
  const screenShareViewing = ref(false);
  const screenShareViewingStreamId = ref("");
  const screenShareRemoteStream = ref<MediaStream | null>(null);
  /**
   * S4-02（T9）：观众端拉流状态机。`waiting-producer` 表示已进入观看态但发起端
   * 尚未推流（`stream.videoProducerId` 缺省），等待 `screenShareProducers` 定向
   * 通知补齐 producerId 后自动唤醒续拉流。
   */
  const screenShareViewerState = ref<"idle" | "connecting" | "waiting-producer" | "playing" | "error">("idle");
  const screenShareError = ref("");
  const screenShareErrorCode = ref("");
  const screenShareRemoteVolume = ref(1);
  let screenShareLocalStream: MediaStream | null = null;
  /**
   * 用户本次选择的帧率上限。决定屏幕共享在带宽受限时的取舍方向：
   * ≥30fps 视为「要流畅」（放视频/游戏）→ 保帧率；否则视为「要看清」（文档/标签页/代码）
   * → 保分辨率。实测在低码率下 maintain-framerate 会把 1280×720 压到 320×180（文字全糊），
   * 而 maintain-resolution 能保持原生分辨率、只牺牲帧率。
   */
  let screenShareCaptureFrameRate = 30;
  // S4-01（T8）：发起端屏幕双轨 SFU Producer。复用既有 sendTransport，停止共享时销毁。
  let screenShareVideoProducer: MediaProducer | null = null;
  let screenShareAudioProducer: MediaProducer | null = null;
  // S4-02（T9）：观众端 SFU 双轨 Consumer 句柄。切换流 / 退出观看时优雅关闭。
  let screenShareVideoConsumer: MediaConsumer | null = null;
  let screenShareAudioConsumer: MediaConsumer | null = null;
  /** `ensureScreenShareRecvReady()` 的 in-flight Promise：并发调用共享，避免重复拉起媒体会话。 */
  let screenShareRecvReadyPromise: Promise<MediaClient> | null = null;
  /**
   * S4-03（T10/H2）：Web 观众间 P2P 直连已彻底下线。以下 P2P 状态
   * （`screenSharePeers` / `screenSharePeerRoles` / `screenSharePeerStreams` /
   * `screenSharePendingIce`）**仅**服务于原生 TeamSpeak 观众（peerId 形如
   * `ts-viewer-<clid>`）与 `source === "teamspeak"` 的原生共享流；Web 观众一律走
   * SFU 中央分发（`startScreenShareSfuViewer`），不再创建 `RTCPeerConnection`。
   * 最小改动：只加注释，不重命名。
   */
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
  /**
   * 浏览器兼容性状态：内核识别 + 能力矩阵 + 降级清单。
   *
   * 会话建立时算一次就固定（能力在页面生命周期内不变），UI 与语音链路都读它，
   * 不再各自做特性探测。`capabilities` 是热路径上最常读的字段，单独提出来。
   */
  const browserSupport = ref<BrowserSupportReport>(getBrowserSupportReport());
  const capabilities: BrowserCapabilities = getBrowserCapabilities();
  /**
   * 扬声器选择按 `outputRoutingMode !== "none"` 显隐：Chromium 与 Firefox 都能在
   * 页面内切换输出（前者改 AudioContext 的 sink，后者走惰性的元素路由），
   * 因此两边露出同一个控件、体验一致；只有无任何 sink API 的 WebKit 才显示说明。
   */
  const outputDeviceSupported = ref(capabilities.outputRoutingMode !== "none");
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

  const volumes = reactive<Record<number, number>>({});
  const speakingIds = reactive(new Set<number>());
  const whisperTargetIds = reactive(new Set<number>());
  const whisperActive = ref(false);
  const speakingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const SPEAKING_HOLD_MS = 360;

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
    applySpeakerVolumes();
  }

  function getAudioCtx(): SinkAudioContext {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: 48000 }) as SinkAudioContext;
      audioContextState.value = audioCtx.state;
      audioCtx.addEventListener("statechange", () => {
        if (audioCtx) audioContextState.value = audioCtx.state;
      });
      // 显隐由能力矩阵给出的路由方式决定（Chromium 与 Firefox 都可用），这里只做
      // 一次兜底校准：audioContext 模式下还要确认实例上真有 setSinkId。
      outputDeviceSupported.value = capabilities.outputRoutingMode === "audioContext"
        ? typeof audioCtx.setSinkId === "function"
        : capabilities.outputRoutingMode === "mediaElement";
      if (selectedOutputDeviceId.value && outputDeviceSupported.value) {
        // 恢复上次选择的扬声器。Firefox 的元素路由需要一个能发声的元素，若被
        // 自动播放策略拦下，就放弃这个偏好（而不是让 UI 显示一个实际没生效的设备），
        // 并提示用户点击页面——UI 状态与实际输出始终一致。
        void setOutputRouting(audioCtx, selectedOutputDeviceId.value).catch(() => {
          selectedOutputDeviceId.value = "";
          localStorage.setItem("webspeak:output-device", "");
          setAudioNotice("PLAYBACK_BLOCKED", "浏览器阻止了自动播放：选中的扬声器未能生效，已回到默认输出设备。点击页面后可从设置重新选择");
        });
      }
    }
    return audioCtx;
  }

  function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
  }

  /**
   * Microphone failures are a degraded state, not a connection failure: the room
   * stays joined, so they get their own diagnostic instead of taking over `error`.
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

  /**
   * 惰性元素路由：只有 `HTMLMediaElement.setSinkId` 可用时（Firefox）才需要。
   *
   * 把可听图接到 `mix`，再用一个**不静音**的元素播放它并 setSinkId —— 实测这是
   * 唯一能把 WebAudio 输出改道到指定设备的办法（单独给元素 setSinkId 改不了
   * WebAudio 图，见 `.local/browser-verify/audio-findings.md`）。
   *
   * 只有在用户**真的选了非默认设备**时才建立，因此默认路径不承担任何额外缓冲：
   * Chrome 走 `AudioContext.setSinkId`，Firefox 不选设备时走 `ctx.destination`。
   */
  let elementOutputRouting: {
    mix: MediaStreamAudioDestinationNode;
    element: HTMLAudioElement;
    deviceId: string;
  } | null = null;

  /** 当前可听总线：建立了元素路由就是混音节点，否则是 AudioContext 的 destination。 */
  function outputBus(ctx: AudioContext): AudioNode {
    return elementOutputRouting?.mix ?? ctx.destination;
  }

  /** 把已建立的说话人节点全部改接到当前总线（总线切换的唯一收口）。 */
  function rewireSpeakerNodes(ctx: AudioContext): void {
    const bus = outputBus(ctx);
    for (const node of speakerNodes.values()) {
      try { node.analyserNode.disconnect(); } catch { /* 已断开 */ }
      try { node.analyserNode.connect(bus); } catch { /* 竞态里轨道已结束 */ }
    }
  }

  /**
   * 拆卸元素路由：可听图回到 `ctx.destination`，额外缓冲随之消失。
   * 先清空状态再改接，`outputBus()` 才会解析回 destination。
   */
  function releaseElementOutputRouting(ctx: AudioContext): void {
    if (!elementOutputRouting) return;
    const { element } = elementOutputRouting;
    elementOutputRouting = null;
    try {
      element.pause();
      element.srcObject = null;
    } catch { /* 幂等 */ }
    rewireSpeakerNodes(ctx);
  }

  /**
   * 切换可听输出的目标设备。
   *
   * - `deviceId` 为空 = 系统默认：Chromium 交回默认 sink，Firefox 直接拆掉元素
   *   路由（零额外开销）。
   * - Chromium（`audioContext` 模式）：改 `AudioContext.setSinkId`，整个上下文
   *   一起改道，图上不用动。
   * - Firefox（`mediaElement` 模式）：建立/复用元素路由并改接总线。
   *
   * 失败一律抛出，由 `setOutputDevice` 负责回滚到上一个设备。
   */
  async function setOutputRouting(ctx: SinkAudioContext, deviceId: string): Promise<void> {
    if (capabilities.outputRoutingMode === "none") {
      if (deviceId) throw new Error("当前浏览器无法在页面内切换扬声器");
      return;
    }

    if (capabilities.outputRoutingMode === "audioContext") {
      if (!deviceId) releaseElementOutputRouting(ctx); // 理论上不会建立，防御性收口
      if (typeof ctx.setSinkId === "function") await ctx.setSinkId(deviceId || "default");
      return;
    }

    // mediaElement 模式（Firefox）
    if (!deviceId) {
      releaseElementOutputRouting(ctx);
      return;
    }
    // 先在本地把元素准备好，**成功之后**才让 `elementOutputRouting` 上线。
    // 否则 setSinkId/play 失败时总线已经指向一条不出声的混音，新来的说话人会被
    // 接到静音链路上（而且没有报错）。
    const existing = elementOutputRouting;
    const isNew = !existing;
    const routing = existing ?? (() => {
      const mix = ctx.createMediaStreamDestination();
      const element = new Audio();
      element.autoplay = true;
      // 不静音：这条链路才是真正出声的。音量/静音仍由 WebAudio 图负责。
      element.srcObject = mix.stream;
      return { mix, element, deviceId: "" };
    })();
    try {
      await routing.element.setSinkId(deviceId);
      await routing.element.play();
    } catch (error) {
      if (isNew) {
        try {
          routing.element.pause();
          routing.element.srcObject = null;
        } catch { /* 幂等 */ }
      }
      throw error instanceof Error ? error : new Error("浏览器阻止了音频播放，请点击页面后重试");
    }
    elementOutputRouting = routing;
    routing.deviceId = deviceId;
    rewireSpeakerNodes(ctx);
  }

  /**
   * 兼容性检查：返回阻断性原因的本地化键（中文原文），可用时返回 null。
   *
   * 判定全部交给 `browser-support.ts` 的能力矩阵 —— 这里不再列举
   * `navigator.mediaDevices` 之类的条件，避免两处规则漂移。
   */
  function checkSupport(): string | null {
    if (typeof window === "undefined") return null;
    return getBrowserSupportReport().blockingReason;
  }

  /**
   * 按内核能力筛选显示采集约束。
   *
   * `displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` 都是
   * Chromium 专有提示：Gecko 会忽略未知成员，WebKit 则可能在拿到
   * `TypeError` 后整段拒绝。所以只在内核确认支持时才带上。
   */
  function displayMediaOptions(audio: boolean): DisplayMediaStreamOptions {
    const options: Record<string, unknown> = { video: true, audio: audio && capabilities.displayAudioCapture };
    if (capabilities.displayCaptureHints) {
      options.video = { displaySurface: "browser" };
      options.selfBrowserSurface = "exclude";
      options.systemAudio = "include";
      options.windowAudio = "window";
    }
    return options as DisplayMediaStreamOptions;
  }

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
      if (audioCtx && outputDeviceSupported.value) {
        // 选中的扬声器已消失：拆掉路由回落到默认设备，并唤醒上下文，避免静音悬挂。
        void setOutputRouting(audioCtx, "").catch(() => undefined);
        if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => undefined);
        syncAudioContextNotice();
      }
    }
  }

  async function refreshInputDevices(): Promise<void> {
    await refreshAudioDevices();
  }

  /**
   * 降噪包的惰性加载器。模块顶层有 `extends AudioWorkletNode`，在没有
   * AudioWorklet 的内核里一 import 就会抛错，所以只能在确认能力之后按需加载。
   * 并发调用共享同一个 in-flight Promise，失败后清空以便重试。
   */
  async function loadNoiseSuppressor(): Promise<typeof import("@sapphi-red/web-noise-suppressor")> {
    if (!noiseSuppressorPromise) {
      noiseSuppressorPromise = import("@sapphi-red/web-noise-suppressor").catch((error) => {
        noiseSuppressorPromise = null;
        throw error;
      });
    }
    return noiseSuppressorPromise;
  }

  async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode | null> {
    if (typeof AudioWorkletNode === "undefined" || !ctx.audioWorklet) {
      microphoneProcessing.rnnoise = false;
      return null;
    }
    try {
      const { RnnoiseWorkletNode: RnnoiseNode, loadRnnoise } = await loadNoiseSuppressor();
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
      const node = new RnnoiseNode(ctx, { maxChannels: 1, wasmBinary });
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
      if (microphoneMuted.value) {
        voxAttack = 0;
        voxRelease = 0;
        return;
      }
      if (microphoneTestActive.value || webrtcActive.value) return;
      if (voxGate(input)) markSpeaking(state.tsClientId);
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
    // mediasoup 下这条混音轨就是上行 Producer 的源轨道。
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

  /**
   * 把上行 Producer 的轨道换成最新的麦克风/伴奏混音轨。
   *
   * 伴奏开始/结束时调用：mediasoup 的 Producer 支持原地换轨，不需要重新 produce，
   * 也就不会打断 DTLS/SRTP 会话。
   */
  async function replaceWebRtcAudioTrack(): Promise<void> {
    if (!micProducer || micProducer.closed || !micStream) return;
    const mixedStream = createWebRtcMixStream();
    const mixedTrack = mixedStream.getAudioTracks()[0];
    if (!mixedTrack) throw new Error("混合音频轨道创建失败");
    await micProducer.replaceTrack({ track: mixedTrack });
  }

  async function startAccompaniment(): Promise<void> {
    accompanimentErrorCode.value = "";
    if (!accompanimentSupported.value) {
      accompanimentErrorCode.value = "unsupported";
      throw new Error("伴奏共享不可用");
    }
    if (!webrtcActive.value || !micProducer || !micStream) {
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
    // 提示项按内核筛选：WebKit 不认识这些 Chromium 专有成员，可能整段拒绝；
    // 但音频约束本身是标准的，需要保留。
    const options = { ...displayMediaOptions(true), audio: audioConstraints } as DisplayMediaStreamOptions;

    let nextStream: MediaStream;
    try {
      nextStream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      // 部分内核（主要是旧 WebKit）会以 TypeError 拒绝含未知约束的字典：
      // 退一步只带标准字段重试一次，让伴奏共享在这些内核上仍然可用。
      if (error instanceof TypeError) {
        try {
          nextStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioConstraints });
        } catch (retryError) {
          if (retryError instanceof DOMException && retryError.name === "AbortError") return;
          accompanimentErrorCode.value = "permission";
          throw retryError;
        }
      } else {
        accompanimentErrorCode.value = "permission";
        throw error;
      }
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
    if (webrtcActive.value && micProducer && micStream) await replaceWebRtcAudioTrack();
    else stopWebRtcMix();
  }

  /**
   * 建立 mediasoup 媒体会话（S5）。
   *
   * 顺序：麦克风（尽力而为）→ Device 载入 → send/recv transport → 上行 produce。
   * 下行 Consumer 不在这里建：服务端收到 TS3 语音后推 `newSpeakerProducer`，
   * 由 handleNewSpeakerProducer 按 clientId 动态 consume。
   */
  async function startWebRtcTransport(sequence: number, socket: WebSocket): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") throw new Error("当前浏览器不支持 WebRTC");
    // 麦克风尽力而为：拿不到也继续建 transport（只听模式），这样"只想听"的用户
    // （例如只听音乐机器人）不会因为麦克风被拒、没有设备或非安全上下文而失去
    // 下行实时音频。
    try {
      await ensureMicrophone();
    } catch {
      // startMicrophone 已记录 microphoneError，界面照旧提示；
      // 这里只降级成"没有上行"，不影响下行实时音频。
    }
    if (sequence !== connectionSequence || socket.readyState !== WebSocket.OPEN) return;
    // WebRTC 接管上行后停掉 WS 采集图（handleCaptureChunk 也以 webrtcActive 兜底），
    // 麦克风电平改由 WebRTC 采集监视器驱动。
    stopCaptureGraph();

    const negotiation = (async () => {
      stopMediaClient();
      const client = new MediaClient(mediaSignaling, {
        iceServers: activeIceServers,
        onConnectionStateChange: (connectionState, direction) => {
          if (connectionState === "failed" && mediaClient === client) {
            failWebRtc(sequence, socket, direction === "send" ? "WEBRTC_UPLINK_FAILED" : "WEBRTC_CONNECTION_FAILED");
          }
        },
      });
      mediaClient = client;
      await client.loadDevice(await mediaSignaling.requestRtpCapabilities());
      await client.createSendTransport();
      await client.createRecvTransport();
      if (sequence !== connectionSequence || socket.readyState !== WebSocket.OPEN || mediaClient !== client) {
        client.close();
        return;
      }
      // 上行轨道 = 麦克风 + 伴奏的混音轨（没有麦克风时只有伴奏，或纯静音轨）。
      const mixedStream = createWebRtcMixStream();
      const track = mixedStream.getAudioTracks()[0] ?? micStream?.getAudioTracks()[0] ?? null;
      if (track) {
        const producer = await client.produce({
          track,
          appData: { muted: microphoneMuted.value, accompanimentActive: accompanimentActive.value },
          codecOptions: { opusStereo: false, opusDtx: true },
        });
        micProducer = producer;
        // 静音时本地先行 pause（停发 RTP，节省上行带宽）；TS3 侧输入静音状态
        // 由 setMicrophoneMuted 命令同步（见 setMicrophoneMuted）。
        if (microphoneMuted.value) producer.pause();
      }
      webrtcActive.value = true;
      if (micStream) startWebRtcMicMonitor(getAudioCtx(), micStream, micStream.getAudioTracks()[0] ?? null);
      startSpeakerActivityMonitor();
      flushPendingSpeakerProducers();
    })();
    webrtcNegotiationPromise = negotiation;
    try {
      await negotiation;
    } catch {
      // 阶梯退避（2s/5s）还有预算时交给它重试；耗尽后判定实时语音不可用并给出
      // 重试指引，不再切入任何兼容通道（见 failWebRtc）。
      if (mediaClient && !scheduleWebRtcRetry(sequence, socket, "WEBRTC_NEGOTIATION_FAILED")) {
        failWebRtc(sequence, socket, "WEBRTC_NEGOTIATION_FAILED");
      }
    } finally {
      if (webrtcNegotiationPromise === negotiation) webrtcNegotiationPromise = null;
    }
  }

  /**
   * WebRTC 协商或媒体链路彻底失败：通知网关释放对端、拆掉媒体客户端，并给出
   * 明确的网络诊断与重试指引。纯 WebRTC 架构下没有可降级的兼容通道，因此这里
   * 只把实时语音置为不可用，等待用户检查网络后调用 retryWebRtc 重试。
   */
  function failWebRtc(sequence: number, socket: WebSocket, reasonCode = "WEBRTC_UNAVAILABLE"): void {
    if (sequence !== connectionSequence) return;
    webrtcActive.value = false;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "webrtcStop", payload: { reason: reasonCode, retries: webRtcRetryCount } }));
    }
    stopWebRtcTransport();
    if (socket.readyState === WebSocket.OPEN && state.connected) {
      setAudioNotice("WEBRTC_UNAVAILABLE", `实时语音（WebRTC）不可用（错误代码：${safeClientErrorCode(reasonCode) || "WEBRTC_UNAVAILABLE"}），请检查网络 UDP 连通性或点击重新尝试`);
    }
  }

  /**
   * 用户主动重试实时语音：清掉不可用告警、重置退避预算后重新发起 WebRTC 协商。
   * 仅在会话已连接且信令通道可用时有效。
   */
  function retryWebRtc(): void {
    const socket = ws.value;
    if (!socket || socket.readyState !== WebSocket.OPEN || !state.connected) return;
    clearAudioNotice("WEBRTC_UNAVAILABLE");
    webRtcRetryCount = 0;
    void startWebRtcTransport(connectionSequence, socket).catch(() => undefined);
  }

  function stopWebRtcTransport(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    webrtcActive.value = false;
    webrtcNegotiationPromise = null;
    releaseAccompanimentStream();
    stopWebRtcMix();
    stopWebRtcMicMonitor();
    stopSpeakerActivityMonitor();
    // 拆掉元素路由（若已建立）：总线回到 ctx.destination，发声元素停止并释放。
    if (audioCtx) releaseElementOutputRouting(audioCtx);
    releaseAllSpeakerNodes();
    pendingSpeakerProducers.length = 0;
    micProducer = null;
    stopMediaClient();
    rejectPendingMediaRequests(new Error("实时语音已停止"));
  }

  /**
   * Schedule a bounded retry of the WebRTC transport.
   *
   * Returns true when a retry was scheduled, false when the retry budget is
   * exhausted (or the sequence is stale) and the caller must declare realtime
   * voice unavailable (see failWebRtc). Never resets webRtcRetryCount — the
   * counter is cleared when a new connection starts or when the user retries.
   */
  function scheduleWebRtcRetry(
    sequence: number,
    socket: WebSocket,
    reasonCode: string,
  ): boolean {
    if (sequence !== connectionSequence) return false;
    if (webRtcRetryCount < BACKOFF_DELAYS.length) {
      const delay = BACKOFF_DELAYS[webRtcRetryCount];
      webRtcRetryCount++;
      stopWebRtcTransport();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (sequence === connectionSequence && socket.readyState === WebSocket.OPEN) {
          void startWebRtcTransport(sequence, socket);
        }
      }, delay);
      return true;
    }
    return false;
  }

  // ── mediasoup 信令与动态播放图（S5） ─────────────────────────────────────

  /** 发送一条媒体信令并等待对应应答（按 requestId 关联）。 */
  function sendMediaRequest(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = MEDIA_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const socket = ws.value;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("语音连接尚未就绪"));
    const requestId = `media-${Date.now().toString(36)}-${(mediaRequestSequence++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingMediaRequests.delete(requestId);
        reject(new Error(`媒体信令超时（${type}）`));
      }, timeoutMs);
      pendingMediaRequests.set(requestId, { resolve, reject, timer });
      sendCmd(type, payload, requestId);
    });
  }

  /** 用 requestId 结算一条待应答的媒体信令（成功应答 / mediaError）。 */
  function settleMediaRequest(message: Record<string, unknown>, isError: boolean): void {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) return;
    const pending = pendingMediaRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingMediaRequests.delete(requestId);
    if (!isError) {
      pending.resolve(message);
      return;
    }
    const error = new Error(String(message.message || "媒体信令处理失败"));
    Object.assign(error, { code: safeClientErrorCode(message.code) || "MEDIA_SIGNALING_FAILED" });
    pending.reject(error);
  }

  function rejectPendingMediaRequests(error: Error): void {
    for (const [requestId, pending] of pendingMediaRequests) {
      clearTimeout(pending.timer);
      pendingMediaRequests.delete(requestId);
      pending.reject(error);
    }
  }

  /**
   * 信令适配器：把 MediaClient 的强类型调用翻译成 `media*` WebSocket 消息。
   *
   * RTP/DTLS 参数在 JSON 边界上做窄化断言（不是 `any`）：语义校验交给 mediasoup，
   * 前端只保证形状与类型。
   */
  const mediaSignaling: MediaSignaling = {
    requestRtpCapabilities: async (): Promise<RouterRtpCapabilities> => {
      const message = await sendMediaRequest("mediaGetRtpCapabilities", {});
      return message.rtpCapabilities as RouterRtpCapabilities;
    },
    createTransport: async (direction): Promise<MediaTransportParams> => {
      const message = await sendMediaRequest("mediaCreateTransport", { direction });
      return {
        transportId: String(message.transportId ?? ""),
        iceParameters: message.iceParameters as MediaTransportParams["iceParameters"],
        iceCandidates: (message.iceCandidates ?? []) as MediaTransportParams["iceCandidates"],
        dtlsParameters: message.dtlsParameters as DtlsParameters,
        ...(message.sctpParameters
          ? { sctpParameters: message.sctpParameters as NonNullable<MediaTransportParams["sctpParameters"]> }
          : {}),
      };
    },
    connectTransport: async (transportId, dtlsParameters): Promise<void> => {
      await sendMediaRequest("mediaConnectTransport", { transportId, dtlsParameters });
    },
    produce: async (transportId, kind: MediaKind, rtpParameters: RtpParameters, appData: AppData): Promise<string> => {
      const message = await sendMediaRequest("mediaProduce", { transportId, kind, rtpParameters, appData });
      return String(message.producerId ?? "");
    },
    consume: async (transportId, producerId, rtpCapabilities) => {
      const message = await sendMediaRequest("mediaConsume", { transportId, producerId, rtpCapabilities });
      return {
        consumerId: String(message.consumerId ?? ""),
        producerId: String(message.producerId ?? producerId),
        kind: message.kind as MediaKind,
        rtpParameters: message.rtpParameters as RtpParameters,
      };
    },
    pauseProducer: async (producerId): Promise<void> => { await sendMediaRequest("mediaPauseProducer", { producerId }); },
    resumeProducer: async (producerId): Promise<void> => { await sendMediaRequest("mediaResumeProducer", { producerId }); },
    resumeConsumer: async (consumerId): Promise<void> => { await sendMediaRequest("mediaConsumerResume", { consumerId }); },
  };

  function stopMediaClient(): void {
    const client = mediaClient;
    mediaClient = null;
    if (client) client.close();
  }

  /** 成员独立音量的作用点：该成员的 GainNode。 */
  function speakerGainValue(clientId: number): number {
    return Math.max(0, (volumes[clientId] ?? DEFAULT_MEMBER_VOLUME) * effectiveOutputVolume());
  }

  /** 把成员音量与总输出音量应用到每个说话人节点。 */
  function applySpeakerVolumes(): void {
    for (const [clientId, node] of speakerNodes) {
      try { node.gainNode.gain.value = speakerGainValue(clientId); } catch { /* 节点已断开 */ }
    }
  }

  /** 关闭 consumer、停轨、断开并回收全部 AudioNode。 */
  function disposeSpeakerNode(node: SpeakerPlaybackNode): void {
    try { node.consumer.close(); } catch { /* 幂等 */ }
    try { node.stream.getTracks().forEach((track) => track.stop()); } catch { /* 幂等 */ }
    try {
      node.element.pause();
      node.element.srcObject = null;
      node.sourceNode.disconnect();
      node.gainNode.disconnect();
      node.analyserNode.disconnect();
    } catch {
      // 已经断开。
    }
  }

  /**
   * 为一个说话人建立播放子图：source → gain → analyser → destination。
   *
   * 必须额外挂一个静音 media element 在这条远端轨道上：Chrome 只在远端轨道被挂到
   * HTMLMediaElement 时才会启动 WebRTC 接收流（接收流的播放由音频设备模块拉取驱动，
   * 元素就是那个"请求播放"的 sink）。只挂 WebAudio 的 MediaStreamAudioSourceNode
   * 不算 sink —— 实测 packetsReceived 正常增长但 jitterBufferEmittedCount 恒为 0，
   * 表现就是"包收得到但一点声音都没有"。元素保持 muted：真正出声的是 WebAudio 图
   * （它承担成员音量、总音量与电平分析），muted 还顺带避开了自动播放策略。
   */
  function attachSpeakerNode(clientId: number, producerId: string, consumer: MediaConsumer): void {
    releaseSpeakerNode(clientId);
    const ctx = getAudioCtx();
    // 本地活动检测与播放共用同一条图：AudioContext 被挂起时既没有声音、
    // 也不会误报"正在说话"，失败模式是自洽的。
    void ctx.resume().catch(() => undefined);
    let element: HTMLAudioElement | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      const stream = new MediaStream([consumer.track]);
      source = ctx.createMediaStreamSource(stream);
      gain = ctx.createGain();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(outputBus(ctx));
      element = new Audio();
      element.autoplay = true;
      element.muted = true;
      element.srcObject = stream;
      void element.play().catch(() => undefined);
      // 这个元素是静音的，只负责驱动接收流，所以**不需要**跟着输出设备改道：
      // Chromium 由 ctx.setSinkId 覆盖整个上下文，Firefox 由共享的混音元素改道，
      // 两条路径都不依赖它。
      gain.gain.value = speakerGainValue(clientId);
      speakerNodes.set(clientId, {
        consumer,
        sourceNode: source,
        gainNode: gain,
        analyserNode: analyser,
        producerId,
        buffer: new Float32Array(analyser.fftSize),
        stream,
        element,
      });
    } catch (error) {
      // 轨道可能在竞态里已被关闭：清理半成品，让调用方知道没建起来。
      if (element) {
        element.pause();
        element.srcObject = null;
      }
      try {
        source?.disconnect();
        gain?.disconnect();
        analyser?.disconnect();
      } catch {
        // 已经断开。
      }
      try { consumer.close(); } catch { /* 幂等 */ }
      throw error;
    }
  }

  /** 立即释放一个说话人节点。 */
  function releaseSpeakerNode(clientId: number): void {
    const node = speakerNodes.get(clientId);
    if (!node) return;
    speakerNodes.delete(clientId);
    clearSpeaking(clientId);
    disposeSpeakerNode(node);
  }

  function releaseAllSpeakerNodes(): void {
    for (const clientId of [...speakerNodes.keys()]) releaseSpeakerNode(clientId);
  }

  /** 收到 speakerProducerClosed：100~150ms 淡出到 0 后再释放，避免爆音。 */
  function fadeOutSpeakerNode(clientId: number, node: SpeakerPlaybackNode): void {
    speakerNodes.delete(clientId);
    clearSpeaking(clientId);
    const ctx = audioCtx;
    if (ctx) {
      const now = ctx.currentTime;
      try {
        const gain = node.gainNode.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(0, now + SPEAKER_FADE_OUT_SECONDS);
      } catch {
        // 参数被拒绝（节点已断开）：直接走释放。
      }
    }
    setTimeout(() => disposeSpeakerNode(node), SPEAKER_FADE_OUT_RELEASE_MS);
  }

  /** 标记"消费尚未完成就已关闭"的 producerId（有界保留），覆盖竞态。 */
  function markClosedProducer(producerId: string): void {
    if (!producerId) return;
    closedSpeakerProducers.add(producerId);
    setTimeout(() => closedSpeakerProducers.delete(producerId), 10_000);
  }

  /** 服务端推送 newSpeakerProducer：consume 并挂入动态播放图。 */
  async function handleNewSpeakerProducer(clientId: number, producerId: string): Promise<void> {
    if (!Number.isInteger(clientId) || clientId <= 0 || !producerId) return;
    const client = mediaClient;
    if (!client || !webrtcActive.value) return;
    const existing = speakerNodes.get(clientId);
    if (existing) {
      if (existing.producerId === producerId) return;
      releaseSpeakerNode(clientId);
    }
    let consumer: MediaConsumer;
    try {
      consumer = await client.consume(producerId);
    } catch {
      // producer 可能已经关闭；按迟到关闭处理，避免留下半截状态。
      markClosedProducer(producerId);
      return;
    }
    // 竞态：consume 期间可能已经收到 speakerProducerClosed（或整个会话已换掉）。
    if (client !== mediaClient) {
      try { consumer.close(); } catch { /* 幂等 */ }
      return;
    }
    if (closedSpeakerProducers.delete(producerId)) {
      try { consumer.close(); } catch { /* 幂等 */ }
      return;
    }
    try {
      attachSpeakerNode(clientId, producerId, consumer);
    } catch {
      return;
    }
    startSpeakerActivityMonitor();
    // 自动播放策略会拦截未经用户手势的音频：解锁后由客户端显式 resume。
    void client.resumeConsumer(consumer).catch(() => undefined);
  }

  /** 媒体会话就绪后，补消费协商期间到达的说话人。 */
  function flushPendingSpeakerProducers(): void {
    if (!pendingSpeakerProducers.length) return;
    const queued = pendingSpeakerProducers.splice(0, pendingSpeakerProducers.length);
    for (const item of queued) void handleNewSpeakerProducer(item.clientId, item.producerId);
  }

  /** 服务端推送 speakerProducerClosed：淡出后释放对应说话人。 */
  function handleSpeakerProducerClosed(clientId: number, producerId: string): void {
    const node = speakerNodes.get(clientId);
    if (!node || (producerId && node.producerId !== producerId)) {
      markClosedProducer(producerId);
      return;
    }
    fadeOutSpeakerNode(clientId, node);
  }

  /**
   * 本地说话指示。
   *
   * mediasoup 不解码，服务端无法再上报 voiceActivity —— 浏览器手里有每一路的真实
   * 音频，直接分析能量即可，比服务端估算更准。
   */
  function startSpeakerActivityMonitor(): void {
    if (speakerActivityTimer !== null) return;
    speakerActivityTimer = setInterval(() => {
      for (const [clientId, node] of speakerNodes) {
        node.analyserNode.getFloatTimeDomainData(node.buffer);
        let sum = 0;
        for (const value of node.buffer) sum += value * value;
        if (Math.sqrt(sum / node.buffer.length) >= SPEAKER_ACTIVITY_RMS) markSpeaking(clientId);
      }
    }, SPEAKER_ACTIVITY_INTERVAL_MS);
  }

  function stopSpeakerActivityMonitor(): void {
    if (speakerActivityTimer !== null) {
      clearInterval(speakerActivityTimer);
      speakerActivityTimer = null;
    }
  }

  function startWebRtcMicMonitor(ctx: AudioContext, stream: MediaStream, track: MediaStreamTrack | null): void {
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
        if (!microphoneMuted.value && track?.enabled === true && rms >= voxThreshold.value) markSpeaking(state.tsClientId);
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

  function stopCaptureGraph(): void {
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
      // 音频上下文即将销毁：元素路由挂在它上面，必须一起清掉，否则会留下一个
      // 指向已关闭上下文的混音节点和一个仍在「播放」的空元素。
      const closing = audioCtx;
      if (closing) releaseElementOutputRouting(closing);
      elementOutputRouting = null;
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

  async function setInputDevice(deviceId: string): Promise<void> {
    const previousDeviceId = selectedInputDeviceId.value;
    selectedInputDeviceId.value = deviceId;
    localStorage.setItem("webspeak:input-device", deviceId);
    void saveAudioPreferences();
    try {
      // 换麦只重建本地采集管线，再用 replaceTrack 原地换轨，传输层与下行
      // Consumer 全程不断，避免切换输入设备后听不到其他成员。
      if (micStream) await startMicrophone();
      if (micProducer && !micProducer.closed) await replaceWebRtcAudioTrack();
      await refreshAudioDevices();
    } catch (error) {
      selectedInputDeviceId.value = previousDeviceId;
      localStorage.setItem("webspeak:input-device", previousDeviceId);
      try {
        if (micStream) await startMicrophone();
        if (micProducer && !micProducer.closed) await replaceWebRtcAudioTrack();
      } catch (recoveryError) {
        setMicrophoneError(recoveryError);
      }
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
      // MediaRecorder 在少数内核/隐私模式下不可用，或构造时因缺少受支持的
      // MIME 而抛错。这两种情况都不是失败：自测退化为「只看实时电平」，
      // 但 5 秒自动停止仍然要生效，否则测试态会一直挂着。
      let recorder: MediaRecorder | null = null;
      if (capabilities.mediaRecorder && micStream) {
        try {
          recorder = capabilities.preferredRecorderMimeType
            ? new MediaRecorder(micStream, { mimeType: capabilities.preferredRecorderMimeType })
            : new MediaRecorder(micStream);
        } catch {
          recorder = null;
        }
      }
      if (recorder) {
        const chunks: Blob[] = [];
        testRecorder = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = () => {
          if (chunks.length) {
            // Safari 只产出 audio/mp4；用 recorder.mimeType 而不是写死 webm。
            testAudioUrl.value = URL.createObjectURL(new Blob(chunks, { type: recorder?.mimeType || "audio/webm" }));
          }
          if (testRecorder === recorder) testRecorder = null;
        };
        recorder.start();
      } else if (!capabilities.mediaRecorder) {
        setAudioNotice("RECORDER_UNAVAILABLE", "当前浏览器不支持本地录音回放，麦克风自测将只显示实时电平");
      }
      testRecorderTimer = setTimeout(() => stopMicrophoneTest(), 5_000);
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
      const ctx = getAudioCtx();
      await setOutputRouting(ctx, deviceId);
      // 切换输出设备会让部分浏览器挂起 AudioContext（输出时钟被重置），必须显式唤醒，
      // 否则表现就是"设置里切了设备却一点声音都没有"。
      if (ctx.state === "suspended") await ctx.resume();
      syncAudioContextNotice();
      await saveAudioPreferences();
    } catch (error) {
      selectedOutputDeviceId.value = previousDeviceId;
      localStorage.setItem("webspeak:output-device", previousDeviceId);
      // 回滚：把总线切回上一个设备。这一步失败不再向外抛，避免掩盖原始错误。
      try { await setOutputRouting(getAudioCtx(), previousDeviceId); } catch { /* 保留原始错误 */ }
      syncAudioContextNotice();
      throw error;
    }
  }

  function playNotification(kind: "connected" | "disconnected" | "poke" | "private" | "reconnectFailed" | "memberJoined"): void {
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
        // 有人进入我所在频道：柔和的上行音（B4→E5），与"连接成功"区分开
        memberJoined: [494, 659],
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
      gain.connect(outputBus(ctx));
      oscillator.start(now);
      oscillator.stop(now + 0.2);
    } catch {
      // Notification sounds are best effort and must never affect the session.
    }
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
    // A brand-new connection starts with a full retry budget. This is the only
    // place the counter is reset — never in stopWebRtcTransport().
    webRtcRetryCount = 0;
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
    ws.value = socket;
    socket.onopen = () => {
      if (sequence !== connectionSequence) {
        socket.close(1000);
        return;
      }
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        handleMessage(JSON.parse(event.data));
      } catch {
        // Ignore malformed control frames.
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

  function parseScreenShareStatsReport(
    statsKey: string,
    report: RTCStatsReport,
    role: "owner" | "viewer",
    connectionState: string,
    iceConnectionState: string,
    fallbackCandidateType?: string,
  ): ScreenSharePeerStats | null {
    try {
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
      const previous = screenShareStatsPrevious.get(statsKey);
      const elapsedMs = previous ? now - previous.sampledAt : 0;
      const derivedFrameRate = previous && elapsedMs >= 250 && frames !== null && previous.frames !== null
        ? Math.max(0, ((frames - previous.frames) * 1_000) / elapsedMs)
        : null;
      const derivedBitrateKbps = previous && elapsedMs >= 250 && bytes !== null && previous.bytes !== null
        ? Math.max(0, ((bytes - previous.bytes) * 8) / elapsedMs)
        : null;
      screenShareStatsPrevious.set(statsKey, { sampledAt: now, bytes, frames });

      const packetsLost = screenShareStatsNumber(remoteStats ?? mediaStats, "packetsLost");
      const packetsTransferred = screenShareStatsNumber(mediaStats, role === "owner" ? "packetsSent" : "packetsReceived");
      const packetsTotal = packetsTransferred === null || packetsLost === null ? null : packetsTransferred + packetsLost;
      const lossPercent = packetsTotal && packetsTotal > 0 && packetsLost !== null ? (packetsLost / packetsTotal) * 100 : null;
      const currentRoundTripTime = screenShareStatsNumber(remoteStats, "roundTripTime") ?? screenShareStatsNumber(candidatePairStats, "currentRoundTripTime");
      const jitter = screenShareStatsNumber(remoteStats ?? mediaStats, "jitter");
      const directFrameRate = screenShareStatsNumber(mediaStats, "framesPerSecond") ?? screenShareStatsNumber(trackStats, "framesPerSecond");
      const directBitrateKbps = screenShareStatsNumber(mediaStats, "bitrate") !== null ? (screenShareStatsNumber(mediaStats, "bitrate") as number) / 1_000 : null;
      const candidateType = screenShareStatsString(localCandidate, "candidateType")
        ?? screenShareStatsString(remoteCandidate, "candidateType")
        ?? fallbackCandidateType
        ?? null;
      return {
        peerId: statsKey,
        role,
        direction: role === "owner" ? "outbound" : "inbound",
        connectionState,
        iceConnectionState,
        codec: screenShareStatsString(codecStats, "mimeType"),
        candidateType,
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

  async function collectScreenSharePeerStats(peerId: string, peer: RTCPeerConnection, role: "owner" | "viewer"): Promise<ScreenSharePeerStats | null> {
    try {
      const report = await peer.getStats();
      return parseScreenShareStatsReport(peerId, report, role, peer.connectionState, peer.iceConnectionState);
    } catch {
      return null;
    }
  }

  async function collectScreenShareWebRtcStats(): Promise<void> {
    if (screenShareStatsCollecting || !hasScreenShareStatsSource()) return;
    screenShareStatsCollecting = true;
    try {
      const peerStatsList: (ScreenSharePeerStats | null)[] = [];

      // 1. mediasoup SFU 发起端（推流）性能统计采集
      if (screenShareActive.value && screenShareVideoProducer) {
        try {
          const report = await screenShareVideoProducer.getStats();
          const stats = parseScreenShareStatsReport(
            "sfu-screen-producer",
            report,
            "owner",
            "connected",
            "connected",
            "SFU",
          );
          if (stats) peerStatsList.push(stats);
        } catch { /* 忽略关闭过程中的瞬态异常 */ }
      }

      // 2. mediasoup SFU 观看端（拉流）性能统计采集
      if (screenShareViewing.value && screenShareVideoConsumer) {
        try {
          const report = await screenShareVideoConsumer.getStats();
          const stats = parseScreenShareStatsReport(
            "sfu-screen-consumer",
            report,
            "viewer",
            "connected",
            "connected",
            "SFU",
          );
          if (stats) peerStatsList.push(stats);
        } catch { /* 忽略关闭过程中的瞬态异常 */ }
      }

      // 3. 原生 TS6 观众 P2P 链路性能统计采集（保持双轨兼容）
      if (screenSharePeers.size > 0) {
        const p2pStats = await Promise.all([...screenSharePeers.entries()].map(async ([peerId, peer]) => {
          const role = screenSharePeerRoles.get(peerId) ?? "viewer";
          return collectScreenSharePeerStats(peerId, peer, role);
        }));
        peerStatsList.push(...p2pStats);
      }

      screenShareWebRtcStats.capture = screenShareStatsCapture();
      screenShareWebRtcStats.peers = peerStatsList.filter((stats): stats is ScreenSharePeerStats => stats !== null);
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

  /**
   * 当前是否存在可采集的屏幕共享数据源。
   *
   * SFU 架构下数据源有两类，缺一不可判：
   *  - 发起端：本端推流中的 `screenShareVideoProducer`；
   *  - 观众端：本端拉流中的 `screenShareVideoConsumer`。
   * P2P（原生 TeamSpeak 观众/来源）的链路单独由 `screenSharePeers` 承载。
   */
  function hasScreenShareStatsSource(): boolean {
    return Boolean(
      (screenShareActive.value && screenShareVideoProducer) ||
        (screenShareViewing.value && screenShareVideoConsumer) ||
        screenSharePeers.size > 0,
    );
  }

  /**
   * 仅在**确实没有任何屏幕共享数据源**时才停止性能采集轮询。
   *
   * 历史缺陷：各处用「`screenSharePeers` 为空就停」做判据，在 SFU 架构下必然误判 ——
   * 网页观众不再建立 P2P 连接，所以直播端收到 `screenShareViewerLeft`（有网页观众停止
   * 观看）时 `screenSharePeers` 本来就是空的，于是把**发起端自己**的性能面板一起清空。
   */
  function maybeStopScreenShareStatsPolling(): void {
    if (hasScreenShareStatsSource()) return;
    stopScreenShareStatsPolling();
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
      failScreenSharePeer(peerId, "屏幕共享直连协商超时，请确认双方网络允许直连");
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
    maybeStopScreenShareStatsPolling();
  }

  function closeAllScreenSharePeers(): void {
    for (const peerId of [...screenSharePeers.keys()]) closeScreenSharePeer(peerId);
  }

  /**
   * 屏幕共享在带宽受限时的取舍方向。
   *
   * 实测（真实 WebRTC 编码器，同一码率上限 250kbps 对照）：
   *  - `contentHint="motion"` + `maintain-framerate` → 编码分辨率被压到 **320×180**（1280×720 的 1/4），
   *    `qualityLimitationReason: "bandwidth"`，文字完全无法辨认；
   *  - `maintain-resolution` → 保持 **1280×720**，只牺牲帧率。
   *
   * 因此：共享**标签页/窗口**（多为文档、代码、网页）或用户只选了低帧率时，分辨率是不可让步的
   * 底线，一律保分辨率；只有"整屏共享 + 用户明确要高帧率（≥30fps，放视频/游戏）"才保帧率。
   */
  function screenShareDegradationPreference(displaySurface: unknown): RTCDegradationPreference {
    const surface = typeof displaySurface === "string" ? displaySurface : "";
    const wantsSmoothness = surface === "monitor" && screenShareCaptureFrameRate >= 30;
    return wantsSmoothness ? "maintain-framerate" : "maintain-resolution";
  }

  function setScreenShareP2PError(message = "屏幕共享直连失败，当前网络无法建立与原生 TeamSpeak 客户端的直接连接") {
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
   * M2 send 方向对称就绪守卫（T8）。
   *
   * 屏幕双轨 produce 复用发起端既有 `sendTransport`。在收到
   * `screenShareStarted owner:true` 后必须确保 `mediaClient` 存在且上行
   * sendTransport 已建立就绪；未就绪时等待既有惰性建连流程
   * （`webrtcNegotiationPromise`）完成，超过上限才抛错。未就绪绝不触发 `produce`。
   */
  async function ensureScreenShareSendReady(timeoutMs = SCREEN_SHARE_SEND_READY_TIMEOUT_MS): Promise<MediaClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const client = mediaClient;
      if (client && client.sendTransportId) return client;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("上行媒体会话尚未就绪");
      const negotiation = webrtcNegotiationPromise;
      if (negotiation) {
        // 复用既有惰性建连流程：等待正在进行的 WebRTC 协商（有界）。
        await Promise.race([
          negotiation.catch(() => undefined),
          new Promise<void>((resolve) => { setTimeout(resolve, remaining); }),
        ]);
      } else {
        await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(remaining, 100)); });
      }
    }
  }

  /** 关闭并清空发起端屏幕双轨 Producer（T8：停止共享 / 推流失败时调用）。 */
  function releaseScreenShareProducers(): void {
    const video = screenShareVideoProducer;
    const audio = screenShareAudioProducer;
    screenShareVideoProducer = null;
    screenShareAudioProducer = null;
    try { video?.close(); } catch { /* 幂等 */ }
    try { audio?.close(); } catch { /* 幂等 */ }
    maybeStopScreenShareStatsPolling();
  }

  /**
   * S4-01（B2/H5/R7）：发起端屏幕双轨 SFU Produce。
   *
   * 收到 `screenShareStarted owner:true` 后调用：先过 M2 send 方向就绪守卫，
   * 再以统一码率天花板 `screenShareBitrateCeiling()` 经 `encodings.maxBitrate`
   * 发布屏幕视频轨（`appData.mediaType = "screen-video"`），并把 contentHint
   * 固定为 `"motion"` 保帧率；系统音轨存在时同步发布 `"screen-audio"`。
   * 成功后把发起端状态机从 starting 推进到 active。SFU 路径不再对该轨调用
   * `applyScreenShareSenderParameters`（仅保留给原生 TS 观众 P2P 路径）。
   */
  async function startScreenShareProducers(streamId: string): Promise<void> {
    const generation = screenShareStartGeneration;
    let client: MediaClient;
    try {
      client = await ensureScreenShareSendReady();
    } catch {
      if (generation !== screenShareStartGeneration) return;
      failScreenShareStart(streamId, "SCREEN_SHARE_UPLINK_NOT_READY", "屏幕共享上行媒体会话尚未就绪，请稍后重试");
      return;
    }
    if (generation !== screenShareStartGeneration || client !== mediaClient || screenShareActiveStreamId.value !== streamId) return;
    const localStream = screenShareLocalStream;
    const videoTrack = localStream?.getVideoTracks()[0];
    if (!videoTrack) {
      failScreenShareStart(streamId, "SCREEN_SHARE_NO_VIDEO_TRACK", "无法获取屏幕视频轨，请重试");
      return;
    }
    // SFU 推流保帧率策略：采集端 contentHint = "motion" 优先保帧率，码率天花板由
    // encodings.maxBitrate 承载；produce 成功后另经 rtpSender.setParameters 显式下发
    // degradationPreference = "maintain-framerate"（见下方 try 块）。
    if ("contentHint" in videoTrack) videoTrack.contentHint = "motion";
    const settings = videoTrack.getSettings();
    const width = typeof settings.width === "number" ? settings.width : null;
    const height = typeof settings.height === "number" ? settings.height : null;
    const ceiling = screenShareBitrateCeiling(width, height);
    try {
      // 推流配置锁定：L1T1（单空间层、单时域层）避免 SFU 层间重编码；maxBitrate 取
      // 按分辨率计算的天花板。produce 成功后把 degradationPreference 固定为
      // maintain-framerate，带宽紧张时优先降分辨率而非丢帧。
      const videoProducer = await client.produce({
        track: videoTrack,
        appData: { mediaType: "screen-video", streamId },
        encodings: [{ maxBitrate: ceiling, scalabilityMode: "L1T1" }],
      });
      try {
        const sender = (videoProducer as unknown as { rtpSender?: RTCRtpSender }).rtpSender;
        if (sender) {
          const params = sender.getParameters();
          params.degradationPreference = screenShareDegradationPreference(settings.displaySurface);
          await sender.setParameters(params);
        }
      } catch { /* 浏览器不支持 degradationPreference 时忽略 */ }
      if (generation !== screenShareStartGeneration || client !== mediaClient) {
        try { videoProducer.close(); } catch { /* 幂等 */ }
        return;
      }
      screenShareVideoProducer = videoProducer;
      // 非预期关闭自愈：发起端的屏幕 Producer 被对端/传输层关闭（DTLS 抖动、ICE 失效等）
      // 时，服务端会把整条共享判为结束。若本端界面不复位，就会停留在"直播中"幽灵态
      // （自己以为在直播、观众却看不到）。这里在 Producer 关闭时主动走停止流程。
      const handleProducerGone = (): void => {
        if (screenShareVideoProducer !== videoProducer) return; // 本端主动停止时不重复处理
        stopScreenShare();
      };
      videoProducer.on("@close", handleProducerGone);
      videoProducer.on("transportclose", handleProducerGone);
      const audioTrack = localStream?.getAudioTracks()[0] ?? null;
      if (audioTrack) {
        const audioProducer = await client.produce({
          track: audioTrack,
          appData: { mediaType: "screen-audio", streamId },
        });
        if (generation !== screenShareStartGeneration || client !== mediaClient) {
          try { audioProducer.close(); } catch { /* 幂等 */ }
          releaseScreenShareProducers();
          return;
        }
        screenShareAudioProducer = audioProducer;
      }
      // 推流成功：发起端状态机 starting → active，并启动网络性能采集轮询。
      screenShareStarting.value = false;
      screenShareActive.value = true;
      screenShareActiveStreamId.value = streamId;
      startScreenShareStatsPolling();
    } catch {
      if (generation !== screenShareStartGeneration) return;
      releaseScreenShareProducers();
      failScreenShareStart(streamId, "SCREEN_SHARE_PRODUCE_FAILED", "屏幕共享推流失败，请重试");
    }
  }

  /** 推流失败 / 就绪超时的统一收尾：通知服务端停止、停轨并复位发起端状态机。 */
  function failScreenShareStart(streamId: string, code: string, message: string): void {
    if (screenShareActiveStreamId.value === streamId) {
      sendScreenShareMessage({ type: "screenShareStop", streamId });
    }
    releaseScreenShareProducers();
    screenShareLocalStream?.getTracks().forEach((track) => track.stop());
    screenShareLocalStream = null;
    screenShareStarting.value = false;
    screenSharePendingStartId = "";
    screenShareStartCancelled = false;
    screenShareActive.value = false;
    screenShareActiveStreamId.value = "";
    screenShareErrorCode.value = code;
    screenShareError.value = message;
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
      // 与 SFU 路径同一取舍判据：文档/标签页等场景必须保分辨率。
      parameters.degradationPreference = screenShareDegradationPreference(settings.displaySurface);
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

  /**
   * M2 recv 方向对称就绪守卫（T9）。
   *
   * 观众端 SFU 拉流依赖下行 `recvTransport`。`mediaClient` 为 null 或尚未完成
   * 初始化时，先等待既有惰性建链流程（`webrtcNegotiationPromise`），必要时以
   * `startWebRtcTransport` 拉起媒体会话；`mediaClient` 存在后调用幂等的
   * `ensureRecvReady()` 确保 device 与 recvTransport 就绪。超过上限才抛错，
   * 未就绪绝不触发 `consume`。并发调用共享同一个 in-flight Promise。
   */
  function ensureScreenShareRecvReady(timeoutMs = SCREEN_SHARE_RECV_READY_TIMEOUT_MS): Promise<MediaClient> {
    if (!screenShareRecvReadyPromise) {
      screenShareRecvReadyPromise = waitForScreenShareRecvReady(timeoutMs).finally(() => {
        screenShareRecvReadyPromise = null;
      });
    }
    return screenShareRecvReadyPromise;
  }

  async function waitForScreenShareRecvReady(timeoutMs: number): Promise<MediaClient> {
    const deadline = Date.now() + timeoutMs;
    let pullUpRequested = false;
    for (;;) {
      const client = mediaClient;
      if (client) {
        if (client.loaded && client.recvTransportId) return client;
        try {
          await client.ensureRecvReady();
          if (client === mediaClient) return client;
        } catch {
          // 建链失败：落入下方重试预算，超时后由调用方统一报错。
        }
      } else if (!pullUpRequested) {
        // mediaClient 缺失：拉起媒体会话（幂等；并发去重由 startWebRtcTransport 自身承担）。
        pullUpRequested = true;
        const socket = ws.value;
        if (socket && socket.readyState === WebSocket.OPEN) {
          void startWebRtcTransport(connectionSequence, socket).catch(() => undefined);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("下行媒体会话尚未就绪");
      const negotiation = webrtcNegotiationPromise;
      if (negotiation) {
        // 复用既有惰性建链流程：等待正在进行的 WebRTC 协商（有界）。
        await Promise.race([
          negotiation.catch(() => undefined),
          new Promise<void>((resolve) => { setTimeout(resolve, remaining); }),
        ]);
      } else {
        await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(remaining, 100)); });
      }
    }
  }

  /** 关闭并清空观众端 SFU 双轨 Consumer（T9：切换流 / 退出观看时调用）。 */
  function releaseScreenShareViewerConsumers(): void {
    const video = screenShareVideoConsumer;
    const audio = screenShareAudioConsumer;
    screenShareVideoConsumer = null;
    screenShareAudioConsumer = null;
    try { video?.close(); } catch { /* 幂等 */ }
    try { audio?.close(); } catch { /* 幂等 */ }
    maybeStopScreenShareStatsPolling();
  }

  /**
   * R4/S4-03（T10）：观众端观看态的统一本地收尾。释放双轨 Consumer、复位观看状态机并
   * 清空播放器流，**不**发送 `screenShareLeave` —— 本函数由服务端级联关闭信令
   * （`screenShareVideoClosed` / `screenShareStopped`）或 Consumer 本地兜底事件驱动，
   * 服务端已掌握关闭语义，重复上报会与级联关闭形成回环。
   */
  function resetScreenShareViewing(): void {
    releaseScreenShareViewerConsumers();
    screenShareViewerState.value = "idle";
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
  }

  /**
   * R4/S4-03（T10）：为观众端 SFU Consumer 注册真实事件驱动的本地兜底清理。
   *
   * mediasoup-client 的 Consumer **没有** `producerclose` 事件（那是服务端事件），
   * 真实可用的是：
   *  - `trackended`：媒体轨实际结束（对端停轨 / 级联关闭）；
   *  - `@close`：Consumer 被关闭（含服务端级联关闭 PipeProducer 触发的连锁关闭）。
   *
   * 视频轨终结 → 退出观看态并释放播放器；音频轨终结 → 仅从 `MediaStream` 移除该音频轨、
   * 保留画面。本端主动 `close()`（切换流 / 退出观看）会先把模块级句柄置空，处理器据此
   * 识别并忽略，避免与服务端信令主驱动（`screenShareVideoClosed`）形成回环。
   */
  function watchScreenShareConsumer(consumer: MediaConsumer, kind: "video" | "audio", streamId: string): void {
    const consumerTrack = consumer.track;
    const handleTrackGone = (): void => {
      if (kind === "video") {
        if (screenShareVideoConsumer !== consumer) return;
        if (screenShareViewingStreamId.value !== streamId) return;
        resetScreenShareViewing();
        // 视频轨非预期终结（源 Producer 关闭 / 级联关闭）：保留流列表条目，给出可重试
        // 的提示，而不是静默退回空闲态——否则用户会以为"共享被关了"却不知可重新观看。
        screenShareErrorCode.value = "SCREEN_SHARE_STREAM_ENDED";
        screenShareError.value = "屏幕共享已中断，可重新点击观看";
        return;
      }
      if (screenShareAudioConsumer !== consumer) return;
      screenShareAudioConsumer = null;
      const media = screenShareRemoteStream.value;
      if (!media) return;
      for (const track of media.getTracks()) {
        if (track.id === consumerTrack.id) {
          media.removeTrack(track);
          break;
        }
      }
    };
    consumer.on("trackended", handleTrackGone);
    consumer.on("@close", handleTrackGone);
  }

  /** 观众端 SFU 拉流失败的统一收尾：释放 Consumer、退出观看态并提示用户。 */
  function failScreenShareViewer(message: string): void {
    releaseScreenShareViewerConsumers();
    if (screenShareViewingStreamId.value) sendScreenShareMessage({ type: "screenShareLeave", streamId: screenShareViewingStreamId.value });
    screenShareViewerState.value = "error";
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
    screenShareErrorCode.value = "";
    screenShareError.value = message;
  }

  /**
   * S4-02（T9）：观众端 SFU 双轨 Consume、显式 Resume 与 `<video>` 播放组装。
   *
   * 视频轨为必需项：`stream.videoProducerId` 缺省时置入 `waiting-producer` 等待态
   * 并提示用户，待 `screenShareProducers` 定向补齐后自动唤醒续拉流。视频就绪后先过
   * M2 recv 就绪守卫，再调用 `consume` 拉取视频轨并显式 `resumeConsumer` 解锁浏览器
   * 自动播放；若存在 `stream.audioProducerId` 则同步 consume + resume 音频轨。拉流
   * 轨道组装成单个 `MediaStream` 赋给 `screenShareRemoteStream`，直接挂到 `<video>`
   * 元素（音画同元素，由原生音量控件调节屏幕声音）。
   */
  async function startScreenShareSfuViewer(stream: ScreenShareStream): Promise<void> {
    if (!stream.videoProducerId) {
      screenShareViewerState.value = "waiting-producer";
      screenShareErrorCode.value = "SCREEN_SHARE_WAITING_PRODUCER";
      screenShareError.value = "等待发起端推流...";
      return;
    }
    screenShareViewerState.value = "connecting";
    let client: MediaClient;
    try {
      client = await ensureScreenShareRecvReady();
    } catch {
      failScreenShareViewer("屏幕共享下行媒体会话尚未就绪，请稍后重试");
      return;
    }
    if (client !== mediaClient || screenShareViewingStreamId.value !== stream.streamId) return;
    releaseScreenShareViewerConsumers();
    let videoConsumer: MediaConsumer;
    try {
      videoConsumer = await client.consume(stream.videoProducerId);
    } catch {
      failScreenShareViewer("屏幕共享拉流失败，请重试");
      return;
    }
    // 竞态：consume 期间可能已切换流或整个媒体会话被替换。
    if (client !== mediaClient || screenShareViewingStreamId.value !== stream.streamId) {
      try { videoConsumer.close(); } catch { /* 幂等 */ }
      return;
    }
    const tracks: MediaStreamTrack[] = [videoConsumer.track];
    let audioConsumer: MediaConsumer | null = null;
    if (stream.audioProducerId) {
      try {
        audioConsumer = await client.consume(stream.audioProducerId);
      } catch {
        // 音频轨拉取失败不阻断视频：屏幕画面仍可正常观看。
        audioConsumer = null;
      }
      if (audioConsumer) {
        if (client !== mediaClient || screenShareViewingStreamId.value !== stream.streamId) {
          try { audioConsumer.close(); } catch { /* 幂等 */ }
          try { videoConsumer.close(); } catch { /* 幂等 */ }
          return;
        }
        tracks.push(audioConsumer.track);
      }
    }
    screenShareVideoConsumer = videoConsumer;
    screenShareAudioConsumer = audioConsumer;
    // R4：注册真实事件驱动的本地兜底清理（trackended / @close），视频轨终结即退出观看态。
    watchScreenShareConsumer(videoConsumer, "video", stream.streamId);
    if (audioConsumer) watchScreenShareConsumer(audioConsumer, "audio", stream.streamId);
    // 自动播放策略会拦下未经用户手势的媒体：显式 resume 解锁；失败不阻断视频（静音播放仍可用）。
    try { await client.resumeConsumer(videoConsumer); } catch { /* 自动播放解锁失败不阻断视频 */ }
    if (audioConsumer) {
      try { await client.resumeConsumer(audioConsumer); } catch { /* 同上 */ }
    }
    screenShareRemoteStream.value = new MediaStream(tracks);
    screenShareViewerState.value = "playing";
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    startScreenShareStatsPolling();
  }

  /** `screenShareProducers` 后到音频：视频已在播时补拉音频轨并并入现有 MediaStream。 */
  async function consumeScreenShareAudioTrack(stream: ScreenShareStream): Promise<void> {
    const producerId = stream.audioProducerId;
    if (!producerId || screenShareAudioConsumer) return;
    const client = mediaClient;
    if (!client || !client.loaded || !client.recvTransportId) return;
    let audioConsumer: MediaConsumer;
    try {
      audioConsumer = await client.consume(producerId);
    } catch {
      return;
    }
    if (client !== mediaClient || screenShareViewingStreamId.value !== stream.streamId || screenShareAudioConsumer) {
      try { audioConsumer.close(); } catch { /* 幂等 */ }
      return;
    }
    screenShareAudioConsumer = audioConsumer;
    // R4：后到音频轨同样注册本地兜底清理（终结时仅移除音频轨，不影响画面）。
    watchScreenShareConsumer(audioConsumer, "audio", stream.streamId);
    try { await client.resumeConsumer(audioConsumer); } catch { /* 自动播放解锁失败不阻断视频 */ }
    const current = screenShareRemoteStream.value;
    if (current) current.addTrack(audioConsumer.track);
    else screenShareRemoteStream.value = new MediaStream([audioConsumer.track]);
  }

  /**
   * 进入观众观看态。
   *
   * S4-03（T10/H2）：Web 观众间 P2P 直连已彻底下线 —— browser 来源流不再创建
   * `RTCPeerConnection`，整体走 SFU 中央分发（`startScreenShareSfuViewer`）；仅
   * `source === "teamspeak"` 的原生共享流保留既有 P2P 直连观看路径。
   */
  async function startScreenShareViewer(stream: ScreenShareStream): Promise<void> {
    closeAllScreenSharePeers();
    releaseScreenShareViewerConsumers();
    screenShareRemoteStream.value = null;
    screenShareViewing.value = true;
    screenShareViewingStreamId.value = stream.streamId;
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    if (stream.source === "teamspeak") {
      // 原生 TeamSpeak 屏幕共享仍走既有 P2P 直连路径（不变，peerId 为 `ts-viewer-*`）。
      screenShareViewerState.value = "connecting";
      createScreenSharePeer(stream.streamId, stream.ownerPeerId, "viewer");
      armScreenSharePeerTimer(stream.ownerPeerId);
      return;
    }
    // 浏览器端屏幕共享走 SFU 中央分发：双轨 consume + 显式 resume（T9）。
    await startScreenShareSfuViewer(stream);
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

    // S4-03（T10/H2）：Web 观众间 P2P 直连已下线。browser 来源流的 P2P 信令仅放行原生
    // TeamSpeak 观众（peerId 形如 `ts-viewer-<clid>`）。对非该前缀的 offer 直接拦截忽略，
    // 避免 Web 观众误触发发起端 P2P 应答（服务端 `relayScreenShareSignal` 亦返回
    // `SCREEN_SHARE_SIGNAL_FORBIDDEN` 拒绝该路径，此处为前端侧双保险）。
    if (stream.source === "browser" && signal.kind === "offer" && !fromPeerId.startsWith("ts-viewer-")) {
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

    // S4-03（T10/H2）：原「Web 观看端接收发起端 answer」的 P2P 分支已随 Web 观众间
    // 直连下线一并删除 —— Web 观众不再创建 `RTCPeerConnection`，不存在待应答的 offer。

    if (screenShareActiveStreamId.value === streamId && stream.ownerPeerId === screenShareLocalPeerId() && fromPeerId.startsWith("ts-viewer-")) {
      // 仅应答原生 TeamSpeak 观众（`ts-viewer-*`）的 P2P offer：P2P 状态仅服务该路径。
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
      // Chromium 专有提示：不支持的字典成员按 WebIDL 应忽略，但 WebKit
      // 历史上会因未知成员整段拒绝，所以按内核筛选。
      ...(capabilities.displayCaptureHints ? { displaySurface: "browser" } : {}),
    } as MediaTrackConstraints;
    // 只有 Chromium 会把显示音频轨交出来；其余内核传 audio:true 只会换来
    // 一条永远不存在的音轨，不如直接不请求。
    const wantAudio = audio && capabilities.displayAudioCapture;
    const captureDisplay = async (): Promise<MediaStream> => {
      try {
        return await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: wantAudio });
      } catch (error) {
        if (error instanceof TypeError) {
          // 退化到最小约束再试一次：宁可不带分辨率/帧率上限，也要出画面。
          return navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantAudio });
        }
        throw error;
      }
    };
    try {
      const stream = await captureDisplay();
      if (startGeneration !== screenShareStartGeneration || !screenShareStarting.value || screenShareStartCancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("NO_VIDEO_TRACK");
      screenShareLocalStream = stream;
      // 显示采集轨默认按「文本/细节」语义编码 —— 清晰度优先，帧率第一个被牺牲。
      // 用户选了 >=30fps 说明要的是流畅（放视频/游戏），设成 motion；
      // 选低帧率通常是在共享文档/代码，保留 text 让文字更锐利。
      // WebKit 未实现 contentHint，写入会被静默忽略，所以先查能力。
      if (capabilities.contentHint) {
        videoTrack.contentHint = (settings?.maxFrameRate ?? 30) >= 30 ? "motion" : "text";
      }
      screenShareCaptureFrameRate = settings?.maxFrameRate ?? 30;
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
    // 只要已登记 streamId 就通知服务端停止：推流尚未完成（active 仍为 false）时
    // 也必须回收服务端已建立的共享会话，避免悬挂。
    if (screenShareActiveStreamId.value) sendScreenShareMessage({ type: "screenShareStop", streamId: screenShareActiveStreamId.value });
    closeAllScreenSharePeers();
    releaseScreenShareProducers();
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
    releaseScreenShareViewerConsumers();
    screenShareViewerState.value = "idle";
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
  }

  function stopScreenShareTransport(sendStop: boolean): void {
    screenShareStartGeneration += 1;
    if (sendStop && screenShareActiveStreamId.value) sendScreenShareMessage({ type: "screenShareStop", streamId: screenShareActiveStreamId.value });
    if (screenShareStarting.value) screenShareStartCancelled = true;
    closeAllScreenSharePeers();
    releaseScreenShareProducers();
    releaseScreenShareViewerConsumers();
    screenShareLocalStream?.getTracks().forEach((track) => track.stop());
    screenShareLocalStream = null;
    screenShareStarting.value = false;
    screenSharePendingStartId = "";
    screenShareStartCancelled = false;
    screenShareActive.value = false;
    screenShareActiveStreamId.value = "";
    screenShareViewerState.value = "idle";
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
    screenShareStreams.length = 0;
  }

  function upsertScreenShareStream(raw: unknown): ScreenShareStream | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<ScreenShareStream>;
    if (typeof value.streamId !== "string" || typeof value.ownerPeerId !== "string") return null;
    const existing = screenShareStreams.find((candidate) => candidate.streamId === value.streamId);
    // R7 / M1：定向管道 Producer ID 为惰性下发，广播态描述（screenShareList、部分广播）
    // 不携带该字段。仅在传入描述显式携带 producerId 时才覆盖，否则保留既有条目中已持久化的
    // 定向 ID，避免被列表刷新或广播冲掉。
    const mergedVideoProducerId = typeof value.videoProducerId === "string" ? value.videoProducerId : existing?.videoProducerId;
    const mergedAudioProducerId = typeof value.audioProducerId === "string" ? value.audioProducerId : existing?.audioProducerId;
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
      ...(typeof mergedVideoProducerId === "string" ? { videoProducerId: mergedVideoProducerId } : {}),
      ...(typeof mergedAudioProducerId === "string" ? { audioProducerId: mergedAudioProducerId } : {}),
    };
    if (existing) {
      // 原地合并：保留既有对象引用（响应式追踪与下游持有引用不失效），逐字段写回。
      Object.assign(existing, stream);
      return existing;
    }
    screenShareStreams.push(stream);
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
          void ensureMicrophone().catch((error: unknown) => { setMicrophoneError(error); });
        }
        sendScreenShareMessage({ type: "screenShareList" });
        break;
      case "screenShareList": {
        // M1 必修项：禁止全量清空（原 `screenShareStreams.length = 0`）。列表应答走广播态
        // 描述、不携带定向 producerId，清空会冲掉已 pipe 的 videoProducerId / audioProducerId，
        // 导致拉流句柄丢失。改为按 streamId 精确调谐：移除远端已下线的流，原地合并仍存在的流，
        // 追加新入流。
        const incoming = Array.isArray(msg.streams) ? msg.streams : [];
        const incomingIds = new Set<string>();
        for (const raw of incoming) {
          if (!raw || typeof raw !== "object") continue;
          const streamId = (raw as Partial<ScreenShareStream>).streamId;
          if (typeof streamId === "string" && streamId) incomingIds.add(streamId);
        }
        for (let i = screenShareStreams.length - 1; i >= 0; i -= 1) {
          if (!incomingIds.has(screenShareStreams[i].streamId)) screenShareStreams.splice(i, 1);
        }
        for (const raw of incoming) upsertScreenShareStream(raw);
        break;
      }
      case "screenShareStarted": {
        const stream = upsertScreenShareStream(msg.stream);
        if (!stream) break;
        if (msg.owner === true) {
          const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
          const isCurrentStart = Boolean(screenSharePendingStartId) && requestId === screenSharePendingStartId && !screenShareStartCancelled;
          screenSharePendingStartId = "";
          if (!isCurrentStart) {
            screenShareStarting.value = false;
            sendScreenShareMessage({ type: "screenShareStop", streamId: stream.streamId });
            screenShareLocalStream?.getTracks().forEach((track) => track.stop());
            screenShareLocalStream = null;
            const staleIndex = screenShareStreams.findIndex((candidate) => candidate.streamId === stream.streamId);
            if (staleIndex >= 0) screenShareStreams.splice(staleIndex, 1);
            break;
          }
          // T8：登记 streamId 后异步走 M2 send 就绪守卫 + 双轨 produce；发起端状态机
          // 由 startScreenShareProducers 在推流成功时从 starting 推进到 active。
          screenShareActiveStreamId.value = stream.streamId;
          void startScreenShareProducers(stream.streamId);
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
          releaseScreenShareProducers();
          screenShareStarting.value = false;
          screenSharePendingStartId = "";
          screenShareStartCancelled = false;
          screenShareActive.value = false;
          screenShareActiveStreamId.value = "";
          screenShareLocalStream?.getTracks().forEach((track) => track.stop());
          screenShareLocalStream = null;
        }
        if (screenShareViewingStreamId.value === streamId) {
          // T10：与 `screenShareVideoClosed` 协同，统一走观看态本地收尾（释放 Consumer/播放器）。
          closeAllScreenSharePeers();
          resetScreenShareViewing();
        }
        break;
      }
      case "screenShareVideoClosed": {
        // R4/S4-03（T10）：源屏幕视频 Producer 关闭的定向通知（服务端在级联关闭该观众的
        // PipeProducer/Consumer 之后下发）。主驱动前端清理：清空失效 producerId、释放
        // Consumer 与播放器并重置状态机；与 `screenShareStopped` 协同（后者覆盖整流结束）。
        const streamId = String(msg.streamId || "");
        const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
        if (stream) {
          // 视频轨为必需项：视频 Producer 关闭即整条观看链路失效，音频 producerId 同步作废，
          // 避免 `screenShareProducers` 后续误触发续拉流悬挂。
          delete stream.videoProducerId;
          delete stream.audioProducerId;
        }
        if (screenShareViewingStreamId.value === streamId) {
          // 保留流列表条目（等 `screenShareStopped` 收尾），仅退出观看态并释放本地资源。
          resetScreenShareViewing();
        }
        break;
      }
      case "screenShareJoined": {
        const stream = upsertScreenShareStream(msg.stream);
        if (!stream) break;
        void startScreenShareViewer(stream);
        break;
      }
      case "screenShareProducers": {
        // T9：观众专属的定向管道 Producer 通知（video 先推、audio 后到时补齐）。
        const streamId = String(msg.streamId || "");
        const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
        if (!stream) break;
        // 按 streamId 原地补齐：仅在显式携带时覆盖，与 upsert 合并语义一致。
        if (typeof msg.videoProducerId === "string" && msg.videoProducerId) stream.videoProducerId = msg.videoProducerId;
        if (typeof msg.audioProducerId === "string" && msg.audioProducerId) stream.audioProducerId = msg.audioProducerId;
        if (screenShareViewingStreamId.value !== streamId) break;
        if (screenShareViewerState.value === "waiting-producer" && stream.videoProducerId) {
          // 等待态被唤醒：自动触发续拉流。
          void startScreenShareSfuViewer(stream);
        } else if (screenShareViewerState.value === "playing" && stream.audioProducerId && !screenShareAudioConsumer) {
          // 视频先到、音频后到的 merge 场景：补拉音频轨并入现有 MediaStream。
          void consumeScreenShareAudioTrack(stream);
        }
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
      case "screenShareError": {
        const code = typeof msg.code === "string" ? msg.code : "";
        // 收敛竞态：源 Producer 非预期关闭时，本端可能先发 screenShareStop、服务端随后
        // 才处理，回执 SCREEN_SHARE_NOT_FOUND。此时本端已退出共享/观看，属正常收敛而非
        // 需要提示用户的失败——静默忽略，避免弹出误导性的错误横幅。
        const alreadyConverged = !screenShareActive.value && !screenShareStarting.value && !screenShareViewing.value;
        if (alreadyConverged && (code === "SCREEN_SHARE_NOT_FOUND" || code === "SCREEN_SHARE_NOT_OWNER")) break;
        screenShareErrorCode.value = code;
        screenShareError.value = String(msg.message || "屏幕共享操作失败");
        if (screenShareStarting.value) {
          releaseScreenShareProducers();
          screenShareStarting.value = false;
          screenSharePendingStartId = "";
          screenShareStartCancelled = false;
          screenShareActive.value = false;
          screenShareActiveStreamId.value = "";
          screenShareLocalStream?.getTracks().forEach((track) => track.stop());
          screenShareLocalStream = null;
        }
        if (screenShareViewing.value) {
          if (screenShareViewingStreamId.value) sendScreenShareMessage({ type: "screenShareLeave", streamId: screenShareViewingStreamId.value });
          closeAllScreenSharePeers();
          releaseScreenShareViewerConsumers();
          screenShareViewerState.value = "idle";
          screenShareViewing.value = false;
          screenShareViewingStreamId.value = "";
          screenShareRemoteStream.value = null;
        }
        break;
      }
      case "memberEnter":
        if (!members.some((member) => member.id === msg.id)) {
          members.push({ id: msg.id, nickname: msg.nickname, uid: typeof msg.uid === "string" ? msg.uid : undefined, avatar: typeof msg.avatar === "string" ? msg.avatar : undefined, isSelf: Boolean(msg.isSelf) });
          syncKnownMemberVolumes();
        }
        break;
      case "memberLeave": {
        const clientId = Number(msg.id);
        clearSpeaking(clientId);
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
      case "audioError": {
        // The gateway could not encode our microphone audio (for example its Opus
        // encoder is unavailable): say it instead of dropping frames silently.
        const audioCode = safeClientErrorCode(msg.code) || "AUDIO_ERROR";
        setAudioNotice(audioCode, audioNoticeMessage(audioCode, msg.detail));
        break;
      }
      // ── mediasoup 媒体信令（S5）────────────────────────────────────────
      case "mediaRtpCapabilities":
      case "mediaTransportCreated":
      case "mediaTransportConnected":
      case "mediaProduced":
      case "mediaConsumed":
      case "mediaProducerPaused":
      case "mediaProducerResumed":
      case "mediaConsumerResumed":
        settleMediaRequest(msg, false);
        break;
      case "mediaError":
        settleMediaRequest(msg, true);
        break;
      case "newSpeakerProducer": {
        const clientId = Number(msg.clientId);
        const producerId = String(msg.producerId ?? "");
        if (!mediaClient || !webrtcActive.value) {
          // 会话还没就绪：先入队，transport 建好后补消费（有界，避免无界增长）。
          if (Number.isInteger(clientId) && clientId > 0 && producerId && pendingSpeakerProducers.length < 64) {
            pendingSpeakerProducers.push({ clientId, producerId });
          }
          break;
        }
        void handleNewSpeakerProducer(clientId, producerId);
        break;
      }
      case "speakerProducerClosed":
        handleSpeakerProducerClosed(Number(msg.clientId), String(msg.producerId ?? ""));
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
   * 返回 null 表示当前没有可测的媒体路径：WebRTC 未启用，或尚未协商出候选对。
   * 调用方应把 null 当作"不可测"而不是"延迟为 0"。
   */
  async function sampleMediaPath(): Promise<MediaPathStats | null> {
    const client = mediaClient;
    if (!client || !webrtcActive.value) return null;
    try {
      const reports = await client.getStats();
      const pairRtts: number[] = [];
      const jitters: number[] = [];
      let packetsLost = 0;
      let packetsReceived = 0;
      for (const report of reports) {
        report.forEach((entry: Record<string, unknown>) => {
          if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated === true && typeof entry.currentRoundTripTime === "number") {
            pairRtts.push(entry.currentRoundTripTime * 1000);
          } else if (entry.type === "inbound-rtp" && entry.kind === "audio") {
            if (typeof entry.packetsLost === "number") packetsLost += entry.packetsLost;
            if (typeof entry.packetsReceived === "number") packetsReceived += entry.packetsReceived;
            if (typeof entry.jitter === "number") jitters.push(entry.jitter * 1000);
          }
        });
      }
      const totalPackets = packetsLost + packetsReceived;
      return {
        rttMs: pairRtts.length ? Math.round(Math.min(...pairRtts)) : null,
        packetsLost,
        packetsReceived,
        lossPercent: totalPackets > 0 ? Math.round((packetsLost / totalPackets) * 100) : null,
        jitterMs: jitters.length ? Math.round(Math.max(...jitters)) : null,
      };
    } catch {
      // transport 正在关闭时 getStats() 会抛错。这只是一次采样失败，不是错误状态。
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
    if (webrtcActive.value) micStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    if (webrtcMixMicGain) webrtcMixMicGain.gain.value = muted ? 0 : inputVolume.value;
    // 上行 Producer：静音时本地先行 pause（停发 RTP，节省上行带宽），解除后 resume；
    // TS3 侧输入静音状态由下面的 setMicrophoneMuted 命令同步。
    if (micProducer && !micProducer.closed) {
      try {
        if (muted) micProducer.pause();
        else micProducer.resume();
      } catch {
        // Producer 正在关闭：忽略，transport 重建时会带上正确的初始 muted。
      }
    }
    // 会话可能是在"没有麦克风"的情况下走 WebRTC 开始的（只听模式）。
    // 这次开麦时把麦克风取回来，并替换上行 Producer 上那条静音轨。
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
    // 动态播放图：成员音量直接落在该成员的 GainNode 上。只写 volumes 不会立刻
    // 改变声音 —— 必须同步更新节点增益。缺这一步时，改音量要等到下一次
    // applyOutputVolume()（例如切换自己的输出静音）才生效。
    const node = speakerNodes.get(clientId);
    if (node) {
      try { node.gainNode.gain.value = normalized * effectiveOutputVolume(); } catch { /* 节点已断开 */ }
    }
    if (webrtcActive.value) sendCmd("setMemberVolume", { clientId, volume: normalized });
  }

  function setInputVolume(volume: number): void {
    inputVolume.value = Math.max(0, Math.min(1, volume));
    if (micGain) micGain.gain.value = inputVolume.value;
    if (webrtcMixMicGain) webrtcMixMicGain.gain.value = microphoneMuted.value ? 0 : inputVolume.value;
    void saveAudioPreferences();
  }

  async function setNoiseSuppressionEnabled(enabled: boolean): Promise<void> {
    if (noiseSuppressionEnabled.value === enabled) return;
    const previousEnabled = noiseSuppressionEnabled.value;
    noiseSuppressionEnabled.value = enabled;
    void saveAudioPreferences();
    if (!micStream) return;
    try {
      // 降噪开关只重建本地采集管线，再用 replaceTrack 原地换轨，传输层与下行
      // Consumer 全程不断，避免切换降噪后听不到其他成员。
      await startMicrophone();
      if (micProducer && !micProducer.closed) await replaceWebRtcAudioTrack();
    } catch (error) {
      // 降噪节点重建或换轨失败：回滚开关与偏好并尽力恢复前置采集图，通话不因
      // 降噪切换断连；恢复成功时以原异常作非致命提示，失败则以恢复异常为准。
      noiseSuppressionEnabled.value = previousEnabled;
      void saveAudioPreferences();
      try {
        await startMicrophone();
        if (micProducer && !micProducer.closed) await replaceWebRtcAudioTrack();
        setMicrophoneError(error);
      } catch (recoveryError) {
        setMicrophoneError(recoveryError);
      }
      throw error;
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
   * 出问题时从 DOM 上看不出播放状态（mediasoup 的 `<audio>` 元素是静音的 sink，
   * 真正出声的是 WebAudio 图），把它挂到 window 上，便于在浏览器控制台或
   * 自动化测试里直接读到说话人绑定、增益与实时能量。不参与任何逻辑。
   */
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "__webspeakSfu", {
      configurable: true,
      get: () => ({
        recentMessages: [...recentMessageTypes],
        audioContextState: audioCtx?.state ?? "none",
        webrtcActive: webrtcActive.value,
        /** 当前媒体会话的 transport 与上行 Producer 概况。 */
        media: () => ({
          sendTransportId: mediaClient?.sendTransportId ?? null,
          recvTransportId: mediaClient?.recvTransportId ?? null,
          producerId: micProducer?.id ?? null,
          producerPaused: micProducer?.paused ?? null,
          producers: mediaClient?.producerCount ?? 0,
          consumers: mediaClient?.consumerCount ?? 0,
        }),
        /** 读取 WebRTC 接收统计，用来确认下行 RTP 是否真的到达浏览器。 */
        peerStats: async () => {
          if (!mediaClient) return null;
          const reports = await mediaClient.getStats();
          const inbound: Array<Record<string, unknown>> = [];
          const pairs: Array<Record<string, unknown>> = [];
          let mediaPlayout: Record<string, unknown> | null = null;
          let outbound: Record<string, unknown> | null = null;
          for (const report of reports) {
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
          }
          return { inbound, pairs, mediaPlayout, outbound };
        },
        /**
         * 用 <audio> 元素播放某个说话人的流，读 Chrome 的解码字节数。
         * 用来判断"轨道里有没有可解码的音频"—— 比分析器更能区分
         * "没收到音频"和"WebAudio 图有问题"。
         */
        probeElement: async (clientId: number) => {
          const node = speakerNodes.get(clientId);
          if (!node) return { error: "no such speaker" };
          const el = document.createElement("audio");
          el.autoplay = true;
          el.muted = true; // 静音播放，避免真的出声
          el.srcObject = node.stream;
          document.body.append(el);
          await el.play().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 2500));
          const anyEl = el as HTMLAudioElement & { webkitAudioDecodedByteCount?: number };
          const result = {
            // webkitAudioDecodedByteCount 是 Blink/WebKit 专有；Gecko 没有等价
            // 计数器，那边改用 RTP 统计的 totalAudioEnergy 判断"解码器有没有产出"。
            decodedBytes: capabilities.decodedAudioByteCounter ? (anyEl.webkitAudioDecodedByteCount ?? null) : null,
            paused: el.paused,
            readyState: el.readyState,
            error: el.error ? `${el.error.code}` : null,
            rtp: await readConsumerAudioEnergy(node.consumer, capabilities.rtcStats),
          };
          el.pause();
          el.srcObject = null;
          el.remove();
          return result;
        },
        /**
         * 用一条全新的独立音频链路测某个说话人的能量。
         * 用来区分"轨道本身没有音频"和"应用的音频图有问题"。
         */
        measureSpeaker: async (clientId: number) => {
          const node = speakerNodes.get(clientId);
          if (!node) return { error: "no such speaker" };
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
        /** 当前播放图快照：每个说话人的增益与实时能量。 */
        speakers: [...speakerNodes].map(([clientId, node]) => {
          node.analyserNode.getFloatTimeDomainData(node.buffer);
          let sum = 0;
          for (const value of node.buffer) sum += value * value;
          return {
            clientId,
            producerId: node.producerId,
            gain: Number(node.gainNode.gain.value.toFixed(3)),
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
     * 浏览器兼容性报告（内核 + 能力矩阵 + 降级清单）。UI 用它决定输出设备选择、
     * 伴奏共享、录音自测这些可选能力要不要露出，以及该给什么提示。
     */
    browserSupport,
    capabilities,
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
    screenShareViewerState,
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
    retryWebRtc,
  };
}
