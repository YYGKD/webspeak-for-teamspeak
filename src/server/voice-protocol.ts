import type {
  DtlsParameters,
  IceCandidate,
  IceParameters,
  MediaKind,
  RtpCapabilities,
  RtpParameters,
  SctpParameters,
} from "mediasoup/types";

/**
 * mediasoup 媒体信令（S3/S4/S5）。
 *
 * 这 8 个消息是浏览器侧 `mediasoup-client` 的握手与发布订阅入口，与 TS3 业务
 * 命令分开解析：媒体信令不依赖 TeamSpeak 会话就绪，浏览器可以在 TS 连接完成
 * 之前先把 Device 载入、把 transport 建起来。
 *
 * 方向约定：
 *   - `send`  transport：浏览器上行（浏览器 produce → 服务端 consume → TS3）
 *   - `recv`  transport：浏览器下行（TS3 说话人 → 服务端 DirectTransport produce → 浏览器 consume）
 */
export const MEDIA_SIGNALING_TYPES = [
  "mediaGetRtpCapabilities",
  "mediaCreateTransport",
  "mediaConnectTransport",
  "mediaProduce",
  "mediaConsume",
  "mediaPauseProducer",
  "mediaResumeProducer",
  "mediaConsumerResume",
] as const;

export type MediaSignalingType = (typeof MEDIA_SIGNALING_TYPES)[number];

export function isMediaSignalingType(type: string): type is MediaSignalingType {
  return (MEDIA_SIGNALING_TYPES as readonly string[]).includes(type);
}

export type MediaTransportDirection = "send" | "recv";

/** 说话人 Producer 关闭原因（`speakerProducerClosed` 推送的 reason 字段）。 */
export type SpeakerProducerCloseReason = "idle" | "evicted" | "closed" | "cleared";

export interface MediaGetRtpCapabilitiesPayload {
  direction?: MediaTransportDirection;
}

export interface MediaCreateTransportPayload {
  direction: MediaTransportDirection;
}

export interface MediaConnectTransportPayload {
  transportId: string;
  dtlsParameters: DtlsParameters;
}

export interface MediaProducePayload {
  transportId: string;
  kind?: MediaKind;
  rtpParameters: RtpParameters;
  appData?: Record<string, unknown>;
}

export interface MediaConsumePayload {
  transportId: string;
  producerId: string;
  rtpCapabilities: RtpCapabilities;
}

export interface MediaPauseProducerPayload {
  producerId: string;
}

export interface MediaResumeProducerPayload {
  producerId: string;
}

export interface MediaConsumerResumePayload {
  consumerId: string;
}

/** 客户端 → 服务端的媒体信令消息联合类型。 */
export type MediaClientMessage =
  | { type: "mediaGetRtpCapabilities"; requestId?: string; payload: MediaGetRtpCapabilitiesPayload }
  | { type: "mediaCreateTransport"; requestId?: string; payload: MediaCreateTransportPayload }
  | { type: "mediaConnectTransport"; requestId?: string; payload: MediaConnectTransportPayload }
  | { type: "mediaProduce"; requestId?: string; payload: MediaProducePayload }
  | { type: "mediaConsume"; requestId?: string; payload: MediaConsumePayload }
  | { type: "mediaPauseProducer"; requestId?: string; payload: MediaPauseProducerPayload }
  | { type: "mediaResumeProducer"; requestId?: string; payload: MediaResumeProducerPayload }
  | { type: "mediaConsumerResume"; requestId?: string; payload: MediaConsumerResumePayload };

/** 服务端 → 客户端的媒体信令响应与推送。 */
export interface MediaRtpCapabilitiesMessage {
  type: "mediaRtpCapabilities";
  requestId?: string;
  rtpCapabilities: RtpCapabilities;
}

export interface MediaTransportCreatedMessage {
  type: "mediaTransportCreated";
  requestId?: string;
  direction: MediaTransportDirection;
  transportId: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
}

export interface MediaTransportConnectedMessage {
  type: "mediaTransportConnected";
  requestId?: string;
  transportId: string;
}

export interface MediaProducedMessage {
  type: "mediaProduced";
  requestId?: string;
  producerId: string;
}

export interface MediaConsumedMessage {
  type: "mediaConsumed";
  requestId?: string;
  consumerId: string;
  producerId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters;
}

export interface MediaProducerStateMessage {
  type: "mediaProducerPaused" | "mediaProducerResumed";
  requestId?: string;
  producerId: string;
}

export interface MediaConsumerResumedMessage {
  type: "mediaConsumerResumed";
  requestId?: string;
  consumerId: string;
}

export interface MediaErrorMessage {
  type: "mediaError";
  requestId?: string;
  code: string;
  message: string;
}

/** 新增说话人：浏览器据此向 recv transport 发起 `mediaConsume`。 */
export interface NewSpeakerProducerMessage {
  type: "newSpeakerProducer";
  clientId: number;
  producerId: string;
}

/** 说话人 Producer 关闭：浏览器据此淡出并释放对应 Consumer。 */
export interface SpeakerProducerClosedMessage {
  type: "speakerProducerClosed";
  clientId: number;
  producerId: string;
  reason: SpeakerProducerCloseReason;
}

export type MediaServerMessage =
  | MediaRtpCapabilitiesMessage
  | MediaTransportCreatedMessage
  | MediaTransportConnectedMessage
  | MediaProducedMessage
  | MediaConsumedMessage
  | MediaProducerStateMessage
  | MediaConsumerResumedMessage
  | MediaErrorMessage
  | NewSpeakerProducerMessage
  | SpeakerProducerClosedMessage;

export type ClientCommandType =
  | "switchChannel"
  | "channelInfo"
  | "moveClient"
  | "sendTextMessage"
  | "sendServerMessage"
  | "sendPrivateMessage"
  | "poke"
  | "setAway"
  | "setWhisperTargets"
  | "setWhisperActive"
  | "setMicrophoneMuted"
  | "setAccompanimentActive"
  | "setMemberVolume"
  | "latencyProbe"
  | MediaSignalingType;

export interface ClientCommand {
  type: ClientCommandType;
  requestId?: string;
  payload: Record<string, unknown>;
}

export type ClientCommandResult = ClientCommand | { error: { code: string; message: string } };

export function parseClientCommand(raw: string): ClientCommandResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: { code: "INVALID_JSON", message: "消息不是有效的 JSON" } };
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return { error: { code: "INVALID_MESSAGE", message: "消息类型不能为空" } };
  }
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || value.requestId.length > 64)) {
    return { error: { code: "INVALID_REQUEST_ID", message: "请求标识无效" } };
  }
  const supportedTypes = new Set<string>(["switchChannel", "channelInfo", "moveClient", "sendTextMessage", "sendServerMessage", "sendPrivateMessage", "poke", "setAway", "setWhisperTargets", "setWhisperActive", "setMicrophoneMuted", "setAccompanimentActive", "setMemberVolume", "latencyProbe", ...MEDIA_SIGNALING_TYPES]);
  if (!supportedTypes.has(value.type)) {
    return { error: { code: "UNKNOWN_MESSAGE_TYPE", message: "不支持的消息类型" } };
  }
  if (!isRecord(value.payload)) {
    return { error: { code: "INVALID_PAYLOAD", message: "消息参数无效" } };
  }
  if (value.type === "switchChannel" && (typeof value.payload.channelId !== "string" || !/^\d{1,20}$/.test(value.payload.channelId))) {
    return { error: { code: "INVALID_CHANNEL_ID", message: "频道标识无效" } };
  }
  if (value.type === "channelInfo" && (typeof value.payload.channelId !== "string" || !/^\d{1,20}$/.test(value.payload.channelId))) {
    return { error: { code: "INVALID_CHANNEL_ID", message: "频道标识无效" } };
  }
  if (value.type === "switchChannel" && value.payload.password !== undefined && (typeof value.payload.password !== "string" || value.payload.password.length > 512)) {
    return { error: { code: "INVALID_CHANNEL_PASSWORD", message: "频道密码无效" } };
  }
  if (value.type === "moveClient" && (typeof value.payload.clientId !== "number" || !Number.isInteger(value.payload.clientId) || value.payload.clientId <= 0 || value.payload.clientId > 65535)) {
    return { error: { code: "INVALID_CLIENT_ID", message: "成员标识无效" } };
  }
  if (value.type === "moveClient" && (typeof value.payload.channelId !== "string" || !/^\d{1,20}$/.test(value.payload.channelId))) {
    return { error: { code: "INVALID_CHANNEL_ID", message: "频道标识无效" } };
  }
  if (value.type === "moveClient" && value.payload.password !== undefined && (typeof value.payload.password !== "string" || value.payload.password.length > 512)) {
    return { error: { code: "INVALID_CHANNEL_PASSWORD", message: "频道密码无效" } };
  }
  if (value.type === "sendTextMessage" && (typeof value.payload.message !== "string" || value.payload.message.length > 500)) {
    return { error: { code: "INVALID_TEXT_MESSAGE", message: "文字消息无效" } };
  }
  if ((value.type === "sendServerMessage" || value.type === "sendPrivateMessage") && (typeof value.payload.message !== "string" || value.payload.message.length > 500)) {
    return { error: { code: "INVALID_TEXT_MESSAGE", message: "文字消息无效" } };
  }
  if ((value.type === "sendPrivateMessage" || value.type === "poke") && (typeof value.payload.clientId !== "number" || !Number.isInteger(value.payload.clientId) || value.payload.clientId <= 0 || value.payload.clientId > 65535)) {
    return { error: { code: "INVALID_CLIENT_ID", message: "成员标识无效" } };
  }
  if (value.type === "poke" && (typeof value.payload.message !== "string" || value.payload.message.length > 200)) {
    return { error: { code: "INVALID_POKE_MESSAGE", message: "戳一戳消息无效" } };
  }
  if (value.type === "setAway" && (typeof value.payload.away !== "boolean" || (value.payload.message !== undefined && (typeof value.payload.message !== "string" || value.payload.message.length > 200)))) {
    return { error: { code: "INVALID_AWAY_STATUS", message: "离开状态无效" } };
  }
  if (value.type === "setWhisperTargets") {
    const targetIds = value.payload.targetIds;
    if (!Array.isArray(targetIds) || targetIds.length > 8 || targetIds.some((clientId) => typeof clientId !== "number" || !Number.isInteger(clientId) || clientId <= 0 || clientId > 65535) || new Set(targetIds).size !== targetIds.length) {
      return { error: { code: "INVALID_WHISPER_TARGETS", message: "私语目标无效" } };
    }
  }
  if (value.type === "setWhisperActive" && typeof value.payload.active !== "boolean") {
    return { error: { code: "INVALID_WHISPER_STATE", message: "私语状态无效" } };
  }
  if (value.type === "setMicrophoneMuted" && typeof value.payload.muted !== "boolean") {
    return { error: { code: "INVALID_MICROPHONE_STATE", message: "麦克风状态无效" } };
  }
  if (value.type === "setAccompanimentActive" && typeof value.payload.active !== "boolean") {
    return { error: { code: "INVALID_ACCOMPANIMENT_STATE", message: "伴奏状态无效" } };
  }
  if (value.type === "setMemberVolume" && (typeof value.payload.clientId !== "number" || !Number.isInteger(value.payload.clientId) || value.payload.clientId <= 0 || value.payload.clientId > 65535 || typeof value.payload.volume !== "number" || !Number.isFinite(value.payload.volume) || value.payload.volume < 0 || value.payload.volume > 4)) {
    return { error: { code: "INVALID_MEMBER_VOLUME", message: "成员音量无效" } };
  }
  if (value.type === "latencyProbe" && (typeof value.payload.sequence !== "string" || value.payload.sequence.length > 64)) {
    return { error: { code: "INVALID_LATENCY_PROBE", message: "延迟探测标识无效" } };
  }
  // ── mediasoup 媒体信令 ──────────────────────────────────────────────
  if (isMediaSignalingType(value.type)) {
    const invalid = validateMediaPayload(value.type, value.payload);
    if (invalid) return { error: invalid };
  }
  return {
    type: value.type as ClientCommand["type"],
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
    payload: value.payload,
  };
}

/** mediasoup 标识符（producerId/consumerId/transportId）长度上限。 */
const MAX_MEDIA_ID_LENGTH = 128;

function isMediaId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MEDIA_ID_LENGTH;
}

/**
 * 媒体信令的 payload 校验。
 *
 * 这里只做形状校验（标识符、方向、JSON 对象），RTP 参数与 DTLS 参数的语义
 * 校验交给 mediasoup 自己 —— 重复实现一遍 ORTC 校验只会引入第二套真相。
 */
function validateMediaPayload(type: MediaSignalingType, payload: Record<string, unknown>): { code: string; message: string } | null {
  switch (type) {
    case "mediaGetRtpCapabilities":
      if (payload.direction !== undefined && payload.direction !== "send" && payload.direction !== "recv") {
        return { code: "INVALID_MEDIA_DIRECTION", message: "媒体传输方向无效" };
      }
      return null;
    case "mediaCreateTransport":
      if (payload.direction !== "send" && payload.direction !== "recv") {
        return { code: "INVALID_MEDIA_DIRECTION", message: "媒体传输方向无效" };
      }
      return null;
    case "mediaConnectTransport":
      if (!isMediaId(payload.transportId)) return { code: "INVALID_MEDIA_TRANSPORT", message: "媒体传输标识无效" };
      if (!isRecord(payload.dtlsParameters)) return { code: "INVALID_MEDIA_DTLS_PARAMETERS", message: "DTLS 参数无效" };
      return null;
    case "mediaProduce":
      if (!isMediaId(payload.transportId)) return { code: "INVALID_MEDIA_TRANSPORT", message: "媒体传输标识无效" };
      if (!isRecord(payload.rtpParameters)) return { code: "INVALID_MEDIA_RTP_PARAMETERS", message: "RTP 参数无效" };
      if (payload.kind !== undefined && payload.kind !== "audio" && payload.kind !== "video") {
        return { code: "INVALID_MEDIA_KIND", message: "媒体类型无效" };
      }
      if (payload.appData !== undefined && !isRecord(payload.appData)) {
        return { code: "INVALID_MEDIA_APP_DATA", message: "媒体附加参数无效" };
      }
      return null;
    case "mediaConsume":
      if (!isMediaId(payload.transportId)) return { code: "INVALID_MEDIA_TRANSPORT", message: "媒体传输标识无效" };
      if (!isMediaId(payload.producerId)) return { code: "INVALID_MEDIA_PRODUCER", message: "生产者标识无效" };
      if (!isRecord(payload.rtpCapabilities)) return { code: "INVALID_MEDIA_RTP_CAPABILITIES", message: "RTP 能力集无效" };
      return null;
    case "mediaPauseProducer":
    case "mediaResumeProducer":
      if (!isMediaId(payload.producerId)) return { code: "INVALID_MEDIA_PRODUCER", message: "生产者标识无效" };
      return null;
    case "mediaConsumerResume":
      if (!isMediaId(payload.consumerId)) return { code: "INVALID_MEDIA_CONSUMER", message: "消费者标识无效" };
      return null;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
