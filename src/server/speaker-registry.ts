import { randomInt } from "node:crypto";
import { RtpHeader, RtpPacket } from "werift";

/** 与 webrtc-audio.ts 的 AUDIO_FRAME_SAMPLES 一致：20ms @ 48kHz。 */
const AUDIO_FRAME_SAMPLES = 960;
const DEFAULT_WEBRTC_OPUS_PAYLOAD_TYPE = 111;

/** 48kHz 下每毫秒的采样数。 */
const SAMPLES_PER_MS = 48;
/** Opus 单包采样数上下限（RFC 6716：单帧 2.5～60ms，单包最多 2 帧）。 */
const MIN_PACKET_SAMPLES = 120;
const MAX_PACKET_SAMPLES = 5760;

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
 */
export function opusPacketSamples(payload: Buffer): number {
  if (payload.length < 1) return AUDIO_FRAME_SAMPLES;
  const toc = payload[0] as number;
  const config = toc >> 3;
  const frameCode = toc & 0b11;
  const frames = frameCode === 0 || frameCode === 3 ? 1 : 2;
  const frameMs = OPUS_FRAME_MS[config];
  if (frameMs === undefined) return AUDIO_FRAME_SAMPLES;
  const samples = Math.round(frameMs * SAMPLES_PER_MS) * frames;
  if (samples < MIN_PACKET_SAMPLES || samples > MAX_PACKET_SAMPLES) return AUDIO_FRAME_SAMPLES;
  return samples;
}

/**
 * slot 用尽时，只有静默超过这个时长的说话人才会被淘汰。
 * 取值远大于一帧（20ms），这样"大家都在说"时不会每帧互相挤。见 acquireSlot。
 */
const EVICT_IDLE_MS = 2_000;

/**
 * 一个说话人的 RTP 生成器。
 *
 * TeamSpeak 交给网关的是每个说话人的裸 Opus 帧，这里把它们打成 RTP。
 * 同一个说话人的每一帧会被同一个连接里的多个 slot sender 复用，所以
 * packetize 必须返回 Buffer 而不是 RtpPacket —— werift 的 sendRtp 会就地
 * 改写 header（ssrc / seq / timestamp），同一个对象喂给第二个 sender 会在
 * 已偏移的值上再加一次偏移。
 */
export class SpeakerStream {
  private sequenceNumber = randomInt(0, 65_536);
  private readonly firstSequenceNumber = this.sequenceNumber;
  private timestamp = randomInt(0, 0x1_0000_0000) >>> 0;
  private lastActiveAt = Date.now();

  constructor(readonly clientId: number) {}

  /** 产出可跨 sender 复用的 RTP Buffer，并推进序号与时间戳。 */
  packetize(opus: Buffer): Buffer {
    const packet = new RtpPacket(new RtpHeader({
      payloadType: DEFAULT_WEBRTC_OPUS_PAYLOAD_TYPE,
      sequenceNumber: this.sequenceNumber,
      timestamp: this.timestamp,
      // sendRtp 会用 sender 自己的 SSRC 覆盖这里，占位即可。
      ssrc: 0,
      // marker 只在每个说话人的第一帧置位。RTP 里 marker 表示"一段话的开始"，
      // 逐帧都置位会让接收端的 jitter buffer 不断判定新话段开始、迟迟不进入
      // 稳定播放，表现为"收得到包但解码器不吐采样"。
      marker: this.sequenceNumber === this.firstSequenceNumber,
    }), opus);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    this.timestamp = (this.timestamp + opusPacketSamples(opus)) >>> 0;
    this.lastActiveAt = Date.now();
    return packet.serialize();
  }

  get lastActive(): number {
    return this.lastActiveAt;
  }

  /** 下一帧将使用的序号 —— 换源时交给 sender.replaceRTP 做连续性重定位。 */
  get nextSequenceNumber(): number {
    return this.sequenceNumber;
  }

  /** 下一帧将使用的时间戳，同上。 */
  get nextTimestamp(): number {
    return this.timestamp;
  }
}

export interface IngestResult {
  slot: number;
  rtp: Buffer;
}

/**
 * 说话人 → slot 的分配器 + RTP 生成器。
 *
 * 每个浏览器会话（WebClientEntry）持有一份：会话内 slot 是预分配的固定数量，
 * 说话人进出只改变 slot 的归属，不触发重协商。
 *
 * 分配策略：首次收到某人的语音时分配一个空闲 slot；之后保持粘性（避免频繁
 * 换源带来的断流），成员离开频道或静默超过 idleReleaseMs 才回收。slot 用尽时
 * 淘汰最久未活跃的说话人。
 */
export class SpeakerRegistry {
  private readonly streams = new Map<number, SpeakerStream>();
  private readonly slotByClient = new Map<number, number>();
  private readonly clientBySlot = new Map<number, number>();

  constructor(
    private readonly slotCount: number,
    private readonly idleReleaseMs = 60_000,
  ) {}

  /**
   * 处理一帧来自 TeamSpeak 的语音。
   *
   * 返回该帧应转发到的 slot 与 RTP 数据；没有可用 slot 时返回 null
   * （此时这一帧被丢弃，调用方无需额外处理）。
   */
  ingest(clientId: number, opus: Buffer): IngestResult | null {
    this.releaseIdle();

    let slot = this.slotByClient.get(clientId);
    if (slot === undefined) {
      const acquired = this.acquireSlot(clientId);
      if (acquired === null) return null;
      slot = acquired;
    }

    let stream = this.streams.get(clientId);
    if (!stream) {
      stream = new SpeakerStream(clientId);
      this.streams.set(clientId, stream);
    }
    return { slot, rtp: stream.packetize(opus) };
  }

  /** 成员离开频道时调用，立即回收其 slot。 */
  release(clientId: number): void {
    this.streams.delete(clientId);
    const slot = this.slotByClient.get(clientId);
    if (slot === undefined) return;
    this.slotByClient.delete(clientId);
    this.clientBySlot.delete(slot);
  }

  /** 当前 slot → clientId 映射，用于下发给浏览器。 */
  snapshot(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const [slot, clientId] of this.clientBySlot) map[String(slot)] = clientId;
    return map;
  }

  /** 某个 slot 当前归属的说话人，换源时用于重定位序号。 */
  streamOf(clientId: number): SpeakerStream | undefined {
    return this.streams.get(clientId);
  }

  get size(): number {
    return this.clientBySlot.size;
  }

  private acquireSlot(clientId: number): number | null {
    for (let slot = 0; slot < this.slotCount; slot++) {
      if (!this.clientBySlot.has(slot)) {
        this.assign(slot, clientId);
        return slot;
      }
    }
    // slot 用尽：淘汰最久未活跃的说话人
    let victimSlot = -1;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [slot, occupant] of this.clientBySlot) {
      const stream = this.streams.get(occupant);
      const lastActive = stream?.lastActive ?? 0;
      if (lastActive < oldest) {
        oldest = lastActive;
        victimSlot = slot;
      }
    }
    if (victimSlot < 0) return null;
    // 只有"确实已经不出声"的说话人才淘汰。
    //
    // 没有这个门槛时，K+1 个人同时说话会**每帧互相挤**：实测 9 人 / 8 slot、
    // 40 轮共 360 帧，产生 360 次归属变化（每帧一次）。每次归属变化都会触发
    // assignSlot → replaceRTP，给该 sender 的 RTP 流制造一次序号/时间戳不连续，
    // 于是**所有人的** jitter buffer 持续失稳 —— 受损的不只是挤不进来的那个人。
    //
    // 加了门槛之后：8 个人都在说话时第 K+1 个人的帧被丢弃（他确实挤不进来），
    // 但只要有人停顿超过阈值，第 K+1 个人立刻接管他的 slot —— 稳定且公平。
    if (Date.now() - oldest < EVICT_IDLE_MS) return null;
    const victim = this.clientBySlot.get(victimSlot);
    if (victim !== undefined) {
      this.clientBySlot.delete(victimSlot);
      this.slotByClient.delete(victim);
      this.streams.delete(victim);
    }
    this.assign(victimSlot, clientId);
    return victimSlot;
  }

  private assign(slot: number, clientId: number): void {
    this.slotByClient.set(clientId, slot);
    this.clientBySlot.set(slot, clientId);
  }

  private releaseIdle(): void {
    const now = Date.now();
    for (const [clientId, stream] of [...this.streams]) {
      if (now - stream.lastActive > this.idleReleaseMs) this.release(clientId);
    }
  }
}
