/**
 * 本地复现台：真实 Chrome 接收端 ← 真实 WebRtcAudioSession（werift SFU）。
 *
 * 存在的理由：交接文档里的诊断结论建立在「packetsReceived>0 且 samples=0 ⇒ RTP 层有问题」
 * 之上，但这个推理不成立 —— Chrome 的 totalSamplesReceived/concealedSamples 都被 NetEq 的
 * decoded_output_played_ 闸门掩盖（见 memory/task-log）。要分清「包没进 NetEq」和
 * 「NetEq 从没被拉取」，必须看不受闸门影响的 jitterBufferEmittedCount，并且要有一个
 * 已知可用的对照组。
 *
 * 本脚本一次性提供两件事：
 *   --mode=control  Chrome ↔ Chrome（同一页面两个 PC，回环），给出「可用音频」的统计基线
 *   --mode=werift   真实 WebRtcAudioSession + SpeakerRegistry，喂真实 Opus 帧
 *
 * 用法：
 *   npx tsx scripts/chrome-sfu-probe.mjs --mode=control
 *   npx tsx scripts/chrome-sfu-probe.mjs --mode=werift [--seconds=8] [--slots=8]
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep } from "./lib/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PROD_ORIGIN = "https://tsweb.yygkd.com";
const MODE = argOf("mode", "control");
const SECONDS = Number(argOf("seconds", "8"));
const SLOTS = Number(argOf("slots", "8"));
// headless 的 Chrome 没有音频输出设备 → ADM 不拉取 → NetEq 从不运行，
// 所有计数恒为 0（实测：连 Chrome↔Chrome 回环都是 jbEmitted=0）。
// 因此凡是验证播放链的场景必须 headful。
const HEADFUL = process.argv.includes("--headful");
// --relay：iceTransportPolicy=relay，强制走 TURN 中继
const RELAY_ONLY = process.argv.includes("--relay");
const ICE_JSON = argOf("ice", null);
// 判断 Chrome 的 NetEq 是否依赖"有 sink 挂在远端轨道上"才会被拉取。
const NO_SINK = process.argv.includes("--no-sink");
// 哪种 sink 才能让 Chrome 真正拉取接收流：webaudio / element / both / none
const SINK = argOf("sink", NO_SINK ? "none" : "both");
// 中途把 slot 交给另一个说话人，验证换源路径（assignSlot / replaceRTP）。
const HANDOVER = process.argv.includes("--handover");

// ---------------------------------------------------------------- 页面脚本

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>SFU probe</title></head>
<body style="font:13px monospace">
<div id="log"></div>
<script>
window.__probe = (() => {
  const state = {
    pc: null, slotByTransceiver: new Map(), speakerMap: {}, errors: [], logs: [],
    audioCtx: null, nodes: new Map(), elements: new Map(), started: false,
  };
  const log = (m) => { state.logs.push(m); document.getElementById('log').textContent = state.logs.slice(-14).join('\\n'); };

  function graph(slot, track) {
    // 播放路径按 --sink 选择：Chrome 只有在远端轨道被挂上 sink 时才会启动接收流，
    // 所以「用哪条路径」是能否出声的决定性变量，必须能单独开关。
    const sink = state.sinkMode || 'both';
    const stream = new MediaStream([track]);
    if (sink === 'element' || sink === 'both' || sink === 'element-analyser' || sink === 'element-source' || sink === 'element-muted-analyser' || sink === 'element-source-pre' || sink === 'leaf-analyser') {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.muted = sink === 'element-muted-analyser';
      el.srcObject = stream;
      if (sink === 'element-source-pre') {
        if (!state.audioCtx) state.audioCtx = new AudioContext();
        state.audioCtx.resume().catch(() => {});
        state.preSources = state.preSources || new Map();
        state.preSources.set(slot, state.audioCtx.createMediaElementSource(el));
      }
      el.play().catch((e) => log('audio.play 失败: ' + e));
      document.body.append(el);
      state.elements.set(slot, el);
    }
    if (sink === 'element-source') {
      // 候选修复：<audio> 元素当 sink（驱动 ADM），再用 createMediaElementSource
      // 把它的音频接进 WebAudio 做增益与电平分析 —— 单条播放路径，增益范围不受
      // HTMLMediaElement.volume 的 [0,1] 限制。
      const el = state.elements.get(slot);
      if (!state.audioCtx) state.audioCtx = new AudioContext();
      const ctx = state.audioCtx;
      ctx.resume().catch(() => {});
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(gain); gain.connect(analyser); analyser.connect(ctx.destination);
      state.nodes.set(slot, { source, gain, analyser, buffer: new Float32Array(analyser.fftSize) });
    }
    if (sink === 'element-source-pre') {
      const ctx = state.audioCtx;
      const source = state.preSources.get(slot);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(gain); gain.connect(analyser); analyser.connect(ctx.destination);
      state.nodes.set(slot, { source, gain, analyser, buffer: new Float32Array(analyser.fftSize) });
    }
    if (sink === 'webaudio' || sink === 'both' || sink === 'element-analyser' || sink === 'element-muted-analyser' || sink === 'webaudio-first' || sink === 'leaf-analyser') {
      if (!state.audioCtx) state.audioCtx = new AudioContext();
      const ctx = state.audioCtx;
      ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(gain); gain.connect(analyser);
      // leaf-analyser：analyser 不接 destination（复刻 measureSlot 的接法），
      // 用来验证"叶子分析器到底拿不拿得到数据"。
      if (sink !== 'leaf-analyser') analyser.connect(ctx.destination);
      state.nodes.set(slot, { source, gain, analyser, buffer: new Float32Array(analyser.fftSize) });
    }
    if (sink === 'webaudio-first') {
      // 复刻生产代码的调用顺序：先 createMediaStreamSource，再挂 <audio> 元素。
      const el = document.createElement('audio');
      el.autoplay = true; el.muted = true; el.srcObject = stream;
      el.play().catch(() => {});
      document.body.append(el);
      state.elements.set(slot, el);
    }
    log('slot' + slot + ' sink=' + sink + ' track=' + track.id.slice(0, 8) + ' muted=' + track.muted);
  }

  function watchTrack(slot, track) {
    track.onmute = () => log('slot' + slot + ' track muted');
    track.onunmute = () => log('slot' + slot + ' track unmuted');
  }

  async function buildPeer(pc, config) {
    const transceivers = [];
    for (let slot = 0; slot < config.slots; slot++) {
      const transceiver = slot === 0 && config.micTrack
        ? pc.addTransceiver(config.micTrack, { direction: 'sendrecv' })
        : pc.addTransceiver('audio', { direction: config.recvOnly ? 'recvonly' : 'sendrecv' });
      state.slotByTransceiver.set(transceiver, slot);
      transceivers.push(transceiver);
    }
    pc.ontrack = (event) => {
      state.trackEvents = (state.trackEvents ?? 0) + 1;
      // 用 mid 定位 slot，而不是对象身份 —— 实测 Chrome 在 setRemoteDescription
      // 时给出的 event.transceiver 与 addTransceiver 返回的对象不是同一个引用。
      // 我们按 slot 顺序创建 transceiver，所以 mid === String(slot)，
      // 这也与服务端 werift 的 mid（"0".."N-1"）一一对应。
      const slot = event.transceiver.mid === null ? undefined : Number(event.transceiver.mid);
      try {
        watchTrack(slot, event.track);
        if (config.sink !== 'none') graph(slot, event.track);
        else state.logs.push('slot' + slot + ' 不挂 sink');
      } catch (e) { state.errors.push('graph(' + slot + '): ' + e); }
    };
    pc.onconnectionstatechange = () => state.logs.push('pc state=' + pc.connectionState);
    pc.oniceconnectionstatechange = () => state.logs.push('ice state=' + pc.iceConnectionState);
    return transceivers;
  }

  async function waitIce(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
  }

  async function snapshot() {
    const out = { logs: state.logs.slice(-20), errors: state.errors, slots: [], trackEvents: state.trackEvents ?? 0, transceiverCount: state.slotByTransceiver.size };
    if (state.audioCtx) out.audioCtxState = state.audioCtx.state;
    for (const [slot, node] of state.nodes) {
      node.analyser.getFloatTimeDomainData(node.buffer);
      let sum = 0;
      for (const v of node.buffer) sum += v * v;
      const el = state.elements.get(slot);
      out.slots.push({
        slot,
        rms: Math.sqrt(sum / node.buffer.length),
        elPaused: el ? el.paused : null,
        elCurrentTime: el ? Number(el.currentTime.toFixed(3)) : null,
        elReadyState: el ? el.readyState : null,
      });
    }
    if (!state.pc) return out;
    // 槽位数的代价：每个 slot 一条 m-line，SDP 体积与收发器数按比例增长。
    out.transceiverCount = state.pc.getTransceivers().length;
    out.offerSdpBytes = state.pc.localDescription?.sdp?.length ?? null;
    out.answerSdpBytes = state.pc.remoteDescription?.sdp?.length ?? null;
    const report = await state.pc.getStats();
    const codecById = new Map();
    report.forEach((e) => { if (e.type === 'codec') codecById.set(e.id, e.mimeType + '/' + e.payloadType); });
    out.inbound = []; out.outbound = []; out.playout = []; out.remoteOutbound = [];
    report.forEach((e) => {
      if (e.type === 'inbound-rtp' && e.kind === 'audio') {
        out.inbound.push({
          mid: e.mid, ssrc: e.ssrc, codec: codecById.get(e.codecId) ?? null,
          packetsReceived: e.packetsReceived, packetsLost: e.packetsLost, packetsDiscarded: e.packetsDiscarded,
          bytesReceived: e.bytesReceived,
          totalSamplesReceived: e.totalSamplesReceived,
          concealedSamples: e.concealedSamples,
          insertedSamplesForDeceleration: e.insertedSamplesForDeceleration,
          removedSamplesForAcceleration: e.removedSamplesForAcceleration,
          jitterBufferEmittedCount: e.jitterBufferEmittedCount,
          jitterBufferDelay: e.jitterBufferDelay,
          audioLevel: e.audioLevel, totalAudioEnergy: e.totalAudioEnergy,
          trackIdentifier: e.trackIdentifier,
        });
      }
      if (e.type === 'outbound-rtp' && e.kind === 'audio') {
        out.outbound.push({ mid: e.mid, ssrc: e.ssrc, packetsSent: e.packetsSent, bytesSent: e.bytesSent, codec: codecById.get(e.codecId) ?? null });
      }
      if (e.type === 'media-playout') {
        out.playout.push({ totalSamplesCount: e.totalSamplesCount, totalSamplesDuration: e.totalSamplesDuration, totalPlayoutDelay: e.totalPlayoutDelay });
      }
      if (e.type === 'remote-inbound-rtp' && e.kind === 'audio') {
        out.remoteOutbound.push({ packetsLost: e.packetsLost, roundTripTime: e.roundTripTime });
      }
    });
    out.inbound.sort((a, b) => String(a.mid).localeCompare(String(b.mid)));

    // 本地候选类型：relay 才说明 TURN 真的分配成功
    out.localCandidates = [];
    out.selectedPair = null;
    const candidateById = new Map();
    report.forEach((e) => { if (e.type === "local-candidate") candidateById.set(e.id, e); });
    report.forEach((e) => {
      if (e.type !== "local-candidate") return;
      out.localCandidates.push({ candidateType: e.candidateType, protocol: e.protocol, address: e.address, port: e.port });
    });
    report.forEach((e) => {
      if (e.type !== "candidate-pair" || e.state !== "succeeded" || !e.nominated) return;
      const local = candidateById.get(e.localCandidateId);
      out.selectedPair = {
        localType: local?.candidateType ?? null,
        localProtocol: local?.protocol ?? null,
        localAddress: local?.address ?? null,
        bytesReceived: e.bytesReceived,
      };
    });
    return out;
  }

  async function runWerift(config) {
    state.started = true;
    state.sinkMode = config.sink || 'both';
    let micTrack = null;
    if (!config.recvOnly) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micTrack = stream.getAudioTracks()[0];
      } catch (e) { state.errors.push('getUserMedia: ' + e); }
    }
    const pc = new RTCPeerConnection({
      iceServers: config.iceServers || [],
      // relay：强制只使用中继候选，用来验证 TURN 真的能用（不然本机直连永远成功）
      ...(config.relayOnly ? { iceTransportPolicy: 'relay' } : {}),
    });
    state.pc = pc;
    await buildPeer(pc, { slots: config.slots, micTrack, recvOnly: config.recvOnly, sink: config.sink });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    const res = await fetch('/offer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }),
    });
    const answer = await res.json();
    if (answer.error) { state.errors.push('answer: ' + answer.error); return { ok: false }; }
    await pc.setRemoteDescription(answer);
    return { ok: true };
  }

  async function runControl(config) {
    state.started = true;
    // 同一页面里的两个 PC 互连：这是本机唯一能拿到的「已知可用」WebRTC 音频基线。
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const senderPc = new RTCPeerConnection({ iceServers: [] });
    const receiverPc = new RTCPeerConnection({ iceServers: [] });
    state.pc = receiverPc;
    senderPc.addTransceiver(stream.getAudioTracks()[0], { direction: 'sendonly' });
    await buildPeer(receiverPc, { slots: 1, micTrack: null, recvOnly: true, sink: 'both' });
    senderPc.onicecandidate = (e) => { if (e.candidate) receiverPc.addIceCandidate(e.candidate).catch(() => {}); };
    receiverPc.onicecandidate = (e) => { if (e.candidate) senderPc.addIceCandidate(e.candidate).catch(() => {}); };
    const offer = await senderPc.createOffer();
    await senderPc.setLocalDescription(offer);
    await waitIce(senderPc);
    await receiverPc.setRemoteDescription(senderPc.localDescription);
    const answer = await receiverPc.createAnswer();
    await receiverPc.setLocalDescription(answer);
    await waitIce(receiverPc);
    await senderPc.setRemoteDescription(receiverPc.localDescription);
    return { ok: true, senderPc, receiverPc };
  }

  return {
    runWerift, runControl, snapshot, state,
    applySpeakerMap: (slots) => { state.speakerMap = slots; },
  };
})();
</script>
</body></html>`;

// ---------------------------------------------------------------- 服务端

const logger = {
  child: () => logger,
  info: (...args) => { if (process.env.PROBE_VERBOSE) console.log("[srv:info]", ...args); },
  warn: (...args) => console.log("[srv:warn]", ...args),
  error: (...args) => console.log("[srv:error]", ...args),
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  level: "info",
};

async function loadIceServers() {
  if (ICE_JSON) return JSON.parse(readFileSync(ICE_JSON, "utf8"));
  if (!RELAY_ONLY) return [];
  const res = await fetch(`${PROD_ORIGIN}/api/public-config`);
  if (!res.ok) throw new Error(`拿不到 public-config: ${res.status}`);
  const config = await res.json();
  console.log("已从生产 public-config 取到 iceServers:", JSON.stringify(config.iceServers?.map((s) => s.urls)));
  return config.iceServers ?? [];
}

async function runWeriftMode() {
  const ICE_SERVERS = await loadIceServers();
  const { WebRtcAudioSession } = await import("../src/server/webrtc-audio.js");
  const { SpeakerRegistry } = await import("../src/server/speaker-registry.js");

  const fixture = JSON.parse(readFileSync(join(here, "fixtures", "opus-20ms-440hz.json"), "utf8"));
  const frames = fixture.frames.map((f) => Buffer.from(f.data, "base64"));
  console.log(`Opus 夹具：${frames.length} 帧 × 20ms = ${(frames.length * 20 / 1000).toFixed(1)}s（来源：${fixture.source}）`);

  const session = new WebRtcAudioSession({
    connectionId: "probe",
    slotCount: SLOTS,
    logger,
    onVoiceFrame: () => {},
  });
  const registry = new SpeakerRegistry(SLOTS);
  const slotOwner = new Map();

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/offer") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        try {
          const offer = JSON.parse(body);
          const answer = await session.createAnswer({ type: offer.type, sdp: offer.sdp });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: answer.type, sdp: answer.sdp }));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error?.stack ?? error) }));
        }
      });
      return;
    }
    if (req.url === "/session-stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(session.getStats()));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  console.log(`本地页面: ${origin}`);

  const chrome = await launchChrome({ headful: HEADFUL });
  console.log(`Chrome: ${chrome.browserVersion} headful=${HEADFUL} sink=${SINK}`);
  try {
    await chrome.navigate(origin);
    const started = await chrome.session.evaluate(`return await window.__probe.runWerift(${JSON.stringify({ slots: SLOTS, recvOnly: false, sink: SINK, relayOnly: RELAY_ONLY, iceServers: ICE_SERVERS })})`);
    if (!started.ok) throw new Error("页面侧协商失败");
    await sleep(500);

    // 按 20ms 节拍喂真实 Opus 帧；--handover 时中途换说话人复用同一个 slot
    let index = 0;
    const startedAt = Date.now();
    let clientId = 60;
    let handoverAt = HANDOVER ? startedAt + Math.round(SECONDS * 1000 / 2) : Number.POSITIVE_INFINITY;
    const timer = setInterval(() => {
      if (Date.now() >= handoverAt) {
        handoverAt = Number.POSITIVE_INFINITY;
        registry.release(60);
        for (const [slot, owner] of [...slotOwner]) if (owner === 60) slotOwner.delete(slot);
        console.log("[handover] clientId 60 离开，改由 clientId 61 复用其 slot");
        clientId = 61;
      }
      const frame = frames[index % frames.length];
      const result = registry.ingest(clientId, frame);
      if (result) {
        if (slotOwner.get(result.slot) !== clientId) {
          slotOwner.set(result.slot, clientId);
          const stream = registry.streamOf(clientId);
          if (stream) session.assignSlot(result.slot, stream);
          console.log(`[slot ${result.slot}] 绑定 clientId=${clientId}`);
        }
        session.forward(result.slot, result.rtp);
      }
      index++;
    }, 20);

    // 把 slot → clientId 映射送进页面（等价于生产里的 speakerMap 消息）
    await sleep(SECONDS * 1000);
    clearInterval(timer);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    const serverStats = await (await fetch(`${origin}session-stats`)).json();
    const snap = await chrome.session.evaluate(`return await window.__probe.snapshot()`);
    report({ mode: "werift", elapsedSeconds: elapsed, serverStats, snap, chromeLogs: chrome.logs });
  } finally {
    await chrome.close();
    server.close();
    await session.close();
  }
}

async function runControlMode() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}/`;

  const chrome = await launchChrome({ headful: HEADFUL });
  console.log(`Chrome: ${chrome.browserVersion} headful=${HEADFUL} sink=${SINK}`);
  try {
    await chrome.navigate(origin);
    const started = await chrome.session.evaluate(`return await window.__probe.runControl(${JSON.stringify({ slots: 1 })})`);
    if (!started.ok) throw new Error("页面侧控制组协商失败");
    await sleep(SECONDS * 1000);
    const snap = await chrome.session.evaluate(`return await window.__probe.snapshot()`);
    report({ mode: "control", elapsedSeconds: SECONDS, snap, chromeLogs: chrome.logs });
  } finally {
    await chrome.close();
    server.close();
  }
}

function report({ mode, elapsedSeconds, serverStats, snap, chromeLogs }) {
  console.log(`\n================ 模式 ${mode} · ${elapsedSeconds}s ================`);
  if (serverStats) console.log("服务端:", JSON.stringify(serverStats));
  console.log("audioCtx:", snap.audioCtxState ?? "-", "| trackEvents:", snap.trackEvents, "| transceivers:", snap.transceiverCount);
  console.log(`SDP 体积: offer=${snap.offerSdpBytes}B answer=${snap.answerSdpBytes}B`);
  console.log("页面日志:", snap.logs.length ? "" : "(无)");
  for (const line of snap.logs) console.log("   ", line);
  if (snap.errors?.length) console.log("页面错误:", snap.errors);
  if (chromeLogs?.length) { console.log("浏览器控制台:"); for (const l of chromeLogs.slice(0, 20)) console.log("   ", l); }
  console.log("播放节点:");
  for (const s of snap.slots) {
    console.log(`   slot${s.slot} rms=${s.rms.toFixed(4)} audioEl(paused=${s.elPaused} t=${s.elCurrentTime} ready=${s.elReadyState})`);
  }
  console.log("inbound-rtp:");
  for (const i of snap.inbound ?? []) {
    console.log(`   mid=${i.mid} ssrc=${i.ssrc} codec=${i.codec}`);
    console.log(`      pkts=${i.packetsReceived} lost=${i.packetsLost} disc=${i.packetsDiscarded} bytes=${i.bytesReceived}`);
    console.log(`      samples=${i.totalSamplesReceived} concealed=${i.concealedSamples} inserted=${i.insertedSamplesForDeceleration} removed=${i.removedSamplesForAcceleration}`);
    console.log(`      jbEmitted=${i.jitterBufferEmittedCount} jbDelay=${i.jitterBufferDelay} audioLevel=${i.audioLevel} energy=${i.totalAudioEnergy}`);
  }
  console.log("outbound-rtp:", JSON.stringify(snap.outbound));
  console.log("media-playout:", JSON.stringify(snap.playout));
  console.log("本地候选:", JSON.stringify(snap.localCandidates));
  console.log("选中候选对:", JSON.stringify(snap.selectedPair));
  console.log("remote-inbound-rtp:", JSON.stringify(snap.remoteOutbound));
}

if (MODE === "werift") await runWeriftMode();
else await runControlMode();
