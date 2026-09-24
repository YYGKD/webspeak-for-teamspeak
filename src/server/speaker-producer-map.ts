/**
 * S3 下行发布订阅模型：TS3 说话人 → mediasoup DirectTransport Producer。
 *
 * 背景（对应迁移规格 M4 / §5.3）：旧模型给每个浏览器会话预分配 K 条 audio m-line
 * 坑位，说话人只能在这 K 个坑位里轮换，超过 K 人就得淘汰。新模型废除预分配：
 * **每个说话人动态创建一条 DirectTransport + 一个 Producer**，浏览器按
 * `clientId ↔ producerId ↔ consumerId` 动态订阅。人数不再受 m-line 数限制，
 * 只受这里的上限护栏约束。
 *
 * 设计要点：
 *
 * 1. **首帧不丢**：TS3 `voiceData` 首帧到达时才创建 DirectTransport/Producer，
 *    同一个异步调用里等待创建完成、立刻 `producer.send()` 把首帧注入 Router，
 *    首包 `marker=1`。绝不做"先丢弃若干帧等资源就绪"的处理。
 * 2. **Opus 帧长解析**：`opusPacketSamples` 按 Opus TOC 解析
 *    真实帧长，保留 60ms 音乐帧（samples=2880）修正 —— 写死 20ms 会让音乐流
 *    RTP 时间轴慢 3 倍，接收端 jitter buffer 只能不断丢样追赶，听感一断一续。
 * 3. **上限护栏**：默认 32，`WEBSPEAK_MAX_SPEAKERS` 覆盖（1–64）。到达上限时
 *    淘汰最久未活跃的说话人，并向其浏览器广播 `speakerProducerClosed`（reason
 *    `evicted`）。这是硬护栏；常态回收走 2000ms idle 定时器（reason `idle`）。
 * 4. **资源自持有**：每条 DirectTransport 只承载一个 Producer，close 时先关
 *    Producer 再关 Transport，避免 Router 上残留半关闭的 transport。
 */
import { randomInt } from "node:crypto";
import type { DirectTransport, Producer, Router } from "mediasoup/types";
import type { SpeakerProducerCloseReason } from "./voice-protocol.js";

/** 48kHz 下每毫秒的采样数。 */
const SAMPLES_PER_MS = 48;
/** Opus 单包采样数上下限（RFC 6716：单帧 2.5～60ms，单包最多 2 帧）。 */
const MIN_PACKET_SAMPLES = 120;
const MAX_PACKET_SAMPLES = 5760;
/** 解析不出 TOC 时的回落值：20ms @ 48kHz。 */
const FALLBACK_FRAME_SAMPLES = 960;

/**
 * Opus 的 config → 每帧时长（毫秒），RFC 6716 §3.1。
 *
 * TeamSpeak 的 codec 5（Opus Music）用 60ms 帧，codec 4（Opus Voice）用 20ms。
 * 时间戳增量必须按真实帧长推进：写死 20ms 会让音乐流的 RTP 时间轴慢 3 倍，
 * 接收端 jitter buffer 只能不断"加速/丢样"追赶，听感就是一断一续。
 */
const OPUS_FRAME_MS: readonly number[] = [
  10, 20, 40, 60, //  0-3   SILK 窄带
  10, 20, 40, 60, //  4-7   SILK 中带
  10, 20, 40, 60, //  8-11  SILK 宽带
  10, 20, // 12-13 混合 超宽带
  10, 20, // 14-15 混合 全带
  2.5, 5, 10, 20, // 16-19 CELP 窄带
  2.5, 5, 10, 20, // 20-23 CELP 中带
  2.5, 5, 10, 20, // 24-27 CELP 超宽带
  2.5, 5, 10, 20, // 28-31 CELP 全带
];

/**
 * 一个 Opus 包实际携带的采样数（48kHz）。
 *
 * TOC 字节：高 5 位 config 决定每帧时长，低 2 位是帧数代码
 * （0=1 帧、1=2 帧、2=2 帧、3=1 帧）。解析不出来时回落到 20ms，
 * 保持旧行为，不会让异常包得到更糟的结果。
 *
 * 60ms 音乐帧：config 3/7/11 命中 OPUS_FRAME_MS 的 60，samples = 60 × 48 = 2880。
 * 这正是"音乐流时间轴慢 3 倍"那个历史缺陷的修正点，平移时逐字保留。
 */
export function opusPacketSamples(payload: Buffer): number {
  if (payload.length < 1) return FALLBACK_FRAME_SAMPLES;
  const toc = payload[0] as number;
  const config = toc >> 3;
  const frameCode = toc & 0b11;
  const frames = frameCode === 0 || frameCode === 3 ? 1 : 2;
  const frameMs = OPUS_FRAME_MS[config];
  if (frameMs === undefined) return FALLBACK_FRAME_SAMPLES;
  const samples = Math.round(frameMs * SAMPLES_PER_MS) * frames;
  if (samples < MIN_PACKET_SAMPLES || samples > MAX_PACKET_SAMPLES) return FALLBACK_FRAME_SAMPLES;
  return samples;
}

/** 说话人上限环境变量（1–64，缺省 32）。 */
export const MAX_SPEAKERS_ENV = "WEBSPEAK_MAX_SPEAKERS";
export const DEFAULT_MAX_SPEAKERS = 32;
export const MIN_MAX_SPEAKERS = 1;
export const MAX_MAX_SPEAKERS = 64;

/** 说话人静默多久后回收其 Producer。取值远大于一帧（20ms），不会误杀说话中的人。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 2_000;

/** DirectTransport 的消息上限（与旧链路 4KB 背压护栏同量级，这里只做显式声明）。 */
export const DIRECT_TRANSPORT_MAX_SEND_MESSAGE_SIZE = 2_048;

const OPUS_PAYLOAD_TYPE = 111;
const OPUS_CLOCK_RATE = 48_000;
const OPUS_CHANNELS = 2;
const RTP_HEADER_BYTES = 12;

/**
 * 解析说话人上限。非法值（非整数 / 越界）回落到默认值，与既有的
 * 环境变量解析约定一致。
 */
export function resolveMaxSpeakers(raw: string | undefined = process.env[MAX_SPEAKERS_ENV]): number {
  const trimmed = raw?.trim();
  const value = trimmed ? Number(trimmed) : DEFAULT_MAX_SPEAKERS;
  return Number.isInteger(value) && value >= MIN_MAX_SPEAKERS && value <= MAX_MAX_SPEAKERS ? value : DEFAULT_MAX_SPEAKERS;
}

/** 一个说话人的下行发布资源。 */
export interface SpeakerProducerEntry {
  readonly clientId: number;
  readonly transport: DirectTransport;
  readonly producer: Producer;
  /** 首个 RTP 包的序号 —— marker=1 只在它上面置位。 */
  readonly firstSequenceNumber: number;
  /** 下一帧将使用的序号。 */
  sequenceNumber: number;
  /** 下一帧将使用的时间戳。 */
  timestamp: number;
  readonly ssrc: number;
  lastActiveAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface SpeakerProducerMapOptions {
  /** 说话人上限；缺省 `WEBSPEAK_MAX_SPEAKERS` 或 32。 */
  maxSpeakers?: number;
  /** 静默回收阈值；缺省 2000ms。 */
  idleTimeoutMs?: number;
  /** 序号起点（测试用；缺省随机）。 */
  initialSequenceNumber?: number;
  /** 时间戳起点（测试用；缺省随机）。 */
  initialTimestamp?: number;
  /** 新建说话人 Producer 时回调，服务端据此向浏览器下发 `newSpeakerProducer`。 */
  onNewSpeakerProducer?: (clientId: number, producerId: string) => void;
  /** 说话人 Producer 关闭时回调，服务端据此下发 `speakerProducerClosed`。 */
  onSpeakerProducerClosed?: (clientId: number, producerId: string, reason: SpeakerProducerCloseReason) => void;
}

/**
 * 说话人 → DirectTransport Producer 的动态映射。
 *
 * 每个浏览器会话持有一份（注入该会话的 Router）。`ingest()` 收到某说话人的
 * 首帧时按需创建资源；后续帧复用同一个 Producer，只推进序号与时间戳。
 */
export class SpeakerProducerMap {
  private readonly entries = new Map<number, SpeakerProducerEntry>();
  /** 正在创建中的说话人（首帧等待 DirectTransport/Producer 落地）。 */
  private readonly pending = new Map<number, Promise<SpeakerProducerEntry | null>>();
  /**
   * 创建过程中被 remove()/clear() 取消的说话人。
   * 只记录"确有创建在途"的 clientId，因此集合大小有界，不会随成员进出无限增长。
   */
  private readonly cancelled = new Set<number>();
  private readonly maxSpeakers: number;
  private readonly idleTimeoutMs: number;
  private readonly initialSequenceNumber: number;
  private readonly initialTimestamp: number;

  constructor(
    private readonly router: Router,
    private readonly options: SpeakerProducerMapOptions = {},
  ) {
    this.maxSpeakers = options.maxSpeakers ?? resolveMaxSpeakers();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.initialSequenceNumber = options.initialSequenceNumber ?? randomInt(0, 65_536);
    this.initialTimestamp = options.initialTimestamp ?? randomInt(0, 0x1_0000_0000) >>> 0;
  }

  /**
   * 处理一帧来自 TeamSpeak 的语音。
   *
   * 首帧会等待 DirectTransport/Producer 创建完成后立刻注入 Router（首帧不丢）；
   * 后续帧同步 `producer.send()`。达到上限且无法腾位时该帧被丢弃（返回后无副作用）。
   */
  async ingest(clientId: number, opusFrame: Buffer): Promise<void> {
    const entry = await this.ensureEntry(clientId);
    if (!entry) return;

    entry.lastActiveAt = Date.now();
    this.armIdleTimer(entry);
    entry.producer.send(packetizeOpusFrame(entry, opusFrame));
  }

  /**
   * 关闭并移除一个说话人。
   *
   * 成员离开频道用 `closed`，idle 定时器用 `idle`，上限淘汰用 `evicted`。
   * 不存在的说话人是无操作（除非确有创建在途，此时取消它）。
   */
  remove(clientId: number, reason: SpeakerProducerCloseReason): void {
    const entry = this.entries.get(clientId);
    if (!entry) {
      if (this.pending.has(clientId)) this.cancelled.add(clientId);
      return;
    }
    this.entries.delete(clientId);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const producerId = entry.producer.id;
    // 先关 Producer 再关 Transport：Transport.close() 会连带关闭其 Producer，
    // 顺序反过来只是让 close() 变成幂等空操作，但显式关闭能保证回调时序确定。
    try { entry.producer.close(); } catch { /* 幂等 */ }
    try { entry.transport.close(); } catch { /* 幂等 */ }
    this.options.onSpeakerProducerClosed?.(clientId, producerId, reason);
  }

  /** 清空全部说话人并释放所有 DirectTransport/Producer（会话结束 / 重连重置）。 */
  clear(): void {
    for (const clientId of [...this.entries.keys()]) this.remove(clientId, "cleared");
    // 创建在途的说话人也要取消，否则它们的 Producer 会在 clear() 之后"复活"。
    for (const clientId of [...this.pending.keys()]) this.cancelled.add(clientId);
  }

  /** 当前在册说话人数。 */
  get size(): number {
    return this.entries.size;
  }

  has(clientId: number): boolean {
    return this.entries.has(clientId);
  }

  /** 说话人当前的下行 Producer id。 */
  producerIdOf(clientId: number): string | undefined {
    return this.entries.get(clientId)?.producer.id;
  }

  /** clientId → producerId 快照（观测/调试用）。 */
  snapshot(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [clientId, entry] of this.entries) map[String(clientId)] = entry.producer.id;
    return map;
  }

  /** 上限护栏：腾出一个位子（淘汰最久未活跃者）。 */
  private enforceLimit(): void {
    while (this.entries.size + this.pending.size >= this.maxSpeakers) {
      const victim = this.leastRecentlyActive();
      // 在册的全被淘汰完仍腾不出位子（剩下的都是创建在途的）：拒绝新说话人。
      if (!victim) return;
      this.remove(victim.clientId, "evicted");
    }
  }

  private leastRecentlyActive(): SpeakerProducerEntry | null {
    let victim: SpeakerProducerEntry | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.lastActiveAt < oldest) {
        oldest = entry.lastActiveAt;
        victim = entry;
      }
    }
    return victim;
  }

  private ensureEntry(clientId: number): Promise<SpeakerProducerEntry | null> {
    const existing = this.entries.get(clientId);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(clientId);
    if (inflight) return inflight;

    // 新说话人：先腾位再创建。occupancy 把创建在途的也算进去，避免 33 个人
    // 同时开口时各自看到"还没满"而一起创建、把上限冲破。
    this.enforceLimit();
    if (this.entries.size + this.pending.size >= this.maxSpeakers) return Promise.resolve(null);

    const promise = this.createEntry(clientId).finally(() => {
      if (this.pending.get(clientId) === promise) this.pending.delete(clientId);
    });
    this.pending.set(clientId, promise);
    return promise;
  }

  private async createEntry(clientId: number): Promise<SpeakerProducerEntry | null> {
    let transport: DirectTransport | null = null;
    try {
      transport = await this.router.createDirectTransport({
        maxSendMessageSize: DIRECT_TRANSPORT_MAX_SEND_MESSAGE_SIZE,
        appData: { clientId },
      });
      if (this.cancelled.delete(clientId)) {
        closeQuietly(transport);
        return null;
      }
      const ssrc = randomInt(1, 0xffff_ffff);
      const producer = await transport.produce({
        kind: "audio",
        rtpParameters: {
          codecs: [{ mimeType: "audio/opus", clockRate: OPUS_CLOCK_RATE, channels: OPUS_CHANNELS, payloadType: OPUS_PAYLOAD_TYPE }],
          encodings: [{ ssrc }],
          rtcp: { cname: `speaker-${clientId}`, reducedSize: true },
        },
        appData: { clientId },
      });
      if (this.cancelled.delete(clientId)) {
        closeQuietly(producer);
        closeQuietly(transport);
        return null;
      }
      const entry: SpeakerProducerEntry = {
        clientId,
        transport,
        producer,
        firstSequenceNumber: this.initialSequenceNumber,
        sequenceNumber: this.initialSequenceNumber,
        timestamp: this.initialTimestamp,
        ssrc,
        lastActiveAt: Date.now(),
        idleTimer: null,
      };
      this.entries.set(clientId, entry);
      this.armIdleTimer(entry);
      this.options.onNewSpeakerProducer?.(clientId, producer.id);
      return entry;
    } catch {
      // Worker 崩溃 / Router 已关闭：本轮创建失败，清理半成品，下一帧自然重试。
      if (transport) closeQuietly(transport);
      return null;
    }
  }

  private armIdleTimer(entry: SpeakerProducerEntry): void {
    if (this.idleTimeoutMs <= 0) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.remove(entry.clientId, "idle");
    }, this.idleTimeoutMs);
    // 定时器不应阻止进程退出。
    entry.idleTimer.unref?.();
  }
}

/** 一个说话人的 RTP 打包状态（`SpeakerProducerEntry` 结构上满足它）。 */
export interface OpusRtpPacketizerState {
  /** 首个 RTP 包的序号 —— marker=1 只在它上面置位。 */
  readonly firstSequenceNumber: number;
  /** 下一帧将使用的序号。 */
  sequenceNumber: number;
  /** 下一帧将使用的时间戳。 */
  timestamp: number;
  readonly ssrc: number;
}

/**
 * 把一个 Opus 帧封成 RTP 报文，并推进序号与时间戳。
 *
 * 手工组包（不依赖任何第三方 RTP 实现）：这里只需要 12 字节定长头，
 * 自己写反而更少意外。
 *
 * marker 只在每个说话人的第一帧置位。RTP 里 marker 表示"一段话的开始"，
 * 逐帧都置位会让接收端 jitter buffer 不断判定新话段开始、迟迟不进入稳定
 * 播放，表现为"收得到包但解码器不吐采样"。
 */
export function packetizeOpusFrame(state: OpusRtpPacketizerState, opusFrame: Buffer): Buffer {
  const marker = state.sequenceNumber === state.firstSequenceNumber;
  const packet = Buffer.allocUnsafe(RTP_HEADER_BYTES + opusFrame.length);
  packet[0] = 0x80; // V=2，无 padding / extension / CSRC
  packet[1] = (marker ? 0x80 : 0) | OPUS_PAYLOAD_TYPE;
  packet.writeUInt16BE(state.sequenceNumber, 2);
  packet.writeUInt32BE(state.timestamp >>> 0, 4);
  packet.writeUInt32BE(state.ssrc, 8);
  opusFrame.copy(packet, RTP_HEADER_BYTES);
  state.sequenceNumber = (state.sequenceNumber + 1) & 0xffff;
  state.timestamp = (state.timestamp + opusPacketSamples(opusFrame)) >>> 0;
  return packet;
}

function closeQuietly(resource: { close(): void } | null): void {
  try { resource?.close(); } catch { /* 幂等 */ }
}
