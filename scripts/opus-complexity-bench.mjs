#!/usr/bin/env node
/**
 * Opus 编码/解码开销基准。
 *
 * 回答一个问题：把编码复杂度从 libopus 默认的 9 降到 4，
 * 在 MCU 混音场景下能省多少 CPU。
 *
 * 运行：node scripts/opus-complexity-bench.mjs
 * 需要能加载 @discordjs/opus 原生模块的环境（Linux/Docker 正常；
 * Windows 需要 MSVC 构建工具链）。
 *
 * 注意：本脚本测量的是**当前这台机器**的 CPU。要评估网关的实际占用，
 * 请在网关所在的那台机器上运行。
 */
import { createRequire } from "node:module";
import { cpus } from "node:os";

const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus");

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960; // 20ms @ 48kHz 单声道帧长
const FRAME_MS = 20;
const FRAMES = 3_000; // 约 60 秒音频

// 场景参数：改成你的实际情况
const LISTENERS = Number(process.env.BENCH_LISTENERS ?? 10);
const SPEAKERS = Number(process.env.BENCH_SPEAKERS ?? 3);

// libopus 的 CTL 请求码（取自 opus_defines.h）
const OPUS_SET_COMPLEXITY_REQUEST = 4010;

/**
 * 接近语音的测试信号：基频谐波 + 少量噪声。
 * 纯静音或纯正弦的编码开销不真实，不能用来估 CPU。
 */
function makeFrame(phase) {
  const pcm = Buffer.allocUnsafe(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (phase + i) / SAMPLE_RATE;
    let sample = 0;
    for (let harmonic = 1; harmonic <= 5; harmonic++) {
      sample += Math.sin(2 * Math.PI * 180 * harmonic * t) / harmonic;
    }
    sample = sample / 3 + (Math.random() * 2 - 1) * 0.05;
    const clamped = Math.max(-32_768, Math.min(32_767, Math.round(sample * 8_000)));
    pcm.writeInt16LE(clamped, i * 2);
  }
  return pcm;
}

const frames = Array.from({ length: 200 }, (_, index) => makeFrame(index * FRAME_SAMPLES));

function benchEncode(complexity) {
  const encoder = new OpusEncoder(SAMPLE_RATE, 1);
  if (complexity !== null) encoder.applyEncoderCTL(OPUS_SET_COMPLEXITY_REQUEST, complexity);
  for (const frame of frames) encoder.encode(frame); // 预热
  const started = process.hrtime.bigint();
  for (let index = 0; index < FRAMES; index++) encoder.encode(frames[index % frames.length]);
  const elapsedNs = Number(process.hrtime.bigint() - started);
  return { usPerFrame: elapsedNs / FRAMES / 1_000, bitrate: encoder.getBitrate() };
}

function benchDecode() {
  const encoder = new OpusEncoder(SAMPLE_RATE, 1);
  const encoded = frames.map((frame) => encoder.encode(frame));
  for (const packet of encoded) encoder.decode(packet); // 预热
  const started = process.hrtime.bigint();
  for (let index = 0; index < FRAMES; index++) encoder.decode(encoded[index % encoded.length]);
  const elapsedNs = Number(process.hrtime.bigint() - started);
  return { usPerFrame: elapsedNs / FRAMES / 1_000 };
}

/** 把单帧耗时换算成"占一个 CPU 核的百分比"。 */
function loadPercent(usPerFrame, framesPerTick) {
  const framesPerSecond = framesPerTick * (1_000 / FRAME_MS);
  return (usPerFrame * framesPerSecond) / 10_000; // → 百分比
}

console.log(`\nOpus 基准  |  场景：${LISTENERS} 听众 × ${SPEAKERS} 说话人  |  每帧 ${FRAME_MS}ms\n`);
console.log("编码（MCU 下行混音：每个听众每 20ms 编码 1 帧）");
console.log("  复杂度   µs/帧     码率       占 1 核");
console.log("  ────────────────────────────────────────────");

const encodeResults = new Map();
for (const complexity of [9, 6, 4, 2, 0]) {
  const { usPerFrame, bitrate } = benchEncode(complexity);
  encodeResults.set(complexity, usPerFrame);
  const label = complexity === 9 ? "9(默认)" : String(complexity).padEnd(6);
  console.log(
    `  ${label}   ${usPerFrame.toFixed(1).padStart(7)}   ${String(bitrate).padStart(6)}bps   ${loadPercent(usPerFrame, LISTENERS).toFixed(1).padStart(5)}%`,
  );
}

const { usPerFrame: decodeUs } = benchDecode();
console.log("\n解码（MCU 下行混音：每个听众每 20ms 解码 M 帧）");
console.log(`  每帧 ${decodeUs.toFixed(1)}µs  →  占 1 核 ${loadPercent(decodeUs, LISTENERS * SPEAKERS).toFixed(1)}%`);

const baseline = encodeResults.get(9);
const tuned = encodeResults.get(4);
if (baseline && tuned) {
  console.log("\n结论");
  console.log(`  编码复杂度 9 → 4：${baseline.toFixed(1)}µs → ${tuned.toFixed(1)}µs，降低 ${(baseline / tuned).toFixed(2)}×`);
  console.log(`  合计（编码 + 解码）占 1 核：`);
  console.log(`    改前 ${(loadPercent(baseline, LISTENERS) + loadPercent(decodeUs, LISTENERS * SPEAKERS)).toFixed(1)}%`);
  console.log(`    改后 ${(loadPercent(tuned, LISTENERS) + loadPercent(decodeUs, LISTENERS * SPEAKERS)).toFixed(1)}%`);
  console.log("\n  对照：本机核数 =", cpus().length);
}
console.log("");
