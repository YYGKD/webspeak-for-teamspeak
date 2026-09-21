/**
 * 极简 CDP 客户端 —— 用来驱动本机真实 Chrome 做 WebRTC 验证。
 *
 * 只依赖 Node 22+ 内置的全局 WebSocket，不引入新依赖。
 * 存在的理由：ZCode 内置浏览器无法做 WebRTC 音频验证（见交接文档坑 #1），
 * 而本机装有真实 Chrome，用 CDP 驱动它能得到与用户真机一致的结论。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error("找不到 Chrome/Edge 可执行文件；可用 CHROME_PATH 指定");
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`DevTools 端口 ${port} 在 ${timeoutMs}ms 内未就绪`);
}

/** 一个极小的 CDP 会话：只有一个页面 target，send() 走 promise。 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params);
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 在页面里求值并取回 JSON 结果。
   * 用 JSON.stringify 包一层是为了让 CDP 的 returnByValue 能原样带回对象。
   */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression: `(async () => JSON.stringify(await (async () => { ${expression} })()))()`,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面内异常: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    const raw = result.result?.value;
    if (raw === undefined) throw new Error("页面求值没有返回可序列化的值");
    return JSON.parse(raw);
  }
}

/**
 * 启动一个真实 Chrome 并返回会话。
 *
 * 默认 headless=new —— 已验证它能跑完整 WebRTC（含 WebCodecs 编解码），
 * 而且不会弹出窗口打扰用户。需要真音频输出设备做播放验证时传 headful: true。
 */
export async function launchChrome({
  headful = false,
  port = 9333 + Math.floor(Math.random() * 400),
  extraArgs = [],
  profileDir = null,
} = {}) {
  const executable = findChrome();
  const profile = profileDir ?? mkdtempSync(join(tmpdir(), "webspeak-cdp-"));
  const args = [
    headful ? "--headless=false" : "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // 合成麦克风：sendrecv 的 m-line 需要一条音轨，否则 Chrome 不会建立上行。
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    ...extraArgs,
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: "ignore", detached: false });
  const version = await waitForDevTools(port, 20_000);

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("Chrome 没有可用的 page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
  });
  const session = new CdpSession(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Console.enable").catch(() => undefined);

  const logs = [];
  session.on("Runtime.consoleAPICalled", (params) => {
    logs.push(`${params.type}: ${params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  });
  session.on("Runtime.exceptionThrown", (params) => {
    logs.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`);
  });

  return {
    browserVersion: version.Browser,
    logs,
    session,
    /** 截当前视口的整页图（用于改动前后的视觉核对）。 */
    async screenshot(filePath) {
      const result = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      writeFileSync(filePath, Buffer.from(result.data, "base64"));
      return filePath;
    },
    async navigate(url) {
      const loaded = new Promise((resolve) => session.on("Page.loadEventFired", resolve));
      await session.send("Page.navigate", { url });
      await loaded;
    },
    async close() {
      try { ws.close(); } catch { /* 已断开 */ }
      try { child.kill(); } catch { /* 已退出 */ }
      if (!profileDir) {
        await new Promise((r) => setTimeout(r, 400));
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 上偶发占用 */ }
      }
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
