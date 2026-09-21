import { createHmac } from "node:crypto";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  useAbsSendTime,
  useAudioLevelIndication,
  useOPUS,
  usePCMU,
  useSdesMid,
  useTransportWideCC,
} from "werift";
import type { Logger as LoggerType } from "../logger.js";
import { WEBRTC_UDP_PORT_RANGE, resolveTurnConfig } from "./webrtc-config.js";
import type { SpeakerStream } from "./speaker-registry.js";

export { DEFAULT_WEBRTC_UDP_PORT_RANGE, WEBRTC_UDP_PORT_RANGE } from "./webrtc-config.js";

const DEFAULT_WEBRTC_OPUS_PAYLOAD_TYPE = 111;

/**
 * 音频编解码器的 RTCP 反馈。
 *
 * werift 的 useOPUS 定义里**没有** rtcpFeedback（视频编解码器都带
 * useNACK/usePLI/useREMB），因此生成的 SDP 不含 a=rtcp-fb，对端也就不会发
 * NACK —— 而 werift 的 NACK 重传实现（rtpCache + onGenericNack）是现成的，
 * 只是从来没被触发过。这里显式补上，SDP 里才会声明，重传才真正生效。
 */
const AUDIO_RTCP_FEEDBACK: Array<{ type: string; parameter?: string }> = [
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "goog-remb" },
  { type: "transport-cc" },
];

/**
 * STUN 服务器地址。默认是公共 STUN，生产部署应通过 WEBSPEAK_STUN_URLS
 * 指向自建 STUN（逗号分隔），这样源码里不出现部署相关的 IP。
 *
 * 浏览器需要靠 STUN 发现自己的公网映射地址（srflx candidate）；没有它，
 * 移动网络与对称 NAT 下会连不上并静默回退到 WS 兼容通道。
 * 服务端因为已经显式广告了公网 IP，STUN 对它只是冗余的 srflx 补充。
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
 * 为一次下发签发 TURN 临时凭据（coturn 的 REST API 方案）。
 *
 * username   = "<过期 unix 秒>:<标识>"
 * credential = base64(HMAC-SHA1(static-auth-secret, username))
 *
 * coturn 收到后会自己算一遍 HMAC 并检查时间戳，所以既不需要在服务端存用户表，
 * 也不会有长期有效的密码流出去。见 webrtc-config.ts 里 resolveTurnConfig 的说明。
 */
function buildTurnCredentials(secret: string, ttlSeconds: number): { username: string; credential: string } {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:webspeak`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

/**
 * 下发给浏览器的完整 ICE 配置：STUN + （配置了的话）TURN。
 *
 * 每次调用都重新签发 TURN 凭据 —— 调用方（/api/public-config）已设 no-store，
 * 每个页面加载拿到的是新鲜凭据。
 *
 * 纯 STUN 只能让浏览器发现自己的公网映射；对称 NAT 或 UDP 被封的网络下没有
 * 可用候选对，只能回退到 WS 兼容通道（延迟与音质下降）。TURN 就是给这类
 * 网络兜底的中继。
 */
export function resolveIceServers(): IceServerConfig[] {
  const servers: IceServerConfig[] = resolveStunUrls().map((urls) => ({ urls: [urls] }));
  const turn = resolveTurnConfig();
  if (turn) servers.push({ urls: turn.urls, ...buildTurnCredentials(turn.secret, turn.ttlSeconds) });
  return servers;
}

export interface WebRtcAudioOptions {
  enabled: boolean;
  udpPortRange?: [number, number];
  /** 预分配的音频 slot 数。slot 复用不触发重协商，见 speaker-registry.ts。 */
  slotCount?: number;
}

export interface WebRtcSessionDescription {
  type: "offer" | "answer";
  sdp: string;
  muted?: boolean;
  accompanimentActive?: boolean;
}

export interface WebRtcAudioSessionOptions {
  connectionId: string;
  publicHost?: string;
  udpPortRange?: [number, number];
  slotCount: number;
  logger: LoggerType;
  microphoneMuted?: boolean;
  accompanimentActive?: boolean;
  onVoiceFrame: (data: Buffer, codec: 4 | 5) => void;
}

export interface WebRtcAudioStats {
  webrtcIngressRtpFrames: number;
  webrtcIngressRtpFirstAt: number | null;
  webrtcIngressRtpLastAt: number | null;
  webrtcIngressRtpMaxGapMs: number;
  webrtcEgressRtpFrames: number;
  webrtcEgressRtpFirstAt: number | null;
  webrtcEgressRtpLastAt: number | null;
  webrtcEgressRtpMaxGapMs: number;
  webrtcEgressDroppedFrames: number;
  /** 当前被分配到 slot 的说话人数（≤ slotCount）。 */
  webrtcSlotsActive: number;
}

/** sender 的最小接口 —— 只用到 werift RTCRtpSender 的这两个方法。 */
interface SlotSender {
  sendRtp(rtp: Buffer): Promise<void>;
  replaceRTP(
    rtp: { sequenceNumber: number; timestamp: number },
    discontinuity?: boolean,
  ): void;
}

/**
 * 一个浏览器连接的下行转发器（SFU 订阅端）。
 *
 * 与旧的混音器不同，这里不做任何编解码：TeamSpeak 给出的每个说话人的 Opus
 * 帧由 SpeakerRegistry 打成 RTP，本类只负责把它交给对应 slot 的 sender。
 * werift 的 sendRtp 负责 SSRC 覆盖、序号/时间戳重定位、SRTP 加密、NACK
 * 重传缓存与带宽估计，因此这里没有采样级处理。
 *
 * slot 在协商时就全部谈好，说话人进出只改变 slot 归属（assignSlot），
 * 不触发重协商。
 *
 * 说话人活动指示（UI 的"正在说话"）不在服务端计算 —— SFU 不解码，
 * 由浏览器侧对每路 track 做能量分析，见 useVoiceWebSocket.ts。
 */
export class WebRtcAudioSession {
  readonly peer: RTCPeerConnection;
  private readonly logger: LoggerType;
  private readonly onVoiceFrame: (data: Buffer, codec: 4 | 5) => void;
  private readonly outgoingTrack: MediaStreamTrack;
  private readonly senders: SlotSender[] = [];
  private readonly opusPayloadTypes = new Set<number>();
  private closed = false;
  private negotiated = false;
  private lastIngressRtpAt: number | null = null;
  private lastEgressRtpAt: number | null = null;
  private microphoneMuted: boolean;
  private accompanimentActive: boolean;
  private readonly stats: WebRtcAudioStats = {
    webrtcIngressRtpFrames: 0,
    webrtcIngressRtpFirstAt: null,
    webrtcIngressRtpLastAt: null,
    webrtcIngressRtpMaxGapMs: 0,
    webrtcEgressRtpFrames: 0,
    webrtcEgressRtpFirstAt: null,
    webrtcEgressRtpLastAt: null,
    webrtcEgressRtpMaxGapMs: 0,
    webrtcEgressDroppedFrames: 0,
    webrtcSlotsActive: 0,
  };

  constructor(options: WebRtcAudioSessionOptions) {
    this.logger = options.logger.child({ component: "webrtc-audio", connectionId: options.connectionId });
    this.onVoiceFrame = options.onVoiceFrame;
    this.microphoneMuted = options.microphoneMuted === true;
    this.accompanimentActive = options.accompanimentActive === true;
    this.outgoingTrack = new MediaStreamTrack({ kind: "audio" });

    const iceAdditionalHostAddresses = options.publicHost ? [options.publicHost] : undefined;
    const udpPortRange = options.udpPortRange ?? WEBRTC_UDP_PORT_RANGE;
    this.peer = new RTCPeerConnection({
      iceServers: resolveIceServers(),
      // 必须在 PeerConfig 里给音频编解码器带上 rtcpFeedback：协商时
      // transceiver 的 codecs 会被"远端 codecs ∩ 本地 config codecs"覆盖
      // （transceiverManager.js），构造后再改 transceiver 是无效的。
      codecs: {
        audio: [
          // channels 必须是 1：TeamSpeak 的语音是单声道，而 werift 的 useOPUS 默认
          // 声明 stereo（opus/48000/2）。
          useOPUS({
            channels: 1,
            rtcpFeedback: AUDIO_RTCP_FEEDBACK.map((feedback) => ({ ...feedback })),
          }),
          usePCMU(),
        ],
      },
      /**
       * 必须显式声明 RTP 头扩展。
       *
       * werift 的 generateDefaultPeerConfig() 把 headerExtensions 默认设为空数组，
       * 而协商逻辑是"远端扩展 ∩ 本地 config"（transceiverManager.js）—— 空数组会把
       * 浏览器 offer 里的 a=extmap 全部过滤掉，answer 里一条 extmap 都不剩。
       *
       * 后果：8 条 m-line 通过 a=group:BUNDLE 复用同一条传输，而接收端要靠
       * sdes:mid 扩展头把 RTP 分派到对应的 m-line。缺了 MID，Chrome 会直接丢弃
       * 全部下行 RTP —— 表现为"服务端在发、werift 对端收得到、浏览器收不到"。
       */
      headerExtensions: {
        audio: [useSdesMid(), useTransportWideCC(), useAbsSendTime(), useAudioLevelIndication()],
        video: [],
      },
      iceUseIpv4: true,
      iceUseIpv6: false,
      /**
       * 允许 ICE over TCP。
       *
       * 默认 false 时服务端只广告 UDP 候选；对端在"UDP 被封但 TCP 放行"的网络里
       * 就连不上（只能回退到 WS 兼容通道）。开着它，werift 的 ICE gatherer 会额外
       * 在 icePortRange 内监听 TCP 并广告 TCP 候选，浏览器侧的 ICE-TCP 可以直接连上。
       *
       * 前提：安全组要同时放行 **TCP** 40000-40099。没放行也不会更糟 —— 那几条
       * TCP 候选连不上，ICE 会退回 UDP 候选，只是多几个无效候选对要试。
       */
      iceUseTcp: true,
      icePortRange: [...udpPortRange] as [number, number],
      ...(iceAdditionalHostAddresses ? { iceAdditionalHostAddresses } : {}),
    });

    // 一次性把 K 个音频 slot 全部谈好。slot0 用 sendrecv 承载上行麦克风，
    // 其余只发不收 —— 这样 K 个说话人可以同时转发而不需要重协商。
    for (let slot = 0; slot < options.slotCount; slot++) {
      const transceiver = this.peer.addTransceiver("audio", {
        direction: slot === 0 ? "sendrecv" : "sendonly",
      });
      this.senders.push(transceiver.sender as unknown as SlotSender);
    }

    // 上行：浏览器 → 网关。取出 RTP payload 原样交给 TeamSpeak，不做任何处理。
    const uplink = this.peer.getTransceivers()[0];
    uplink?.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        if (this.closed) return;
        const receivedAt = performance.now();
        if (this.lastIngressRtpAt !== null) {
          this.stats.webrtcIngressRtpMaxGapMs = Math.max(
            this.stats.webrtcIngressRtpMaxGapMs,
            Math.round(receivedAt - this.lastIngressRtpAt),
          );
        }
        this.lastIngressRtpAt = receivedAt;
        this.stats.webrtcIngressRtpFirstAt ??= Date.now();
        this.stats.webrtcIngressRtpLastAt = Date.now();
        this.stats.webrtcIngressRtpFrames++;
        if (!this.opusPayloadTypes.has(rtp.header.payloadType)) return;
        // 静音麦克风必须在网关处切断上行：浏览器的 track.enabled/gain 改动
        // 仍可能产生舒适噪声 RTP，转发过去会让 TeamSpeak 认为用户还在说话。
        if (this.microphoneMuted && !this.accompanimentActive) return;
        this.onVoiceFrame(Buffer.from(rtp.payload), this.accompanimentActive ? 5 : 4);
      });
    });

    this.peer.onconnectionstatechange = () => {
      this.logger.info({ state: this.peer.connectionState }, "WebRTC connection state changed");
    };
  }

  get slotCount(): number {
    return this.senders.length;
  }

  getStats(): WebRtcAudioStats {
    return { ...this.stats };
  }

  async createAnswer(offer: WebRtcSessionDescription): Promise<WebRtcSessionDescription> {
    if (this.closed) throw new Error("WebRTC session is closed");
    this.setOpusPayloadTypes(offer.sdp);
    await this.peer.setRemoteDescription(offer);

    for (const transceiver of this.peer.getTransceivers()) {
      if (transceiver.kind !== "audio") continue;
      await transceiver.sender.replaceTrack(this.outgoingTrack).catch((error: unknown) => {
        this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Could not attach WebRTC output track");
      });
    }

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    const description = this.peer.localDescription;
    if (!description) throw new Error("WebRTC answer was not created");
    if (description.type !== "answer" && description.type !== "offer") throw new Error("Unexpected WebRTC answer type");
    this.negotiated = true;
    // 诊断：确认发送侧是否真的会写 MID 扩展头。
    // BUNDLE 下接收端靠 MID 分派 RTP；answer 声明了 MID 但包里没有的话，
    // 浏览器会计数收包却无法把包交给解码器（totalSamplesReceived 恒为 0）。
    const probe = (this.peer.getTransceivers()[0]?.sender ?? null) as unknown as
      { mid?: string; headerExtensions?: Array<{ id: number; uri: string }> } | null;
    this.logger.info({
      slotCount: this.senders.length,
      senderMid: probe?.mid ?? null,
      headerExtensions: (probe?.headerExtensions ?? []).map((e) => `${e.id}:${e.uri}`),
      answerExtmap: description.sdp.split("\n").filter((l) => l.startsWith("a=extmap:")).slice(0, 5),
    }, "WebRTC 协商完成：发送侧扩展头状态");
    return { type: description.type, sdp: description.sdp };
  }

  /**
   * 把某个 slot 的归属切换到新的说话人。
   *
   * slot 被复用时序号/时间戳会跳变，用 replaceRTP 重定位到新说话人的当前
   * 进度，避免对端 jitter buffer 把跳变当成丢包。
   * 只在归属真正变化时调用 —— 对未换源的 sender 调用会重复上一个序号。
   *
   * discontinuity 必须传 false：werift 0.24.4 的 replaceRTP 在
   * discontinuity=true 时用 uint16Add 去加 32 位时间戳偏移
   * （rtpSender.js: `this.timestampOffset = uint16Add(this.timestampOffset, 1)`），
   * 会把高 16 位直接抹掉 —— 实测偏移 0x92345678 变成 0x5679，换源后首包的
   * 时间戳跳变可达数万秒，对端 jitter buffer 当场失稳。上游 issue #677 已确认
   * 该缺陷且 0.24.4 未修。传 false 得到的是正确的 32 位偏移。
   *
   * 代价：首包会与上一包同序号（对端按重复包丢弃，损失 20ms 一帧），
   * 之后序号与时间戳都连续。这比"时间戳跳变几万秒"好得多。
   */
  assignSlot(slot: number, stream: SpeakerStream): void {
    const sender = this.senders[slot];
    if (!sender) return;
    sender.replaceRTP({
      sequenceNumber: stream.nextSequenceNumber,
      timestamp: stream.nextTimestamp,
    }, false);
  }

  /** 转发一个说话人的一帧到指定 slot。 */
  forward(slot: number, rtp: Buffer): void {
    if (this.closed || !this.negotiated) return;
    const sender = this.senders[slot];
    if (!sender) {
      this.stats.webrtcEgressDroppedFrames++;
      return;
    }
    // sendRtp 内部要等 DTLS 加密完成，但帧本身必须按序入队；不 await，
    // 避免 20ms 节拍被加密耗时拖住。werift 保证同一 sender 的顺序。
    void sender.sendRtp(rtp).catch(() => {
      this.stats.webrtcEgressDroppedFrames++;
    });
    const sentAt = performance.now();
    if (this.lastEgressRtpAt !== null) {
      this.stats.webrtcEgressRtpMaxGapMs = Math.max(
        this.stats.webrtcEgressRtpMaxGapMs,
        Math.round(sentAt - this.lastEgressRtpAt),
      );
    }
    this.lastEgressRtpAt = sentAt;
    this.stats.webrtcEgressRtpFirstAt ??= Date.now();
    this.stats.webrtcEgressRtpLastAt = Date.now();
    this.stats.webrtcEgressRtpFrames++;
  }

  setSlotStats(active: number): void {
    this.stats.webrtcSlotsActive = active;
  }

  setMicrophoneMuted(muted: boolean): void {
    this.microphoneMuted = muted;
  }

  setAccompanimentActive(active: boolean): void {
    this.accompanimentActive = active;
  }

  /**
   * SFU 模式下成员音量在浏览器侧应用（每个 slot 一个 GainNode），服务端
   * 不再参与混音。保留此方法只为协议兼容。
   */
  setMemberVolume(_clientId: number, _volume: number): void {
    // 故意为空。
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.outgoingTrack.stop();
    await this.peer.close();
  }

  private setOpusPayloadTypes(sdp: string): void {
    this.opusPayloadTypes.clear();
    for (const match of sdp.matchAll(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?/gim)) {
      const payloadType = Number(match[1]);
      if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) continue;
      this.opusPayloadTypes.add(payloadType);
    }
    if (!this.opusPayloadTypes.size) this.opusPayloadTypes.add(DEFAULT_WEBRTC_OPUS_PAYLOAD_TYPE);
  }
}
