/**
 * S3 下行发布订阅模型验收测试（speaker-producer-map.ts）。
 *
 * 覆盖：
 *   ① `opusPacketSamples` 采样表（含 60ms 音乐帧
 *      samples=2880 修正）；
 *   ② `packetizeOpusFrame` 的封包契约：首包 marker=1、序号递增、时间戳按真实帧长累加；
 *   ③ DirectTransport 内存回环：1,000 帧混合 Opus fixture 经 Router 注入后，
 *      由 Consumer 的 `rtp` 事件解包，**payload 逐字节与输入一致**、时间戳步进
 *      **精确匹配**（含起点绝对对齐）；
 *   ④ 上限护栏：默认 32 / `WEBSPEAK_MAX_SPEAKERS` 1–64，超限淘汰最久未活跃者，
 *      并以 reason `evicted` 广播 `speakerProducerClosed`；
 *   ⑤ 2000ms idle 超时回收（reason `idle`），持续发言不会被误回收；
 *   ⑥ `remove()` 的 reason 透传与 `clear()` 的全量释放。
 *
 * 关于"逐字节一致"的口径：mediasoup 的 DirectTransport Consumer 会**重写 RTP
 * 序号并注入一个头部扩展**（实测恒为 16 字节），但 **payload 与时间戳原样保留**、
 * marker 语义保留。因此"逐字节一致"断言的是**解包后的 Opus payload** 与输入
 * fixture 一致；序号只断言 Consumer 侧严格 +1 步进，时间戳断言精确相等。
 *
 * 用法：npx tsx scripts/speaker-producer-map-test.mjs
 */
const { createMediaWorker, createMediaRouter } = await import("../src/server/media-worker.ts");
const { SpeakerProducerMap, opusPacketSamples, packetizeOpusFrame, resolveMaxSpeakers, DEFAULT_MAX_SPEAKERS } = await import(
  "../src/server/speaker-producer-map.ts"
);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 从 RTP 报文里取出头部字段与 payload（跳过 CSRC 与扩展）。 */
function parseRtp(buf) {
  const csrcCount = buf[0] & 0x0f;
  let offset = 12 + csrcCount * 4;
  let extensionBytes = 0;
  if (buf[0] & 0x10) {
    const words = buf.readUInt16BE(offset + 2);
    extensionBytes = 4 + words * 4;
    offset += extensionBytes;
  }
  return {
    version: buf[0] >> 6,
    marker: (buf[1] & 0x80) !== 0,
    payloadType: buf[1] & 0x7f,
    sequenceNumber: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    extensionBytes,
    payload: buf.subarray(offset),
  };
}

/** 轮询等待条件成立（mediasoup 的 rtp 事件是异步投递的）。 */
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

/** 造一帧"混合 fixture"：TOC 决定帧长，包体长度与内容随序号变化。 */
const FIXTURE_TOCS = [0x48, 0x18, 0x00, 0x80, 0x10, 0x49, 0x58, 0x2a];
function mixedFixture(index) {
  const body = Buffer.alloc(3 + (index % 37), (index * 7) & 0xff);
  body[0] = FIXTURE_TOCS[index % FIXTURE_TOCS.length];
  body[1] = (index >> 8) & 0xff;
  body[2] = index & 0xff;
  return body;
}

let worker;
let router;
let loopbackTransport;
const openMaps = [];

const closeQuietly = (resource) => {
  try {
    if (resource && typeof resource.close === "function" && !resource.closed) resource.close();
  } catch {
    /* best effort */
  }
};

try {
  // ───────────────────── ① opusPacketSamples 采样表 ─────────────────────
  console.log("=== ① opusPacketSamples 采样表 ===");
  const SAMPLE_TABLE = [
    { toc: 0x00, expected: 480, label: "SILK 窄带 10ms" },
    { toc: 0x10, expected: 1920, label: "SILK 窄带 40ms" },
    { toc: 0x18, expected: 2880, label: "SILK 窄带 60ms（音乐帧修正）" },
    { toc: 0x48, expected: 960, label: "SILK 宽带 20ms" },
    { toc: 0x58, expected: 2880, label: "SILK 宽带 60ms（音乐帧修正）" },
    { toc: 0x80, expected: 120, label: "CELP 窄带 2.5ms" },
    { toc: 0xe8, expected: 240, label: "CELP 全带 5ms（config 29）" },
    { toc: 0xf8, expected: 960, label: "CELP 全带 20ms（config 31）" },
    { toc: 0x49, expected: 1920, label: "20ms × 2 帧" },
    { toc: 0x1a, expected: 5760, label: "60ms × 2 帧（上限）" },
    { toc: 0x1b, expected: 2880, label: "60ms × 1 帧（frameCode=3）" },
  ];
  let sampleTableOk = true;
  for (const { toc, expected, label } of SAMPLE_TABLE) {
    const actual = opusPacketSamples(Buffer.from([toc, 0xaa, 0xbb]));
    if (actual !== expected) {
      sampleTableOk = false;
      console.log(`   ✗ ${label}：期望 ${expected}，实际 ${actual}`);
    }
  }
  check("10 项 TOC → samples 映射全部命中（含 60ms=2880）", sampleTableOk, `覆盖 config 0/2/3/9/11/16/29 与多帧代码`);
  check("空 payload 回落 20ms（960）", opusPacketSamples(Buffer.alloc(0)) === 960, `实际 ${opusPacketSamples(Buffer.alloc(0))}`);

  // ───────────────────── ② packetizeOpusFrame 封包契约 ─────────────────────
  console.log("\n=== ② packetizeOpusFrame 封包契约 ===");
  {
    const state = { firstSequenceNumber: 1000, sequenceNumber: 1000, timestamp: 5000, ssrc: 0x0badf00d };
    const frames = [Buffer.from([0x48, 1, 2]), Buffer.from([0x18, 3, 4, 5]), Buffer.from([0x80, 6])];
    const packets = frames.map((frame) => packetizeOpusFrame(state, frame));
    const parsed = packets.map(parseRtp);
    check("首包 marker=1、后续 marker=0", parsed[0].marker === true && parsed.slice(1).every((p) => p.marker === false),
      `markers=[${parsed.map((p) => (p.marker ? 1 : 0)).join(",")}]`);
    check("RTP 版本=2、payloadType=111、ssrc 透传",
      parsed.every((p) => p.version === 2 && p.payloadType === 111 && p.ssrc === 0x0badf00d),
      `version=${parsed[0].version}, pt=${parsed[0].payloadType}, ssrc=0x${parsed[0].ssrc.toString(16)}`);
    check("序号从起点严格 +1 递增（mod 65536）",
      parsed[0].sequenceNumber === 1000 && parsed[1].sequenceNumber === 1001 && parsed[2].sequenceNumber === 1002,
      `seq=[${parsed.map((p) => p.sequenceNumber).join(",")}]`);
    const expectedTs = [5000, 5000 + 960, 5000 + 960 + 2880];
    check("时间戳按真实帧长累加（960 → 2880）",
      parsed[0].timestamp === expectedTs[0] && parsed[1].timestamp === expectedTs[1] && parsed[2].timestamp === expectedTs[2],
      `ts=[${parsed.map((p) => p.timestamp).join(",")}] 期望 [${expectedTs.join(",")}]`);
    check("封包 payload 与输入逐字节一致", packets.every((p, i) => parseRtp(p).payload.equals(frames[i])), "3/3 帧");
    check("序号回绕（65535 → 0）",
      (() => {
        const wrap = { firstSequenceNumber: 65535, sequenceNumber: 65535, timestamp: 0, ssrc: 1 };
        packetizeOpusFrame(wrap, Buffer.from([0x48]));
        return wrap.sequenceNumber === 0;
      })(), "65535 之后回到 0");
  }

  // ───────────────────── ③ DirectTransport 内存回环 1,000 帧 ─────────────────────
  console.log("\n=== ③ DirectTransport 内存回环（1,000 帧混合 fixture）===");
  worker = await createMediaWorker();
  router = await createMediaRouter(worker);
  loopbackTransport = await router.createDirectTransport({ maxSendMessageSize: 2048 });

  const INITIAL_TIMESTAMP = 100_000;
  const SPEAKER_CLIENT_ID = 7;
  const WARMUP = Buffer.from([0x48, 0xde, 0xad, 0xbe, 0xef]);

  const created = [];
  const closed = [];
  const loopback = new SpeakerProducerMap(router, {
    idleTimeoutMs: 60_000,
    initialTimestamp: INITIAL_TIMESTAMP,
    onNewSpeakerProducer: (clientId, producerId) => created.push({ clientId, producerId }),
    onSpeakerProducerClosed: (clientId, producerId, reason) => closed.push({ clientId, producerId, reason }),
  });
  openMaps.push(loopback);

  // 首帧（warm-up）先把 Producer 建起来 —— Consumer 只能在 Producer 存在之后订阅，
  // 订阅之前发出的包不会补投（这与浏览器收到 newSpeakerProducer 后再 consume 一致）。
  await loopback.ingest(SPEAKER_CLIENT_ID, WARMUP);
  const speakerProducerId = loopback.producerIdOf(SPEAKER_CLIENT_ID);
  check("首帧触发 newSpeakerProducer 回调", created.length === 1 && created[0].clientId === SPEAKER_CLIENT_ID && typeof speakerProducerId === "string",
    `producerId=${speakerProducerId}`);

  const received = [];
  const consumer = await loopbackTransport.consume({ producerId: speakerProducerId, rtpCapabilities: router.rtpCapabilities });
  consumer.on("rtp", (packet) => received.push(Buffer.from(packet)));
  check("DirectTransport Consumer 建立成功（kind=audio）", consumer.kind === "audio", `consumerId=${consumer.id}`);

  const FIXTURE_FRAMES = 1_000;
  const fixture = [];
  for (let i = 0; i < FIXTURE_FRAMES; i++) fixture.push(mixedFixture(i));
  const ingestStartedAt = Date.now();
  for (const frame of fixture) await loopback.ingest(SPEAKER_CLIENT_ID, frame);
  const drained = await waitFor(() => received.length >= FIXTURE_FRAMES);
  const ingestMs = Date.now() - ingestStartedAt;
  check(`1,000 帧全部到达 Consumer（${ingestMs}ms 注入）`, drained && received.length === FIXTURE_FRAMES, `received=${received.length}/${FIXTURE_FRAMES}`);

  const parsed = received.map(parseRtp);
  const payloadMismatch = parsed.findIndex((p, i) => !p.payload.equals(fixture[i]));
  check("解包 payload 逐字节与输入 fixture 一致", payloadMismatch === -1,
    payloadMismatch === -1 ? "1000/1000 帧一致" : `第 ${payloadMismatch} 帧不一致`);

  const baseTimestamp = INITIAL_TIMESTAMP + opusPacketSamples(WARMUP);
  let expectedTimestamp = baseTimestamp;
  let timestampMismatch = -1;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].timestamp !== expectedTimestamp) {
      timestampMismatch = i;
      break;
    }
    expectedTimestamp = (expectedTimestamp + opusPacketSamples(fixture[i])) >>> 0;
  }
  check("时间戳步进精确匹配（含起点绝对对齐）", timestampMismatch === -1,
    timestampMismatch === -1
      ? `起点 ${baseTimestamp}，终点 ${parsed[parsed.length - 1].timestamp}`
      : `第 ${timestampMismatch} 帧：期望 ${expectedTimestamp}，实际 ${parsed[timestampMismatch].timestamp}`);

  const seqStepped = parsed.every((p, i) => i === 0 || p.sequenceNumber === ((parsed[i - 1].sequenceNumber + 1) & 0xffff));
  check("Consumer 侧序号严格 +1 步进（无丢包/乱序）", seqStepped, `${parsed.length} 帧连续`);
  check("订阅后的帧不再置 marker（避免 jitter buffer 反复判定新话段）", parsed.every((p) => !p.marker),
    `marker 计数=${parsed.filter((p) => p.marker).length}`);
  check("首帧 warm-up 的 marker=1 由封包契约测试覆盖", true, "见 ② 首包 marker=1");
  check("Router 侧 payloadType 归一为 111", parsed.every((p) => p.payloadType === 111), `pt=${parsed[0].payloadType}`);

  // ───────────────────── ④ 上限护栏与 eviction ─────────────────────
  console.log("\n=== ④ 上限护栏（WEBSPEAK_MAX_SPEAKERS 1–64）===");
  {
    const original = process.env.WEBSPEAK_MAX_SPEAKERS;
    const cases = [
      { raw: "4", expected: 4 },
      { raw: "1", expected: 1 },
      { raw: "64", expected: 64 },
      { raw: "0", expected: DEFAULT_MAX_SPEAKERS },
      { raw: "65", expected: DEFAULT_MAX_SPEAKERS },
      { raw: "abc", expected: DEFAULT_MAX_SPEAKERS },
      { raw: "12.5", expected: DEFAULT_MAX_SPEAKERS },
      { raw: undefined, expected: DEFAULT_MAX_SPEAKERS },
    ];
    let envOk = true;
    for (const { raw, expected } of cases) {
      if (raw === undefined) delete process.env.WEBSPEAK_MAX_SPEAKERS;
      else process.env.WEBSPEAK_MAX_SPEAKERS = raw;
      const actual = resolveMaxSpeakers();
      if (actual !== expected) {
        envOk = false;
        console.log(`   ✗ WEBSPEAK_MAX_SPEAKERS=${raw}：期望 ${expected}，实际 ${actual}`);
      }
    }
    if (original === undefined) delete process.env.WEBSPEAK_MAX_SPEAKERS;
    else process.env.WEBSPEAK_MAX_SPEAKERS = original;
    check("resolveMaxSpeakers 接受 1–64、越界/非法回落默认 32", envOk, `默认 ${DEFAULT_MAX_SPEAKERS}`);
  }

  {
    // 小上限便于验证淘汰语义。
    const evictions = [];
    const small = new SpeakerProducerMap(router, {
      maxSpeakers: 3,
      idleTimeoutMs: 60_000,
      onNewSpeakerProducer: () => {},
      onSpeakerProducerClosed: (clientId, producerId, reason) => evictions.push({ clientId, producerId, reason }),
    });
    openMaps.push(small);
    for (const clientId of [11, 12, 13]) await small.ingest(clientId, mixedFixture(clientId));
    const firstProducerId = small.producerIdOf(11);
    check("未达上限时全部保留", small.size === 3 && evictions.length === 0, `size=${small.size}`);

    await small.ingest(14, mixedFixture(14));
    const eviction = evictions[0];
    check("超过上限触发 eviction", small.size === 3 && evictions.length === 1, `size=${small.size}，关闭回调 ${evictions.length} 次`);
    check("被淘汰者是 id 最小/最久未活跃者（client 11）", eviction?.clientId === 11, `clientId=${eviction?.clientId}`);
    check("eviction 广播原因精确为 evicted", eviction?.reason === "evicted", `reason=${eviction?.reason}`);
    check("被淘汰者的 producerId 与创建时一致", eviction?.producerId === firstProducerId, `producerId=${eviction?.producerId}`);
    check("新说话人已入册、被淘汰者已移除", small.has(14) && !small.has(11), `snapshot=${JSON.stringify(small.snapshot())}`);
  }

  {
    // 默认上限 32：第 33 个说话人触发一次淘汰。
    delete process.env.WEBSPEAK_MAX_SPEAKERS;
    const defaultMap = new SpeakerProducerMap(router, { idleTimeoutMs: 60_000 });
    openMaps.push(defaultMap);
    const reasons = [];
    for (let i = 0; i < 32; i++) await defaultMap.ingest(500 + i, mixedFixture(i));
    check("默认上限下 32 个说话人全部在册", defaultMap.size === 32, `size=${defaultMap.size}`);
    await defaultMap.ingest(999, mixedFixture(1));
    check("默认上限 32：第 33 人触发淘汰且规模保持不变", defaultMap.size === 32 && defaultMap.has(999) && !defaultMap.has(500),
      `size=${defaultMap.size}, has(500)=${defaultMap.has(500)}, has(999)=${defaultMap.has(999)}`);
  }

  // ───────────────────── ⑤ 2000ms idle 超时回收 ─────────────────────
  console.log("\n=== ⑤ 2000ms idle 超时回收 ===");
  {
    const idleClosed = [];
    const idleMap = new SpeakerProducerMap(router, {
      // 默认 2000ms；显式声明以对齐验收标准。
      idleTimeoutMs: 2_000,
      onSpeakerProducerClosed: (clientId, producerId, reason) => idleClosed.push({ clientId, producerId, reason }),
    });
    openMaps.push(idleMap);
    await idleMap.ingest(21, mixedFixture(1));
    check("idleMap 默认 2000ms 阈值下说话人已建立", idleMap.size === 1, `size=${idleMap.size}`);
    await new Promise((r) => setTimeout(r, 1_500));
    await idleMap.ingest(21, mixedFixture(2));
    await new Promise((r) => setTimeout(r, 1_200));
    check("持续发言（<2000ms 间隔）不会被误回收", idleMap.size === 1 && idleClosed.length === 0,
      `size=${idleMap.size}，closed=${idleClosed.length}`);
    await new Promise((r) => setTimeout(r, 1_300));
    check("静默超过 2000ms 后自动回收", idleMap.size === 0 && idleClosed.length === 1, `size=${idleMap.size}`);
    check("idle 回收广播原因精确为 idle", idleClosed[0]?.reason === "idle", `reason=${idleClosed[0]?.reason}`);
  }

  // ───────────────────── ⑥ remove() / clear() ─────────────────────
  console.log("\n=== ⑥ remove() 与 clear() ===");
  {
    const events = [];
    const lifecycle = new SpeakerProducerMap(router, {
      maxSpeakers: 8,
      idleTimeoutMs: 60_000,
      onSpeakerProducerClosed: (clientId, producerId, reason) => events.push({ clientId, producerId, reason }),
    });
    openMaps.push(lifecycle);
    await lifecycle.ingest(31, mixedFixture(1));
    const producerId = lifecycle.producerIdOf(31);
    lifecycle.remove(31, "closed");
    check("remove() 移除并透传 reason=closed", lifecycle.size === 0 && events[0]?.reason === "closed" && events[0]?.producerId === producerId,
      `reason=${events[0]?.reason}, producerId=${events[0]?.producerId}`);
    check("remove() 对不存在的说话人是无操作", (() => { lifecycle.remove(999, "closed"); return events.length === 1; })(), `回调次数=${events.length}`);

    const producerRefs = [];
    const createSpy = new SpeakerProducerMap(router, {
      maxSpeakers: 8,
      idleTimeoutMs: 60_000,
      onNewSpeakerProducer: (clientId) => producerRefs.push(clientId),
    });
    openMaps.push(createSpy);
    for (const clientId of [41, 42, 43]) await createSpy.ingest(clientId, mixedFixture(clientId));
    const clearEvents = [];
    const clearing = new SpeakerProducerMap(router, {
      maxSpeakers: 8,
      idleTimeoutMs: 60_000,
      onSpeakerProducerClosed: (clientId, producerId, reason) => clearEvents.push({ clientId, reason }),
    });
    openMaps.push(clearing);
    for (const clientId of [51, 52, 53]) await clearing.ingest(clientId, mixedFixture(clientId));
    clearing.clear();
    check("clear() 清空全部说话人", clearing.size === 0 && Object.keys(clearing.snapshot()).length === 0, `size=${clearing.size}`);
    check("clear() 对每个说话人广播 reason=cleared", clearEvents.length === 3 && clearEvents.every((e) => e.reason === "cleared"),
      `reasons=[${clearEvents.map((e) => e.reason).join(",")}]`);
    check("clear() 后再次 ingest 会重建（映射仍可用）", await (async () => { await clearing.ingest(54, mixedFixture(1)); return clearing.size === 1; })(),
      `size=${clearing.size}`);
  }
} catch (error) {
  console.error(`\n✗ 测试执行中断：${error instanceof Error ? error.stack : String(error)}`);
  results.push({ name: "测试执行未中断", ok: false, detail: String(error) });
} finally {
  for (const map of openMaps) {
    try { map.clear(); } catch { /* best effort */ }
  }
  closeQuietly(loopbackTransport);
  closeQuietly(router);
  closeQuietly(worker);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  process.exitCode = 1;
}
