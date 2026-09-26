import { Device } from "mediasoup-client";
import type { types } from "mediasoup-client";

/**
 * mediasoup-client 封装层（S5）。
 *
 * 这一层只负责 mediasoup-client 的 `Device` / `Transport` / `Producer` /
 * `Consumer` 生命周期与事件透传，不碰 WebSocket：信令往返由调用方通过
 * `MediaSignaling` 注入（composable 里用 requestId 做请求/应答关联）。
 * 这样协议细节（消息类型、requestId、超时）留在一处，媒体对象留在一处。
 */

export type RouterRtpCapabilities = types.RtpCapabilities;
export type MediaKind = types.MediaKind;
export type DtlsParameters = types.DtlsParameters;
export type RtpParameters = types.RtpParameters;
export type AppData = types.AppData;
export type MediaProducer = types.Producer;
export type MediaConsumer = types.Consumer;
export type MediaTransport = types.Transport;
export type MediaTransportConnectionState = types.ConnectionState;

/** 服务端 `mediaTransportCreated` 下发的 transport 参数。 */
export interface MediaTransportParams {
  transportId: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
  sctpParameters?: types.SctpParameters;
}

/** 服务端 `mediaConsumed` 应答的 consumer 参数。 */
export interface MediaConsumeParams {
  consumerId: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
}

export interface MediaProduceOptions {
  track: MediaStreamTrack;
  appData?: types.AppData;
  codecOptions?: types.ProducerCodecOptions;
  /** 透传给 `transport.produce()`，用于表达码率/帧率天花板（屏幕共享 H5）。 */
  encodings?: types.RtpEncodingParameters[];
}

/**
 * 由调用方（composable）提供的信令通道。
 *
 * 每个方法对应一个 `media*` 客户端消息，成功时 resolve 服务端的应答，
 * 失败（`mediaError` / 超时 / 连接关闭）时 reject。
 */
export interface MediaSignaling {
  /** `mediaGetRtpCapabilities` → `mediaRtpCapabilities`。 */
  requestRtpCapabilities(): Promise<types.RtpCapabilities>;
  /** `mediaCreateTransport` → `mediaTransportCreated`。 */
  createTransport(direction: "send" | "recv"): Promise<MediaTransportParams>;
  /** `mediaConnectTransport` → `mediaTransportConnected`。 */
  connectTransport(transportId: string, dtlsParameters: types.DtlsParameters): Promise<void>;
  /** `mediaProduce` → `mediaProduced`，返回服务端 producerId。 */
  produce(transportId: string, kind: types.MediaKind, rtpParameters: types.RtpParameters, appData: types.AppData): Promise<string>;
  /** `mediaConsume` → `mediaConsumed`。 */
  consume(transportId: string, producerId: string, rtpCapabilities: types.RtpCapabilities): Promise<MediaConsumeParams>;
  /** `mediaPauseProducer` → `mediaProducerPaused`。 */
  pauseProducer(producerId: string): Promise<void>;
  /** `mediaResumeProducer` → `mediaProducerResumed`。 */
  resumeProducer(producerId: string): Promise<void>;
  /** `mediaConsumerResume` → `mediaConsumerResumed`（自动播放策略解锁）。 */
  resumeConsumer(consumerId: string): Promise<void>;
}

export interface MediaClientOptions {
  /** 浏览器侧 ICE 配置（STUN/TURN），由 /api/public-config 下发。 */
  iceServers?: RTCIceServer[];
  /** transport 连接状态变化（失败时调用方据此回退到兼容通道）。 */
  onConnectionStateChange?: (state: types.ConnectionState, direction: "send" | "recv") => void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 一次会话的 mediasoup 媒体客户端。
 *
 * 生命周期：`loadDevice()` → `createSendTransport()` / `createRecvTransport()`
 * → `produce()` / `consume()` → `close()`。所有 transport 事件在创建时一次性挂好，
 * 之后调用方只需要操作 Producer/Consumer。
 */
export class MediaClient {
  private device: types.Device | null = null;
  private sendTransport: types.Transport | null = null;
  private recvTransport: types.Transport | null = null;
  private readonly producers = new Map<string, types.Producer>();
  private readonly consumers = new Map<string, types.Consumer>();
  /** `ensureRecvReady()` 的 in-flight Promise：并发调用共享，避免重复建链。 */
  private recvReadyPromise: Promise<void> | null = null;

  constructor(
    private readonly signaling: MediaSignaling,
    private readonly options: MediaClientOptions = {},
  ) {}

  get loaded(): boolean {
    return this.device?.loaded === true;
  }

  get deviceRtpCapabilities(): types.RtpCapabilities | null {
    return this.device?.rtpCapabilities ?? null;
  }

  get sendTransportId(): string | null {
    return this.sendTransport?.id ?? null;
  }

  get recvTransportId(): string | null {
    return this.recvTransport?.id ?? null;
  }

  get producerCount(): number {
    return this.producers.size;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  /** 载入 Device（`Device.load({ routerRtpCapabilities })`）。 */
  async loadDevice(routerRtpCapabilities: types.RtpCapabilities): Promise<types.Device> {
    const device = new Device();
    await device.load({ routerRtpCapabilities });
    this.device = device;
    return device;
  }

  /**
   * 创建上行 transport。
   *
   * `connect` 事件（DTLS 握手）与 `produce` 事件（新建上行 Producer）都在这里
   * 透传给信令层；`produce` 事件用服务端返回的 producerId 回调，否则
   * `transport.produce()` 永远不会 resolve。
   */
  async createSendTransport(): Promise<types.Transport> {
    if (this.sendTransport) return this.sendTransport;
    const device = this.requireDevice();
    const params = await this.signaling.createTransport("send");
    const transport = device.createSendTransport(this.transportOptions(params, "send"));
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      this.signaling.connectTransport(transport.id, dtlsParameters)
        .then(() => callback())
        .catch((error: unknown) => errback(toError(error)));
    });
    transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      this.signaling.produce(transport.id, kind, rtpParameters, appData)
        .then((producerId) => callback({ id: producerId }))
        .catch((error: unknown) => errback(toError(error)));
    });
    this.watchConnectionState(transport, "send");
    this.sendTransport = transport;
    return transport;
  }

  /** 创建下行 transport。只透传 `connect` 事件（下行不产生 Producer）。 */
  async createRecvTransport(): Promise<types.Transport> {
    if (this.recvTransport) return this.recvTransport;
    const device = this.requireDevice();
    const params = await this.signaling.createTransport("recv");
    const transport = device.createRecvTransport(this.transportOptions(params, "recv"));
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      this.signaling.connectTransport(transport.id, dtlsParameters)
        .then(() => callback())
        .catch((error: unknown) => errback(toError(error)));
    });
    this.watchConnectionState(transport, "recv");
    this.recvTransport = transport;
    return transport;
  }

  /**
   * 确保 recv 方向媒体会话就绪（`device` 已加载 + 下行 `recvTransport` 已建立）。
   *
   * 幂等且并发安全：就绪后立即 resolve；并发调用共享同一个 in-flight Promise，
   * 不会重复 `Device.load()` / `createTransport("recv")`。失败时清空缓存，
   * 允许调用方重试。`consume()` 的契约是「调用前必须 `await ensureRecvReady()`」。
   */
  async ensureRecvReady(): Promise<void> {
    if (this.loaded && this.recvTransport) return;
    if (!this.recvReadyPromise) {
      this.recvReadyPromise = this.prepareRecvReady().finally(() => {
        this.recvReadyPromise = null;
      });
    }
    return this.recvReadyPromise;
  }

  private async prepareRecvReady(): Promise<void> {
    if (!this.device || !this.device.loaded) {
      await this.loadDevice(await this.signaling.requestRtpCapabilities());
    }
    await this.createRecvTransport();
  }

  /** 在 send transport 上发布麦克风（/ 混音）轨道。 */
  async produce(options: MediaProduceOptions): Promise<types.Producer> {
    const transport = this.sendTransport;
    if (!transport) throw new Error("上行 transport 尚未创建");
    const producer = await transport.produce({
      track: options.track,
      ...(options.appData ? { appData: options.appData } : {}),
      ...(options.codecOptions ? { codecOptions: options.codecOptions } : {}),
      ...(options.encodings ? { encodings: options.encodings } : {}),
    });
    this.producers.set(producer.id, producer);
    producer.on("transportclose", () => { this.producers.delete(producer.id); });
    producer.on("@close", () => { this.producers.delete(producer.id); });
    return producer;
  }

  /** 消费一个说话人 Producer（服务端 `mediaConsume` → 本地 `transport.consume`）。 */
  async consume(producerId: string): Promise<types.Consumer> {
    const device = this.requireDevice();
    const transport = this.recvTransport;
    if (!transport) {
      // 就绪边界契约（R7/M2）：调用前必须 `await ensureRecvReady()`。未就绪时直接
      // 抛错，绝不静默等待，避免调用方悬挂在永不 resolve 的 consume 上。
      throw new Error("下行媒体会话尚未就绪：请先 await ensureRecvReady() 再调用 consume()");
    }
    const params = await this.signaling.consume(transport.id, producerId, device.rtpCapabilities);
    const consumer = await transport.consume({
      id: params.consumerId,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    });
    this.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => { this.consumers.delete(consumer.id); });
    // mediasoup-client 的 Consumer 没有 `producerclose`（那是服务端事件）：服务端
    // 关闭说话人 Producer 时，客户端的远端轨道会结束，这里用 `trackended` 清理索引。
    consumer.on("trackended", () => { this.consumers.delete(consumer.id); });
    consumer.on("@close", () => { this.consumers.delete(consumer.id); });
    return consumer;
  }

  /** 解锁被自动播放策略拦下的 Consumer（服务端 + 客户端双侧 resume）。 */
  async resumeConsumer(consumer: types.Consumer): Promise<void> {
    await this.signaling.resumeConsumer(consumer.id);
    consumer.resume();
  }

  /** 合并 send/recv transport 的 RTC 统计（媒体路径指标用）。 */
  async getStats(): Promise<RTCStatsReport[]> {
    const reports: RTCStatsReport[] = [];
    for (const transport of [this.sendTransport, this.recvTransport]) {
      if (!transport || transport.closed) continue;
      try {
        reports.push(await transport.getStats());
      } catch {
        // transport 正在关闭时 getStats() 会抛错：这只是一次采样失败。
      }
    }
    return reports;
  }

  /** 关闭全部 Producer/Consumer/Transport 并释放 Device。 */
  close(): void {
    for (const producer of this.producers.values()) {
      try { producer.close(); } catch { /* 幂等 */ }
    }
    this.producers.clear();
    for (const consumer of this.consumers.values()) {
      try { consumer.close(); } catch { /* 幂等 */ }
    }
    this.consumers.clear();
    try { this.sendTransport?.close(); } catch { /* 幂等 */ }
    try { this.recvTransport?.close(); } catch { /* 幂等 */ }
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    this.recvReadyPromise = null;
  }

  private requireDevice(): types.Device {
    if (!this.device || !this.device.loaded) throw new Error("Device 尚未载入");
    return this.device;
  }

  private transportOptions(params: MediaTransportParams, direction: "send" | "recv"): types.TransportOptions {
    return {
      id: params.transportId,
      iceParameters: params.iceParameters,
      iceCandidates: params.iceCandidates,
      dtlsParameters: params.dtlsParameters,
      ...(params.sctpParameters ? { sctpParameters: params.sctpParameters } : {}),
      ...(this.options.iceServers?.length ? { iceServers: this.options.iceServers } : {}),
      appData: { direction },
    };
  }

  private watchConnectionState(transport: types.Transport, direction: "send" | "recv"): void {
    transport.on("connectionstatechange", (state) => {
      this.options.onConnectionStateChange?.(state, direction);
    });
  }
}
