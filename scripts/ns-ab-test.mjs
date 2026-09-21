/**
 * 降噪 A/B：四种配置 × 两种测试信号，量"真正发出去的那路音频"。
 *
 * 四种配置（都能靠注入到达，不需要改 App 设置）：
 *   none      无降噪        getUserMedia noiseSuppression=false + 阻断 RNNoise 资源
 *   webrtc    只 WebRTC NS  noiseSuppression=true  + 阻断 RNNoise 资源
 *   rnnoise   只 RNNoise    noiseSuppression=false + RNNoise 正常
 *   both      两级串联      noiseSuppression=true  + RNNoise 正常（App 默认）
 *
 * 两种信号：纯噪声 / 纯语音。**全部相对 none 基线比较**，这样未知的输入增益被消掉：
 *   噪声抑制(dB) = 20log10(该配置噪声RMS / 基线噪声RMS)   —— 越负越好
 *   语音变化(dB) = 20log10(该配置语音RMS / 基线语音RMS)   —— 越接近 0 越好（掉了说明在吃语音）
 *
 * 测量点在浏览器侧：包一层 WebSocket.prototype.send，直接累加 App 发出的 PCM 的平方和
 * （不发音频本身，只回传统计量）。用 WS 兼容通道是因为它发的是裸 PCM，好算；
 * 而降噪链在 WebRTC/WS 两条路的**分叉点之前**，所以测到的是同一套处理。
 *
 * 用法：
 *   node scripts/make-ns-fixtures.mjs <sapi语音.wav>     # 先生成两个测试 wav
 *   npx tsx scripts/ns-ab-test.mjs                        # 再跑对比
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { launchChrome, sleep } from "./lib/cdp.mjs";
import { ORIGIN, joinAs } from "./lib/app-session.mjs";

const DIR = process.env.NS_DIR ?? "C:/Users/zyy/AppData/Local/Temp/nstest";
if (process.env.NS_SAVE) mkdirSync(process.env.NS_SAVE, { recursive: true });
const NOISE_WAV = `${DIR}/noise_only.wav`;
const SPEECH_WAV = `${DIR}/speech_only.wav`;
const CHANNEL = process.env.NS_CHANNEL ?? "";
const CAPTURE_MS = Number(process.env.NS_CAPTURE_MS ?? 9000);

/** 四种配置。forceNs 为 null 表示不改写 getUserMedia 约束（保持 App 默认 true）。 */
const CONFIGS = [
  { id: "none", label: "无降噪", forceNs: false, blockRnnoise: true },
  { id: "webrtc", label: "只 WebRTC NS", forceNs: true, blockRnnoise: true },
  { id: "rnnoise", label: "只 RNNoise", forceNs: false, blockRnnoise: false },
  { id: "both", label: "两级串联（默认）", forceNs: null, blockRnnoise: false },
];

function buildInjection(forceNs) {
  return `
    (() => {
      // 1) 强制走 WS 兼容通道，好拿到裸 PCM
      try { delete window.RTCPeerConnection; } catch (e) {}
      Object.defineProperty(window, "RTCPeerConnection", { value: undefined, configurable: true });

      // 2b) 在 VAD 门限**之前**取样本：App 的 VAD 在 handleCaptureChunk 里判断，
      //     而 worklet 是先 port.postMessage 再判断的。额外挂一个 port 监听即可拿到
      //     未经门限的降噪输出 —— 否则残余落到门限以下就只剩"全部静音"这个下界。
      window.__nsPre = { n: 0, sum2: 0, chunks: 0, peak: 0, belowGate: 0 };
      const VAD_THRESHOLD = 0.008;   // 与 App 的 voxThreshold 默认值一致
      // NS_SAVE 时额外留下实际样本，用于导出 wav 让人耳判定 artifact（RMS 测不出失真）
      window.__nsKeep = ${process.env.NS_SAVE ? "[]" : "null"};
      try {
        const Orig = window.AudioWorkletNode;
        const Patched = function (...args) {
          const node = new Orig(...args);
          try {
            node.port.addEventListener("message", (ev) => {
              const s = ev && ev.data ? ev.data.samples : null;
              if (s instanceof Float32Array) {
                const acc = window.__nsPre;
                for (let i = 0; i < s.length; i++) {
                  const v = s[i];
                  acc.sum2 += v * v;
                  const a = v < 0 ? -v : v;
                  if (a > acc.peak) acc.peak = a;
                }
                acc.n += s.length;
                acc.chunks++;
                // 复刻 App 的 VAD 判据：这一块会不会被门限吃掉
                let chunkSum = 0;
                for (let i = 0; i < s.length; i++) chunkSum += s[i] * s[i];
                if (Math.sqrt(chunkSum / s.length) < VAD_THRESHOLD) acc.belowGate++;
                if (window.__nsKeep && acc.n < 48000 * 12) window.__nsKeep.push(s.slice());
              }
            });
          } catch (e) {}
          return node;
        };
        Patched.prototype = Orig.prototype;
        window.AudioWorkletNode = Patched;
      } catch (e) {}

      // 2) 累加 App 发出的 PCM 帧（只回传统计量，不回传音频）
      window.__ns = { n: 0, sum2: 0, frames: 0, peak: 0 };
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          if (data instanceof ArrayBuffer) {
            const s = new Int16Array(data);
            const acc = window.__ns;
            for (let i = 0; i < s.length; i++) {
              const v = s[i] / 32768;
              acc.sum2 += v * v;
              const a = v < 0 ? -v : v;
              if (a > acc.peak) acc.peak = a;
            }
            acc.n += s.length;
            acc.frames++;
          }
        } catch (e) {}
        return origSend.call(this, data);
      };

      // 3) 按配置改写 getUserMedia 的 noiseSuppression 约束
      const force = ${forceNs === null ? "null" : JSON.stringify(forceNs)};
      if (force !== null) {
        const md = navigator.mediaDevices;
        const orig = md.getUserMedia.bind(md);
        md.getUserMedia = (constraints) => {
          const c = constraints ? { ...constraints } : {};
          const audio = c.audio && typeof c.audio === "object" ? { ...c.audio } : {};
          audio.noiseSuppression = force;
          c.audio = audio;
          return orig(c);
        };
      }
    })();
  `;
}

async function runOnce(config, wavPath, tag) {
  const chrome = await launchChrome({
    headful: true,
    extraArgs: [
      `--use-file-for-fake-audio-capture=${wavPath}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  try {
    if (config.blockRnnoise) {
      await chrome.session.send("Network.enable");
      await chrome.session.send("Network.setBlockedURLs", { urls: ["*rnnoise*", "*rnnoiseWorklet*"] });
    }
    // 唯一昵称：TS3 会拒绝重复昵称，8 次连跑必须错开
    await joinAs(chrome, `NS${tag}`.slice(0, 30), { injectBeforeLoad: buildInjection(config.forceNs), channel: CHANNEL, timeoutSeconds: 20 });
    // 等会话真的建立（__webspeakSfu 一加载就有，不能当成功判据）
    let ready = false;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const s = await chrome.session.evaluate(`return { inRoom: document.body.innerText.indexOf("退出") >= 0 };`).catch(() => ({ inRoom: false }));
      if (s.inRoom) { ready = true; break; }
    }
    if (!ready) return { error: "未能进入房间" };
    await chrome.session.evaluate(`window.__ns = { n: 0, sum2: 0, frames: 0, peak: 0 }; window.__nsPre = { n: 0, sum2: 0, chunks: 0, peak: 0, belowGate: 0 }; ${process.env.NS_SAVE ? "window.__nsKeep = [];" : ""} return true;`);
    await sleep(CAPTURE_MS);
    const stats = await chrome.session.evaluate(`return { sent: window.__ns, pre: window.__nsPre };`);
    const rms = stats.sent.n > 0 ? Math.sqrt(stats.sent.sum2 / stats.sent.n) : 0;
    const rmsPre = stats.pre.n > 0 ? Math.sqrt(stats.pre.sum2 / stats.pre.n) : 0;
    const blocked = config.blockRnnoise
      ? await chrome.session.evaluate(`return performance.getEntriesByType("resource").filter((e) => e.name.indexOf("rnnoise") >= 0).length;`)
      : null;
    let savedPath = null;
    if (process.env.NS_SAVE) {
      const chunks = await chrome.session.evaluate(`
        const out = [];
        for (const c of (window.__nsKeep || [])) out.push(...c);
        const pcm = new Int16Array(out.length);
        for (let i = 0; i < out.length; i++) {
          const v = Math.max(-1, Math.min(1, out[i]));
          pcm[i] = Math.round(v * (v < 0 ? 32768 : 32767));
        }
        let bin = "";
        const bytes = new Uint8Array(pcm.buffer);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      `);
      const raw = Buffer.from(chunks, "base64");
      savedPath = `${process.env.NS_SAVE}/${tag}.wav`;
      const header = Buffer.alloc(44);
      header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + raw.length, 4); header.write("WAVE", 8, "ascii");
      header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28);
      header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36, "ascii");
      header.writeUInt32LE(raw.length, 40);
      writeFileSync(savedPath, Buffer.concat([header, raw]));
    }
    return { rms, rmsPre, frames: stats.sent.frames, samples: stats.sent.n, peak: stats.sent.peak,
             belowGate: stats.pre.belowGate, chunks: stats.pre.chunks, rnnoiseRequests: blocked, savedPath };
  } finally {
    await chrome.close().catch(() => {});
  }
}

const db = (ratio) => (ratio > 0 ? (20 * Math.log10(ratio)).toFixed(1) : "-inf");

console.log(`信号目录 ${DIR}`);
console.log(`采集窗口 ${CAPTURE_MS}ms/次，频道=${CHANNEL || "(服务器默认)"}\n`);

const FILTER = process.env.NS_FILTER ?? "";
const results = {};
for (const signal of [
  { key: "noise", path: NOISE_WAV },
  { key: "speech", path: SPEECH_WAV },
  { key: "loud", path: `${DIR}/noise_loud.wav` },
  { key: "mixed", path: `${DIR}/mixed.wav` },
  { key: "quiet", path: `${DIR}/speech_quiet.wav` },
  { key: "vquiet", path: `${DIR}/speech_vquiet.wav` },
]) {
  for (const config of CONFIGS) {
    if (FILTER && FILTER !== `${signal.key}:${config.id}`) continue;
    process.stdout.write(`跑 ${signal.key.padEnd(6)} / ${config.label.padEnd(16)} … `);
    const PREFIX = { noise: "N", speech: "S", loud: "L", mixed: "M", quiet: "Q", vquiet: "V" };
    const r = await runOnce(config, signal.path, `${PREFIX[signal.key]}${config.id}`);
    results[`${signal.key}:${config.id}`] = r;
    console.log(r.error ? `✗ ${r.error}` : `发出去 rms=${r.rms.toFixed(5)} frames=${r.frames}  |  VAD 前 rms=${r.rmsPre.toFixed(5)} 门限下块=${r.belowGate}/${r.chunks}${r.savedPath ? "  → " + r.savedPath : ""}`);
    await sleep(2500);
  }
}

const base = (field) => ({
  noise: results[`noise:none`]?.[field],
  loud: results[`loud:none`]?.[field],
  speech: results[`speech:none`]?.[field],
  quiet: results[`quiet:none`]?.[field],
  vquiet: results[`vquiet:none`]?.[field],
  mixed: results[`mixed:none`]?.[field],
});
const baseSent = base("rms");
const basePre = base("rmsPre");
const SIGNALS = [
  { key: "noise", label: "静噪" },
  { key: "loud", label: "响噪" },
  { key: "speech", label: "语音" },
  { key: "quiet", label: "轻语音" },
  { key: "vquiet", label: "极轻" },
  { key: "mixed", label: "混合" },
];

/** 相对基线换算成 dB；全静音时给可读说明。 */
function cell(configId, signalKey, field, baseMap) {
  const r = results[`${signalKey}:${configId}`];
  const ref = baseMap[signalKey];
  if (!r || !ref) return "n/a";
  if (field === "rms" && r.frames === 0) return "全部静音";
  const value = r[field];
  return value ? db(value / ref) : "n/a";
}

function table(title, field, baseMap) {
  console.log("");
  console.log("================ " + title + " ================");
  console.log("配置".padEnd(18) + SIGNALS.map((s) => (s.label + " dB").padStart(11)).join("") + "   绝对 RMS(响噪/语音)");
  for (const config of CONFIGS) {
    const cells = SIGNALS.map((s) => String(cell(config.id, s.key, field, baseMap)).padStart(11)).join("");
    const loud = results["loud:" + config.id]?.[field]?.toFixed(5) ?? "n/a";
    const sp = results["speech:" + config.id]?.[field]?.toFixed(5) ?? "n/a";
    console.log(config.label.padEnd(18) + cells + "   " + loud + " / " + sp);
  }
}

table("发出去的音频（VAD 门限之后，对端真正收到的）", "rms", baseSent);
table("降噪器真实输出（VAD 门限之前，不被门限截断）", "rmsPre", basePre);

console.log("");
console.log("读法：");
console.log("  静噪/响噪列越负越好（压掉多少底噪）；语音列越接近 0 越好（负得多说明在吃语音）。");
console.log("  「全部静音」= 降噪后残余落到 App 的 VAD 门限(0.008 RMS)以下，一个包都不发。");
console.log("  纯噪声列的极低值不代表真实能力：没有语音时降噪器会把一切都当噪声压掉。");
console.log("  真实场景看「混合」列 —— 语音与噪声同时存在，才考验降噪同时保住语音。");
if (results["noise:none"]?.rnnoiseRequests === 0) console.log("");
console.log("校验：阻断配置下确实没有 rnnoise 资源请求。");
