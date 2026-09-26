/**
 * S5-01 屏幕共享 SFU 跨 Router 分发与防回归集成断言（T11 / 门禁 G5）。
 *
 * 目标：在**真实 mediasoup Worker** 上建立双 Router 纯内存回环环境（零生产 TS3 连接），
 * 直接驱动生产实现（`VoiceBridge.ensureScreenSharePipe` / `handleMediaMessage` /
 * `handleScreenShareSourceProducerClosed` 与纯函数 `isScreenShareProducer`）完成
 * R1 / R2 / R3 / R6-B3 / H4 全项断言，固化屏幕共享中央分发的防回归基线。
 *
 * 只读红线（规格 §10.1）：本脚本绝不连接生产 TS3；脚本源码内不出现点号调用的
 * 语音发送字面量，满足 `! grep -rqE "\.sendVoice\s*\(" scripts/` 退出码为 0。
 *
 * 用法：npx tsx scripts/screen-share-sfu-test.mjs
 */
const { readFileSync } = await import("node:fs");
const { MEDIA_CODECS, createMediaWorker, createMediaRouter } = await import("../src/server/media-worker.ts");
const { VoiceBridge, isScreenShareProducer } = await import("../src/server/voice-bridge.ts");
const { teamSpeakTargetKey } = await import("../src/domain/teamspeak-target.ts");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

/** 零副作用日志桩：`child()` 返回自身，避免构造 VoiceBridge 时依赖真实 pino。 */
const noopLogger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child() {
    return this;
  },
};

/**
 * 构造一个真实的 VoiceBridge 实例，仅替换外部副作用胶水（发送出口 / 媒体会话解析）；
 * pipe 去重、按轨 merge、分流判据、级联清理全部走生产实现，不做任何重写。
 */
function makeBridge() {
  const sent = [];
  const bridge = new VoiceBridge({ joinTickets: {} }, noopLogger);
  bridge.sendToEntry = (entryId, message) => {
    sent.push({ entryId, message });
  };
  bridge.ensureMediaSession = async (entry) => entry.media;
  return { bridge, sent };
}

function opusParams(ssrc) {
  return {
    codecs: [{ mimeType: "audio/opus", clockRate: 48_000, channels: 2, payloadType: 111, parameters: {} }],
    encodings: [{ ssrc }],
    rtcp: { cname: "screen-sfu-test", reducedSize: true },
  };
}

function vp8Params(ssrc) {
  return {
    codecs: [{ mimeType: "video/VP8", clockRate: 90_000, payloadType: 96, parameters: {} }],
    encodings: [{ ssrc }],
    rtcp: { cname: "screen-sfu-test", reducedSize: true },
  };
}

/** 构造一份满足生产代码读取面的 ScreenStreamRecord（仅测试内部使用）。 */
function screenStream({ streamId, ownerEntryId, viewerIds = [], targetKey = "test\u0000target", videoProducerId, audioProducerId }) {
  return {
    streamId,
    source: "browser",
    ownerPeerId: `peer-${ownerEntryId}`,
    ownerNickname: "owner",
    name: streamId,
    audio: Boolean(audioProducerId),
    createdAt: Date.now(),
    viewerCount: viewerIds.length,
    viewers: [],
    targetKey,
    channelId: 0n,
    ownerEntryId,
    viewerEntryIds: new Set(viewerIds),
    nativeViewerClids: new Set(),
    pipedByViewerEntryId: new Map(),
    ...(videoProducerId ? { sfuVideoProducerId: videoProducerId } : {}),
    ...(audioProducerId ? { sfuAudioProducerId: audioProducerId } : {}),
  };
}

let worker;
const openRouters = [];
const openTransports = [];

async function newRouter() {
  const router = await createMediaRouter(worker);
  openRouters.push(router);
  return router;
}

async function newDirectTransport(router, label) {
  const transport = await router.createDirectTransport({ maxSendMessageSize: 2048, appData: { label } });
  openTransports.push(transport);
  return transport;
}

try {
  worker = await createMediaWorker();

  // ═════════════════════ R1：keepId:false 生成新 UUID + 缺省 keepId 必抛错 ═════════════════════
  console.log("=== R1: pipeToRouter keepId 语义（同 Worker）===");
  {
    const ownerRouter = await newRouter();
    const viewerRouter = await newRouter();
    const sourceTransport = await newDirectTransport(ownerRouter, "r1-src");
    const sourceVideo = await sourceTransport.produce({
      kind: "video",
      rtpParameters: vp8Params(0x1001),
      appData: { mediaType: "screen-video" },
    });

    const { pipeProducer } = await ownerRouter.pipeToRouter({
      producerId: sourceVideo.id,
      router: viewerRouter,
      keepId: false,
    });
    check(
      "R1: keepId:false pipe 成功且生成新 UUID（pipeProducer.id !== sourceProducer.id）",
      pipeProducer.id !== sourceVideo.id && pipeProducer.id.length > 0,
      `source=${sourceVideo.id.slice(0, 8)}… pipe=${pipeProducer.id.slice(0, 8)}…`,
    );

    // 对照：同 Worker 下缺省 keepId（默认 true）再次 pipe 同一 Producer 必抛错——
    // 默认 true 会让管道 Producer 复用源 ID，与源 Producer 的 Worker 通道 ID 冲突。
    let defaultErr = null;
    try {
      await ownerRouter.pipeToRouter({ producerId: sourceVideo.id, router: viewerRouter });
    } catch (error) {
      defaultErr = error;
    }
    check(
      "R1 对照: 同 Worker 下缺省 keepId(true) 重复 pipe 必抛错（与源 Producer 通道 ID 冲突）",
      defaultErr instanceof Error && /already exists/i.test(defaultErr.message),
      defaultErr ? defaultErr.message : "未抛错——防回归基线失效",
    );

    // 生产实现同源校验：ensureScreenSharePipe 走的就是 keepId:false。
    const { bridge } = makeBridge();
    bridge.entries.set("owner-r1", { id: "owner-r1", media: { router: ownerRouter } });
    bridge.entries.set("viewer-r1", { id: "viewer-r1", media: { router: viewerRouter } });
    const stream = screenStream({
      streamId: "stream-r1",
      ownerEntryId: "owner-r1",
      viewerIds: ["viewer-r1"],
      videoProducerId: sourceVideo.id,
    });
    const piped = await bridge.ensureScreenSharePipe(stream, "viewer-r1");
    check(
      "R1: 生产 ensureScreenSharePipe 返回的管道 ID 为 keepId:false 生成的新 UUID（≠ 源 Producer）",
      Boolean(piped?.videoProducerId) && piped.videoProducerId !== sourceVideo.id,
      `pipe=${piped?.videoProducerId?.slice(0, 8)}…`,
    );
  }

  // ═════════════════════ R2：视频先推、音频后到，按轨独立 pipe（merge） ═════════════════════
  console.log("\n=== R2: 视频先推 / 音频后到的按轨 merge ===");
  {
    const ownerRouter = await newRouter();
    const viewerRouter = await newRouter();
    const sourceTransport = await newDirectTransport(ownerRouter, "r2-src");
    const sourceVideo = await sourceTransport.produce({
      kind: "video",
      rtpParameters: vp8Params(0x2001),
      appData: { mediaType: "screen-video" },
    });
    const sourceAudio = await sourceTransport.produce({
      kind: "audio",
      rtpParameters: opusParams(0x2002),
      appData: { mediaType: "screen-audio" },
    });

    const pipeProducers = [];
    let pipeCalls = 0;
    const originalPipe = ownerRouter.pipeToRouter.bind(ownerRouter);
    ownerRouter.pipeToRouter = async (options) => {
      pipeCalls += 1;
      const result = await originalPipe(options);
      pipeProducers.push(result.pipeProducer);
      return result;
    };

    const { bridge } = makeBridge();
    bridge.entries.set("owner-r2", { id: "owner-r2", media: { router: ownerRouter } });
    bridge.entries.set("viewer-r2", { id: "viewer-r2", media: { router: viewerRouter } });
    // 「视频先推」：音频源尚未就绪。
    const stream = screenStream({
      streamId: "stream-r2",
      ownerEntryId: "owner-r2",
      viewerIds: ["viewer-r2"],
      videoProducerId: sourceVideo.id,
    });

    const first = await bridge.ensureScreenSharePipe(stream, "viewer-r2");
    check(
      "R2: 视频先推——仅生成视频 PipeProducer，音频未就绪不 pipe",
      Boolean(first?.videoProducerId) && !first?.audioProducerId && pipeCalls === 1,
      `video=${first?.videoProducerId?.slice(0, 8)}…, audio=${first?.audioProducerId ?? "none"}, pipeCalls=${pipeCalls}`,
    );

    // 「音频后到」：第二次调用只补音频轨，视频轨复用缓存。
    stream.sfuAudioProducerId = sourceAudio.id;
    const second = await bridge.ensureScreenSharePipe(stream, "viewer-r2");
    check(
      "R2: 音频后到——只补音频轨，视频 PipeProducer 复用不变（merge 语义）",
      Boolean(second?.audioProducerId) &&
        second.videoProducerId === first.videoProducerId &&
        second.audioProducerId !== second.videoProducerId &&
        pipeCalls === 2,
      `video=${second?.videoProducerId?.slice(0, 8)}…, audio=${second?.audioProducerId?.slice(0, 8)}…, pipeCalls=${pipeCalls}`,
    );
    check(
      "R2: 两轨 PipeProducer 独立并存且互不阻塞（均未关闭）",
      pipeProducers.length === 2 &&
        pipeProducers[0].id !== pipeProducers[1].id &&
        !pipeProducers[0].closed &&
        !pipeProducers[1].closed,
      `pipes=${pipeProducers.map((p) => p.id.slice(0, 8)).join(", ")}`,
    );
  }

  // ═════════════════════ R3：并发 in-flight 去重，杜绝 double-pipe ═════════════════════
  console.log("\n=== R3: 并发分发 in-flight 去重 ===");
  {
    const ownerRouter = await newRouter();
    const viewerRouter = await newRouter();
    const viewerRouterB = await newRouter();
    const sourceTransport = await newDirectTransport(ownerRouter, "r3-src");
    const sourceVideo = await sourceTransport.produce({
      kind: "video",
      rtpParameters: vp8Params(0x3001),
      appData: { mediaType: "screen-video" },
    });

    let pipeCalls = 0;
    const originalPipe = ownerRouter.pipeToRouter.bind(ownerRouter);
    ownerRouter.pipeToRouter = async (options) => {
      pipeCalls += 1;
      // 人为放大底层 pipe 耗时，确保两个并发调用真实重叠在 in-flight 窗口内。
      await new Promise((r) => setTimeout(r, 40));
      return originalPipe(options);
    };

    const { bridge } = makeBridge();
    bridge.entries.set("owner-r3", { id: "owner-r3", media: { router: ownerRouter } });
    bridge.entries.set("viewer-r3", { id: "viewer-r3", media: { router: viewerRouter } });
    bridge.entries.set("viewer-r3b", { id: "viewer-r3b", media: { router: viewerRouterB } });
    // 观众媒体会话解析延迟，进一步拉开 in-flight 窗口（模拟未开语音的惰性建连）。
    bridge.ensureMediaSession = async (entry) => {
      await new Promise((r) => setTimeout(r, 60));
      return entry.media;
    };
    const stream = screenStream({
      streamId: "stream-r3",
      ownerEntryId: "owner-r3",
      viewerIds: ["viewer-r3", "viewer-r3b"],
      videoProducerId: sourceVideo.id,
    });

    const [a, b] = await Promise.all([
      bridge.ensureScreenSharePipe(stream, "viewer-r3"),
      bridge.ensureScreenSharePipe(stream, "viewer-r3"),
    ]);
    check(
      "R3: 同一观众的并发请求经 in-flight Promise 缓存复用，底层 pipeToRouter 仅调用一次",
      pipeCalls === 1 && Boolean(a?.videoProducerId) && a.videoProducerId === b?.videoProducerId,
      `pipeCalls=${pipeCalls}, a=${a?.videoProducerId?.slice(0, 8)}…, b=${b?.videoProducerId?.slice(0, 8)}…`,
    );

    const c = await bridge.ensureScreenSharePipe(stream, "viewer-r3");
    check(
      "R3: 完成后重复调用命中按轨缓存，仍不触发底层 pipeToRouter（防 double-pipe）",
      pipeCalls === 1 && c?.videoProducerId === a?.videoProducerId,
      `pipeCalls=${pipeCalls}`,
    );
    check(
      "R3: in-flight 表在任务完成后清空（不泄漏）",
      bridge.screenSharePipeInflight.size === 0,
      `inflight=${bridge.screenSharePipeInflight.size}`,
    );

    const other = await bridge.ensureScreenSharePipe(stream, "viewer-r3b");
    check(
      "R3 对照: 去重粒度为 (stream, viewer)——不同观众各自独立 pipe",
      pipeCalls === 2 && Boolean(other?.videoProducerId) && other.videoProducerId !== a?.videoProducerId,
      `pipeCalls=${pipeCalls}`,
    );
  }

  // ═════════════════════ R6/B3：分流判据 + 绕过上行管线（upstreams 计数 0） ═════════════════════
  console.log("\n=== R6/B3: 屏幕流分流判据与 TS3 上行管线隔离 ===");
  {
    // 纯函数判据（与生产 mediaProduce 分支同源）。
    check(
      "R6/B3: isScreenShareProducer 识别 mediaType=screen-video",
      isScreenShareProducer({ mediaType: "screen-video" }, "video") === true,
      "screen-video",
    );
    check(
      "R6/B3: isScreenShareProducer 识别 mediaType=screen-audio（kind=audio）",
      isScreenShareProducer({ mediaType: "screen-audio" }, "audio") === true,
      "screen-audio",
    );
    check(
      "R6/B3: isScreenShareProducer 将任意 kind=video 识别为屏幕流",
      isScreenShareProducer(undefined, "video") === true && isScreenShareProducer({}, "video") === true,
      "kind=video",
    );
    check(
      "R6/B3: 麦克风 audio 不被误判为屏幕流",
      isScreenShareProducer(undefined, "audio") === false &&
        isScreenShareProducer({ mediaType: "microphone" }, "audio") === false,
      "audio 非屏幕流",
    );

    // 行为断言：真实 Router 上驱动生产 mediaProduce 分支。
    const ownerRouter = await newRouter();
    const sourceTransport = await newDirectTransport(ownerRouter, "r6-src");
    const session = {
      router: ownerRouter,
      sendTransport: sourceTransport,
      recvTransport: null,
      producers: new Map(),
      consumers: new Map(),
      upstreams: new Map(),
      speakerProducers: null,
    };
    const target = { host: "screen.test", port: 9987 };
    const targetKey = teamSpeakTargetKey(target);
    const { bridge, sent } = makeBridge();
    bridge.ensureMediaSession = async () => session;
    const entry = {
      id: "owner-r6",
      media: session,
      tsClient: { setInputMuted() {} },
      target,
      microphoneMuted: false,
      accompanimentActive: false,
    };
    bridge.entries.set(entry.id, entry);

    // 登记匹配的屏幕共享会话，使 registerScreenShareProducer 正常登记（键格式镜像 screenStreamKey）。
    const streamId = "stream-r6";
    bridge.screenStreams.set(
      `${targetKey}\u0000${streamId}`,
      screenStream({ streamId, ownerEntryId: entry.id, targetKey }),
    );

    let attachCalls = 0;
    const originalAttach = bridge.attachUpstreamPipeline.bind(bridge);
    bridge.attachUpstreamPipeline = async (...args) => {
      attachCalls += 1;
      return originalAttach(...args);
    };

    const sendJson = (message) => sent.push(message);
    const produce = (requestId, kind, rtpParameters, appData) =>
      bridge.handleMediaMessage(entry, { type: "mediaProduce", requestId, payload: { transportId: sourceTransport.id, kind, rtpParameters, appData } }, sendJson);

    await produce("v", "video", vp8Params(0x6001), { mediaType: "screen-video", streamId, muted: true });
    check(
      "R6/B3: 屏幕视频 produce 绕过 attachUpstreamPipeline，session.upstreams 屏幕计数为 0",
      attachCalls === 0 && session.upstreams.size === 0 && sent.some((m) => m.type === "mediaProduced"),
      `attachCalls=${attachCalls}, upstreams=${session.upstreams.size}`,
    );
    check(
      "R6/B3: 屏幕流不触发 microphoneMuted 初值回写（即使 appData 携带 muted）",
      entry.microphoneMuted === false,
      `microphoneMuted=${entry.microphoneMuted}`,
    );

    await produce("a", "audio", opusParams(0x6002), { mediaType: "screen-audio", streamId });
    check(
      "R6/B3: 屏幕音频 produce 同样绕过上行管线，upstreams 仍为 0",
      attachCalls === 0 && session.upstreams.size === 0,
      `attachCalls=${attachCalls}, upstreams=${session.upstreams.size}`,
    );

    await produce("v2", "video", vp8Params(0x6003), {});
    check(
      "R6/B3: 任意 kind=video 上行亦绕过上行管线（含无 streamId 场景）",
      attachCalls === 0 && session.upstreams.size === 0,
      `attachCalls=${attachCalls}, upstreams=${session.upstreams.size}`,
    );

    // 对照组：麦克风 audio 必须正常进入上行管线，证明上一条并非"永远不进"。
    await produce("m", "audio", opusParams(0x6004), { muted: true });
    check(
      "R6/B3 对照: 麦克风 audio 正常进入 attachUpstreamPipeline（upstreams 计数 +1）",
      attachCalls === 1 && session.upstreams.size === 1,
      `attachCalls=${attachCalls}, upstreams=${session.upstreams.size}`,
    );
    check(
      "R6/B3 对照: 麦克风 produce 正常执行 muted 初值回写",
      entry.microphoneMuted === true,
      `microphoneMuted=${entry.microphoneMuted}`,
    );
  }

  // ═════════════════════ H4：源 Producer 关闭级联关闭 PipeProducer 与 Consumer ═════════════════════
  console.log("\n=== H4: 源 Producer 关闭的级联清理 ===");
  {
    const ownerRouter = await newRouter();
    const viewerRouter = await newRouter();
    const sourceTransport = await newDirectTransport(ownerRouter, "h4-src");
    const viewerTransport = await newDirectTransport(viewerRouter, "h4-viewer");
    const sourceVideo = await sourceTransport.produce({
      kind: "video",
      rtpParameters: vp8Params(0x4001),
      appData: { mediaType: "screen-video" },
    });

    let pipeProducer = null;
    const originalPipe = ownerRouter.pipeToRouter.bind(ownerRouter);
    ownerRouter.pipeToRouter = async (options) => {
      const result = await originalPipe(options);
      pipeProducer = result.pipeProducer;
      return result;
    };

    const { bridge, sent } = makeBridge();
    bridge.entries.set("owner-h4", { id: "owner-h4", media: { router: ownerRouter } });
    bridge.entries.set("viewer-h4", { id: "viewer-h4", media: { router: viewerRouter } });
    const stream = screenStream({
      streamId: "stream-h4",
      ownerEntryId: "owner-h4",
      viewerIds: ["viewer-h4"],
      videoProducerId: sourceVideo.id,
    });

    const piped = await bridge.ensureScreenSharePipe(stream, "viewer-h4");
    check(
      "H4: 前置——管道 Producer 建立成功",
      Boolean(piped?.videoProducerId) && pipeProducer?.id === piped.videoProducerId,
      `pipe=${piped?.videoProducerId?.slice(0, 8)}…`,
    );

    // 模拟浏览器观众消费该 PipeProducer（真实 Consumer）。
    const consumer = await viewerTransport.consume({
      producerId: piped.videoProducerId,
      rtpCapabilities: viewerRouter.rtpCapabilities,
    });
    let pipeClosed = false;
    let consumerProducerClose = false;
    pipeProducer.on("@close", () => {
      pipeClosed = true;
    });
    consumer.on("producerclose", () => {
      consumerProducerClose = true;
    });

    // 生产清理逻辑：源 Producer 关闭 → 状态复位 + 定向 screenShareVideoClosed。
    bridge.handleScreenShareSourceProducerClosed(stream, sourceVideo.id, true);
    check(
      "H4: 源关闭事件复位 stream 状态并定向通知观众 screenShareVideoClosed",
      stream.sfuVideoProducerId === undefined &&
        stream.pipedByViewerEntryId.get("viewer-h4")?.videoProducerId === undefined &&
        sent.some((s) => s.entryId === "viewer-h4" && s.message?.type === "screenShareVideoClosed"),
      `sent=${sent.map((s) => s.message?.type).join(",")}`,
    );

    // 真实级联：关闭源 Producer → PipeProducer 与 Consumer 一并关闭。
    sourceVideo.close();
    const cascaded = await waitFor(() => pipeProducer.closed && consumer.closed, 5_000);
    check(
      "H4: 关闭源 Producer 级联关闭 PipeProducer 与 Consumer",
      cascaded && pipeClosed && consumer.closed && consumerProducerClose,
      `pipe.closed=${pipeProducer.closed}, consumer.closed=${consumer.closed}, producerclose=${consumerProducerClose}`,
    );
  }

  // ═════════════════════ 第 8 项：协商顺序断言（排序即协商优先级） ═════════════════════
  console.log("\n=== 第 8 项: 协商顺序断言（排序即协商优先级）===");
  {
    // 以 MEDIA_CODECS 初始化 Router：rtpCapabilities.codecs 的声明顺序即协商优先级，
    // mediasoup-client 对同 kind 只取第一条本地支持的 codec，故首条 video 必须是 H.264。
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    openRouters.push(router);

    const videoCodecs = router.rtpCapabilities.codecs.filter((codec) => codec.kind === "video");
    const firstVideo = videoCodecs[0];
    check(
      "第 8 项: 首条 kind=video 为 video/H264（H.264 优先于 VP8，固化「排序即协商优先级」）",
      firstVideo?.mimeType === "video/H264",
      `首条 video=${firstVideo?.mimeType ?? "none"}；全部 video=${videoCodecs.map((codec) => codec.mimeType).join(", ")}`,
    );
    check(
      "第 8 项: 首条 H.264 parameters 锁定 packetization-mode=1 / profile-level-id=42e01f / level-asymmetry-allowed=1",
      firstVideo?.parameters?.["packetization-mode"] === 1 &&
        firstVideo.parameters?.["profile-level-id"] === "42e01f" &&
        firstVideo.parameters?.["level-asymmetry-allowed"] === 1,
      JSON.stringify(firstVideo?.parameters),
    );
  }

  // ═════════════════════ 源码固化断言（防回归基线） ═════════════════════
  console.log("\n=== 源码固化断言（防回归基线）===");
  {
    const source = readFileSync(new URL("../src/server/voice-bridge.ts", import.meta.url), "utf8");
    const keepIdFalse = (source.match(/keepId:\s*false/g) ?? []).length;
    check(
      "固化: ensureScreenSharePipe 视频/音频两轨 pipe 均显式 keepId:false",
      keepIdFalse >= 2,
      `keepId:false 出现 ${keepIdFalse} 次`,
    );

    const produceIdx = source.indexOf('case "mediaProduce"');
    const branchIdx = source.indexOf("isScreenShareProducer(produceAppData, producer.kind)");
    const attachIdx = source.indexOf("await this.attachUpstreamPipeline(entry, session, producer)");
    check(
      "固化: mediaProduce 屏幕流分流判据先于 attachUpstreamPipeline",
      produceIdx !== -1 && branchIdx > produceIdx && attachIdx > branchIdx,
      `produce=${produceIdx}, branch=${branchIdx}, attach=${attachIdx}`,
    );

    check(
      "固化: ensureScreenSharePipe 使用 screenSharePipeInflight 表做并发去重",
      source.includes("this.screenSharePipeInflight.get(inflightKey)") &&
        source.includes("this.screenSharePipeInflight.set(inflightKey, pending)"),
      "in-flight 双闸存在",
    );

    check(
      "固化: 按轨缓存 pipedByViewerEntryId 按 viewerEntryId 合并写回",
      source.includes("stream.pipedByViewerEntryId.set(viewerEntryId, merged)"),
      "merge 写回存在",
    );
  }
} catch (error) {
  console.error(`\n✗ 测试执行中断：${error instanceof Error ? error.stack : String(error)}`);
  results.push({ name: "测试执行未中断", ok: false, detail: String(error) });
} finally {
  for (const transport of openTransports) {
    try {
      if (!transport.closed) transport.close();
    } catch {
      /* best effort */
    }
  }
  for (const router of openRouters) {
    try {
      if (!router.closed) router.close();
    } catch {
      /* best effort */
    }
  }
  try {
    if (worker && !worker.closed) worker.close();
  } catch {
    /* best effort */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  process.exitCode = 1;
}
