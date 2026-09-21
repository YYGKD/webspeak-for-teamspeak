/**
 * SFU 端到端验证：两个真实会话，A 发合成语音，B 观察是否收到。
 *
 * 覆盖完整环路：
 *   A(werift) → 网关A → TS 服务器 → 网关B → B 的 slot
 *
 * 单客户端测不出来 —— 网关不会把音频回送给发送者本人，而且频道静音时
 * SFU 不转发任何东西（这正是它与 MCU 的区别）。
 *
 * 用法：node scripts/sfu-e2e.mjs [baseUrl]
 */
import { createRequire } from "node:module";
import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useSdesMid, useTransportWideCC } from "werift";

// 模拟真实浏览器：声明 MID 等扩展头。不声明的话协商结果为空，
// 服务端就不会在 RTP 上写扩展 —— 测不出浏览器的真实情况。
const CLIENT_HEADER_EXTENSIONS = { audio: [useSdesMid(), useTransportWideCC()], video: [] };

const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus");

const BASE = process.argv[2] ?? "http://127.0.0.1:3040";
const SEND_MS = Number(process.env.SEND_MS ?? 10_000);
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 8_000);

const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`✓ ${m}`);

/** 建立一个完整的网关会话（ticket + WS + SDP 协商）。 */
async function openSession(label) {
  const res = await fetch(`${BASE}/api/join-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, accept: "application/json" },
    body: JSON.stringify({ nickname: `${label}-${Date.now() % 10000}` }),
  });
  if (!res.ok) throw new Error(`${label}: join-ticket HTTP ${res.status}`);
  const { ticket } = await res.json();

  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/voice?ticket=${encodeURIComponent(ticket)}`);
  const queue = [];
  let pending = null;
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const msg = JSON.parse(e.data);
    if (pending) { const r = pending; pending = null; r(msg); } else queue.push(msg);
  });
  const next = (timeoutMs = 20000) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => { pending = null; reject(new Error(`${label}: 等待消息超时`)); }, timeoutMs);
    pending = (msg) => { clearTimeout(timer); resolve(msg); };
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`${label}: ws error`)), { once: true });
    setTimeout(() => reject(new Error(`${label}: ws open timeout`)), 15000);
  });

  let connected = null;
  for (let i = 0; i < 20 && !connected; i++) {
    const msg = await next();
    if (msg.type === "connected") connected = msg;
    else if (msg.type === "connectionFailed") throw new Error(`${label}: ${msg.code}`);
  }
  if (!connected) throw new Error(`${label}: 未收到 connected`);

  const slots = connected.webrtcSlotCount ?? 8;
  const peer = new RTCPeerConnection({ iceServers: [], headerExtensions: CLIENT_HEADER_EXTENSIONS });
  const outgoing = new MediaStreamTrack({ kind: "audio" });
  const senders = [];
  for (let slot = 0; slot < slots; slot++) {
    const transceiver = slot === 0
      ? peer.addTransceiver(outgoing, { direction: "sendrecv" })
      : peer.addTransceiver("audio", { direction: "recvonly" });
    senders.push(transceiver.sender);
  }

  const stats = { rtp: 0, tracks: 0, speakerMap: null, bySlot: new Map(), decoded: 0, decodeErrors: 0, peakRms: 0, headerDump: [] };
  peer.getTransceivers().forEach((transceiver, slot) => {
    transceiver.onTrack.subscribe((track) => {
      stats.tracks++;
      track.onReceiveRtp.subscribe((rtp) => {
        if (stats.headerDump.length < 6) {
          stats.headerDump.push({
            slot,
            seq: rtp.header.sequenceNumber,
            ts: rtp.header.timestamp,
            ssrc: rtp.header.ssrc,
            pt: rtp.header.payloadType,
            marker: rtp.header.marker,
            exts: (rtp.header.extensions ?? []).map((e) => `${e.id}:${String(e.payload).slice(0, 12)}`),
            payloadBytes: rtp.payload.length,
          });
        }
        stats.rtp++;
        stats.bySlot.set(slot, (stats.bySlot.get(slot) ?? 0) + 1);
        // 真正解码，判断负载是否有效（只数包会漏掉"收得到但解不出"）
        try {
          const pcm = decoder.decode(Buffer.from(rtp.payload));
          let sum = 0;
          const n = Math.floor(pcm.length / 2);
          for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
          const rms = n ? Math.sqrt(sum / n) : 0;
          if (rms > stats.peakRms) stats.peakRms = rms;
          stats.decoded++;
        } catch (e) { stats.decodeErrors++; }
      });
    });
  });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, 5000);
    peer.iceGatheringStateChange.subscribe(() => {
      if (peer.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
    });
  });
  const ld = peer.localDescription;
  ws.send(JSON.stringify({ type: "webrtcOffer", payload: { sdp: { type: ld.type, sdp: ld.sdp }, muted: false, accompanimentActive: false } }));

  let answered = false;
  while (!answered) {
    const msg = await next();
    if (msg.type === "webrtcAnswer") { await peer.setRemoteDescription(msg.payload.sdp); answered = true; }
    else if (msg.type === "webrtcError") throw new Error(`${label}: ${msg.code}`);
  }

  // 后台消费 speakerMap
  const drain = setInterval(() => {
    while (queue.length) {
      const msg = queue.shift();
      if (msg.type === "speakerMap") stats.speakerMap = msg.slots;
    }
  }, 200);

  return { label, ws, peer, senders, slots, stats, close: () => { clearInterval(drain); ws.close(); return peer.close(); } };
}

// ---------------------------------------------------------------- 发送端
const encoder = new OpusEncoder(48000, 1);
const decoder = new OpusEncoder(48000, 1); // @discordjs/opus 的解码器就是同一个类
const FRAME_SAMPLES = 960;
let phase = 0;
function nextOpusFrame() {
  const pcm = Buffer.allocUnsafe(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (phase + i) / 48000;
    let s = 0;
    for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * 220 * h * t) / h;
    s = (s / 3) * 0.35;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  phase += FRAME_SAMPLES;
  return encoder.encode(pcm);
}

console.log("建立两个会话…");
const sender = await openSession("SFU-Send");
const observer = await openSession("SFU-Obs");
ok(`A=${sender.label} slots=${sender.slots} | B=${observer.label} slots=${observer.slots}`);

// A 在 slot0 上持续发送 20ms Opus 帧
let seq = 1000;
let ts = 0;
const sendTimer = setInterval(() => {
  const opus = nextOpusFrame();
  const packet = new RtpPacket(new RtpHeader({
    payloadType: 111, sequenceNumber: seq++ & 0xffff, timestamp: ts >>> 0, ssrc: 0x12345678, marker: true,
  }), opus);
  ts = (ts + FRAME_SAMPLES) >>> 0;
  void sender.senders[0].sendRtp(packet.serialize()).catch(() => {});
}, 20);

console.log(`A 持续发送语音 ${SEND_MS / 1000} 秒…`);
await new Promise((r) => setTimeout(r, SEND_MS));
clearInterval(sendTimer);
console.log(`A 发送完毕，B 再观察 ${OBSERVE_MS / 1000} 秒…`);
await new Promise((r) => setTimeout(r, OBSERVE_MS));

// ---------------------------------------------------------------- 结果
console.log("\n========== 结果 ==========");
console.log(`A 发送: ${seq - 1000} 帧 Opus`);
console.log(`B 收到: ${observer.stats.rtp} 帧 RTP，${observer.stats.tracks} 路 track`);
console.log(`B 解码: ${observer.stats.decoded} 帧成功 / ${observer.stats.decodeErrors} 失败，峰值 RMS = ${observer.stats.peakRms.toFixed(0)}`);
console.log("前 6 个 RTP 头:");
for (const h of observer.stats.headerDump) console.log("  " + JSON.stringify(h));
console.log(`B 的 speakerMap: ${observer.stats.speakerMap ? JSON.stringify(observer.stats.speakerMap) : "(无)"}`);
for (const [slot, n] of [...observer.stats.bySlot].sort((a, b) => a[0] - b[0])) {
  console.log(`  slot${slot}: ${n} 帧`);
}

if (observer.stats.rtp > 0) ok(`SFU 转发成功：B 收到 ${observer.stats.rtp} 帧`);
else fail("B 没有收到任何 RTP —— SFU 转发未生效");
if (observer.stats.speakerMap) ok("speakerMap 已下发（浏览器能知道 slot 归属）");
else fail("没有收到 speakerMap");
console.log(`B 连接状态: ${observer.peer.connectionState}`);

await sender.close();
await observer.close();
process.exit(process.exitCode ?? 0);
