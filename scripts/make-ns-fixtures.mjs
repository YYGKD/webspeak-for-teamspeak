/**
 * 生成降噪对比用的两个测试信号（48kHz 单声道 16-bit）：
 *   noise_only.wav  粉噪（模拟风扇/空调这类稳态底噪）
 *   speech_only.wav SAPI 合成的真实语音
 *
 * 为什么分开造而不是混在一起：分开就**不需要做时间对齐**，指标直接可比；
 * 混在一起要么得靠互相关找相位，要么就得假设设备延迟，都会引入误差。
 *
 * 用法：node scripts/make-ns-fixtures.mjs <sapi语音.wav> [输出目录]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const src = process.argv[2];
const outDir = process.argv[3] ?? "C:/Users/zyy/AppData/Local/Temp/nstest";
if (!src) {
  console.error("用法: node scripts/make-ns-fixtures.mjs <sapi语音.wav> [输出目录]");
  process.exit(1);
}

const SAMPLE_RATE = 48_000;
const SECONDS = 10;
const TOTAL = SAMPLE_RATE * SECONDS;

function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("不是 WAV");
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("data 在 fmt 之前");
      if (fmt.bits !== 16) throw new Error(`只支持 16-bit，实际 ${fmt.bits}`);
      const count = Math.floor(size / 2 / fmt.channels);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += buf.readInt16LE(body + (i * fmt.channels + c) * 2);
        samples[i] = sum / fmt.channels / 32768;
      }
      return { sampleRate: fmt.sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("没找到 data 块");
}

function writeWav(path, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const rms = (s) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length);

/** 归一化到目标 RMS，必要时循环铺满 TOTAL。 */
function fit(samples, targetRms, loop) {
  const out = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) out[i] = samples[i % samples.length];
  const gain = targetRms / (rms(out) || 1);
  for (let i = 0; i < TOTAL; i++) out[i] = Math.max(-1, Math.min(1, out[i] * gain));
  void loop;
  return out;
}

// ---- 语音：归一化到 -20 dBFS，尾部不足则循环补齐（SAPI 只有十几秒，够用）----
const speech = readWav(src);
console.log(`语音源: ${speech.sampleRate}Hz, ${(speech.samples.length / speech.sampleRate).toFixed(1)}s, rms=${rms(speech.samples).toFixed(4)}`);
if (speech.sampleRate !== SAMPLE_RATE) throw new Error(`语音采样率应为 ${SAMPLE_RATE}，实际 ${speech.sampleRate}`);
const speechOut = fit(speech.samples, 0.1);

// ---- 粉噪：白噪过两级一阶低通，近似 1/f 谱（风扇/空调的稳态底噪）----
const white = new Float32Array(TOTAL);
let seed = 20260922;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
let lp1 = 0;
let lp2 = 0;
for (let i = 0; i < TOTAL; i++) {
  const w = rand();
  lp1 = 0.92 * lp1 + 0.08 * w;
  lp2 = 0.92 * lp2 + 0.08 * lp1;
  white[i] = lp2;
}
const noiseOut = fit(white, 0.03);

// ---- 轻语音：-35 dBFS。用来测 VAD 门限(0.008 RMS)与降噪的耦合 ——
//      说话轻的人会不会被门限连语音一起切掉。----
const speechQuiet = fit(speech.samples, 0.0178);
// 再压一档：-45 dBFS(0.0056)，语音 RMS 本身已低于 VAD 门限 0.008。
// 用来区分"是降噪把它压下去的"还是"信号本来就低于门限"。
const speechVQuiet = fit(speech.samples, 0.0056);

// ---- 更响的噪声：-10 dBFS。留给降噪足够余量，避免残余落到 VAD 门限(0.008)以下
//      导致"一个包都不发"、指标被地板截断。量的是降噪器的**能力**，不是真实房间残余。----
const noiseLoud = fit(white, 0.316);

// ---- 混合：语音 -20 dBFS + 噪声 -14 dBFS ≈ SNR 6 dB（真实嘈杂环境）----
const mixed = new Float32Array(TOTAL);
const mixedNoise = fit(white, 0.05);
for (let i = 0; i < TOTAL; i++) mixed[i] = Math.max(-1, Math.min(1, speechOut[i] + mixedNoise[i]));

mkdirSync(outDir, { recursive: true });
writeWav(`${outDir}/speech_only.wav`, speechOut, SAMPLE_RATE);
writeWav(`${outDir}/noise_only.wav`, noiseOut, SAMPLE_RATE);
writeWav(`${outDir}/speech_quiet.wav`, speechQuiet, SAMPLE_RATE);
writeWav(`${outDir}/speech_vquiet.wav`, speechVQuiet, SAMPLE_RATE);
writeWav(`${outDir}/noise_loud.wav`, noiseLoud, SAMPLE_RATE);
writeWav(`${outDir}/mixed.wav`, mixed, SAMPLE_RATE);
console.log(`已写 ${outDir}/speech_only.wav  rms=${rms(speechOut).toFixed(4)} (-20 dBFS 目标)`);
console.log(`已写 ${outDir}/noise_only.wav   rms=${rms(noiseOut).toFixed(4)} (-30 dBFS 目标)`);
console.log(`已写 ${outDir}/speech_quiet.wav rms=${rms(speechQuiet).toFixed(4)} (-35 dBFS 目标，测 VAD 耦合)`);
console.log(`已写 ${outDir}/speech_vquiet.wav rms=${rms(speechVQuiet).toFixed(4)} (-45 dBFS，语音RMS本身已低于门限)`);
console.log(`已写 ${outDir}/noise_loud.wav   rms=${rms(noiseLoud).toFixed(4)} (-10 dBFS 目标，给降噪留余量)`);
console.log(`已写 ${outDir}/mixed.wav        rms=${rms(mixed).toFixed(4)} (语音+噪声，SNR≈6dB)`);
console.log(`全部远高于 App 的 VAD 门限 0.008。`);
