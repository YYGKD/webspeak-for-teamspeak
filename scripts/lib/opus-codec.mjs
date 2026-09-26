/**
 * 纯测试辅助模块：封装 TS3 语音链路用到的 Opus 编解码器。
 *
 * 从 `src/server/opus-codec.ts` 迁出——生产源码树已全面改走 WebRTC（mediasoup），
 * 不再直接依赖 `@discordjs/opus` 原生模块；仅 e2e / 基准脚本需要它，故归入测试侧。
 * complexity/bitrate 调优逻辑与迁移前保持一致。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * @discordjs/opus 暴露的 OpusEncoder。注意它同时承担编码与解码：
 * 该包没有独立的 OpusDecoder 构造器。
 */
const { OpusEncoder } = require("@discordjs/opus");

export const OPUS_SAMPLE_RATE = 48_000;
export const OPUS_CHANNELS = 1;

// libopus 的控制请求码，取自 opus_defines.h。这些值在 opus 1.x 中稳定不变。
const OPUS_SET_BITRATE_REQUEST = 4002;
const OPUS_SET_COMPLEXITY_REQUEST = 4010;
const OPUS_SET_SIGNAL_REQUEST = 4024;
const OPUS_SIGNAL_VOICE = 3001;

/**
 * 编码复杂度。libopus 的默认值是 9（有效范围 0-10，接近最高档），
 * 对语音场景没有必要：降到 4 可把编码 CPU 降低约 2-3 倍，而语音质量
 * 差异很小。这是本模块存在的主要理由。
 */
const DEFAULT_COMPLEXITY = 4;

/**
 * 显式码率。libopus 默认 OPUS_AUTO，在 48kHz 单声道 20ms 帧下实际为
 * 60*Fs/frame_size + Fs*channels = 51kbps。固定下来让音质与带宽估算
 * 都可预期。
 */
const DEFAULT_BITRATE = 48_000;

/**
 * 当前生效的编码复杂度。可用 WEBSPEAK_OPUS_COMPLEXITY 覆盖（0-10），
 * 便于在不重新构建的前提下对比测量。
 */
export function getOpusComplexity() {
  const raw = process.env.WEBSPEAK_OPUS_COMPLEXITY?.trim();
  if (!raw) return DEFAULT_COMPLEXITY;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 10 ? value : DEFAULT_COMPLEXITY;
}

/**
 * 创建用于语音的 Opus 编码器。
 *
 * 每个 CTL 单独捕获异常：当某个参数不被当前 libopus 构建支持时，
 * 只保留该参数的库默认值。编码器创建失败是会话级错误，因此不能
 * 因为一个可选参数而失败。
 */
export function createOpusEncoder() {
  const encoder = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
  applyEncoderCtl(encoder, OPUS_SET_COMPLEXITY_REQUEST, getOpusComplexity());
  applyEncoderCtl(encoder, OPUS_SET_SIGNAL_REQUEST, OPUS_SIGNAL_VOICE);
  applyEncoderCtl(encoder, OPUS_SET_BITRATE_REQUEST, DEFAULT_BITRATE);
  return encoder;
}

/**
 * 创建 Opus 解码器。解码侧没有需要覆盖的参数，保持库默认值。
 */
export function createOpusDecoder() {
  return new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
}

function applyEncoderCtl(encoder, ctl, value) {
  try {
    encoder.applyEncoderCTL(ctl, value);
  } catch {
    // 该 CTL 不被当前构建支持：保留库默认值，不影响编码器可用性。
  }
}
