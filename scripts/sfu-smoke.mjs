/**
 * SFU 验证客户端（不依赖浏览器）。
 *
 * 走完真实链路：取 join ticket → 连 /ws/voice → 用 K 条 audio m-line 发起
 * offer → 收 answer → 检查 SDP 与收到的 RTP。用来在动前端之前暴露服务端问题。
 *
 * 用法：node scripts/sfu-smoke.mjs [baseUrl] [slotCount]
 */
import { RTCPeerConnection, MediaStreamTrack, useOPUS, usePCMU } from "werift";

// 模拟真实浏览器：Chrome 的 opus 默认带 rtcp-fb nack / transport-cc。
// 服务端的 answer 会从 offer 的 codecs 过滤而来，所以客户端不声明就测不出来。
const CLIENT_AUDIO_CODECS = [
  useOPUS({ rtcpFeedback: [{ type: "nack" }, { type: "transport-cc" }] }),
  usePCMU(),
];

const BASE = process.argv[2] ?? "http://127.0.0.1:3040";
const SLOTS = Number(process.argv[3] ?? 8);
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 15_000);

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✓ ${msg}`);

// --- 1. 取 join ticket -------------------------------------------------
const ticketResponse = await fetch(`${BASE}/api/join-ticket`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: BASE,
    accept: "application/json",
  },
  body: JSON.stringify({ nickname: `SFU-Smoke-${Date.now() % 10000}` }),
});
if (!ticketResponse.ok) {
  fail(`join-ticket HTTP ${ticketResponse.status}: ${await ticketResponse.text()}`);
  process.exit(1);
}
const { ticket } = await ticketResponse.json();
ok(`取得 join ticket (${ticket.slice(0, 10)}…)`);

// --- 2. 连 /ws/voice ---------------------------------------------------
const wsUrl = BASE.replace(/^http/, "ws") + `/ws/voice?ticket=${encodeURIComponent(ticket)}`;
const ws = new WebSocket(wsUrl);
const jsonQueue = [];
let resolveJson = null;
ws.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  const msg = JSON.parse(event.data);
  if (resolveJson) { const r = resolveJson; resolveJson = null; r(msg); }
  else jsonQueue.push(msg);
});
const nextJson = (timeoutMs = 15000) => new Promise((resolve, reject) => {
  if (jsonQueue.length) return resolve(jsonQueue.shift());
  const timer = setTimeout(() => { resolveJson = null; reject(new Error("timeout")); }, timeoutMs);
  resolveJson = (msg) => { clearTimeout(timer); resolve(msg); };
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  setTimeout(() => reject(new Error("ws open timeout")), 15000);
});
ok("WebSocket 已连接");

// --- 3. 等 connected ---------------------------------------------------
let connected = null;
for (let i = 0; i < 20 && !connected; i++) {
  const msg = await nextJson(20000);
  if (msg.type === "connected") connected = msg;
  else if (msg.type === "connectionFailed") { fail(`连接失败: ${msg.code}`); process.exit(1); }
}
if (!connected) { fail("未收到 connected"); process.exit(1); }
ok(`已连接 TS：tsClientId=${connected.tsClientId} webrtcAvailable=${connected.webrtcAvailable} webrtcSlotCount=${connected.webrtcSlotCount}`);

if (connected.webrtcSlotCount !== undefined && connected.webrtcSlotCount !== SLOTS) {
  console.log(`  (服务端 slot 数 = ${connected.webrtcSlotCount}，本脚本按 ${SLOTS} 发起 offer)`);
}
const slots = connected.webrtcSlotCount ?? SLOTS;

// --- 4. 发起 offer -----------------------------------------------------
const peer = new RTCPeerConnection({ iceServers: [], codecs: { audio: CLIENT_AUDIO_CODECS } });
const outgoing = new MediaStreamTrack({ kind: "audio" });
const transceivers = [];
for (let slot = 0; slot < slots; slot++) {
  const transceiver = slot === 0
    ? peer.addTransceiver(outgoing, { direction: "sendrecv" })
    : peer.addTransceiver("audio", { direction: "recvonly" });
  transceivers.push(transceiver);
}
let receivedTracks = 0;
let receivedRtp = 0;
peer.getTransceivers().forEach((transceiver, index) => {
  transceiver.onTrack.subscribe((track) => {
    receivedTracks++;
    track.onReceiveRtp.subscribe(() => { receivedRtp++; });
    console.log(`  slot${index} 收到 track (ssrc=${track.ssrc ?? "?"})`);
  });
});

const offer = await peer.createOffer();
await peer.setLocalDescription(offer);
// ICE gathering（无 STUN，host candidate 即可）
await new Promise((resolve) => {
  if (peer.iceGatheringState === "complete") return resolve();
  const timer = setTimeout(resolve, 5000);
  peer.iceGatheringStateChange.subscribe?.(() => {});
  peer.iceGatheringStateChange.subscribe(() => {
    if (peer.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
  });
});
const localDescription = peer.localDescription;
ws.send(JSON.stringify({
  type: "webrtcOffer",
  payload: { sdp: { type: localDescription.type, sdp: localDescription.sdp }, muted: false, accompanimentActive: false },
}));
ok(`offer 已发送（${slots} 条 m-line）`);

// --- 5. 等 answer ------------------------------------------------------
let answer = null;
for (let i = 0; i < 30 && !answer; i++) {
  const msg = await nextJson(20000);
  if (msg.type === "webrtcAnswer") answer = msg;
  else if (msg.type === "webrtcError") { fail(`服务端协商失败: ${msg.code}`); process.exit(1); }
  else if (msg.type === "speakerMap") console.log(`  speakerMap: ${JSON.stringify(msg.slots)}`);
}
if (!answer) { fail("未收到 webrtcAnswer"); process.exit(1); }
await peer.setRemoteDescription(answer.payload.sdp);
ok("answer 已应用");

// --- 6. 检查 SDP -------------------------------------------------------
const sdp = answer.payload.sdp.sdp;
const mAudio = (sdp.match(/^m=audio /gm) ?? []).length;
const rtcpFbNack = /a=rtcp-fb:\d+\s+nack/.test(sdp);
const rtcpFbTwcc = /a=rtcp-fb:\d+\s+transport-cc/.test(sdp);
console.log(`\nanswer SDP: ${mAudio} 条 m=audio，nack=${rtcpFbNack}，transport-cc=${rtcpFbTwcc}`);
if (process.env.DUMP_SDP === "1") {
  console.log("\n--- 首条 m=audio 段 ---");
  const first = sdp.split(/^m=audio /m)[1];
  console.log("m=audio " + first.split(/^m=/m)[0].trim());
  console.log("\n--- 所有 rtcp-fb 行 ---");
  for (const line of sdp.split("\n").filter((l) => l.includes("rtcp-fb"))) console.log(line.trim());
  console.log("\n--- offer 里的 rtcp-fb 行 ---");
  for (const line of localDescription.sdp.split("\n").filter((l) => l.includes("rtcp-fb"))) console.log(line.trim());
}
if (mAudio === slots) ok(`m-line 数量与 slot 数一致 (${mAudio})`);
else fail(`m-line 数量不符：期望 ${slots}，实际 ${mAudio}`);
if (rtcpFbNack) ok("协商出 NACK（丢包重传可用）");
else fail("SDP 里没有 rtcp-fb nack —— 丢包不会重传");
if (rtcpFbTwcc) ok("协商出 transport-cc（拥塞控制可用）");
else console.log("  ⚠ 没有 transport-cc，拥塞控制不可用（非致命）");

// --- 7. 观察 RTP -------------------------------------------------------
console.log(`\n观察 ${OBSERVE_MS / 1000} 秒 RTP…`);
const startedAt = Date.now();
let lastSpeakerMap = null;
const poll = setInterval(() => {
  // 消费剩余消息
  while (jsonQueue.length) {
    const msg = jsonQueue.shift();
    if (msg.type === "speakerMap") lastSpeakerMap = msg.slots;
    if (msg.type === "voiceActivity") { /* SFU 下服务端不再发 */ }
  }
}, 200);
await new Promise((resolve) => setTimeout(resolve, OBSERVE_MS));
clearInterval(poll);

console.log(`\n结果：收到 track ${receivedTracks} 路，RTP 帧 ${receivedRtp} 帧`);
console.log(`最后的 speakerMap: ${lastSpeakerMap ? JSON.stringify(lastSpeakerMap) : "(无)"}`);
if (receivedTracks > 0) ok("至少建立了一路下行 track");
else console.log("  ⚠ 没有收到 track —— 可能当前频道里没人说话（属正常，不一定是缺陷）");
console.log(`连接状态: ${peer.connectionState}`);

ws.close();
await peer.close();
process.exit(process.exitCode ?? 0);
