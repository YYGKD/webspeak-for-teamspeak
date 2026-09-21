/**
 * 定论实验：网关 `stop()` 的两段关闭语义到底哪一段会卡住。
 *
 * 生产现象：`systemctl restart webspeak` 挂满 TimeoutStopSec=90s 后被 SIGKILL
 * （`State 'stop-sigterm' timed out`）。`webServer.stop()` 依次做两件事：
 *   1. `await voiceBridge.shutdown()` → 内含 `await wss.close(cb)`
 *   2. `await new Promise(r => server.close(() => r()))`
 * 两处的回调都"只在连接全部关闭后才触发"，反代/SSH 隧道的 keep-alive 长连接
 * 和残留的 WS 客户端都可能让回调永不触发。
 *
 * 本脚本用最小复现逐项测出哪一段会挂，作为修复依据与回归测试。
 *
 * 用法：node scripts/shutdown-semantics.mjs
 */
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const PROBE_TIMEOUT_MS = 3000;

/** 在 timeoutMs 内等 promise；超时返回 "TIMEOUT"。 */
const raceTimeout = (promise, timeoutMs = PROBE_TIMEOUT_MS) =>
  Promise.race([promise, new Promise((r) => setTimeout(() => r("TIMEOUT"), timeoutMs))]);

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

async function caseHttpClose({ holdConnection }) {
  const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  const port = await listen(server);
  let held = null;
  if (holdConnection) {
    held = createConnection({ host: "127.0.0.1", port });
    await new Promise((r) => held.once("connect", r));
    // 建立一条 keep-alive 长连接（不发请求，纯占位 —— 等价于隧道那种常驻连接）
  }
  const result = await raceTimeout(new Promise((resolve) => server.close(() => resolve("CLOSED"))));
  held?.destroy();
  server.closeAllConnections?.();
  return result;
}

/**
 * 候选修法：先 closeIdleConnections()，再用 2s 兜底 closeAllConnections()。
 * 这是 src/server/server.ts 里 stop() 实际采用的写法。
 * `kind` 区分连接形态：'idle-keepalive' 是反代那种"发过请求、之后空闲"的长连接；
 * 'raw' 是连上但一个字节都没发的裸连接。
 */
async function caseHttpCloseWithFix({ kind }) {
  const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  const port = await listen(server);
  let held = null;
  if (kind === "idle-keepalive") {
    // 用 keepAlive Agent 发一次请求，让连接完成请求后**空闲**下来
    // —— 这正是反向代理 / SSH 隧道持有的那种长连接形态。
    const http = await import("node:http");
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/health", agent }, (res) => {
        res.resume();
        res.once("end", resolve);
      });
      req.once("error", resolve);
      req.end();
    });
    held = agent;
  } else if (kind === "raw") {
    held = createConnection({ host: "127.0.0.1", port });
    await new Promise((r) => held.once("connect", r));
  }
  const result = await raceTimeout(new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve("CLOSED"); } };
    const timer = setTimeout(() => { server.closeAllConnections?.(); finish(); }, 2000);
    server.close(finish);
    server.closeIdleConnections?.();
  }), 5000);
  held?.destroy?.();
  server.closeAllConnections?.();
  return result;
}

async function caseWssClose({ holdClient }) {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws/voice" });
  const port = await listen(server);
  let client = null;
  if (holdClient) {
    client = new WebSocket(`ws://127.0.0.1:${port}/ws/voice`);
    await new Promise((r, j) => { client.once("open", r); client.once("error", j); });
  }
  const result = await raceTimeout(new Promise((resolve) => wss.close(() => resolve("CLOSED"))));
  client?.terminate();
  server.closeAllConnections?.();
  return result;
}

async function caseWssCloseAfterTerminate() {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws/voice" });
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/voice`);
  await new Promise((r, j) => { client.once("open", r); client.once("error", j); });
  const closed = new Promise((resolve) => wss.close(() => resolve("CLOSED")));
  // 候选修法：先强制断开所有残留客户端，再等 close 回调
  for (const socket of wss.clients) socket.terminate();
  const result = await raceTimeout(closed);
  server.closeAllConnections?.();
  return result;
}

console.log(`node ${process.version} · ws ${(await import("ws/package.json", { with: { type: "json" } })).default.version}`);
console.log("");
console.log("1) server.close()  无连接                →", await caseHttpClose({ holdConnection: false }));
console.log("2) server.close()  有常驻连接            →", await caseHttpClose({ holdConnection: true }), "  ← 隧道场景，会挂");
console.log("3) wss.close()     无客户端              →", await caseWssClose({ holdClient: false }));
console.log("4) wss.close()     有残留客户端          →", await caseWssClose({ holdClient: true }), "  ← 会挂");
console.log("5) wss.close()     先 terminate          →", await caseWssCloseAfterTerminate(), "  ← voice-bridge 采用的修法");
console.log("6) server.stop()修法  空闲 keep-alive 连接 →", await caseHttpCloseWithFix({ kind: "idle-keepalive" }), "  ← server.ts 采用的修法");
console.log("7) server.stop()修法  裸连接              →", await caseHttpCloseWithFix({ kind: "raw" }), "  ← 兜底 2s 后强制关闭");
console.log("");
console.log("（TIMEOUT 表示回调在超时内没有触发 = 会卡住）");
