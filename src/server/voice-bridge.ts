import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
// randomUUID 来自 v0.2.4 的屏幕共享（流 id / peer id）。
// v0.2.4 同时把 OpusEncoder 的 createRequire 内联到了这个文件，但本地已经把
// 编码器抽到 opus-codec.ts（带 complexity/bitrate 调优），所以这里不要那个内联。
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { identityFromString } from "@echosixhiya/teamspeak-client";
import { DirectorySynchronizer } from "./directory-sync.js";
import { TSClient, type TSDirectorySnapshot, type TSVoiceData, type TSRawNotification } from "./ts-client.js";
import type { Logger as LoggerType } from "../logger.js";
import { clientConnectionFailureCode, describeTeamSpeakError, normalizeTeamSpeakError, teamSpeakServerErrorCode, type WebSpeakError } from "../errors.js";
import { formatTeamSpeakTarget, teamSpeakTargetKey, type TeamSpeakTarget } from "../domain/teamspeak-target.js";
import { JoinTicketStore, type JoinTicketPayload } from "./join-ticket.js";
import { IdentityLeaseStore } from "./identity-lease.js";
import { SessionManager, type ManagedSession, type SessionTeardownReason } from "./session-manager.js";
import { parseClientCommand, isMediaSignalingType, type ClientCommand, type MediaTransportDirection } from "./voice-protocol.js";
import { isRecoverable, reconnectDelayMs, reconnectWindowOpen } from "./reconnect-policy.js";
import { generateTurnUserid, resolveIceServers } from "./ice-credentials.js";
import { pingTeamSpeakSession } from "./network-probe.js";
import type { AccelerationRelayOptions, ConfiguredAccelerationRelay } from "./acceleration-relay.js";
import { createOpusEncoder } from "./opus-codec.js";
import type { WebRtcAudioOptions } from "./webrtc-config.js";
import { createMediaRouter, createMediaWebRtcTransport, getMediaWorker } from "./media-worker.js";
import { DIRECT_TRANSPORT_MAX_SEND_MESSAGE_SIZE, SpeakerProducerMap, resolveMaxSpeakers } from "./speaker-producer-map.js";
import type { Consumer, DirectTransport, DtlsParameters, MediaKind, Producer, Router, RtpCapabilities, RtpParameters, WebRtcTransport } from "mediasoup/types";
import { normalizeScreenShareIceServers, parseScreenShareMessage, type ScreenShareClientMessage, type ScreenShareIceServer, type ScreenSharePeerSignal, type ScreenShareStreamDescription, type ScreenShareViewerDescription } from "./screen-share.js";

// 90s（原 30s）：防跨境抖动拆连，运维热补丁固化。
const HEARTBEAT_INTERVAL_MS = 90_000;
/**
 * WS 兼容（降级）通道的定长 PCM 帧：20ms 单声道 48kHz s16le。
 * S4 起 WebRTC 上行改走 mediasoup DirectTransport Consumer，但这条
 * 二进制通道**原样保留**，作为 WebRTC 禁用/协商失败时的降级路径。
 */
export const AUDIO_FRAME_BYTES = 1_920;
// A browser audio frame is 20 ms of mono 48 kHz PCM. Keep the server-side
// WebSocket egress queue small enough that a slow browser cannot turn old
// voice into seconds of latency. Opus frames are variable-sized, so this is
// deliberately a conservative byte backpressure guard for roughly 10–20
// small Opus frames; the browser also enforces a time-based playback limit
// before scheduling decoded audio.
const MAX_SERVER_AUDIO_BUFFERED_BYTES = 4_096;

/** TS3 上行语音 codec：4 = Opus Voice（普通语音）。 */
export const OPUS_VOICE_CODEC = 4;
/** TS3 上行语音 codec：5 = Opus Music（伴奏，60ms 音乐帧）。 */
export const OPUS_MUSIC_CODEC = 5;

/** RTP 固定头长度（RFC 3550：V/P/X/CC + M/PT + seq + ts + ssrc）。 */
const RTP_FIXED_HEADER_BYTES = 12;

/**
 * 从 RTP 报文中抽取载荷，安全跳过 CSRC 列表、头部扩展与 padding。
 *
 * S4 上行链路必须"复用 RTP 头解析安全跳过扩展头"：mediasoup 的
 * DirectTransport Consumer 会重写序号并注入一个 16 字节头部扩展
 * （见 speaker-producer-map-test 的实测结论），若按固定 12 字节偏移取
 * payload 会把扩展字节当成 Opus 数据送给 TeamSpeak，造成解码爆音。
 *
 * 解析不出来（截断、版本非 2、扩展/padding 长度越界、空载荷）时返回 null，
 * 由调用方按"格式无效"静默丢弃，绝不猜一个偏移量硬送。
 */
export function extractOpusPayload(packet: Buffer): Buffer | null {
  if (packet.length < RTP_FIXED_HEADER_BYTES) return null;
  if ((packet[0] as number) >> 6 !== 2) return null;
  const csrcCount = (packet[0] as number) & 0x0f;
  let offset = RTP_FIXED_HEADER_BYTES + csrcCount * 4;
  if (packet.length < offset) return null;
  // 头部扩展：X 位置位时，头 4 字节为 profile(2) + 长度(2，单位 32bit 字)。
  if (((packet[0] as number) & 0x10) !== 0) {
    if (packet.length < offset + 4) return null;
    const extensionWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extensionWords * 4;
    if (packet.length < offset) return null;
  }
  let end = packet.length;
  // padding：P 位置位时，最后一字节是 padding 长度（含该字节自身）。
  if (((packet[0] as number) & 0x20) !== 0) {
    const paddingBytes = packet[packet.length - 1] as number;
    if (paddingBytes === 0 || paddingBytes > end - offset) return null;
    end -= paddingBytes;
  }
  if (offset >= end) return null;
  return packet.subarray(offset, end);
}

/**
 * 上行转发的目标抽象。
 *
 * `WebClientEntry` 结构上满足它（`tsClient` 提供 sendVoice/sendWhisper，
 * whisper/mute/accompaniment 状态是同一对象的可变字段），因此管线读取的永远是
 * **实时状态**而非快照；测试可注入一个记录调用的 Stub 目标。
 */
export interface UpstreamAudioTarget {
  /** 私语是否激活（`setWhisperActive` 命令维护）。 */
  whisperActive: boolean;
  /** 私语目标 clientId 集合（`setWhisperTargets` 命令维护）。 */
  whisperTargetIds: Set<number>;
  /** 网关侧麦克风静音状态（`setMicrophoneMuted` / `mediaPauseProducer` 维护）。 */
  microphoneMuted: boolean;
  /** 伴奏是否激活（`setAccompanimentActive` 命令维护）。 */
  accompanimentActive: boolean;
  tsClient: {
    sendVoice(payload: Buffer, codec: number): void;
    sendWhisper(payload: Buffer, targets: number[], codec: number): void;
  };
}

export interface UpstreamAudioPipelineOptions {
  /** DirectTransport 的消息上限；缺省与下行链路同量级（2048）。 */
  maxSendMessageSize?: number;
  /** 一帧成功转发到 TS3 时回调（观测用）。 */
  onFrameForwarded?: (codec: number, bytes: number) => void;
  /** 一帧被丢弃时回调（观测用）。 */
  onFrameDropped?: (reason: "muted" | "malformed") => void;
}

/**
 * 可同步 TS3 输入静音状态的目标（`WebClientEntry` 与测试 Stub 均结构满足）。
 */
export interface MicrophoneMuteTarget {
  microphoneMuted: boolean;
  tsClient: { setInputMuted(muted: boolean): void | Promise<void> };
}

/**
 * 应用网关侧麦克风静音状态（S4 §8.3）。
 *
 * 先同步 TS3 输入静音（TS3 目录里静音图标一致），再更新网关侧丢包护栏状态。
 * `setInputMuted` 失败时抛出，由命令处理器统一 catch 转成错误帧——不静默吞。
 */
export async function applyMicrophoneMute(target: MicrophoneMuteTarget, muted: boolean): Promise<void> {
  await target.tsClient.setInputMuted(muted);
  target.microphoneMuted = muted;
}

/**
 * S4 上行链路：浏览器上行 Producer → DirectTransport Consumer → TSClient。
 *
 * 每个上行 Producer 一条管线、一条 DirectTransport。`attach()` 订阅该 Producer
 * 并**显式 `consumer.resume()`**；`consumer.on('rtp')` 抽出的 Opus payload 按
 * 零退化矩阵分流：
 *
 *   ① whisper：`whisperActive && whisperTargetIds.size > 0` → `sendWhisper(..., 4)`；
 *      否则 → `sendVoice(..., codec)`；
 *   ② accompaniment：`accompanimentActive` 决定 codec（true → 5 Opus Music，false → 4）；
 *   ③ mute 护栏：`microphoneMuted` 期间收到上行包一律静默丢弃（防御浏览器异常）。
 *
 * 设计上把"决策"与"资源"都收进这个类，便于用 Stub 目标做零网络单测；
 * 生产侧由 `VoiceBridge.attachUpstreamPipeline()` 接线。
 */
export class UpstreamAudioPipeline {
  private transport: DirectTransport | null = null;
  private consumer: Consumer | null = null;
  private closed = false;

  constructor(
    private readonly target: UpstreamAudioTarget,
    private readonly options: UpstreamAudioPipelineOptions = {},
  ) {}

  /** 是否已订阅到上行 Producer。 */
  get attached(): boolean {
    return this.consumer !== null;
  }

  /** 当前 Consumer id（未订阅时为 undefined）。 */
  get consumerId(): string | undefined {
    return this.consumer?.id;
  }

  /**
   * 在 Router 上创建 DirectTransport Consumer 订阅该上行 Producer 并显式 resume。
   *
   * 创建失败（Producer 不存在 / Router 已关闭）时清理半成品并抛出，由信令层
   * 转成 mediaError —— 不静默吞掉，否则浏览器会一直等不到 `mediaProduced` 回执。
   */
  async attach(router: Router, producerId: string): Promise<void> {
    if (this.closed) throw new Error("upstream pipeline is closed");
    if (this.consumer) return;
    const transport = await router.createDirectTransport({
      maxSendMessageSize: this.options.maxSendMessageSize ?? DIRECT_TRANSPORT_MAX_SEND_MESSAGE_SIZE,
      appData: { direction: "upstream" },
    });
    try {
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: router.rtpCapabilities,
        appData: { direction: "upstream" },
      });
      consumer.on("rtp", (packet: Buffer) => this.handleRtpPacket(packet));
      consumer.on("producerclose", () => this.close());
      consumer.on("transportclose", () => { this.consumer = null; });
      // Consumer 默认未暂停，这里显式 resume 声明"立即开始收包"，与验收口径一致。
      await consumer.resume();
      this.transport = transport;
      this.consumer = consumer;
    } catch (error: unknown) {
      try { transport.close(); } catch { /* 幂等 */ }
      throw error;
    }
  }

  /** 处理一个来自上行 Producer 的 RTP 报文（Consumer 'rtp' 事件的入口）。 */
  handleRtpPacket(packet: Buffer): void {
    if (this.closed) return;
    // ③ 静音护栏：muted 期间的上行包一律丢弃，绝不透传到 TS3。
    if (this.target.microphoneMuted) {
      this.options.onFrameDropped?.("muted");
      return;
    }
    const extracted = extractOpusPayload(packet);
    if (!extracted || extracted.length === 0) {
      this.options.onFrameDropped?.("malformed");
      return;
    }
    // mediasoup 的 rtp 事件 Buffer 由事件循环复用，转发前拷一份自有内存。
    this.forwardOpusPayload(Buffer.from(extracted));
  }

  /** 抽取后的 Opus payload 按零退化矩阵分流到 TS3。 */
  forwardOpusPayload(payload: Buffer): void {
    if (this.closed) return;
    // ③ 静音护栏（防御性重复拦截）：无论从 handleRtpPacket 还是直接调用进入，
    // muted 期间都不得透传。两道拦截保证任何一个入口都不会漏。
    if (this.target.microphoneMuted) {
      this.options.onFrameDropped?.("muted");
      return;
    }
    // ② 伴奏决定 codec：5 = Opus Music，4 = Opus Voice。
    const codec = this.target.accompanimentActive ? OPUS_MUSIC_CODEC : OPUS_VOICE_CODEC;
    if (this.target.whisperActive && this.target.whisperTargetIds.size > 0) {
      // ① 私语命中：仅目标成员收到，沿用既有 codec 4 约定。
      this.target.tsClient.sendWhisper(payload, [...this.target.whisperTargetIds], OPUS_VOICE_CODEC);
    } else {
      this.target.tsClient.sendVoice(payload, codec);
    }
    this.options.onFrameForwarded?.(codec, payload.length);
  }

  /** 释放 Consumer 与 DirectTransport（幂等）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const consumer = this.consumer;
    this.consumer = null;
    if (consumer) {
      try { consumer.close(); } catch { /* 幂等 */ }
    }
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      try { transport.close(); } catch { /* 幂等 */ }
    }
  }
}

function publicFailureDetail(error: ReturnType<typeof normalizeTeamSpeakError>): string | undefined {
  const serverMessage = error.diagnostics.serverMessage?.trim();
  const serverId = error.diagnostics.id?.trim();
  const detail = [serverMessage, serverId ? `server error id=${serverId}` : ""].filter(Boolean).join("; ");
  const safe = detail.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return safe || undefined;
}

export interface VoiceBridgeOptions {
  joinTickets: JoinTicketStore;
  webRtc?: WebRtcAudioOptions | (() => WebRtcAudioOptions);
  screenShareIceServers?: ScreenShareIceServer[] | (() => ScreenShareIceServer[]);
  acceleration?: ConfiguredAccelerationRelay[] | (() => ConfiguredAccelerationRelay[]);
  accelerationName?: string | (() => string | undefined);
}

export interface AdminSessionSummary {
  id: string;
  nickname: string;
  target: string;
  state: string;
  createdAt: string;
  ageSeconds: number;
  tsClientId: number | null;
  channelId: string | null;
  memberCount: number;
  audio: AudioFlowStats;
}

export interface AudioFlowStats {
  ingressFrames: number;
  ingressDroppedFrames: number;
  ingressFirstAt: number | null;
  ingressLastAt: number | null;
  ingressMaxGapMs: number;
  tsSendFrames: number;
  tsSendErrors: number;
  tsSendFirstAt: number | null;
  tsSendLastAt: number | null;
  tsSendMaxGapMs: number;
  tsEncodeMaxMs: number;
  tsReceiveFrames: number;
  tsReceiveFirstAt: number | null;
  tsReceiveLastAt: number | null;
  tsReceiveMaxGapMs: number;
  egressFrames: number;
  egressDroppedFrames: number;
  egressFirstAt: number | null;
  egressLastAt: number | null;
  egressMaxGapMs: number;
  egressSentFirstAt: number | null;
  egressSentLastAt: number | null;
  egressSentMaxGapMs: number;
  egressPeakBufferedBytes: number;
  egressFramesByClient: Record<string, number>;
}

interface ChannelMember {
  id: number;
  nickname: string;
  uid: string;
  avatar?: string;
  away?: boolean;
  awayMessage?: string;
  inputMuted?: boolean;
  outputMuted?: boolean;
  channelCommander?: boolean;
}

interface ServerEvent {
  id: string;
  kind: "joined" | "left" | "moved" | "poke" | "connection";
  message: string;
  timestamp: number;
}

/**
 * 一个浏览器会话的 mediasoup 媒体图。
 *
 * - `sendTransport`：浏览器上行（浏览器 produce → 服务端 consume → TS3，S4 接线）
 * - `recvTransport`：浏览器下行（TS3 说话人 → DirectTransport produce → 浏览器 consume）
 * - `speakerProducers`：说话人 → DirectTransport Producer 的动态映射（S3 核心）
 *
 * 每个会话一个 Router：说话人集合与订阅关系都是会话私有的，共享 Router 会让
 * 一个会话的 Producer 泄漏到另一个会话的 `rtpCapabilities` 视图里。
 */
interface MediaSession {
  router: Router;
  sendTransport: WebRtcTransport | null;
  recvTransport: WebRtcTransport | null;
  /** 浏览器上行 Producer：producerId → Producer。 */
  producers: Map<string, Producer>;
  /** 浏览器下行 Consumer：consumerId → Consumer。 */
  consumers: Map<string, Consumer>;
  /** 说话人下行发布器。 */
  speakerProducers: SpeakerProducerMap;
  /** 浏览器上行 Producer → 上行转发管线（producerId → pipeline，S4 核心）。 */
  upstreams: Map<string, UpstreamAudioPipeline>;
}

interface WebClientEntry {
  id: string;
  session: ManagedSession;
  tsClient: TSClient;
  ws: WebSocket;
  nickname: string;
  rememberIdentity: boolean;
  clientIp: string;
  target: TeamSpeakTarget;
  accelerationRelay?: { name: string; target: string };
  acceleration?: AccelerationRelayOptions;
  identityLeaseKey?: string;
  webrtcPublicHost?: string;
  channelTree: unknown[];
  members: Map<number, ChannelMember>;
  avatarCache: Map<string, string | null>;
  eventLog: ServerEvent[];
  opusEncoder: { encode(pcm: Buffer): Buffer } | null;
  opusEncoderWarnedAt: number; // Opus 编码器不可用告警的时间戳，用于限流避免反复刷屏
  whisperTargetIds: Set<number>;
  whisperActive: boolean;
  /**
   * S4 网关侧麦克风静音状态。与 TS3 `client_input_muted` 同步，同时作为上行
   * Consumer 的丢包护栏：muted 期间到达的上行 RTP 包一律静默丢弃。
   */
  microphoneMuted: boolean;
  /** S4 伴奏状态：决定上行转发的 TS3 codec（true → 5 Opus Music，false → 4）。 */
  accompanimentActive: boolean;
  isAlive: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  audio: AudioFlowStats;
  /**
   * S3 mediasoup 媒体会话：浏览器发出 `mediaGetRtpCapabilities` 时惰性建立。
   * 为 null 表示该会话尚未启用 WebRTC 媒体（此时走 WS 兼容通道）。
   */
  media: MediaSession | null;
  /** 媒体会话创建在途（并发信令共享同一次创建）。 */
  mediaPending: Promise<MediaSession> | null;
  lastLatencyProbeAt: number;
  /** 最近一次用 clientinfo 补齐成员状态的时间（按 clid），用于限速与去重。 */
  clientStateRefreshedAt: Map<number, number>;
  /** 成员静音状态补全的周期定时器；随会话清理。 */
  clientStateSweepTimer: ReturnType<typeof setInterval> | null;
  /** 每个 uid 最近一次看到的头像哈希（`client_flag_avatar`），用于发现"换了头像"。 */
  avatarFlagByUid: Map<string, string>;
  connectionFailureCode?: string;
  screenPeerId: string;
}

interface ScreenStreamRecord extends ScreenShareStreamDescription {
  targetKey: string;
  channelId: bigint;
  ownerEntryId: string;
  viewerEntryIds: Set<string>;
  sourceClientId?: number;
  /** The gateway TS client that publishes a browser-owned stream to TS6. */
  teamSpeakPublisherEntryId?: string;
  /** The TS6 stream id paired with a browser-owned WebSpeak stream. */
  teamSpeakStreamId?: string;
  /** Native TS6 viewer client ids paired with a browser-owned stream. */
  nativeViewerClids: Set<number>;
}

// Stream ids are scoped to a TeamSpeak server. Keep the target in the key so
// two unrelated servers cannot overwrite each other's native stream record.
function screenStreamKey(targetKey: string, streamId: string): string {
  return `${targetKey}\u0000${streamId}`;
}

export class VoiceBridge {
  private readonly sessionManager = new SessionManager();
  private readonly entries = new Map<string, WebClientEntry>();
  private readonly screenStreams = new Map<string, ScreenStreamRecord>();
  private readonly screenStreamDiscoveryTargets = new Set<string>();
  private readonly identityLeases = new IdentityLeaseStore();
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private logger: LoggerType;

  constructor(
    private options: VoiceBridgeOptions,
    logger: LoggerType,
  ) {
    this.logger = logger.child({ component: "voice-bridge" });
  }

  attach(server: Server): void {
    // Avatar data is delivered as a data URL in a memberAvatar message. Keep
    // the frame limit above the encoded avatar ceiling with room for JSON.
    this.wss = new WebSocketServer({ server, path: "/ws/voice", maxPayload: 512 * 1024 });
    this.startHeartbeat();

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
      const connection = this.resolveConnection(url);
      if (!connection) {
        ws.close(4001, "Join ticket required");
        return;
      }

      const { target, serverPassword, nickname } = connection;
      const channelName = connection.channel;
      const acceleration = connection.accelerated ? this.getAccelerationOptions(connection.accelerationRelayId) : undefined;
      if (connection.accelerated && !acceleration) {
        ws.close(4006, "ACCELERATION_UNAVAILABLE");
        return;
      }
      const clientIp = resolveClientIp(req);
      const webrtcPublicHost = resolveWebRtcPublicHost(req);
      let identity;
      try {
        identity = connection.identity ? identityFromString(connection.identity) : undefined;
      } catch {
        // Send a structured failure before the close so the browser can tell
        // an invalid remembered identity apart from a real connection failure.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "connectionFailed", code: "IDENTITY_INVALID", detail: "Invalid identity" }));
        ws.close(4003, "IDENTITY_INVALID");
        return;
      }
      const entryId = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      let entry: WebClientEntry | null = null;
      const session = this.sessionManager.admit(entryId, async (reason) => {
        if (entry) await this.cleanupEntry(entry, reason);
      });
      if (!session) {
        this.logger.warn({ max: this.sessionManager.maxSessions }, "Max clients reached");
        ws.close(4004, "GATEWAY_FULL");
        return;
      }

      const identityLeaseKey = identity
        ? `${teamSpeakTargetKey(target)}:${identity.toString()}`
        : "";
      if (identityLeaseKey && !this.identityLeases.acquire(identityLeaseKey, entryId)) {
        this.logger.warn({ entryId, nickname, target: formatTeamSpeakTarget(target) }, "TeamSpeak identity already in use");
        void this.sessionManager.teardown(entryId, "teamSpeak-connect-failed");
        ws.close(4005, "IDENTITY_IN_USE");
        return;
      }

      this.logger.info({
        entryId,
        nickname,
        clientIp,
        channel: channelName,
        target: formatTeamSpeakTarget(target),
        ...(acceleration ? { relayName: acceleration.name, relayTarget: formatTeamSpeakTarget({ host: acceleration.relayHost, port: acceleration.relayPort }) } : {}),
      }, "WebClient connecting");
      let tsClient: TSClient;
      try {
        tsClient = new TSClient({ target, nickname, serverPassword, defaultChannel: channelName, identity, ...(acceleration ? { acceleration } : {}) }, this.logger);
      } catch (error: unknown) {
        if (identityLeaseKey) this.identityLeases.release(identityLeaseKey, entryId);
        this.logger.error({ err: error, entryId }, "Could not create TeamSpeak client");
        // A 4003 with a bare close used to be reported as "identity rejected".
        // Send a structured failure so the browser says the TeamSpeak client
        // could not be created (server down / unreachable) instead.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "connectionFailed", code: "TEAM_SPEAK_CLIENT_UNAVAILABLE", detail: "TeamSpeak client unavailable" }));
        ws.close(4003, "TEAM_SPEAK_CLIENT_UNAVAILABLE");
        return;
      }
      entry = {
        id: entryId,
        session,
        tsClient,
        ws,
        nickname,
        rememberIdentity: connection.rememberIdentity === true,
        clientIp,
        target,
        ...(acceleration ? { accelerationRelay: { name: acceleration.name, target: formatTeamSpeakTarget({ host: acceleration.relayHost, port: acceleration.relayPort }) } } : {}),
        ...(acceleration ? { acceleration } : {}),
        ...(identityLeaseKey ? { identityLeaseKey } : {}),
        ...(webrtcPublicHost ? { webrtcPublicHost } : {}),
        channelTree: [],
        members: new Map(),
        avatarCache: new Map(),
        eventLog: [],
        opusEncoder: null,
        opusEncoderWarnedAt: 0,
        whisperTargetIds: new Set(),
        whisperActive: false,
        microphoneMuted: false,
        accompanimentActive: false,
        isAlive: true,
        reconnectTimer: null,
        audio: createAudioFlowStats(),
        media: null,
        mediaPending: null,
        lastLatencyProbeAt: 0,
        clientStateRefreshedAt: new Map(),
        clientStateSweepTimer: null,
        avatarFlagByUid: new Map(),
        screenPeerId: entryId,
      };
      this.entries.set(entryId, entry!);
      try {
        entry!.opusEncoder = createOpusEncoder();
      } catch (error: unknown) {
        this.logger.error({ err: error, entryId }, "Could not create Opus encoder");
        void this.teardown(entryId, "teamSpeak-connect-failed");
        return;
      }

      let tsReady = false;
      let selfId = 0;
      let selfChannelId = 0n;
      let initialStateSent = false;
      let audioReady = true;
      let realtimeReady = false;
      let hasConnectedOnce = false;
      // Set when the server kicks or bans this client. The kick and the transport
      // drop can arrive in either order, so the reason is parked here and consumed
      // by whichever handler runs second.
      let pendingKickReason: WebSpeakError | null = null;
      let reconnectStartedAt = 0;
      let reconnectAttempt = 0;
      const directory = new DirectorySynchronizer();
      const avatarRequests = new Set<string>();
      let avatarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
      let avatarRefreshRunning = false;

      const sendJson = (message: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      };
      const addServerEvent = (kind: ServerEvent["kind"], message: string) => {
        const event: ServerEvent = {
          id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          kind,
          message,
          timestamp: Date.now(),
        };
        entry!.eventLog.push(event);
        if (entry!.eventLog.length > 200) entry!.eventLog.splice(0, entry!.eventLog.length - 200);
        if (initialStateSent) sendJson({ type: "serverEvent", event });
      };
      const refreshDirectory = () => {
        const snapshot = directory.getSnapshot();
        if (!snapshot) return;
        const previousWhisperTargets = [...entry!.whisperTargetIds].sort((a, b) => a - b);
        const effectiveSelfId = selfId || tsClient.getClientId();
        const sdkChannelId = tsClient.getChannelId();
        if (selfChannelId === 0n && sdkChannelId !== 0n) selfChannelId = sdkChannelId;
        const normalizedSnapshot = normalizeDirectorySnapshot(snapshot, effectiveSelfId, selfChannelId, nickname, channelName);
        entry!.channelTree = mapChannelTree(normalizedSnapshot, entry!.avatarCache);
        entry!.members.clear();
        for (const client of normalizedSnapshot.clients) {
          const avatar = client.uid ? entry!.avatarCache.get(client.uid) : undefined;
          entry!.members.set(client.id, {
            id: client.id,
            nickname: client.nickname,
            uid: client.uid,
            ...(avatar ? { avatar } : {}),
            away: client.away,
            awayMessage: client.awayMessage,
            inputMuted: client.inputMuted,
            outputMuted: client.outputMuted,
            channelCommander: client.channelCommander,
          });
        }
        for (const clientId of entry!.whisperTargetIds) {
          if (!entry!.members.has(clientId) || clientId === effectiveSelfId) entry!.whisperTargetIds.delete(clientId);
        }
        if (!entry!.whisperTargetIds.size) entry!.whisperActive = false;
        const nextWhisperTargets = [...entry!.whisperTargetIds].sort((a, b) => a - b);
        if (initialStateSent && (previousWhisperTargets.length !== nextWhisperTargets.length || previousWhisperTargets.some((clientId, index) => clientId !== nextWhisperTargets[index]))) {
          sendJson({ type: "whisperTargets", targetIds: nextWhisperTargets, active: entry!.whisperActive });
        }
      };
      /**
       * 成员状态补全（静音 / 硬件 / 离开 / 指挥官）。
       *
       * 成员是随 `notifycliententerview` 进目录的，那条通知不带静音字段；批量接口
       * `clientlist -muted`、`clientfind` 在普通权限下被服务器拒绝（实测 2568）。
       * 结果就是"在网页端连接之前就已经静音"的人一直显示为未静音，和原生客户端不一致。
       * `clientinfo clid=N` 有权限（实测 ~20ms），所以按 clid 逐条补：限速 4 条/秒、
       * 每条 60s 内不重复查，避免触发服务器的洪水防护；只有真正变化才回推 channelList。
       */
      const CLIENT_STATE_STALE_MS = 60_000;
      const CLIENT_STATE_SWEEP_BATCH = 4;
      const CLIENT_STATE_SWEEP_INTERVAL_MS = 1_000;
      const sweepClientStates = async (): Promise<void> => {
        if (!entry || !entry.isAlive || !tsReady || session.state !== "connected") return;
        const snapshot = directory.getSnapshot();
        if (!snapshot) return;
        const now = Date.now();
        const stale = snapshot.clients
          .filter((client) => client.id > 0 && now - (entry!.clientStateRefreshedAt.get(client.id) ?? 0) >= CLIENT_STATE_STALE_MS)
          .slice(0, CLIENT_STATE_SWEEP_BATCH);
        if (!stale.length) return;
        let changed = false;
        let avatarChanged = false;
        for (const client of stale) {
          entry.clientStateRefreshedAt.set(client.id, Date.now());
          try {
            const state = await entry.tsClient.getClientState(client.id);
            const next = {
              ...client,
              nickname: state.nickname || client.nickname,
              uid: state.uid || client.uid,
              away: state.away,
              awayMessage: state.awayMessage,
              inputMuted: state.inputMuted,
              outputMuted: state.outputMuted,
              channelCommander: state.channelCommander,
            };
            if (
              client.away !== next.away ||
              client.awayMessage !== next.awayMessage ||
              client.inputMuted !== next.inputMuted ||
              client.outputMuted !== next.outputMuted ||
              client.channelCommander !== next.channelCommander
            ) {
              directory.applyClientUpdated(next);
              changed = true;
            }
            // 头像变更检测：`client_flag_avatar` 变了就丢弃缓存，让 refreshMemberAvatars
            // 重新取一次并推给浏览器。原来每个 uid 一个会话只取一次，线上表现就是
            // "不刷新页面看不到机器人换的新头像（换歌 = 换专辑封面）"。
            if (next.uid) {
              const previousFlag = entry.avatarFlagByUid.get(next.uid);
              if (previousFlag === undefined) {
                entry.avatarFlagByUid.set(next.uid, state.avatarFlag);
              } else if (previousFlag !== state.avatarFlag) {
                entry.avatarFlagByUid.set(next.uid, state.avatarFlag);
                entry.avatarCache.delete(next.uid);
                avatarChanged = true;
              }
            }
          } catch {
            // 单条失败（离线 / 超时 / 服务器差异）不影响其它成员，下个周期会重试。
          }
        }
        if (avatarChanged) scheduleMemberAvatarRefresh(0);
        if (!changed || !entry || !entry.isAlive) return;
        refreshDirectory();
        if (initialStateSent) sendJson({ type: "channelList", channels: entry.channelTree });
      };
      entry.clientStateSweepTimer = setInterval(() => { void sweepClientStates(); }, CLIENT_STATE_SWEEP_INTERVAL_MS);
      entry.clientStateSweepTimer.unref?.();

      const scheduleMemberAvatarRefresh = (delayMs = 0): void => {
        if (!entry || !entry.isAlive || avatarRefreshTimer) return;
        avatarRefreshTimer = setTimeout(() => {
          avatarRefreshTimer = null;
          void refreshMemberAvatars();
        }, delayMs);
        avatarRefreshTimer.unref?.();
      };
      const refreshMemberAvatars = async (): Promise<void> => {
        if (!entry || !entry.isAlive || !tsReady || session.state !== "connected" || avatarRefreshRunning) return;
        avatarRefreshRunning = true;
        try {
          const candidates = [...entry.members.values()]
            .filter((member) => member.uid && !entry!.avatarCache.has(member.uid) && !avatarRequests.has(member.uid))
            .slice(0, 50);
          for (const member of candidates) {
            if (!entry || !entry.isAlive || !member.uid) return;
            avatarRequests.add(member.uid);
            try {
              const loaded = await tsClient.getClientAvatar(member.id, member.uid);
              const avatar = loaded ? avatarDataUrl(loaded.data) : null;
              entry.avatarCache.set(member.uid, avatar);
              const current = entry.members.get(member.id);
              // 头像被换掉（含被清空）时也要推一次，否则浏览器会一直显示旧图。
              if (current && current.uid === member.uid && (current.avatar ?? null) !== avatar) {
                current.avatar = avatar ?? undefined;
                sendJson({ type: "memberAvatar", id: member.id, uid: member.uid, avatar: avatar ?? "" });
              }
            } catch (error: unknown) {
              // Avatar access is optional. A permission or file-transfer failure
              // must never affect joining, directory updates, or voice traffic.
              entry.avatarCache.set(member.uid, null);
              this.logger.debug({
                entryId,
                clientId: member.id,
                uid: member.uid,
                err: error instanceof Error ? error.message : String(error),
              }, "TeamSpeak client avatar unavailable");
            } finally {
              avatarRequests.delete(member.uid);
            }
          }
        } finally {
          avatarRefreshRunning = false;
          if (entry?.isAlive && tsReady && session.state === "connected" && [...entry.members.values()].some((member) => member.uid && !entry!.avatarCache.has(member.uid))) {
            scheduleMemberAvatarRefresh(250);
          }
        }
      };
      const trackChannelEvents = (previous: unknown[], next: unknown[]) => {
        if (!initialStateSent) return;
        const before = new Map(previous.filter(isChannelRecord).map((channel) => [channel.id, channel]));
        const after = new Map(next.filter(isChannelRecord).map((channel) => [channel.id, channel]));
        for (const channel of after.values()) {
          if (!before.has(channel.id)) addServerEvent("joined", `频道「${channel.name}」已创建`);
          else if (before.get(channel.id)?.name !== channel.name) addServerEvent("moved", `频道已重命名为「${channel.name}」`);
        }
        for (const channel of before.values()) if (!after.has(channel.id)) addServerEvent("left", `频道「${channel.name}」已删除`);
      };
      /**
       * 确保 TS 客户端真的待在一个频道里。
       *
       * 两个原因让"界面上显示你在某频道、实际你在 cid 0"成为可能：
       * 1) TS6 不认 clientinit 的 client_default_channel（按名字传的），
       *    请求的频道不会生效；
       * 2) 拿不到权威目录快照时（普通语音客户端没有 list 权限），
       *    normalizeDirectorySnapshot 会把你补进请求的频道或频道树里的第一个频道。
       *
       * 所以这里把"界面显示的那个频道"真正执行出来：请求了频道就移过去，
       * 没请求（或名字解析不到）且当前不在任何频道，就移进频道树里的第一个频道
       * ——否则用户会停在没有频道的状态，服务器不向他转发任何语音，一帧都听不到。
       */
      const ensureChannel = async (): Promise<void> => {
        const requested = channelName?.trim().toLocaleLowerCase();
        const channelIdByName = (name: string): bigint | null => {
          for (const raw of entry!.channelTree) {
            if (!isRecord(raw) || typeof raw.id !== "string") continue;
            if (String(raw.name ?? "").trim().toLocaleLowerCase() !== name) continue;
            try {
              return BigInt(raw.id);
            } catch {
              return null;
            }
          }
          return null;
        };
        const firstChannelId = (): bigint | null => {
          for (const raw of entry!.channelTree) {
            if (!isRecord(raw) || typeof raw.id !== "string") continue;
            try {
              return BigInt(raw.id);
            } catch {
              return null;
            }
          }
          return null;
        };

        const current = tsClient.getChannelId();
        let targetId = requested ? channelIdByName(requested) : null;
        let reason = "requested";
        if (targetId === null && current === 0n) {
          targetId = firstChannelId();
          reason = "default";
        }
        if (targetId === null || current === targetId) return;
        try {
          await tsClient.switchChannel(targetId);
          this.logger.info({
            entryId: entry!.id,
            channel: channelName || "(默认频道)",
            channelId: targetId.toString(),
            reason,
          }, "Moved into a channel");
        } catch (error: unknown) {
          this.logger.warn({
            err: error instanceof Error ? error.message : String(error),
            entryId: entry!.id,
            channel: channelName || "(默认频道)",
            channelId: targetId.toString(),
          }, "Could not move into a channel");
        }
      };

      const sendInitialState = () => {
        if (initialStateSent || !tsReady || !directory.ready || !realtimeReady || !audioReady || session.state !== "syncing") return;
        initialStateSent = true;
        const wasReconnecting = hasConnectedOnce;
        hasConnectedOnce = true;
        // A previous kick reason never applies to a fresh, successful session.
        pendingKickReason = null;
        reconnectAttempt = 0;
        reconnectStartedAt = 0;
        if (!wasReconnecting) {
          entry!.eventLog.push({ id: `event-${Date.now().toString(36)}-connected`, kind: "connection", message: "已连接到服务器", timestamp: Date.now() });
          this.logger.info({
            entryId: entry!.id,
            nickname: entry!.nickname,
            clientIp: entry!.clientIp,
            target: formatTeamSpeakTarget(entry!.target),
            ...(entry!.accelerationRelay ? { relayName: entry!.accelerationRelay.name, relayTarget: entry!.accelerationRelay.target } : {}),
          }, "Web client connected to TeamSpeak");
        }
        session.transition("connected");
        sendJson({
          type: "connected",
          tsClientId: selfId,
          members: Array.from(entry!.members.values()),
          serverEventLog: entry!.eventLog,
          whisperTargetIds: [...entry!.whisperTargetIds],
          whisperActive: entry!.whisperActive,
          webrtcAvailable: this.getWebRtcOptions()?.enabled === true,
          // S3 起废除预分配坑位：说话人按 clientId ↔ producerId 动态发布订阅，
          // 浏览器不再需要知道"服务端开了几条 m-line"。字段已彻底移除。
          screenShareIceServers: this.getScreenShareIceServers(),
          accelerated: Boolean(entry!.acceleration),
          ...(entry!.rememberIdentity ? { identity: tsClient.getIdentityString() } : {}),
        });
        sendJson({ type: "channelList", channels: entry!.channelTree });
        if (wasReconnecting) sendJson({ type: "reconnected" });
        scheduleMemberAvatarRefresh();
        // 频道树已经就绪，这时才解析得出请求频道的 id。
        void ensureChannel();
      };

      const resetDirectoryForReconnect = () => {
        tsReady = false;
        initialStateSent = false;
        selfId = 0;
        selfChannelId = 0n;
        directory.clear();
        entry!.channelTree = [];
        entry!.members.clear();
        entry!.whisperTargetIds.clear();
        entry!.whisperActive = false;
        // S3：重连后旧说话人 Producer 全部失效，清空并广播 speakerProducerClosed。
        entry?.media?.speakerProducers.clear();
      };

      const failReconnect = (normalized: ReturnType<typeof normalizeTeamSpeakError>) => {
        if (entry!.reconnectTimer) {
          clearTimeout(entry!.reconnectTimer);
          entry!.reconnectTimer = null;
        }
        try {
          if (session.state !== "disconnecting" && session.state !== "idle") session.transition("failed");
        } catch { /* teardown below remains authoritative */ }
        const failureCode = clientConnectionFailureCode(normalized, serverPassword);
        const failureDetail = publicFailureDetail(normalized);
        entry!.connectionFailureCode = failureCode;
        sendJson({ type: "reconnectFailed", code: failureCode, ...(failureDetail ? { detail: failureDetail } : {}) });
        void this.teardown(entryId, "teamSpeak-connect-failed");
      };

      const scheduleReconnect = (normalized: ReturnType<typeof normalizeTeamSpeakError> | null) => {
        if (session.state === "disconnecting" || session.state === "idle" || session.state === "failed") return;
        if (!isRecoverable(normalized)) {
          failReconnect(normalized ?? normalizeTeamSpeakError(new Error("TeamSpeak connection failed")));
          return;
        }
        const now = Date.now();
        if (!reconnectStartedAt) reconnectStartedAt = now;
        reconnectAttempt += 1;
        if (!reconnectWindowOpen(reconnectStartedAt, now)) {
          failReconnect(normalized ?? normalizeTeamSpeakError(new Error("Reconnect window expired")));
          return;
        }
        if (session.state === "connected") session.transition("interrupted");
        if (session.state === "interrupted") session.transition("reconnecting");
        if (entry!.reconnectTimer) return;
        const delayMs = reconnectDelayMs(reconnectAttempt);
        sendJson({ type: "reconnecting", attempt: reconnectAttempt, delayMs });
        entry!.reconnectTimer = setTimeout(() => {
          entry!.reconnectTimer = null;
          if (session.state !== "reconnecting") return;
          try {
            session.transition("connecting");
            session.transition("authenticating");
          } catch {
            failReconnect(normalizeTeamSpeakError(new Error("Reconnect state initialization failed")));
            return;
          }
          void connectTeamSpeak(true);
        }, delayMs);
        entry!.reconnectTimer.unref?.();
      };

      const connectTeamSpeak = async (isReconnect: boolean): Promise<void> => {
        try {
          await tsClient.connect();
          if (session.state !== "authenticating") return;
          session.transition("syncing");
          tsReady = true;
          selfId = tsClient.getClientId();
          const sdkChannelId = tsClient.getChannelId();
          if (sdkChannelId !== 0n) selfChannelId = sdkChannelId;
          refreshDirectory();
          if (selfId > 0 && !entry!.members.has(selfId)) {
            directory.applyClientEnter({ id: selfId, nickname, channelID: selfChannelId, uid: "", type: 1, serverGroups: [] });
            refreshDirectory();
          }
          sendInitialState();
          void this.discoverExistingTeamSpeakStreams(entry!);
        } catch (error: unknown) {
          const normalized = normalizeTeamSpeakError(error);
          const failureCode = clientConnectionFailureCode(normalized, serverPassword);
          const failureDetail = publicFailureDetail(normalized);
          entry!.connectionFailureCode = failureCode;
          this.logger.warn({
            code: failureCode,
            normalizedCode: normalized.code,
            failureDetail: describeTeamSpeakError(normalized),
            ...(Object.keys(normalized.diagnostics).length ? { failureDiagnostics: normalized.diagnostics } : {}),
            entryId,
            reconnect: isReconnect,
            attempt: reconnectAttempt,
          }, "TS connect failed");
          if (!isReconnect) {
            try {
              if (session.state !== "disconnecting" && session.state !== "idle") session.transition("failed");
            } catch { /* teardown below remains authoritative */ }
            // Send the structured failure before closing. Some browsers and
            // reverse proxies do not preserve a WebSocket close reason, which
            // would otherwise collapse every failure into a generic message.
            sendJson({ type: "connectionFailed", code: failureCode, ...(failureDetail ? { detail: failureDetail } : {}) });
            if (ws.readyState === WebSocket.OPEN) ws.close(4003, failureCode);
            void this.teardown(entryId, "teamSpeak-connect-failed");
            return;
          }
          if (isReconnect && isRecoverable(normalized)) {
            try {
              if (session.state !== "disconnecting" && session.state !== "idle") session.transition("reconnecting");
            } catch { /* teardown below remains authoritative */ }
            scheduleReconnect(normalized);
            return;
          }
          failReconnect(normalized);
        }
      };

      // Register every directory listener before connect(). Events emitted by
      // the welcome flow are queued by DirectorySynchronizer until its
      // snapshot establishes the baseline.
      realtimeReady = true;
      tsClient.on("directorySnapshot", (snapshot: TSDirectorySnapshot) => {
        const previousChannels = entry!.channelTree;
        directory.applySnapshot(snapshot);
        refreshDirectory();
        trackChannelEvents(previousChannels, entry!.channelTree);
        sendInitialState();
        if (tsReady && initialStateSent) sendJson({ type: "channelList", channels: entry!.channelTree });
        scheduleMemberAvatarRefresh();
      });

      tsClient.on("clientEnter", (info) => {
        const candidateSelfId = tsClient.getClientId();
        if (candidateSelfId > 0 && info.id === candidateSelfId) {
          selfId = candidateSelfId;
          if (info.channelID !== undefined && info.channelID !== 0n) selfChannelId = info.channelID;
        }
        const wasKnown = entry!.members.has(info.id);
        directory.applyClientEnter(info);
        refreshDirectory();
        if (tsReady && initialStateSent) {
          sendJson({ type: "channelList", channels: entry!.channelTree });
          if (!wasKnown) sendJson({ type: "memberEnter", id: info.id, nickname: info.nickname, uid: info.uid, isSelf: info.id === selfId });
          if (!wasKnown && info.id !== selfId) addServerEvent("joined", `${info.nickname || "未知用户"} 加入了服务器`);
          scheduleMemberAvatarRefresh();
        }
      });

      tsClient.on("clientLeave", (info) => {
        this.reconcileNativeScreenShareAfterClientLeave(entry!, info.id);
        const wasKnown = entry!.members.has(info.id);
        const leavingMember = entry!.members.get(info.id);
        // S3：回收该说话人的下行 Producer，浏览器据此淡出并释放 Consumer。
        entry!.media?.speakerProducers.remove(info.id, "closed");
        directory.applyClientLeave(info.id);
        refreshDirectory();
        if (tsReady && initialStateSent && wasKnown) {
          sendJson({ type: "memberLeave", id: info.id });
          sendJson({ type: "channelList", channels: entry!.channelTree });
          if (info.id !== selfId) addServerEvent("left", `${leavingMember?.nickname || "用户"} 离开了服务器`);
        }
      });

      tsClient.on("clientMoved", (info) => {
        if (info.targetChannelID === undefined || info.targetChannelID === 0n) return;
        this.reconcileScreenShareAfterClientMove(entry!, info.id, info.targetChannelID);
        const movedMember = entry!.members.get(info.id);
        if (info.id === selfId) selfChannelId = info.targetChannelID;
        directory.applyClientMoved(info.id, info.targetChannelID);
        refreshDirectory();
        if (tsReady && initialStateSent) {
          sendJson({ type: "channelList", channels: entry!.channelTree });
          if (info.id !== selfId) addServerEvent("moved", `${movedMember?.nickname || "用户"} 移动到了其他频道`);
        }
      });

      tsClient.on("clientUpdated", (info) => {
        directory.applyClientUpdated(info);
        refreshDirectory();
        if (tsReady && initialStateSent) sendJson({ type: "channelList", channels: entry!.channelTree });
      });

      // v0.2.4：原生 TS6 屏幕共享的通知入口。
      tsClient.on("rawNotification", (notification: TSRawNotification) => {
        this.handleRawScreenNotification(entry!, notification);
      });

      tsClient.on("voiceData", (data: TSVoiceData) => {
        const receivedAt = Date.now();
        if (entry!.audio.tsReceiveLastAt !== null) entry!.audio.tsReceiveMaxGapMs = Math.max(entry!.audio.tsReceiveMaxGapMs, receivedAt - entry!.audio.tsReceiveLastAt);
        entry!.audio.tsReceiveFirstAt ??= receivedAt;
        entry!.audio.tsReceiveLastAt = receivedAt;
        entry!.audio.tsReceiveFrames++;
        if (ws.readyState !== WebSocket.OPEN || data.clientId === selfId) return;
        const now = receivedAt;
        if (entry!.audio.egressLastAt !== null) entry!.audio.egressMaxGapMs = Math.max(entry!.audio.egressMaxGapMs, now - entry!.audio.egressLastAt);
        entry!.audio.egressFirstAt ??= now;
        entry!.audio.egressLastAt = now;
        const sourceKey = String(data.clientId);
        entry!.audio.egressFramesByClient[sourceKey] = (entry!.audio.egressFramesByClient[sourceKey] ?? 0) + 1;
        // S3 mediasoup 下行：每个说话人一条 DirectTransport Producer，按
        // clientId 动态发布；浏览器收到 newSpeakerProducer 后自行 consume。
        // 首帧在 ingest() 内部等资源创建完成再注入 Router，首帧不丢。
        const media = entry!.media;
        if (media) {
          void media.speakerProducers.ingest(data.clientId, data.data);
          entry!.audio.egressFrames++;
          return;
        }
        const packet = Buffer.allocUnsafe(3 + data.data.length);
        packet[0] = data.codec;
        packet.writeUInt16BE(data.clientId, 1);
        data.data.copy(packet, 3);
        const bufferedBytes = ws.bufferedAmount;
        entry!.audio.egressPeakBufferedBytes = Math.max(entry!.audio.egressPeakBufferedBytes, bufferedBytes);
        if (bufferedBytes > MAX_SERVER_AUDIO_BUFFERED_BYTES) {
          entry!.audio.egressDroppedFrames++;
          return;
        }
        try {
          ws.send(packet);
          entry!.audio.egressFrames++;
          const sentAt = Date.now();
          if (entry!.audio.egressSentLastAt !== null) entry!.audio.egressSentMaxGapMs = Math.max(entry!.audio.egressSentMaxGapMs, sentAt - entry!.audio.egressSentLastAt);
          entry!.audio.egressSentFirstAt ??= sentAt;
          entry!.audio.egressSentLastAt = sentAt;
        } catch {
          entry!.audio.egressDroppedFrames++;
        }
      });

      tsClient.on("textMessage", (message) => {
        const scope = message.targetMode === 1 ? "private" : message.targetMode === 3 ? "server" : message.targetMode === 2 ? "channel" : "server";
        const targetId = message.targetId ?? 0n;
        // TeamSpeak channel notifications omit `target`; the SDK represents
        // that as 0. Bind the broadcast to this session's current channel so
        // it remains visible now but cannot leak into another channel after a
        // later channel switch.
        const effectiveTargetId = scope === "channel" && targetId === 0n ? tsClient.getChannelId() : targetId;
        sendJson({
          type: "chatMessage",
          scope,
          ...(effectiveTargetId !== 0n ? { targetId: String(effectiveTargetId) } : {}),
          senderUid: message.invokerUid,
          timestamp: Date.now(),
          invokerName: message.invokerName,
          invokerId: message.invokerId,
          message: message.message,
        });
      });

      tsClient.on("poked", (event) => {
        sendJson({ type: "pokeReceived", invokerId: event.invokerID, invokerUid: event.invokerUID, invokerName: event.invokerName, message: event.message, timestamp: Date.now() });
        addServerEvent("poke", `${event.invokerName || "用户"} 戳了你一下`);
      });

      // 被踢/封禁对本会话是终态：把服务器给出的原因回放给浏览器并拆除会话，
      // 而不是像以前那样因原因被丢弃而反复重连、再次撞上同一踢出。
      // A kick or ban is terminal for this session: replay the reason the server
      // sent instead of reconnecting, which is what used to happen once the reason
      // message was dropped (the browser kept retrying straight into the kick).
      tsClient.on("kicked", (kick: WebSpeakError) => {
        if (!hasConnectedOnce || session.state !== "connected") return;
        pendingKickReason = kick;
        resetDirectoryForReconnect();
        const failureCode = clientConnectionFailureCode(kick, serverPassword);
        const failureDetail = publicFailureDetail(kick);
        entry!.connectionFailureCode = failureCode;
        this.logger.warn({ entryId, code: failureCode, normalizedCode: kick.code, failureDetail: describeTeamSpeakError(kick) }, "TeamSpeak session ended by kick/ban");
        sendJson({ type: "connectionFailed", code: failureCode, ...(failureDetail ? { detail: failureDetail } : {}) });
        void this.teardown(entryId, "teamSpeak-kicked");
      });

      tsClient.on("disconnected", (error?: Error) => {
        if (!hasConnectedOnce || session.state !== "connected") return;
        resetDirectoryForReconnect();
        // Prefer a kick reason over the generic transport error that follows it,
        // regardless of which of the two events arrives first.
        const normalized = pendingKickReason ?? (error ? normalizeTeamSpeakError(error) : null);
        pendingKickReason = null;
        sendJson({ type: "disconnected", recoverable: isRecoverable(normalized) });
        scheduleReconnect(normalized);
      });

      ws.on("pong", () => { if (entry) entry.isAlive = true; });
      ws.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          const frame = typeof data === "string" ? Buffer.from(data) : data;
          if (!tsReady || frame.length !== AUDIO_FRAME_BYTES) {
            entry!.audio.ingressDroppedFrames++;
            sendProtocolError(sendJson, "INVALID_AUDIO_FRAME", "音频帧格式无效");
            return;
          }
          const now = Date.now();
          if (entry!.audio.ingressLastAt !== null) entry!.audio.ingressMaxGapMs = Math.max(entry!.audio.ingressMaxGapMs, now - entry!.audio.ingressLastAt);
          entry!.audio.ingressFirstAt ??= now;
          entry!.audio.ingressLastAt = now;
          entry!.audio.ingressFrames++;
          const encodeStartedAt = Date.now();
          try {
            if (entry!.opusEncoder) {
              const encoded = entry!.opusEncoder.encode(frame);
              const encodedAt = Date.now();
              entry!.audio.tsEncodeMaxMs = Math.max(entry!.audio.tsEncodeMaxMs, encodedAt - encodeStartedAt);
              if (entry!.whisperActive && entry!.whisperTargetIds.size) tsClient.sendWhisper(encoded, [...entry!.whisperTargetIds], 4);
              else tsClient.sendVoice(encoded, 4);
              const sentAt = Date.now();
              if (entry!.audio.tsSendLastAt !== null) entry!.audio.tsSendMaxGapMs = Math.max(entry!.audio.tsSendMaxGapMs, sentAt - entry!.audio.tsSendLastAt);
              entry!.audio.tsSendFirstAt ??= sentAt;
              entry!.audio.tsSendLastAt = sentAt;
              entry!.audio.tsSendFrames++;
            } else {
              // Opus 编码器不可用（初始化失败或销毁后仍有帧在途）：显式告知浏览器
              // 而不是静默丢帧，5 秒限流避免高频告警刷屏。
              // The Opus encoder is unavailable (init failed or torn down while
              // frames are still in flight): say it instead of dropping silently.
              const warnedAt = entry!.opusEncoderWarnedAt;
              if (Date.now() - warnedAt > 5_000) {
                entry!.opusEncoderWarnedAt = Date.now();
                sendJson({ type: "audioError", code: "AUDIO_ENCODER_UNAVAILABLE", detail: "Opus encoder unavailable" });
              }
            }
          } catch {
            // A frame arriving during shutdown is safe to discard.
            entry!.audio.tsSendErrors++;
          }
          return;
        }

        const rawMessage = typeof data === "string" ? data : data.toString("utf-8");
        // S6 起服务端不再维护浏览器 WebRTC 对端会话（媒体统一由 mediasoup
        // DirectTransport 承载）。`webrtcStop` 是旧客户端在回退到兼容通道时
        // 仍会发送的遗留信令：这里静默忽略，避免把它当成未知消息回一个错误帧
        // （否则每次回退都会在界面上弹一次报错）。
        if (isLegacyWebRtcStopMessage(rawMessage)) return;
        const screenShareMessage = parseScreenShareMessage(rawMessage);
        if (screenShareMessage) {
          if ("error" in screenShareMessage) {
            sendProtocolError(sendJson, screenShareMessage.error.code, screenShareMessage.error.message);
            return;
          }
          if (!tsReady || session.state !== "connected") {
            sendProtocolError(sendJson, "SESSION_NOT_READY", "TeamSpeak 会话尚未就绪");
            return;
          }
          this.handleScreenShareMessage(entry!, screenShareMessage, sendJson);
          return;
        }
        const command = parseClientCommand(rawMessage);
        if ("error" in command) {
          sendProtocolError(sendJson, command.error.code, command.error.message);
          return;
        }
        // 媒体信令不依赖 TeamSpeak 会话就绪：浏览器可以在 TS 连接完成前先把
        // Device 载入、把 transport 建起来，这样首次开口时不用再等握手。
        if (isMediaSignalingType(command.type)) {
          void this.handleMediaMessage(entry!, command, sendJson);
          return;
        }
        if (!tsReady || session.state !== "connected") {
          sendProtocolError(sendJson, "SESSION_NOT_READY", "TeamSpeak 会话尚未就绪");
          return;
        }
        void handleCommand(entry!, command, sendJson);
      });

      ws.on("close", () => {
        this.logger.info({ entryId }, "WebSocket closed");
        void this.teardown(entryId, "websocket-close");
      });

      ws.on("error", (error) => {
        this.logger.error({ err: error, entryId }, "WebSocket error");
        void this.teardown(entryId, "websocket-error");
      });

      try {
        session.transition("connecting");
        session.transition("authenticating");
      } catch (error: unknown) {
        this.logger.error({ err: error instanceof Error ? error.message : String(error), entryId }, "Session state initialization failed");
        void this.teardown(entryId, "protocol-error");
        return;
      }

      void connectTeamSpeak(false);
    });

    this.wss.on("error", (error) => {
      this.logger.error({ err: error }, "Voice WebSocket server error");
    });
    this.logger.info("Voice WebSocket endpoint ready at /ws/voice");
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.sessionManager.shutdown("gateway-shutdown");
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    // ws 的语义：只要还有客户端连着，close 的回调就不会触发
    // （实测：留一个客户端不 terminate，回调 3s 内不触发）。
    // 会话拆解之后仍可能有残留 —— 半握手、或对端已断网但 TCP 还没超时。
    // 强制断开它们，否则整个关闭流程会卡死在这里，进程永不退出。
    const closed = new Promise<void>((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
    for (const client of [...wss.clients]) client.terminate();
    await closed;
  }

  getActiveCount(): number {
    return this.sessionManager.activeCount;
  }

  getPeakCount(): number {
    return this.sessionManager.peakCount;
  }

  getCreatedCount(): number {
    return this.sessionManager.createdCount;
  }

  getSessionSummaries(): AdminSessionSummary[] {
    const now = Date.now();
    return [...this.entries.values()]
      .sort((left, right) => left.session.createdAt - right.session.createdAt)
      .map((entry) => {
        let tsClientId: number | null = null;
        let channelId: string | null = null;
        try { tsClientId = entry.tsClient.getClientId() || null; } catch { /* still connecting */ }
        try {
          const id = entry.tsClient.getChannelId();
          channelId = id === 0n ? null : id.toString();
        } catch { /* still connecting */ }
        return {
          id: entry.id,
          nickname: entry.nickname,
          target: formatTeamSpeakTarget(entry.target),
          state: entry.session.state,
          createdAt: new Date(entry.session.createdAt).toISOString(),
          ageSeconds: Math.max(0, Math.floor((now - entry.session.createdAt) / 1000)),
          tsClientId,
          channelId,
          memberCount: entry.members.size,
          audio: snapshotAudioStats(entry),
        };
      });
  }

  async terminateSession(entryId: string): Promise<boolean> {
    if (!this.entries.has(entryId)) return false;
    await this.sessionManager.teardown(entryId, "admin-terminated");
    return true;
  }

  private async teardown(entryId: string, reason: SessionTeardownReason): Promise<void> {
    await this.sessionManager.teardown(entryId, reason);
  }

  private async cleanupEntry(entry: WebClientEntry, reason: SessionTeardownReason): Promise<void> {
    this.removeScreenSharePeer(entry.id);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.clientStateSweepTimer) {
      clearInterval(entry.clientStateSweepTimer);
      entry.clientStateSweepTimer = null;
    }
    entry.clientStateRefreshedAt.clear();
    entry.avatarFlagByUid.clear();
    entry.opusEncoder = null;
    const media = entry.media;
    entry.media = null;
    entry.mediaPending = null;
    if (media) this.closeMediaSession(media);
    entry.whisperTargetIds.clear();
    entry.whisperActive = false;
    entry.channelTree = [];
    entry.members.clear();
    entry.tsClient.removeAllListeners();
    try { await entry.tsClient.disconnect(); } catch { /* disconnect is intentionally idempotent */ }
    entry.ws.removeAllListeners();
    if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
      if (reason === "heartbeat-timeout" || reason === "gateway-shutdown") entry.ws.terminate();
      else entry.ws.close(reason === "protocol-error" ? 1008 : 1000, reason);
    }
    if (entry.identityLeaseKey) this.identityLeases.release(entry.identityLeaseKey, entry.id);
    this.logger.info({
      entryId: entry.id,
      nickname: entry.nickname,
      clientIp: entry.clientIp,
      target: formatTeamSpeakTarget(entry.target),
      ...(entry.accelerationRelay ? { relayName: entry.accelerationRelay.name, relayTarget: entry.accelerationRelay.target } : {}),
      reason,
      ...(entry.connectionFailureCode ? { failureCode: entry.connectionFailureCode } : {}),
      durationSeconds: Math.max(0, Math.floor((Date.now() - entry.session.createdAt) / 1000)),
      audio: { ...entry.audio },
    }, "Client session torn down");
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      for (const entry of this.entries.values()) {
        if (entry.ws.readyState !== WebSocket.OPEN) continue;
        if (!entry.isAlive) {
          entry.ws.terminate();
          void this.teardown(entry.id, "heartbeat-timeout");
          continue;
        }
        entry.isAlive = false;
        entry.ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private resolveConnection(url: URL): JoinTicketPayload | null {
    const token = url.searchParams.get("ticket");
    return token ? this.options.joinTickets.consume(token) : null;
  }

  private getWebRtcOptions(): WebRtcAudioOptions | undefined {
    const configured = this.options.webRtc;
    return typeof configured === "function" ? configured() : configured;
  }

  /**
   * 屏幕共享用的 ICE 服务器。
   *
   * v0.2.4 原本为此单独开了一个环境变量（WEBSPEAK_SCREEN_SHARE_ICE_SERVERS，
   * 默认用 TeamSpeak 官方 STUN）。本项目自建 STUN，所以这里**复用语音 WebRTC
   * 已经在用的那一套配置**（WEBSPEAK_STUN_URLS / WEBSPEAK_TURN_*）——
   * 一个地方配置，两条链路都生效，不需要再记第二个环境变量。
   */
  private getScreenShareIceServers(): ScreenShareIceServer[] {
    const configured = this.options.screenShareIceServers;
    const servers = typeof configured === "function" ? configured() : configured;
    // 屏幕共享（scr）：调用 generateTurnUserid() 独立生成合规的 12 位纯十六进制 userid，独享配额
    return normalizeScreenShareIceServers(servers ?? resolveIceServers(generateTurnUserid()));
  }

  private getAccelerationOptions(relayId = ""): ConfiguredAccelerationRelay | undefined {
    const configured = this.options.acceleration;
    const relays = typeof configured === "function" ? configured() : configured;
    if (!relays?.length) return undefined;
    const selected = relayId ? relays.find((relay) => relay.id === relayId) : relays[0];
    if (!selected) return undefined;
    return selected;
  }

  /**
   * 惰性建立该会话的 mediasoup 媒体图。
   *
   * Router 从进程内唯一 Worker 派生。Worker 拉起失败（二进制缺失 / sha256 校验
   * 不过）会抛出，由 handleMediaMessage 转成 mediaError 帧 —— 不静默降级，否则
   * 浏览器会一直等一个永远不会来的 answer。
   */
  private async ensureMediaSession(
    entry: WebClientEntry,
    sendJson: (message: Record<string, unknown>) => void,
  ): Promise<MediaSession> {
    if (entry.media) return entry.media;
    if (entry.mediaPending) return entry.mediaPending;
    const pending = (async (): Promise<MediaSession> => {
      const worker = await getMediaWorker({ logger: this.logger });
      const router = await createMediaRouter(worker);
      const session: MediaSession = {
        router,
        sendTransport: null,
        recvTransport: null,
        producers: new Map(),
        consumers: new Map(),
        upstreams: new Map(),
        speakerProducers: new SpeakerProducerMap(router, {
          maxSpeakers: resolveMaxSpeakers(),
          onNewSpeakerProducer: (clientId, producerId) => sendJson({ type: "newSpeakerProducer", clientId, producerId }),
          onSpeakerProducerClosed: (clientId, producerId, reason) => sendJson({ type: "speakerProducerClosed", clientId, producerId, reason }),
        }),
      };
      entry.media = session;
      return session;
    })();
    entry.mediaPending = pending;
    try {
      return await pending;
    } finally {
      if (entry.mediaPending === pending) entry.mediaPending = null;
    }
  }

  /**
   * mediasoup 媒体信令分发。
   *
   * 只做协议搬运：RTP 参数、DTLS 参数、能力集都原样透传给 mediasoup 校验，
   * 网关不复制一份 ORTC 规则（两份真相必然漂移）。
   */
  private async handleMediaMessage(
    entry: WebClientEntry,
    command: ClientCommand,
    sendJson: (message: Record<string, unknown>) => void,
  ): Promise<void> {
    try {
      const session = await this.ensureMediaSession(entry, sendJson);
      switch (command.type) {
        case "mediaGetRtpCapabilities": {
          sendJson({ type: "mediaRtpCapabilities", requestId: command.requestId, rtpCapabilities: session.router.rtpCapabilities });
          return;
        }
        case "mediaCreateTransport": {
          const direction = command.payload.direction as MediaTransportDirection;
          const transport = await createMediaWebRtcTransport(session.router, {
            ...(entry.webrtcPublicHost ? { announcedAddress: entry.webrtcPublicHost } : {}),
            appData: { direction },
          });
          if (direction === "send") session.sendTransport = transport;
          else session.recvTransport = transport;
          transport.on("dtlsstatechange", (state) => {
            if (state === "failed" || state === "closed") {
              this.logger.warn({ entryId: entry.id, transportId: transport.id, direction, state }, "mediasoup transport DTLS 状态异常");
            }
          });
          sendJson({
            type: "mediaTransportCreated",
            requestId: command.requestId,
            direction,
            transportId: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            ...(transport.sctpParameters ? { sctpParameters: transport.sctpParameters } : {}),
          });
          return;
        }
        case "mediaConnectTransport": {
          const transport = findMediaTransport(session, command.payload.transportId as string);
          if (!transport) {
            sendMediaError(sendJson, command.requestId, "MEDIA_TRANSPORT_NOT_FOUND", "媒体传输不存在或已关闭");
            return;
          }
          await transport.connect({ dtlsParameters: command.payload.dtlsParameters as DtlsParameters });
          sendJson({ type: "mediaTransportConnected", requestId: command.requestId, transportId: transport.id });
          return;
        }
        case "mediaProduce": {
          const transport = findMediaTransport(session, command.payload.transportId as string);
          if (!transport) {
            sendMediaError(sendJson, command.requestId, "MEDIA_TRANSPORT_NOT_FOUND", "媒体传输不存在或已关闭");
            return;
          }
          // 浏览器在 appData 里携带初始 muted / accompanimentActive（替代旧 offer
          // 内字段），作为网关侧状态初值；后续由 setMicrophoneMuted /
          // setAccompanimentActive 命令热更新。
          const produceAppData = command.payload.appData as Record<string, unknown> | undefined;
          if (produceAppData) {
            if (typeof produceAppData.muted === "boolean") entry.microphoneMuted = produceAppData.muted;
            if (typeof produceAppData.accompanimentActive === "boolean") entry.accompanimentActive = produceAppData.accompanimentActive;
          }
          const producer = await transport.produce({
            kind: (command.payload.kind as MediaKind | undefined) ?? "audio",
            rtpParameters: command.payload.rtpParameters as RtpParameters,
            ...(command.payload.appData ? { appData: command.payload.appData as Record<string, unknown> } : {}),
          });
          session.producers.set(producer.id, producer);
          producer.on("transportclose", () => { session.producers.delete(producer.id); });
          // S4：在 Router 上建立 DirectTransport Consumer 订阅该上行 Producer 并 resume，
          // 抽出的 Opus payload 按零退化矩阵透传 TSClient。
          await this.attachUpstreamPipeline(entry, session, producer);
          sendJson({ type: "mediaProduced", requestId: command.requestId, producerId: producer.id });
          return;
        }
        case "mediaConsume": {
          const transport = findMediaTransport(session, command.payload.transportId as string);
          if (!transport) {
            sendMediaError(sendJson, command.requestId, "MEDIA_TRANSPORT_NOT_FOUND", "媒体传输不存在或已关闭");
            return;
          }
          const consumer = await transport.consume({
            producerId: command.payload.producerId as string,
            rtpCapabilities: command.payload.rtpCapabilities as RtpCapabilities,
          });
          session.consumers.set(consumer.id, consumer);
          // 说话人 Producer 关闭（idle/淘汰/离开）时 mediasoup 会自动关掉对应的
          // Consumer 并发 producerclose，这里只需把索引清掉。
          consumer.on("producerclose", () => { session.consumers.delete(consumer.id); });
          consumer.on("transportclose", () => { session.consumers.delete(consumer.id); });
          sendJson({
            type: "mediaConsumed",
            requestId: command.requestId,
            consumerId: consumer.id,
            producerId: consumer.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          });
          return;
        }
        case "mediaPauseProducer": {
          const producer = session.producers.get(command.payload.producerId as string);
          if (!producer) {
            sendMediaError(sendJson, command.requestId, "MEDIA_PRODUCER_NOT_FOUND", "上行生产者不存在或已关闭");
            return;
          }
          await producer.pause();
          // §8.3：媒体暂停等价于"网关侧静音"，同步 TS3 输入静音状态并开启丢包护栏。
          entry.microphoneMuted = true;
          await this.syncTeamSpeakInputMuted(entry, true);
          sendJson({ type: "mediaProducerPaused", requestId: command.requestId, producerId: producer.id });
          return;
        }
        case "mediaResumeProducer": {
          const producer = session.producers.get(command.payload.producerId as string);
          if (!producer) {
            sendMediaError(sendJson, command.requestId, "MEDIA_PRODUCER_NOT_FOUND", "上行生产者不存在或已关闭");
            return;
          }
          await producer.resume();
          entry.microphoneMuted = false;
          await this.syncTeamSpeakInputMuted(entry, false);
          sendJson({ type: "mediaProducerResumed", requestId: command.requestId, producerId: producer.id });
          return;
        }
        case "mediaConsumerResume": {
          const consumer = session.consumers.get(command.payload.consumerId as string);
          if (!consumer) {
            sendMediaError(sendJson, command.requestId, "MEDIA_CONSUMER_NOT_FOUND", "下行消费者不存在或已关闭");
            return;
          }
          // 浏览器自动播放策略会拦截未经用户手势的音频；解锁后由客户端显式 resume。
          await consumer.resume();
          sendJson({ type: "mediaConsumerResumed", requestId: command.requestId, consumerId: consumer.id });
          return;
        }
        default:
          return;
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn({ entryId: entry.id, type: command.type, err: detail }, "mediasoup 信令处理失败");
      sendMediaError(sendJson, command.requestId, "MEDIA_SIGNALING_FAILED", detail.slice(0, 160) || "媒体信令处理失败");
    }
  }

  /**
   * 为一个上行 Producer 建立转发管线（S4）。
   *
   * 失败时清理半成品并抛出，由 `handleMediaMessage` 的 catch 转成 mediaError：
   * 浏览器据此知道上行链路没起来，而不是以为在正常推流。
   */
  private async attachUpstreamPipeline(entry: WebClientEntry, session: MediaSession, producer: Producer): Promise<void> {
    const pipeline = new UpstreamAudioPipeline(entry, {
      onFrameDropped: (reason) => {
        if (reason === "malformed") this.logger.debug({ producerId: producer.id }, "上行 RTP 帧格式无效，已丢弃");
      },
    });
    try {
      await pipeline.attach(session.router, producer.id);
    } catch (error: unknown) {
      pipeline.close();
      throw error;
    }
    session.upstreams.set(producer.id, pipeline);
    const dispose = (): void => {
      if (session.upstreams.get(producer.id) === pipeline) session.upstreams.delete(producer.id);
      pipeline.close();
    };
    producer.on("transportclose", dispose);
    producer.on("@close", dispose);
  }

  /**
   * 同步 TS3 输入静音状态（best-effort）。
   *
   * 媒体信令不要求 TS 会话已就绪，`mediaPauseProducer` 可能在 TS 未连上时到达，
   * 此时 `setInputMuted` 会抛错——静音护栏本身已由 `entry.microphoneMuted` 生效，
   * 不应让同步失败反过来打断信令。
   */
  private async syncTeamSpeakInputMuted(entry: WebClientEntry, muted: boolean): Promise<void> {
    try {
      await entry.tsClient.setInputMuted(muted);
    } catch (error: unknown) {
      this.logger.warn(
        { entryId: entry.id, muted, err: error instanceof Error ? error.message : String(error) },
        "无法同步 TS3 输入静音状态（媒体信令不受影响）",
      );
    }
  }

  /** 释放一个会话的全部 mediasoup 资源（先发布器/消费者，再 transport，最后 Router）。 */
  private closeMediaSession(session: MediaSession): void {
    try { session.speakerProducers.clear(); } catch { /* 幂等 */ }
    for (const pipeline of session.upstreams.values()) {
      try { pipeline.close(); } catch { /* 幂等 */ }
    }
    session.upstreams.clear();
    for (const consumer of session.consumers.values()) {
      try { consumer.close(); } catch { /* 幂等 */ }
    }
    session.consumers.clear();
    for (const producer of session.producers.values()) {
      try { producer.close(); } catch { /* 幂等 */ }
    }
    session.producers.clear();
    try { session.sendTransport?.close(); } catch { /* 幂等 */ }
    try { session.recvTransport?.close(); } catch { /* 幂等 */ }
    session.sendTransport = null;
    session.recvTransport = null;
    try { session.router.close(); } catch { /* 幂等 */ }
  }

  private handleScreenShareMessage(
    entry: WebClientEntry,
    message: ScreenShareClientMessage,
    sendJson: (message: Record<string, unknown>) => void,
  ): void {
    if (message.type === "screenShareList") {
      sendJson({ type: "screenShareList", streams: this.listScreenStreamsFor(entry) });
      return;
    }

    if (message.type === "screenShareStart") {
      if ([...this.screenStreams.values()].some((stream) => stream.source === "browser" && stream.ownerEntryId === entry.id)) {
        sendJson({ type: "screenShareError", requestId: message.requestId, code: "SCREEN_SHARE_ALREADY_ACTIVE", message: "你已经在共享屏幕" });
        return;
      }
      const stream: ScreenStreamRecord = {
        streamId: `screen-${randomUUID()}`,
        source: "browser",
        ownerPeerId: entry.screenPeerId,
        ownerClientId: entry.tsClient.getClientId() || undefined,
        ownerNickname: entry.nickname,
        name: message.name?.trim() || `${entry.nickname} 的屏幕`,
        audio: message.audio === true,
        createdAt: Date.now(),
        viewerCount: 0,
        viewers: [],
        targetKey: teamSpeakTargetKey(entry.target),
        channelId: entry.tsClient.getChannelId(),
        ownerEntryId: entry.id,
        viewerEntryIds: new Set(),
        teamSpeakPublisherEntryId: entry.id,
        nativeViewerClids: new Set(),
      };
      this.screenStreams.set(screenStreamKey(stream.targetKey, stream.streamId), stream);
      sendJson({ type: "screenShareStarted", requestId: message.requestId, stream: this.describeScreenStream(stream), owner: true });
      this.broadcastScreenMessage(stream, {
        type: "screenShareStarted",
        stream: this.describeScreenStream(stream),
        owner: false,
      }, entry.id);
      void this.publishBrowserScreenStream(entry, stream);
      return;
    }

    const stream = this.screenStreams.get(screenStreamKey(teamSpeakTargetKey(entry.target), message.streamId));
    if (!stream) {
      sendJson({ type: "screenShareError", requestId: "requestId" in message ? message.requestId : undefined, code: "SCREEN_SHARE_NOT_FOUND", message: "屏幕共享已结束或不存在" });
      return;
    }
    if (stream.targetKey !== teamSpeakTargetKey(entry.target) || stream.channelId !== entry.tsClient.getChannelId()) {
      sendJson({ type: "screenShareError", requestId: "requestId" in message ? message.requestId : undefined, code: "SCREEN_SHARE_TARGET_MISMATCH", message: "屏幕共享不属于当前服务器或频道" });
      return;
    }

    if (message.type === "screenShareStop") {
      if (stream.ownerEntryId !== entry.id) {
        sendJson({ type: "screenShareError", requestId: message.requestId, code: "SCREEN_SHARE_NOT_OWNER", message: "只有共享者可以结束共享" });
        return;
      }
      this.stopScreenStream(stream, "owner-stopped");
      if (message.requestId) sendJson({ type: "screenShareCompleted", requestId: message.requestId });
      return;
    }

    if (message.type === "screenShareJoin") {
      if (stream.ownerEntryId === entry.id) {
        sendJson({ type: "screenShareError", requestId: message.requestId, code: "SCREEN_SHARE_OWNER_CANNOT_JOIN", message: "共享者不能作为观看者加入自己的共享" });
        return;
      }
      const alreadyJoined = stream.viewerEntryIds.has(entry.id);
      if (!alreadyJoined) stream.viewerEntryIds.add(entry.id);
      stream.viewerCount = this.screenShareViewerCount(stream);
      sendJson({
        type: "screenShareJoined",
        requestId: message.requestId,
        stream: this.describeScreenStream(stream),
        ownerPeerId: stream.ownerPeerId,
        mode: stream.source,
      });
      if (stream.source === "browser" && !alreadyJoined) {
        this.sendToEntry(stream.ownerEntryId, {
          type: "screenShareViewerJoined",
          streamId: stream.streamId,
          viewerPeerId: entry.screenPeerId,
          viewerNickname: entry.nickname,
        });
      } else if (stream.source === "teamspeak" && !alreadyJoined) {
        void this.joinNativeScreenStream(entry, stream, sendJson, message.requestId);
      }
      if (!alreadyJoined) {
        this.broadcastScreenMessage(stream, this.screenShareViewerCountMessage(stream));
      }
      return;
    }

    if (message.type === "screenShareLeave") {
      this.leaveScreenStream(entry, stream);
      if (message.requestId) sendJson({ type: "screenShareCompleted", requestId: message.requestId });
      return;
    }

    if (message.type === "screenShareSignal") {
      this.relayScreenShareSignal(entry, stream, message.targetPeerId, message.signal, sendJson);
    }
  }

  private listScreenStreamsFor(entry: WebClientEntry): ScreenShareStreamDescription[] {
    const targetKey = teamSpeakTargetKey(entry.target);
    return [...this.screenStreams.values()]
      .filter((stream) => stream.targetKey === targetKey && stream.channelId === entry.tsClient.getChannelId())
      .map((stream) => this.describeScreenStream(stream));
  }

  /**
   * A gateway session can connect after a native TeamSpeak stream has already
   * started. TS6 does not replay that stream in the normal welcome snapshot;
   * requeststreaminfo is the official client-protocol query for this case.
   * Query each visible client once per TeamSpeak target, then let the normal
   * raw notification path announce the discovered stream to web viewers.
   */
  private async discoverExistingTeamSpeakStreams(entry: WebClientEntry): Promise<void> {
    const targetKey = teamSpeakTargetKey(entry.target);
    if (this.screenStreamDiscoveryTargets.has(targetKey)) return;
    this.screenStreamDiscoveryTargets.add(targetKey);
    const clientIds = [...entry.members.keys()].filter((clientId) => Number.isInteger(clientId) && clientId > 0);
    for (const clientId of clientIds) {
      if (!entry.tsClient.isConnected()) return;
      try {
        await entry.tsClient.sendProtocolCommand(`requeststreaminfo clid=${clientId}`);
      } catch (error: unknown) {
        this.logger.debug({
          target: formatTeamSpeakTarget(entry.target),
          clientId,
          err: error instanceof Error ? error.message : String(error),
        }, "Could not query existing TeamSpeak screen stream");
      }
    }
  }

  private describeScreenStream(stream: ScreenStreamRecord): ScreenShareStreamDescription {
    return {
      streamId: stream.streamId,
      source: stream.source,
      ownerPeerId: stream.ownerPeerId,
      ...(typeof stream.ownerClientId === "number" ? { ownerClientId: stream.ownerClientId } : {}),
      ownerNickname: stream.ownerNickname,
      name: stream.name,
      audio: stream.audio,
      createdAt: stream.createdAt,
      viewerCount: stream.viewerCount,
      viewers: this.describeScreenViewers(stream),
    };
  }

  private describeScreenViewers(stream: ScreenStreamRecord): ScreenShareViewerDescription[] {
    return [...stream.viewerEntryIds]
      .map((entryId) => this.entries.get(entryId))
      .filter((entry): entry is WebClientEntry => Boolean(entry))
      .slice(0, 64)
      .map((entry) => {
        const avatar = entry.members.get(entry.tsClient.getClientId())?.avatar;
        return {
          peerId: entry.screenPeerId,
          nickname: entry.nickname,
          ...(avatar && avatar.length <= 128 * 1024 ? { avatar } : {}),
        };
      });
  }

  private screenShareViewerCountMessage(stream: ScreenStreamRecord): Record<string, unknown> {
    return {
      type: "screenShareViewerCount",
      streamId: stream.streamId,
      viewerCount: stream.viewerCount,
      viewers: this.describeScreenViewers(stream),
    };
  }

  private screenShareViewerCount(stream: ScreenStreamRecord): number {
    return stream.viewerEntryIds.size + stream.nativeViewerClids.size;
  }

  private broadcastScreenMessage(stream: ScreenStreamRecord, message: Record<string, unknown>, excludeEntryId?: string): void {
    for (const candidate of this.entries.values()) {
      if (candidate.id === excludeEntryId || candidate.target && teamSpeakTargetKey(candidate.target) !== stream.targetKey) continue;
      // A stream is scoped to the source channel. Do not leak its card or
      // viewer roster to users who are connected to another channel on the
      // same TeamSpeak target.
      if (candidate.id !== stream.ownerEntryId) {
        try {
          if (candidate.tsClient.getChannelId() !== stream.channelId) continue;
        } catch {
          continue;
        }
      }
      this.sendToEntry(candidate.id, message);
    }
  }

  private sendToEntry(entryId: string, message: Record<string, unknown>): void {
    const candidate = this.entries.get(entryId);
    if (candidate?.ws.readyState === WebSocket.OPEN) candidate.ws.send(JSON.stringify(message));
  }

  private stopScreenStream(stream: ScreenStreamRecord, reason: string): void {
    if (stream.source === "browser" && stream.teamSpeakStreamId && stream.teamSpeakPublisherEntryId) {
      const publisher = this.entries.get(stream.teamSpeakPublisherEntryId);
      if (publisher) {
        void publisher.tsClient.sendProtocolCommand(buildTeamSpeakCommand("stopstream", {
          id: stream.teamSpeakStreamId,
          reason: "1",
        })).catch(() => undefined);
      }
    }
    if (!this.screenStreams.delete(screenStreamKey(stream.targetKey, stream.streamId))) return;
    const message = { type: "screenShareStopped", streamId: stream.streamId, reason };
    this.broadcastScreenMessage(stream, message);
    stream.viewerEntryIds.clear();
    stream.nativeViewerClids.clear();
    stream.viewerCount = 0;
  }

  private leaveScreenStream(entry: WebClientEntry, stream: ScreenStreamRecord): void {
    if (!stream.viewerEntryIds.delete(entry.id)) return;
    stream.viewerCount = this.screenShareViewerCount(stream);
    if (stream.source === "browser") this.sendToEntry(stream.ownerEntryId, { type: "screenShareViewerLeft", streamId: stream.streamId, viewerPeerId: entry.screenPeerId });
    else {
      void entry.tsClient.sendProtocolCommand(buildTeamSpeakCommand("removeclientfromstream", {
        id: stream.streamId,
        clid: String(entry.tsClient.getClientId()),
      })).catch(() => undefined);
    }
    this.sendToEntry(entry.id, { type: "screenShareLeft", streamId: stream.streamId });
    this.broadcastScreenMessage(stream, this.screenShareViewerCountMessage(stream));
  }

  private relayScreenShareSignal(
    entry: WebClientEntry,
    stream: ScreenStreamRecord,
    targetPeerId: string,
    signal: ScreenSharePeerSignal,
    sendJson: (message: Record<string, unknown>) => void,
  ): void {
    if (stream.source === "teamspeak") {
      if (!stream.viewerEntryIds.has(entry.id) || targetPeerId !== stream.ownerPeerId) {
        sendJson({ type: "screenShareError", code: "SCREEN_SHARE_SIGNAL_FORBIDDEN", message: "无权发送该屏幕共享信令" });
        return;
      }
      const sourceClientId = stream.sourceClientId;
      if (!sourceClientId) {
        sendJson({ type: "screenShareError", code: "SCREEN_SHARE_SOURCE_UNAVAILABLE", message: "共享来源暂不可用" });
        return;
      }
      if (signal.kind === "close") {
        this.leaveScreenStream(entry, stream);
        return;
      }
      if (signal.kind === "offer") {
        sendJson({ type: "screenShareError", code: "SCREEN_SHARE_INVALID_SIGNAL", message: "观看端不能向 TeamSpeak 来源发送 offer" });
        return;
      }
      const payload = signal.kind === "iceCandidate"
        ? { cmd: "iceCandidate", args: { sdp: signal.candidate, ...(signal.sdpMid !== undefined ? { mid: signal.sdpMid } : {}), ...(signal.sdpMLineIndex !== undefined ? { mLine: signal.sdpMLineIndex } : {}) } }
        : { cmd: "answer", args: { answer: signal.sdp } };
      void entry.tsClient.sendProtocolCommand(buildTeamSpeakCommand("streamsignaling", {
        id: stream.streamId,
        clid: String(sourceClientId),
        json: JSON.stringify(payload),
      })).catch((error: unknown) => {
        sendJson({ type: "screenShareError", code: "SCREEN_SHARE_SIGNAL_FAILED", message: error instanceof Error ? error.message : "屏幕共享信令发送失败" });
      });
      return;
    }

    if (stream.source === "browser" && entry.id === stream.ownerEntryId && targetPeerId.startsWith("ts-viewer-")) {
      const viewerClid = parseNativeViewerPeerId(targetPeerId);
      const publisher = stream.teamSpeakPublisherEntryId ? this.entries.get(stream.teamSpeakPublisherEntryId) : undefined;
      if (!viewerClid || !publisher || !stream.teamSpeakStreamId || !stream.nativeViewerClids.has(viewerClid)) {
        sendJson({ type: "screenShareError", code: "SCREEN_SHARE_PEER_NOT_FOUND", message: "TeamSpeak 观看者已离开" });
        return;
      }
      if (signal.kind === "close") {
        void publisher.tsClient.sendProtocolCommand(buildTeamSpeakCommand("removeclientfromstream", {
          id: stream.teamSpeakStreamId,
          clid: String(viewerClid),
        })).catch(() => undefined);
        stream.nativeViewerClids.delete(viewerClid);
        stream.viewerCount = this.screenShareViewerCount(stream);
        this.sendToEntry(entry.id, { type: "screenShareViewerLeft", streamId: stream.streamId, viewerPeerId: targetPeerId });
        this.broadcastScreenMessage(stream, this.screenShareViewerCountMessage(stream));
        return;
      }
      if (signal.kind === "answer") {
        sendJson({ type: "screenShareError", code: "SCREEN_SHARE_INVALID_SIGNAL", message: "TeamSpeak 观看端不能先发送 answer" });
        return;
      }
      let command: string;
      if (signal.kind === "offer") {
        command = buildTeamSpeakCommand("respondjoinstreamrequest", {
          id: stream.teamSpeakStreamId,
          clid: String(viewerClid),
          msg: "",
          offer: signal.sdp,
          decision: "1",
        });
      } else if (signal.kind === "iceCandidate") {
        command = buildTeamSpeakCommand("streamsignaling", {
          id: stream.teamSpeakStreamId,
          clid: String(viewerClid),
          json: JSON.stringify({ cmd: "iceCandidate", args: { sdp: signal.candidate, ...(signal.sdpMid !== undefined ? { mid: signal.sdpMid } : {}), ...(signal.sdpMLineIndex !== undefined ? { mLine: signal.sdpMLineIndex } : {}) } }),
        });
      } else {
        return;
      }
      void publisher.tsClient.sendProtocolCommand(command).catch((error: unknown) => {
        sendJson({ type: "screenShareError", code: "SCREEN_SHARE_SIGNAL_FAILED", message: error instanceof Error ? error.message : "屏幕共享信令发送失败" });
      });
      return;
    }

    const owner = this.entries.get(stream.ownerEntryId);
    const isOwner = entry.id === stream.ownerEntryId;
    const isViewer = stream.viewerEntryIds.has(entry.id);
    if (!owner || (!isOwner && !isViewer)) {
      sendJson({ type: "screenShareError", code: "SCREEN_SHARE_SIGNAL_FORBIDDEN", message: "无权发送该屏幕共享信令" });
      return;
    }
    // Keep the browser P2P graph bipartite: the owner may signal only an
    // active viewer, and a viewer may signal only the owner. Without this
    // check one viewer could inject SDP/ICE into another viewer's peer.
    const targetEntry = isOwner
      ? [...stream.viewerEntryIds]
        .map((id) => this.entries.get(id))
        .find((candidate) => candidate?.screenPeerId === targetPeerId)
      : targetPeerId === owner.screenPeerId ? owner : undefined;
    if (!targetEntry || targetEntry.id === entry.id) {
      sendJson({ type: "screenShareError", code: "SCREEN_SHARE_PEER_NOT_FOUND", message: "观看者已离开" });
      return;
    }
    this.sendToEntry(targetEntry.id, { type: "screenShareSignal", streamId: stream.streamId, fromPeerId: entry.screenPeerId, signal });
  }

  private async publishBrowserScreenStream(entry: WebClientEntry, stream: ScreenStreamRecord): Promise<void> {
    try {
      await entry.tsClient.sendProtocolCommand(buildTeamSpeakCommand("setupstream", {
        name: stream.name,
        type: "3",
        bitrate: "4608",
        accessibility: "1",
        mode: "1",
        viewer_limit: "0",
        audio: stream.audio ? "1" : "0",
      }));
    } catch (error: unknown) {
      this.logger.warn({
        target: formatTeamSpeakTarget(entry.target),
        streamId: stream.streamId,
        err: error instanceof Error ? error.message : String(error),
      }, "Could not publish browser screen share to TeamSpeak");
    }
  }

  private async joinNativeScreenStream(
    entry: WebClientEntry,
    stream: ScreenStreamRecord,
    sendJson: (message: Record<string, unknown>) => void,
    requestId?: string,
  ): Promise<void> {
    const sourceClientId = stream.sourceClientId;
    if (!entry.tsClient.getClientId() || !sourceClientId) {
      sendJson({ type: "screenShareError", requestId, code: "SCREEN_SHARE_SOURCE_UNAVAILABLE", message: "共享来源暂不可用" });
      return;
    }
    try {
      await entry.tsClient.sendProtocolCommand(buildTeamSpeakCommand("joinstreamrequest", {
        id: stream.streamId,
        // TS6 uses the source client id on joinstreamrequest. The requesting
        // gateway session is identified later by the response/signaling
        // notification delivered to this TS connection.
        clid: String(sourceClientId),
        msg: "",
        is_remove: "0",
        muted: "0",
        volume: "0",
        hidden: "0",
      }));
    } catch (error: unknown) {
      this.leaveScreenStream(entry, stream);
      sendJson({ type: "screenShareError", requestId, code: "SCREEN_SHARE_JOIN_FAILED", message: error instanceof Error ? error.message : "无法加入屏幕共享" });
    }
  }

  private removeScreenSharePeer(entryId: string): void {
    for (const stream of [...this.screenStreams.values()]) {
      if (stream.ownerEntryId === entryId) {
        this.stopScreenStream(stream, "owner-disconnected");
        continue;
      }
      const entry = this.entries.get(entryId);
      if (entry && stream.viewerEntryIds.has(entryId)) this.leaveScreenStream(entry, stream);
    }
  }

  private reconcileScreenShareAfterClientMove(entry: WebClientEntry, movedClientId: number, targetChannelId: bigint): void {
    const targetKey = teamSpeakTargetKey(entry.target);
    for (const stream of [...this.screenStreams.values()]) {
      if (stream.targetKey !== targetKey) continue;
      // A browser share belongs to the gateway user's current channel. Stop
      // it when that user moves so existing viewers cannot keep a cross-
      // channel peer alive.
      if (stream.source === "browser" && stream.ownerEntryId === entry.id && stream.channelId !== targetChannelId) {
        this.stopScreenStream(stream, "owner-moved-channel");
        continue;
      }
      // Native TS6 shares are channel-scoped as well. The notification is
      // observed by every gateway session, so stop the shared record once the
      // native source changes channels.
      if (stream.source === "teamspeak" && stream.sourceClientId === movedClientId) {
        this.stopScreenStream(stream, "source-moved-channel");
        continue;
      }
      if (stream.viewerEntryIds.has(entry.id) && stream.channelId !== targetChannelId) {
        this.leaveScreenStream(entry, stream);
      }
    }
  }

  private reconcileNativeScreenShareAfterClientLeave(entry: WebClientEntry, clientId: number): void {
    const targetKey = teamSpeakTargetKey(entry.target);
    for (const stream of [...this.screenStreams.values()]) {
      if (stream.targetKey === targetKey && stream.source === "teamspeak" && stream.sourceClientId === clientId) {
        this.stopScreenStream(stream, "source-left");
      }
    }
  }

  private handleRawScreenNotification(entry: WebClientEntry, notification: TSRawNotification): void {
    const params = notification.params;
    if (notification.name === "notifyjoinstreamrequest") {
      const streamId = params.id || params.stream_id;
      const viewerClientId = parseNumber(params.clid);
      if (!streamId || !viewerClientId) return;
      const targetKey = teamSpeakTargetKey(entry.target);
      const stream = [...this.screenStreams.values()].find((candidate) => candidate.targetKey === targetKey
        && candidate.source === "browser"
        && candidate.teamSpeakPublisherEntryId === entry.id
        && candidate.teamSpeakStreamId === streamId);
      if (!stream) return;
      stream.nativeViewerClids.add(viewerClientId);
      stream.viewerCount = this.screenShareViewerCount(stream);
      this.sendToEntry(stream.ownerEntryId, {
        type: "screenShareNativeViewerJoined",
        streamId: stream.streamId,
        viewerPeerId: nativeViewerPeerId(viewerClientId),
        viewerClientId,
      });
      this.broadcastScreenMessage(stream, this.screenShareViewerCountMessage(stream));
      return;
    }
    if (notification.name === "notifystreamstarted" || notification.name === "notifystreaminfo") {
      const streamId = params.id || params.stream_id;
      const sourceClientId = parseNumber(params.clid);
      if (!streamId || !sourceClientId) return;
      const targetKey = teamSpeakTargetKey(entry.target);
      const publisherEntry = [...this.entries.values()].find((candidate) => candidate.target
        && teamSpeakTargetKey(candidate.target) === targetKey
        && candidate.tsClient.getClientId() === sourceClientId);
      const browserStream = publisherEntry
        ? [...this.screenStreams.values()].find((candidate) => candidate.targetKey === targetKey
          && candidate.source === "browser"
          && candidate.teamSpeakPublisherEntryId === publisherEntry.id
          && !candidate.teamSpeakStreamId)
        : undefined;
      if (browserStream) {
        browserStream.teamSpeakStreamId = streamId;
        return;
      }
      const sourceEntry = [...this.entries.values()].find((candidate) => candidate.tsClient.getClientId() === sourceClientId);
      const key = screenStreamKey(targetKey, streamId);
      const current = this.screenStreams.get(key);
      const stream: ScreenStreamRecord = current ?? {
        streamId,
        source: "teamspeak",
        ownerPeerId: `ts-${sourceClientId}`,
        ownerClientId: sourceClientId,
        ownerNickname: params.name || `TeamSpeak 用户 ${sourceClientId}`,
        name: params.name || "TeamSpeak 屏幕共享",
        audio: params.audio === "1",
        createdAt: Date.now(),
        viewerCount: 0,
        viewers: [],
        targetKey,
        channelId: sourceEntry?.tsClient.getChannelId() ?? entry.tsClient.getChannelId(),
        ownerEntryId: "",
        viewerEntryIds: new Set(),
        nativeViewerClids: new Set(),
        sourceClientId,
      };
      stream.sourceClientId = sourceClientId;
      stream.ownerNickname = params.name || stream.ownerNickname;
      stream.name = params.name || stream.name;
      stream.audio = params.audio === "1";
      this.screenStreams.set(key, stream);
      // Every gateway session attached to the same TS target sees the same
      // raw notification. Only the first one should announce a new stream to
      // browsers; otherwise each connected user receives duplicate cards.
      if (!current) {
        this.broadcastScreenMessage(stream, { type: "screenShareStarted", stream: this.describeScreenStream(stream), owner: false });
      }
      return;
    }
    if (notification.name === "notifystreamstopped") {
      const streamId = params.id || params.stream_id;
      if (!streamId) return;
      const targetKey = teamSpeakTargetKey(entry.target);
      const stream = this.screenStreams.get(screenStreamKey(targetKey, streamId));
      if (stream) {
        this.stopScreenStream(stream, "source-stopped");
        return;
      }
      const browserStream = [...this.screenStreams.values()].find((candidate) => candidate.targetKey === targetKey
        && candidate.source === "browser"
        && candidate.teamSpeakStreamId === streamId);
      if (browserStream) {
        browserStream.teamSpeakStreamId = undefined;
        browserStream.nativeViewerClids.clear();
        browserStream.viewerCount = this.screenShareViewerCount(browserStream);
        this.sendToEntry(browserStream.ownerEntryId, {
          type: "screenShareError",
          code: "SCREEN_SHARE_NATIVE_PUBLISHER_STOPPED",
          message: "TeamSpeak 客户端屏幕共享通道已停止，网页共享仍可继续",
        });
        this.broadcastScreenMessage(browserStream, this.screenShareViewerCountMessage(browserStream));
      }
      return;
    }
    if (notification.name === "notifystreamclientleft") {
      const streamId = params.id || params.stream_id;
      const viewerClientId = parseNumber(params.clid);
      if (!streamId || !viewerClientId) return;
      const targetKey = teamSpeakTargetKey(entry.target);
      const stream = [...this.screenStreams.values()].find((candidate) => candidate.targetKey === targetKey
        && candidate.source === "browser"
        && candidate.teamSpeakStreamId === streamId
        && candidate.nativeViewerClids.has(viewerClientId));
      if (!stream) return;
      stream.nativeViewerClids.delete(viewerClientId);
      stream.viewerCount = this.screenShareViewerCount(stream);
      this.sendToEntry(stream.ownerEntryId, {
        type: "screenShareViewerLeft",
        streamId: stream.streamId,
        viewerPeerId: nativeViewerPeerId(viewerClientId),
      });
      this.broadcastScreenMessage(stream, this.screenShareViewerCountMessage(stream));
      return;
    }
    if (notification.name === "notifyrespondjoinstreamrequest" || notification.name === "notifystreamsignaling") {
      const streamId = params.id || params.stream_id;
      if (!streamId) return;
      const targetKey = teamSpeakTargetKey(entry.target);
      const browserStream = notification.name === "notifystreamsignaling"
        ? [...this.screenStreams.values()].find((candidate) => candidate.targetKey === targetKey
          && candidate.source === "browser"
          && candidate.teamSpeakPublisherEntryId === entry.id
          && candidate.teamSpeakStreamId === streamId)
        : undefined;
      if (browserStream) {
        const viewerClientId = parseNumber(params.clid);
        if (!viewerClientId || !browserStream.nativeViewerClids.has(viewerClientId)) return;
        const payload = parseStreamSignalPayload(params.json || params.data || "");
        if (!payload) return;
        const signal = toBrowserScreenSignal(payload);
        if (!signal) return;
        this.sendToEntry(browserStream.ownerEntryId, {
          type: "screenShareSignal",
          streamId: browserStream.streamId,
          fromPeerId: nativeViewerPeerId(viewerClientId),
          signal,
        });
        return;
      }
      const stream = this.screenStreams.get(screenStreamKey(targetKey, streamId));
      if (!stream || stream.source !== "teamspeak" || !stream.viewerEntryIds.has(entry.id)) return;
      const payload = notification.name === "notifyrespondjoinstreamrequest"
        ? { cmd: "offer", args: { offer: params.offer || "" } }
        : parseStreamSignalPayload(params.json || params.data || "");
      if (!payload) return;
      const signal = toBrowserScreenSignal(payload);
      if (!signal) return;
      this.sendToEntry(entry.id, { type: "screenShareSignal", streamId, fromPeerId: stream.ownerPeerId, signal });
    }
  }
}

function resolveWebRtcPublicHost(request: IncomingMessage): string | undefined {
  // 反向代理部署（例如境外 443 入口反代到本机）下，Origin/Host 指向的是代理的
  // 域名。从它们推导媒体地址会把 ICE candidate 广告成代理的 IP，媒体因此绕路到
  // 代理机房。这种部署必须用 WEBSPEAK_MEDIA_PUBLIC_HOST 显式指定媒体地址。
  const configured = process.env.WEBSPEAK_MEDIA_PUBLIC_HOST?.trim();
  if (configured) {
    const host = normalizeWebRtcHost(configured);
    if (host) return host;
  }
  // 未配置时回退到原有的头推导，保持单机直连部署的向后兼容。
  const origin = firstHeader(request.headers.origin);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const directHost = firstHeader(request.headers.host);
  for (const candidate of [origin, forwardedHost, directHost]) {
    const host = normalizeWebRtcHost(candidate);
    if (host) return host;
  }
  return undefined;
}

function resolveClientIp(request: IncomingMessage): string {
  const candidates = [
    firstHeader(request.headers["x-forwarded-for"])?.split(",", 1)[0],
    firstHeader(request.headers["x-real-ip"]),
    request.socket.remoteAddress,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeClientIp(candidate);
    if (normalized) return normalized;
  }
  return "unknown";
}

function normalizeClientIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) trimmed = trimmed.slice(1, -1);
  if (trimmed.toLowerCase().startsWith("::ffff:")) {
    const mapped = trimmed.slice("::ffff:".length);
    if (isIP(mapped) === 4) trimmed = mapped;
  }
  return isIP(trimmed) ? trimmed : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeWebRtcHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.split(",", 1)[0]?.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

/** 按 transportId 在会话的 send/recv transport 里查找。 */
function findMediaTransport(session: MediaSession, transportId: string): WebRtcTransport | null {
  if (session.sendTransport?.id === transportId) return session.sendTransport;
  if (session.recvTransport?.id === transportId) return session.recvTransport;
  return null;
}

function sendMediaError(
  sendJson: (message: Record<string, unknown>) => void,
  requestId: string | undefined,
  code: string,
  message: string,
): void {
  sendJson({ type: "mediaError", requestId, code, message });
}

async function handleCommand(
  entry: WebClientEntry,
  command: ClientCommand,
  sendJson: (message: Record<string, unknown>) => void,
): Promise<void> {
  if (command.type === "latencyProbe") {
    const sequence = command.payload.sequence as string;
    const now = Date.now();
    if (now - entry.lastLatencyProbeAt < 150) return;
    entry.lastLatencyProbeAt = now;
    const result = await pingTeamSpeakSession(
      (request, timeoutMs) => entry.tsClient.execCommandWithResponse(request, timeoutMs),
    );
    sendJson({
      type: "latencyPong",
      sequence,
      teamSpeakLatencyMs: result.latencyMs,
      teamSpeakReachable: result.ok,
      teamSpeakErrorCode: result.errorCode ?? null,
    });
    return;
  }

  if (command.type === "channelInfo") {
    const channelId = command.payload.channelId as string;
    try {
      const info = await entry.tsClient.getChannelInfo(BigInt(channelId));
      sendJson({
        type: "channelInfo",
        requestId: command.requestId,
        channelId,
        name: info.name,
        topic: info.topic,
        description: info.description,
      });
    } catch (error: unknown) {
      // 说明是可选信息：这里不用通用 error 帧，避免把一个"取不到说明"的失败
      // 升级成全局错误提示。浏览器侧收到 channelInfoUnavailable 只会回落到空态。
      const operation = classifyOperationError(error, "CHANNEL_INFO_UNAVAILABLE", "无法读取频道说明");
      sendJson({
        type: "channelInfoUnavailable",
        requestId: command.requestId,
        channelId,
        error: { code: operation.code, message: operation.message },
      });
    }
    return;
  }

  if (command.type === "switchChannel") {
    const rawId = command.payload.channelId as string;
    const channelPassword = typeof command.payload.password === "string" ? command.payload.password : "";
    try {
      await entry.tsClient.switchChannel(BigInt(rawId), channelPassword || undefined);
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      if (/already member/i.test(rawMessage)) {
        sendJson({ type: "channelSwitched", requestId: command.requestId, channelId: rawId });
        return;
      }
      const operation = classifyOperationError(error, "CHANNEL_SWITCH_FAILED", "频道切换失败");
      sendJson({ type: "error", requestId: command.requestId, error: { code: operation.code, message: operation.message, recoverable: false } });
      return;
    }
    sendJson({ type: "channelSwitched", requestId: command.requestId, channelId: rawId });
    sendJson({ type: "channelList", channels: entry.channelTree });
    return;
  }

  try {
    if (command.type === "moveClient") {
      const clientId = command.payload.clientId as number;
      const channelId = command.payload.channelId as string;
      if (clientId === entry.tsClient.getClientId()) {
        sendJson({ type: "error", requestId: command.requestId, error: { code: "CANNOT_MOVE_SELF", message: "不能移动自己的客户端", recoverable: false } });
        return;
      }
      if (!entry.members.has(clientId)) {
        sendJson({ type: "error", requestId: command.requestId, error: { code: "CLIENT_NOT_FOUND", message: "成员已离线或当前不可见", recoverable: false } });
        return;
      }
      const targetExists = entry.channelTree.some((channel) => isRecord(channel) && channel.id === channelId);
      if (!targetExists) {
        sendJson({ type: "error", requestId: command.requestId, error: { code: "CHANNEL_NOT_FOUND", message: "目标频道不可用", recoverable: false } });
        return;
      }
      // TeamSpeak evaluates i_client_move_power against the target's
      // i_client_needed_move_power inside clientmove. Do not duplicate that
      // policy in the gateway; forwarding the authoritative command keeps TS3
      // and TS6 permission behavior aligned.
      // Moving another visible client is an administrator operation. It must
      // not prompt for or depend on the target channel's join password.
      await entry.tsClient.moveClient(clientId, BigInt(channelId));
    } else if (command.type === "sendTextMessage") {
      const message = (command.payload.message as string).trim();
      if (message) await entry.tsClient.sendTextMessage("channel", message, entry.tsClient.getChannelId());
    } else if (command.type === "sendServerMessage") {
      const message = (command.payload.message as string).trim();
      if (message) await entry.tsClient.sendTextMessage("server", message);
    } else if (command.type === "sendPrivateMessage") {
      const clientId = command.payload.clientId as number;
      if (!entry.members.has(clientId)) {
        sendJson({ type: "error", requestId: command.requestId, error: { code: "CLIENT_NOT_FOUND", message: "成员已离线", recoverable: false } });
        return;
      }
      const message = (command.payload.message as string).trim();
      if (message) await entry.tsClient.sendTextMessage("private", message, BigInt(clientId));
    } else if (command.type === "poke") {
      const clientId = command.payload.clientId as number;
      if (!entry.members.has(clientId)) {
        sendJson({ type: "error", requestId: command.requestId, error: { code: "CLIENT_NOT_FOUND", message: "成员已离线", recoverable: false } });
        return;
      }
      await entry.tsClient.poke(clientId, (command.payload.message as string).trim());
    } else if (command.type === "setAway") {
      await entry.tsClient.setAway(command.payload.away as boolean, typeof command.payload.message === "string" ? command.payload.message.trim() : "");
    } else if (command.type === "setWhisperTargets") {
      const targetIds = command.payload.targetIds as number[];
      const selfId = entry.tsClient.getClientId();
      if (targetIds.some((clientId) => clientId === selfId || !entry.members.has(clientId))) {
        sendJson({ type: "error", requestId: command.requestId, error: { code: "CLIENT_NOT_FOUND", message: "私语目标已离线", recoverable: false } });
        return;
      }
      entry.whisperTargetIds = new Set(targetIds);
      if (!entry.whisperTargetIds.size) entry.whisperActive = false;
      sendJson({ type: "whisperTargets", targetIds: [...entry.whisperTargetIds], active: entry.whisperActive });
    } else if (command.type === "setWhisperActive") {
      const active = command.payload.active as boolean;
      if (active && !entry.whisperTargetIds.size) {
        sendJson({ type: "error", requestId: command.requestId, error: { code: "NO_WHISPER_TARGETS", message: "请先选择私语目标", recoverable: false } });
        return;
      }
      entry.whisperActive = active;
      sendJson({ type: "whisperTargets", targetIds: [...entry.whisperTargetIds], active: entry.whisperActive });
    } else if (command.type === "setMicrophoneMuted") {
      const muted = command.payload.muted as boolean;
      // S4：同步 TS3 输入静音状态，并驱动上行 Consumer 的丢包护栏。
      await applyMicrophoneMute(entry, muted);
    } else if (command.type === "setAccompanimentActive") {
      const active = command.payload.active as boolean;
      // S4：伴奏状态热更新——决定后续上行帧的 TS3 codec（5 Opus Music / 4 Opus Voice），
      // 并同步到上行 Producer 的 appData，便于观测与前端对账。
      entry.accompanimentActive = active;
      for (const producer of entry.media?.producers.values() ?? []) {
        producer.appData = { ...producer.appData, accompanimentActive: active };
      }
    } else if (command.type === "setMemberVolume") {
      // S5 起成员音量在浏览器侧按 clientId 作用于独立 GainNode（WebAudio 播放图），
      // 服务端只回执，不再参与音量计算。
    }
    if (command.requestId) sendJson({ type: "commandCompleted", requestId: command.requestId });
  } catch (error: unknown) {
    const operation = classifyOperationError(error, "OPERATION_FAILED", "操作失败");
    sendJson({ type: "error", requestId: command.requestId, error: { code: operation.code, message: operation.message, recoverable: false } });
  }
}

function classifyOperationError(error: unknown, fallbackCode: string, fallbackMessage: string): { code: string; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLocaleLowerCase();
  // A TeamSpeak server error id is authoritative when the SDK preserved it, so it
  // is consulted before the keyword rules: 781 (channel password), 2568
  // (permissions), 515/2817 (server capacity limit) and friends keep their exact
  // meaning instead of being guessed from prose.
  const serverCode =
    teamSpeakServerErrorCode(isRecord(error) ? (error.id ?? error.code) : undefined) ??
    teamSpeakServerErrorCode(/\bid[\s=:]*(\d{3,5})\b/.exec(normalized)?.[1]);
  if (serverCode) {
    if (serverCode === "identity_security_level_too_low") return { code: "PERMISSION_DENIED", message: "你没有执行此操作的权限" };
    if (serverCode === "channel_password_required") return { code: "CHANNEL_PASSWORD_REQUIRED", message: "该频道需要密码" };
    if (serverCode === "server_full") return { code: "CHANNEL_FULL", message: "该频道已满" };
    if (serverCode === "client_version_outdated") return { code: "CLIENT_VERSION_OUTDATED", message: "客户端版本过旧，服务器拒绝了该操作" };
    if (serverCode === "flooding") return { code: "FLOOD_PROTECTION", message: "操作过于频繁，请稍后重试" };
    if (serverCode === "banned") return { code: "BANNED", message: "你已被该服务器封禁" };
    if (serverCode === "connection_initialisation_failed") return { code: "CONNECTION_INITIALISATION_FAILED", message: "TeamSpeak 服务器未能完成连接初始化，请稍后重试" };
  }
  if (/permission|not permitted|insufficient|i_permission|2568/.test(normalized)) return { code: "PERMISSION_DENIED", message: "你没有执行此操作的权限" };
  if (/channel.*(password|password.*required)|invalid.*(channel|password)|i_channel_password|781/.test(normalized)) return { code: "CHANNEL_PASSWORD_REQUIRED", message: "该频道需要密码" };
  if (/already member/.test(normalized)) return { code: "ALREADY_IN_CHANNEL", message: "你已经在该频道中" };
  if (/full|maximum.*clients/.test(normalized)) return { code: "CHANNEL_FULL", message: "该频道已满" };
  if (/not found|unknown client|invalid client/.test(normalized)) return { code: "CLIENT_NOT_FOUND", message: "成员已离线" };
  return { code: fallbackCode, message: fallbackMessage };
}

function sendProtocolError(sendJson: (message: Record<string, unknown>) => void, code: string, message: string): void {
  sendJson({ type: "error", error: { code, message, recoverable: false } });
}

/**
 * 旧客户端回退到兼容通道时发送的遗留信令（S6 起服务端无对应会话，静默忽略）。
 */
function isLegacyWebRtcStopMessage(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) && value.type === "webrtcStop";
  } catch {
    return false;
  }
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nativeViewerPeerId(clientId: number): string {
  return `ts-viewer-${clientId}`;
}

function parseNativeViewerPeerId(peerId: string): number | undefined {
  const match = /^ts-viewer-(\d+)$/.exec(peerId);
  if (!match) return undefined;
  return parseNumber(match[1]);
}

function buildTeamSpeakCommand(command: string, params: Record<string, string>): string {
  return [command, ...Object.entries(params).map(([key, value]) => `${key}=${escapeTeamSpeakValue(value)}`)].join(" ");
}

function parseStreamSignalPayload(raw: string): { cmd: string; args: Record<string, unknown> } | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.cmd !== "string" || !isRecord(value.args)) return null;
    return { cmd: value.cmd, args: value.args };
  } catch {
    return null;
  }
}

function toBrowserScreenSignal(payload: { cmd: string; args: Record<string, unknown> }): ScreenSharePeerSignal | null {
  const args = payload.args;
  // TeamSpeak's native screen-share source wraps the initial SDP in a
  // `joinResponse` message after it accepts a viewer's join request. The
  // browser-side protocol uses the regular offer shape, so normalize it here
  // before forwarding it. Without this mapping the native source can accept a
  // viewer while the browser waits forever for its first SDP.
  if (payload.cmd === "joinResponse") {
    const decision = args.decision;
    if (decision === false || decision === 0 || decision === "0") return { kind: "close" };
    const sdp = typeof args.offer === "string" ? args.offer : typeof args.sdp === "string" ? args.sdp : "";
    return sdp ? { kind: "offer", sdp } : null;
  }
  if (payload.cmd === "offer" || payload.cmd === "reconnectOffer") {
    const sdp = typeof args.offer === "string" ? args.offer : typeof args.sdp === "string" ? args.sdp : "";
    return sdp ? { kind: "offer", sdp } : null;
  }
  if (payload.cmd === "answer") {
    const sdp = typeof args.answer === "string" ? args.answer : typeof args.sdp === "string" ? args.sdp : "";
    return sdp ? { kind: "answer", sdp } : null;
  }
  if (payload.cmd === "iceCandidate") {
    const candidate = typeof args.sdp === "string" ? args.sdp : typeof args.candidate === "string" ? args.candidate : "";
    if (!candidate) return null;
    return {
      kind: "iceCandidate",
      candidate,
      ...(typeof args.mid === "string" ? { sdpMid: args.mid } : {}),
      ...(typeof args.mLine === "number" ? { sdpMLineIndex: args.mLine } : {}),
    };
  }
  return null;
}

function escapeTeamSpeakValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/\//g, "\\/")
    .replace(/\|/g, "\\p")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChannelRecord(value: unknown): value is { id: string; name: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { name?: unknown }).name === "string";
}

function createAudioFlowStats(): AudioFlowStats {
  return {
    ingressFrames: 0,
    ingressDroppedFrames: 0,
    ingressFirstAt: null,
    ingressLastAt: null,
    ingressMaxGapMs: 0,
    tsSendFrames: 0,
    tsSendErrors: 0,
    tsSendFirstAt: null,
    tsSendLastAt: null,
    tsSendMaxGapMs: 0,
    tsEncodeMaxMs: 0,
    tsReceiveFrames: 0,
    tsReceiveFirstAt: null,
    tsReceiveLastAt: null,
    tsReceiveMaxGapMs: 0,
    egressFrames: 0,
    egressDroppedFrames: 0,
    egressFirstAt: null,
    egressLastAt: null,
    egressMaxGapMs: 0,
    egressSentFirstAt: null,
    egressSentLastAt: null,
    egressSentMaxGapMs: 0,
    egressPeakBufferedBytes: 0,
    egressFramesByClient: {},
  };
}

function snapshotAudioStats(entry: WebClientEntry): AudioFlowStats {
  return { ...entry.audio };
}

function mapChannelTree(snapshot: TSDirectorySnapshot, avatarCache = new Map<string, string | null>()): unknown[] {
  return snapshot.channels.map((channel) => ({
    id: String(channel.id),
    parentID: String(channel.parentID),
    order: String(channel.order),
    name: channel.name || "未命名频道",
    description: channel.description || "",
    members: snapshot.clients
      .filter((client) => client.channelID === channel.id)
      .map((client) => {
        const avatar = client.uid ? avatarCache.get(client.uid) : undefined;
        return {
          id: client.id,
          nickname: client.nickname || "未知用户",
          uid: client.uid,
          ...(avatar ? { avatar } : {}),
          away: client.away,
          awayMessage: client.awayMessage,
          inputMuted: client.inputMuted,
          outputMuted: client.outputMuted,
          channelCommander: client.channelCommander,
        };
      }),
  }));
}

function avatarDataUrl(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return `data:image/png;base64,${data.toString("base64")}`;
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return `data:image/jpeg;base64,${data.toString("base64")}`;
  if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) return `data:image/gif;base64,${data.toString("base64")}`;
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return `data:image/webp;base64,${data.toString("base64")}`;
  return null;
}

function normalizeDirectorySnapshot(
  snapshot: TSDirectorySnapshot,
  selfId: number,
  selfChannelId: bigint,
  nickname: string,
  requestedChannelName?: string,
): TSDirectorySnapshot {
  if (selfId <= 0) return snapshot;

  const clients = snapshot.clients.slice();
  const selfIndex = clients.findIndex((client) => client.id === selfId);
  const snapshotChannelId = selfIndex >= 0 ? clients[selfIndex]!.channelID : 0n;
  const requestedName = requestedChannelName?.trim().toLocaleLowerCase();
  const requestedChannel = requestedName
    ? snapshot.channels.find((channel) => channel.name.trim().toLocaleLowerCase() === requestedName)
    : undefined;
  const resolvedChannelId = selfChannelId !== 0n
    ? selfChannelId
    : snapshotChannelId !== 0n
      ? snapshotChannelId
      : requestedChannel?.id ?? snapshot.channels[0]?.id ?? 0n;
  if (selfIndex >= 0) {
    const current = clients[selfIndex]!;
    if (resolvedChannelId !== 0n) clients[selfIndex] = { ...current, channelID: resolvedChannelId };
  } else if (resolvedChannelId !== 0n) {
    clients.push({ id: selfId, nickname, uid: "", channelID: resolvedChannelId, type: 1, serverGroups: [] });
  }

  return { ...snapshot, clients };
}
