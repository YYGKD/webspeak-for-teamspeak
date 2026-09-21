/**
 * 复现/验证网关优雅退出：SIGTERM 后能不能在几秒内退出。
 *
 * 背景：生产上 `systemctl restart webspeak` 会挂满 90 秒被 SIGKILL
 * （`State 'stop-sigterm' timed out`）。原因是反代/SSH 隧道会长期持有
 * keep-alive 连接，而 `webServer.stop()` 结尾的 `server.close(cb)` 只在
 * 所有连接关闭后才回调 —— 回调永不触发，`process.exit(0)` 永不执行。
 *
 * 用法：
 *   node scripts/shutdown-probe.mjs            # 无外部连接（基线）
 *   node scripts/shutdown-probe.mjs --hold     # 先挂一条常驻 TCP 连接再发 SIGTERM
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOLD = process.argv.includes("--hold");
// 端口是 src/constants.ts 里的常量（3040），不接受环境变量覆盖，所以本地跑
// 需要 3040 空闲。config.json 已被 .gitignore 忽略，服务自建不会污染仓库。
const PORT = 3040;
const dataDir = mkdtempSync(join(tmpdir(), "webspeak-shutdown-"));

const child = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, WEBSPEAK_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (c) => { output += c; });
child.stderr.on("data", (c) => { output += c; });

const waitForPort = async (timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/health`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
};

const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

if (!(await waitForPort())) {
  console.log("服务未能在 15s 内起来；输出：\n" + output.slice(-2000));
  child.kill("SIGKILL");
  process.exit(1);
}
console.log(`服务已就绪 :${PORT}（dataDir=${dataDir}）`);

let held = null;
if (HOLD) {
  held = createConnection({ host: "127.0.0.1", port: PORT }, () => {
    // 发一个请求但不关闭连接 —— 复刻反代/SSH 隧道的 keep-alive 长连接
    held.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
  });
  await new Promise((r) => setTimeout(r, 1000));
  console.log("已挂一条常驻 keep-alive 连接");
}

const startedAt = Date.now();
child.kill("SIGTERM");
const result = await Promise.race([
  exited,
  new Promise((r) => setTimeout(() => r("TIMEOUT"), 20000)),
]);
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

if (result === "TIMEOUT") {
  console.log(`✗ SIGTERM 后 20s 仍未退出 —— 复现了 90s 挂起（本次耗时 >${elapsed}s）`);
  console.log("最后输出：\n" + output.split("\n").slice(-12).join("\n"));
  held?.destroy();
  child.kill("SIGKILL");
  process.exitCode = 1;
} else {
  console.log(`✓ SIGTERM 后 ${elapsed}s 退出（code=${result.code} signal=${result.signal}）`);
  console.log("最后输出：\n" + output.split("\n").slice(-8).join("\n"));
  held?.destroy();
}
