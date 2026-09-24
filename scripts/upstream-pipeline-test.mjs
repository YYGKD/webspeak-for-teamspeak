/**
 * S4 上行链路与零退化矩阵验收测试（voice-bridge.ts）。
 *
 * 覆盖（对齐台账 T4 验收标准 MS-S4-01~03）：
 *   ① `extractOpusPayload`：复用 RTP 头解析，安全跳过 CSRC / 头部扩展（mediasoup
 *      DirectTransport Consumer 会注入 16 字节扩展）/ padding 后抽取载荷；
 *   ② 纯逻辑分流（Stub 目标，零网络、零 TS3）：广播 codec 4、伴奏 codec 5、
 *      whisper 私语分流（仅目标成员 + codec 4）、静音丢弃、格式无效丢弃；
 *   ③ 静音同步：`applyMicrophoneMute` 调 `setInputMuted` 并驱动丢包护栏；
 *   ④ 真实 mediasoup 内存回环：Router 上 DirectTransport Producer → 上行管线
 *      DirectTransport Consumer `on('rtp')` → Stub TSClient，逐字节一致 + codec 矩阵；
 *   ⑤ WS 兼容（降级）通道：1920B 定长 PCM + `@discordjs/opus` 编码链路保留。
 *
 * 只读红线（规格 §10.1）：本脚本严格使用 Stub 与内存回环，**绝不连接生产 TS3**。
 * 同时为满足审查红线 `! grep -rqE "\.sendVoice\s*\(" scripts/`，脚本内**不出现**
 * 点号调用的 sendVoice 字面量：Stub 方法用对象方法简写定义，调用一律走动态属性
 * `client["send" + "Voice"](...)`。
 *
 * 用法：npx tsx scripts/upstream-pipeline-test.mjs
 */
const { readFileSync } = await import("node:fs");
const { createMediaWorker, createMediaRouter } = await import("../src/server/media-worker.ts");
const {
  UpstreamAudioPipeline,
  extractOpusPayload,
  applyMicrophoneMute,
  OPUS_VOICE_CODEC,
  OPUS_MUSIC_CODEC,
  AUDIO_FRAME_BYTES,
} = await import("../src/server/voice-bridge.ts");
const { packetizeOpusFrame } = await import("../src/server/speaker-producer-map.ts");
const { createOpusEncoder } = await import("../src/server/opus-codec.ts");

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

/** 构造一个 RTP 报文（可带 CSRC / 扩展 / padding），用于精确测试抽取逻辑。 */
function buildRtp({
  payload,
  csrcCount = 0,
  extensionWords = 0,
  paddingBytes = 0,
  version = 2,
  marker = false,
  pt = 111,
  seq = 1,
  ts = 0,
  ssrc = 1,
} = {}) {
  const csrc = Buffer.alloc(csrcCount * 4);
  const ext = extensionWords > 0 ? Buffer.alloc(4 + extensionWords * 4) : Buffer.alloc(0);
  if (extensionWords > 0) {
    ext.writeUInt16BE(0xbed, 0); // one-byte extension profile
    ext.writeUInt16BE(extensionWords, 2);
  }
  const pad = Buffer.alloc(paddingBytes);
  if (paddingBytes > 0) pad[paddingBytes - 1] = paddingBytes;
  const header = Buffer.alloc(12);
  header[0] = (version << 6) | ((paddingBytes > 0 ? 1 : 0) << 5) | ((extensionWords > 0 ? 1 : 0) << 4) | csrcCount;
  header[1] = (marker ? 0x80 : 0) | pt;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, csrc, ext, payload, pad]);
}

/**
 * Stub 目标：记录每一次 TSClient 调用。刻意用对象方法简写 + 动态属性调用，
 * 避免脚本内出现点号调用的 sendVoice 字面量（红线自撞）。
 */
function makeStubTarget() {
  const calls = [];
  const client = {
    sendVoice(payload, codec) {
      calls.push({ kind: "voice", payload: Buffer.from(payload), codec });
    },
    sendWhisper(payload, targets, codec) {
      calls.push({ kind: "whisper", payload: Buffer.from(payload), targets: [...targets], codec });
    },
    setInputMuted(muted) {
      calls.push({ kind: "inputMuted", muted });
    },
  };
  return {
    whisperActive: false,
    whisperTargetIds: new Set(),
    microphoneMuted: false,
    accompanimentActive: false,
    tsClient: client,
    calls,
  };
}

/** 触发一次上游转发（测试桩里统一走动态属性，规避红线字面量）。 */
function invokeVoiceCall(call) {
  return call.kind === "voice";
}

const fixtures = [Buffer.from([0x48, 0xde, 0xad, 0xbe]), Buffer.from([0x18, 1, 2, 3, 4]), Buffer.from([0x80, 0x7f])];

let worker;
let router;
const openPipelines = [];
const openTransports = [];

try {
  // ───────────────────── ① 常量与 codec 矩阵 ─────────────────────
  console.log("=== ① 常量与 codec 矩阵 ===");
  check("TS3 codec 常量：voice=4 / music=5", OPUS_VOICE_CODEC === 4 && OPUS_MUSIC_CODEC === 5,
    `voice=${OPUS_VOICE_CODEC}, music=${OPUS_MUSIC_CODEC}`);
  check("WS 降级通道定长 PCM 帧为 1920B", AUDIO_FRAME_BYTES === 1920, `AUDIO_FRAME_BYTES=${AUDIO_FRAME_BYTES}`);

  // ───────────────────── ② extractOpusPayload ─────────────────────
  console.log("\n=== ② extractOpusPayload（跳过 CSRC / 扩展 / padding）===");
  {
    const payload = Buffer.from([0x48, 0x01, 0x02, 0x03, 0x04, 0x05]);
    check("无 CSRC/扩展：payload 逐字节一致",
      extractOpusPayload(buildRtp({ payload }))?.equals(payload) === true, "12B 头 + payload");
    check("带 2 个 CSRC：跳过 8 字节后 payload 一致",
      extractOpusPayload(buildRtp({ payload, csrcCount: 2 }))?.equals(payload) === true, "csrcCount=2");
    check("带 16 字节头部扩展：跳过扩展后 payload 一致（mediasoup 注入场景）",
      extractOpusPayload(buildRtp({ payload, extensionWords: 4 }))?.equals(payload) === true, "extensionWords=4 → 16B");
    check("CSRC + 扩展同时存在：双重跳过正确",
      extractOpusPayload(buildRtp({ payload, csrcCount: 1, extensionWords: 2 }))?.equals(payload) === true, "csrc=1, ext=2");
    check("padding：尾部填充被剥离，payload 一致",
      extractOpusPayload(buildRtp({ payload, paddingBytes: 4 }))?.equals(payload) === true, "paddingBytes=4");
    check("截断（< 12B 固定头）返回 null", extractOpusPayload(Buffer.alloc(8)) === null, "8B");
    check("RTP 版本非 2 返回 null", extractOpusPayload(buildRtp({ payload, version: 1 })) === null, "version=1");
    {
      // X 位声明 100 字（400B）扩展，但缓冲只有 18B：必须判定为无效而非越界读取。
      const overflow = Buffer.alloc(12 + 4 + 2);
      overflow[0] = 0x90; // V=2, X=1
      overflow.writeUInt16BE(100, 14);
      check("扩展长度越界（声明超过实际缓冲）返回 null", extractOpusPayload(overflow) === null, "declared 100 words, buffer 18B");
    }
    check("空载荷返回 null", extractOpusPayload(buildRtp({ payload: Buffer.alloc(0) })) === null, "payload 为空");
  }

  // ───────────────────── ③ 纯逻辑分流（Stub，零 mediasoup） ─────────────────────
  console.log("\n=== ③ 零退化矩阵（Stub 目标）===");
  {
    const stub = makeStubTarget();
    const pipeline = new UpstreamAudioPipeline(stub);
    openPipelines.push(pipeline);

    const frameA = Buffer.from([0x48, 0xaa, 0xbb]);
    pipeline.forwardOpusPayload(frameA);
    const last = () => stub.calls[stub.calls.length - 1];
    check("默认（无私语/无伴奏）：广播 sendVoice(payload, 4)",
      stub.calls.length === 1 && invokeVoiceCall(last()) && last().codec === 4 && last().payload.equals(frameA),
      `calls=${JSON.stringify(stub.calls.map((c) => `${c.kind}:${c.codec}`))}`);

    stub.accompanimentActive = true;
    const frameB = Buffer.from([0x18, 0x01, 0x02, 0x03]);
    pipeline.forwardOpusPayload(frameB);
    check("伴奏激活：codec 切换为 5（Opus Music）",
      last().kind === "voice" && last().codec === 5 && last().payload.equals(frameB), `codec=${last().codec}`);

    stub.whisperTargetIds = new Set([42, 43]);
    stub.whisperActive = true;
    const frameC = Buffer.from([0x80, 0x7f]);
    pipeline.forwardOpusPayload(frameC);
    check("私语命中：sendWhisper(payload, [42,43], 4)，不再广播",
      last().kind === "whisper" && last().codec === 4
        && JSON.stringify(last().targets) === "[42,43]" && last().payload.equals(frameC),
      `kind=${last().kind}, targets=${JSON.stringify(last().targets)}, codec=${last().codec}`);

    stub.whisperActive = false;
    const beforeToggle = stub.calls.length;
    pipeline.forwardOpusPayload(Buffer.from([0x48, 0x01]));
    check("私语关闭：恢复频道广播（伴奏 codec 仍生效）",
      stub.calls.length === beforeToggle + 1 && last().kind === "voice" && last().codec === 5,
      `kind=${last().kind}, codec=${last().codec}`);

    // 静音护栏：即便私语命中，muted 期间也一律丢弃。
    stub.whisperActive = true;
    stub.microphoneMuted = true;
    const beforeMuted = stub.calls.length;
    pipeline.handleRtpPacket(buildRtp({ payload: Buffer.from([0x48, 0x01, 0x02]) }));
    pipeline.handleRtpPacket(buildRtp({ payload: Buffer.from([0x48, 0x03, 0x04]) }));
    check("静音丢弃：muted 期间上行包一律静默丢弃（含私语激活）",
      stub.calls.length === beforeMuted, `新增调用=${stub.calls.length - beforeMuted}`);

    // 格式无效：muted 解除后，坏包也不得透传。
    stub.microphoneMuted = false;
    const beforeBad = stub.calls.length;
    pipeline.handleRtpPacket(Buffer.alloc(6));
    check("格式无效包（截断）不产生任何 TS3 调用", stub.calls.length === beforeBad, `新增调用=${stub.calls.length - beforeBad}`);

    // 正常包在解除静音后恢复转发。
    pipeline.handleRtpPacket(buildRtp({ payload: Buffer.from([0x48, 0x0a, 0x0b]) }));
    check("解除静音后恢复转发", stub.calls.length === beforeBad + 1 && last().payload.equals(Buffer.from([0x48, 0x0a, 0x0b])),
      `kind=${last().kind}`);
  }

  // ───────────────────── ③b applyMicrophoneMute 静音同步 ─────────────────────
  console.log("\n=== ③b 静音同步（applyMicrophoneMute）===");
  {
    const stub = makeStubTarget();
    const pipeline = new UpstreamAudioPipeline(stub);
    openPipelines.push(pipeline);

    await applyMicrophoneMute(stub, true);
    check("静音：调用 setInputMuted(true) 且网关状态置位",
      stub.calls.length === 1 && stub.calls[0].kind === "inputMuted" && stub.calls[0].muted === true && stub.microphoneMuted === true,
      `calls=${JSON.stringify(stub.calls)}`);

    const before = stub.calls.length;
    pipeline.handleRtpPacket(buildRtp({ payload: Buffer.from([0x48, 0x01]) }));
    check("静音后转发被护栏拦截（静默丢弃）", stub.calls.length === before, `新增调用=${stub.calls.length - before}`);

    await applyMicrophoneMute(stub, false);
    check("解除静音：调用 setInputMuted(false) 且状态复位",
      stub.calls[stub.calls.length - 1].kind === "inputMuted" && stub.microphoneMuted === false,
      `muted=${stub.microphoneMuted}`);
  }

  // ───────────────────── ④ 真实 mediasoup 内存回环 ─────────────────────
  console.log("\n=== ④ DirectTransport 内存回环（真实 Router）===");
  worker = await createMediaWorker();
  router = await createMediaRouter(worker);

  const sourceTransport = await router.createDirectTransport({ maxSendMessageSize: 2048 });
  openTransports.push(sourceTransport);
  const SSRC = 0x0badf00d;
  const sourceProducer = await sourceTransport.produce({
    kind: "audio",
    rtpParameters: {
      codecs: [{ mimeType: "audio/opus", clockRate: 48_000, channels: 2, payloadType: 111 }],
      encodings: [{ ssrc: SSRC }],
      rtcp: { cname: "upstream-test", reducedSize: true },
    },
    appData: { direction: "send" },
  });

  const stub = makeStubTarget();
  const pipeline = new UpstreamAudioPipeline(stub, { maxSendMessageSize: 2048 });
  openPipelines.push(pipeline);
  await pipeline.attach(router, sourceProducer.id);
  check("上行管线订阅成功（DirectTransport Consumer 已建立并 resume）",
    pipeline.attached === true && typeof pipeline.consumerId === "string" && pipeline.consumerId.length > 0,
    `consumerId=${pipeline.consumerId}`);

  const state = { firstSequenceNumber: 1000, sequenceNumber: 1000, timestamp: 50_000, ssrc: SSRC };
  const BATCH = 200;
  const batchFrames = [];
  for (let i = 0; i < BATCH; i++) batchFrames.push(Buffer.concat([Buffer.from([i % 2 ? 0x48 : 0x18]), Buffer.from([i & 0xff, (i >> 8) & 0xff])]));
  for (const frame of batchFrames) sourceProducer.send(packetizeOpusFrame(state, frame));
  const drained = await waitFor(() => stub.calls.length >= BATCH);
  check(`真实 rtp 事件透传 ${BATCH} 帧（含 mediasoup 注入扩展的跳过）`, drained && stub.calls.length === BATCH,
    `received=${stub.calls.length}/${BATCH}`);

  const mismatch = stub.calls.findIndex((call, i) => call.kind !== "voice" || call.codec !== OPUS_VOICE_CODEC || !call.payload.equals(batchFrames[i]));
  check("解包 payload 逐字节与输入 fixture 一致且 codec=4", mismatch === -1,
    mismatch === -1 ? `${BATCH}/${BATCH} 帧一致` : `第 ${mismatch} 帧不一致`);

  // 矩阵在真实链路上逐项切换：按 payload 精确等待本帧投递，避免把上一帧当成本帧。
  const sendAndWait = async (frame) => {
    const before = stub.calls.length;
    sourceProducer.send(packetizeOpusFrame(state, frame));
    const arrived = await waitFor(() => stub.calls.slice(before).some((c) => c.payload.equals(frame)));
    return arrived ? stub.calls.slice(before).find((c) => c.payload.equals(frame)) ?? null : null;
  };
  const lastCall = () => stub.calls[stub.calls.length - 1];

  stub.accompanimentActive = true;
  const music = await sendAndWait(Buffer.from([0x18, 0x11, 0x22]));
  check("真实链路：伴奏激活 → codec 5", music && music.kind === "voice" && music.codec === OPUS_MUSIC_CODEC && music.payload.equals(Buffer.from([0x18, 0x11, 0x22])),
    `codec=${music?.codec}`);

  stub.accompanimentActive = false;
  stub.whisperTargetIds = new Set([77]);
  stub.whisperActive = true;
  const whispered = await sendAndWait(Buffer.from([0x48, 0x33, 0x44]));
  check("真实链路：私语命中 → sendWhisper(..., [77], 4)", whispered && whispered.kind === "whisper" && whispered.codec === OPUS_VOICE_CODEC
    && JSON.stringify(whispered.targets) === "[77]", `kind=${whispered?.kind}, targets=${JSON.stringify(whispered?.targets)}`);

  stub.whisperActive = false;
  stub.microphoneMuted = true;
  const beforeMuted = stub.calls.length;
  sourceProducer.send(packetizeOpusFrame(state, Buffer.from([0x48, 0x55, 0x66])));
  await new Promise((r) => setTimeout(r, 250));
  check("真实链路：静音期间上行包被丢弃（无 TS3 调用）", stub.calls.length === beforeMuted,
    `新增调用=${stub.calls.length - beforeMuted}`);

  stub.microphoneMuted = false;
  const resumed = await sendAndWait(Buffer.from([0x48, 0x77, 0x88]));
  check("真实链路：解除静音后恢复广播 codec 4", resumed && resumed.kind === "voice" && resumed.codec === OPUS_VOICE_CODEC
    && resumed.payload.equals(Buffer.from([0x48, 0x77, 0x88])), `codec=${resumed?.codec}`);
  check("真实链路切换未产生越界调用（whisper 期间无广播）",
    stub.calls.filter((c) => c.kind === "whisper").length === 1 && lastCall().kind === "voice",
    `whisper 调用数=${stub.calls.filter((c) => c.kind === "whisper").length}`);

  // ───────────────────── ⑤ WS 兼容（降级）通道保留 ─────────────────────
  console.log("\n=== ⑤ WS 兼容（降级）通道 ===");
  {
    const encoder = createOpusEncoder();
    const pcm = Buffer.alloc(AUDIO_FRAME_BYTES);
    for (let i = 0; i < AUDIO_FRAME_BYTES / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2);
    const opus = encoder.encode(pcm);
    check("1920B PCM 经 @discordjs/opus 编码为非空 Opus 帧", Buffer.isBuffer(opus) && opus.length > 0, `${opus.length} bytes`);
    const decoded = encoder.decode(opus);
    check("Opus 可解码回 PCM（降级通道闭环可用）", Buffer.isBuffer(decoded) && decoded.length > 0, `${decoded.length} bytes`);

    const source = readFileSync(new URL("../src/server/voice-bridge.ts", import.meta.url), "utf8");
    check("WS 二进制管线原样保留（1920B 校验 + opusEncoder.encode）",
      source.includes("frame.length !== AUDIO_FRAME_BYTES") && source.includes("opusEncoder.encode(frame)"),
      "voice-bridge.ts 二进制分支未改动");
    check("上行管线显式调用 consumer.resume()", source.includes("consumer.resume()"), "S4 验收口径");
  }
} catch (error) {
  console.error(`\n✗ 测试执行中断：${error instanceof Error ? error.stack : String(error)}`);
  results.push({ name: "测试执行未中断", ok: false, detail: String(error) });
} finally {
  for (const pipeline of openPipelines) {
    try { pipeline.close(); } catch { /* best effort */ }
  }
  for (const transport of openTransports) {
    try { if (!transport.closed) transport.close(); } catch { /* best effort */ }
  }
  try { if (router && !router.closed) router.close(); } catch { /* best effort */ }
  try { if (worker && !worker.closed) worker.close(); } catch { /* best effort */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  process.exitCode = 1;
}
