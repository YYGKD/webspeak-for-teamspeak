/**
 * 合成语音源：连上网关、进入指定频道、持续发送 Opus 语音。
 *
 * 用途：在浏览器实测时充当"第二个说话人"，用来验证 SFU 的下行转发。
 *
 * 用法：node scripts/sfu-speak.mjs [baseUrl] [channelId] [seconds]
 */
import { createRequire } from "node:module";
import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket } from "werift";

const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus");

const BASE = process.argv[2] ?? "http://127.0.0.1:3040";
const CHANNEL = Number(process.argv[3] ?? 1);
const SECONDS = Number(process.argv[4] ?? 30);

const res = await fetch(`${BASE}/api/join-ticket`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE, accept: "application/json" },
  body: JSON.stringify({ nickname: "WebSpeak-测试语音源" }),
});
const { ticket } = await res.json();

const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/voice?ticket=${encodeURIComponent(ticket)}`);
const queue = [];
let pending = null;
ws.addEventListener("message", (e) => {
  if (typeof e.data !== "string") return;
  const msg = JSON.parse(e.data);
  if (pending) { const r = pending; pending = null; r(msg); } else queue.push(msg);
});
const next = (ms = 20000) => new Promise((resolve, reject) => {
  if (queue.length) return resolve(queue.shift());
  const t = setTimeout(() => { pending = null; reject(new Error("timeout")); }, ms);
  pending = (m) => { clearTimeout(t); resolve(m); };
});
await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", () => j(new Error("ws error")), { once: true }); });

let connected = null;
for (let i = 0; i < 20 && !connected; i++) {
  const m = await next();
  if (m.type === "connected") connected = m;
  else if (m.type === "connectionFailed") throw new Error(m.code);
}
const slots = connected.webrtcSlotCount ?? 8;
console.log(`已连接 TS clid=${connected.tsClientId}，slot 数=${slots}`);

const peer = new RTCPeerConnection({ iceServers: [] });
const outgoing = new MediaStreamTrack({ kind: "audio" });
const senders = [];
for (let s = 0; s < slots; s++) {
  const tx = s === 0 ? peer.addTransceiver(outgoing, { direction: "sendrecv" }) : peer.addTransceiver("audio", { direction: "recvonly" });
  senders.push(tx.sender);
}
const offer = await peer.createOffer();
await peer.setLocalDescription(offer);
await new Promise((r) => { if (peer.iceGatheringState === "complete") return r(); const t = setTimeout(r, 5000); peer.iceGatheringStateChange.subscribe(() => { if (peer.iceGatheringState === "complete") { clearTimeout(t); r(); } }); });
const ld = peer.localDescription;
ws.send(JSON.stringify({ type: "webrtcOffer", payload: { sdp: { type: ld.type, sdp: ld.sdp }, muted: false, accompanimentActive: false } }));
for (;;) {
  const m = await next();
  if (m.type === "webrtcAnswer") { await peer.setRemoteDescription(m.payload.sdp); break; }
  if (m.type === "webrtcError") throw new Error(m.code);
}
console.log("协商完成，进入频道…");

// 进入指定频道（普通客户端可以移动自己）
ws.send(JSON.stringify({ type: "switchChannel", payload: { channelId: String(CHANNEL) } }));
await new Promise((r) => setTimeout(r, 1500));

const encoder = new OpusEncoder(48000, 1);
const FRAME = 960;
let phase = 0, seq = 1, ts = 0, sent = 0;
const timer = setInterval(() => {
  const pcm = Buffer.allocUnsafe(FRAME * 2);
  for (let i = 0; i < FRAME; i++) {
    const t = (phase + i) / 48000;
    let s = 0;
    for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * 220 * h * t) / h;
    s = (s / 3) * 0.35;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  phase += FRAME;
  const packet = new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq++ & 0xffff, timestamp: ts >>> 0, ssrc: 0x5aa5aa5a, marker: true }), encoder.encode(pcm));
  ts = (ts + FRAME) >>> 0;
  void senders[0].sendRtp(packet.serialize()).catch(() => {});
  sent++;
}, 20);

console.log(`持续发送语音 ${SECONDS} 秒…`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);
console.log(`发送结束，共 ${sent} 帧`);
ws.close();
await peer.close();
process.exit(0);
