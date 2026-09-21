import { reactive, ref } from "vue";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import { loadLocalPreferences, saveLocalPreferences } from "../services/local-persistence.js";

const micCaptureWorkletUrl = "/mic-capture-worklet.js";

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
  canMoveClients: boolean;
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
const MIN_NICKNAME_CHARACTERS = 3;

/** 连接阶段「正在连接…」的兜底上限。见 armConnectWatchdog。 */
const CONNECT_WATCHDOG_MS = 25_000;
const CONNECT_WATCHDOG_MESSAGE = "连接超时：服务器在 25 秒内没有响应，请重试";

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
};

export function useVoiceWebSocket() {
  const ws = ref<WebSocket | null>(null);
  const state = reactive<VoiceState>({ connected: false, connecting: false, reconnecting: false, reconnectAttempt: 0, reconnectFailed: false, tsClientId: 0, canMoveClients: false, error: "", errorCode: "", microphoneError: "", microphoneErrorCode: "", audioNotice: "", audioNoticeCode: "", channelSwitchedChannelId: "" });
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

  void loadLocalPreferences().then((preferences) => {
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
    for (const [clientId, gain] of remoteGains) gain.gain.value = (volumes[clientId] ?? 1) * level;
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
    if (!micStream) throw new Error("没有可用的麦克风音轨");
    const ctx = getAudioCtx();
    stopWebRtcMix();
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    destination.channelCountMode = "explicit";
    // Use the browser-native processed track plus the browser-side RNNoise
    // graph. Display/application audio is added separately below and never
    // passes through this microphone denoiser.
    const microphoneStream = processedMicDestination?.stream ?? micStream;
    const microphoneSource = ctx.createMediaStreamSource(microphoneStream);
    const microphoneGain = ctx.createGain();
    microphoneGain.gain.value = microphoneMuted.value ? 0 : inputVolume.value;
    microphoneSource.connect(microphoneGain);
    microphoneGain.connect(destination);

    webrtcMixDestination = destination;
    webrtcMixMicSource = microphoneSource;
    webrtcMixMicGain = microphoneGain;

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
    await ensureMicrophone();
    if (sequence !== connectionSequence || socket.readyState !== WebSocket.OPEN || !micStream) return;
    const microphoneTrack = micStream.getAudioTracks()[0];
    if (!microphoneTrack) throw new Error("没有可用的麦克风音轨");

    stopCaptureGraph();
    const peer = new RTCPeerConnection({ iceServers: activeIceServers });
    webrtcPeer = peer;
    webrtcFallbackStarted = false;
    microphoneTrack.enabled = !microphoneMuted.value;
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
    startWebRtcMicMonitor(getAudioCtx(), micStream, microphoneTrack);
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
      const memberVolume = node.clientId === null ? 1 : (volumes[node.clientId] ?? 1);
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

  function playAudioFrame(clientId: number, opusData: Uint8Array): void {
    if (opusData.length < 3) return;
    let decoder = remoteDecoders.get(clientId);
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const scheduledUntil = remotePlayTimes.get(clientId) ?? now;
    const decodeQueueSize = decoder?.decodeQueueSize ?? 0;
    if (
      decoder &&
      (scheduledUntil > now + MAX_REMOTE_PLAY_AHEAD_SECONDS || decodeQueueSize >= MAX_REMOTE_DECODE_QUEUE_FRAMES)
    ) {
      resetRemotePlayback(clientId);
      decoder = undefined;
    }

    if (!decoder) {
      const gainNode = ctx.createGain();
      gainNode.gain.value = (volumes[clientId] ?? 1) * effectiveOutputVolume();
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
            if (playTime + numberOfFrames / sampleRate > ctx.currentTime + MAX_REMOTE_PLAY_AHEAD_SECONDS) {
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
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp, duration: 20_000, data: opusData }));
      remoteDecodeTimestamps.set(clientId, timestamp + 20_000);
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
      state.connecting = false;
      state.reconnecting = false;
      state.errorCode = "CONNECT_TIMEOUT";
      state.error = CONNECT_WATCHDOG_MESSAGE;
      const socket = ws.value;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
    }, CONNECT_WATCHDOG_MS);
  }

  function connect(target: string, channel: string, nickname: string, serverPassword = "", identity = "", rememberIdentity = false, inviteToken = "", accelerated = false, accelerationRelayId = ""): void {
    disconnect(true);
    lastConnection = { target, channel, nickname, serverPassword, ...(identity ? { identity } : {}), rememberIdentity, accelerated, accelerationRelayId };
    identityMaterial.value = identity;
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
    armConnectWatchdog(sequence);
    void openTicketedConnection(sequence, target, channel, nickname, serverPassword, inviteToken, accelerated);
  }

  async function openTicketedConnection(sequence: number, target: string, channel: string, nickname: string, serverPassword: string, inviteToken: string, accelerated: boolean): Promise<void> {
    try {
      const response = await fetch("/api/join-ticket", {
        method: "POST",
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
      const errorRecord = error && typeof error === "object" ? error as { code?: unknown } : {};
      state.errorCode = normalizedClientErrorCode(errorRecord.code, "REQUEST_FAILED");
      state.error = error instanceof Error ? error.message : connectionFailureMessage(state.errorCode);
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
      clearLatencyProbes();
      rejectPendingCommands(new Error("语音连接已关闭"));
      state.connected = false;
      state.canMoveClients = false;
      state.connecting = false;
      state.reconnecting = false;
      // Prefer the close code over the generic WebSocket error event. The
      // gateway uses a dedicated code when a remembered identity is already
      // active in another browser page.
      if (event.code !== 1000 && !state.reconnectFailed && !state.errorCode) {
        state.errorCode = closeErrorCode(event.code, event.reason);
        state.error = closeReason(event.code, event.reason);
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
    const keepRememberedIdentity = lastConnection?.rememberIdentity === true;
    if (!preserveConnection) lastConnection = null;
    stopMicrophone();
    clearMicrophoneError();
    clearAudioNotice();
    const socket = ws.value;
    ws.value = null;
    stopWebRtcTransport();
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
    state.connected = false;
    state.connecting = false;
    state.reconnecting = false;
    state.reconnectAttempt = 0;
    state.reconnectFailed = false;
    state.tsClientId = 0;
    state.canMoveClients = false;
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

  function handleMessage(msg: any): void {
    recentMessageTypes.push(String(msg?.type));
    if (recentMessageTypes.length > 15) recentMessageTypes.shift();
    switch (msg.type) {
      case "connected":
        const wasReconnecting = state.reconnecting;
        clearConnectWatchdog();
        state.connected = true;
        state.connecting = false;
        state.reconnecting = false;
        state.reconnectAttempt = 0;
        state.reconnectFailed = false;
        state.error = "";
        state.errorCode = "";
        state.channelSwitchedChannelId = "";
        state.tsClientId = Number(msg.tsClientId) || 0;
        state.canMoveClients = msg.canMoveClients === true;
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
        break;
      case "capabilities":
        state.canMoveClients = msg.canMoveClients === true;
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
        state.canMoveClients = false;
        state.connecting = false;
        state.reconnecting = Boolean(msg.recoverable !== false);
        state.reconnectFailed = false;
        if (!state.reconnecting) state.error = "TeamSpeak 连接已断开";
        stopWebRtcTransport();
        stopMicrophone();
        whisperTargetIds.clear();
        whisperActive.value = false;
        break;
      case "reconnecting":
        state.connected = false;
        state.canMoveClients = false;
        state.connecting = false;
        state.reconnecting = true;
        state.reconnectFailed = false;
        state.reconnectAttempt = Number(msg.attempt) || state.reconnectAttempt + 1;
        stopWebRtcTransport();
        stopMicrophone();
        whisperTargetIds.clear();
        whisperActive.value = false;
        break;
      case "reconnected":
        state.reconnecting = false;
        state.reconnectFailed = false;
        break;
      case "reconnectFailed":
        state.connected = false;
        state.canMoveClients = false;
        state.connecting = false;
        state.reconnecting = false;
        state.reconnectFailed = true;
        state.errorCode = normalizedClientErrorCode(msg.code);
        state.error = connectionFailureMessage(state.errorCode, msg.detail);
        whisperTargetIds.clear();
        whisperActive.value = false;
        break;
      case "connectionFailed":
        clearConnectWatchdog();
        state.connected = false;
        state.canMoveClients = false;
        state.connecting = false;
        state.reconnecting = false;
        // This is the first connection attempt, not a failed reconnect. Keep
        // the user on the welcome form instead of showing an empty voice room.
        state.reconnectFailed = false;
        state.errorCode = normalizedClientErrorCode(msg.code);
        state.error = connectionFailureMessage(state.errorCode, msg.detail);
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
      setMicrophoneError(error);
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
    members,
    channels,
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
    checkSupport,
    clearError,
    measureLatency,
    sampleMediaPath,
    webrtcActive,
  };
}
