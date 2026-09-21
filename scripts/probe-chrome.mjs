/**
 * 本机 Chrome 能力探测 + Opus 帧夹具生成。
 *
 * 为什么需要夹具：本机没有 libopus 原生模块（@discordjs/opus 的 prebuild 是空的，
 * 也没有 ffmpeg），而 Chrome 的 WebCodecs 编码器与浏览器上行同源，是唯一可用且
 * 可信的 Opus 编码器。生成一次，落盘复用。
 *
 * WebCodecs 要求安全上下文，about:blank 拿不到，所以这里起一个 localhost 静态页
 * （localhost 被视为安全上下文）。
 *
 * 用法：node scripts/probe-chrome.mjs
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./lib/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "opus-20ms-440hz.json");

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><meta charset=utf-8><title>probe</title><body>probe</body>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;
console.log(`本地页面: ${origin}`);

const chrome = await launchChrome();
console.log(`Chrome: ${chrome.browserVersion}`);
try {
  await chrome.navigate(origin);
  const result = await chrome.session.evaluate(`
    const out = {
      secure: window.isSecureContext,
      hasPc: typeof RTCPeerConnection !== "undefined",
      hasAudioEncoder: typeof AudioEncoder !== "undefined",
      hasAudioDecoder: typeof AudioDecoder !== "undefined",
    };

    const frames = [];
    let encoderError = null;
    if (out.hasAudioEncoder) {
      const encoder = new AudioEncoder({
        output: (chunk) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          let binary = "";
          for (const byte of buf) binary += String.fromCharCode(byte);
          frames.push({ data: btoa(binary), duration: chunk.duration });
        },
        error: (e) => { encoderError = String(e); },
      });
      encoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 });
      const frameSamples = 960;
      const totalFrames = 250;
      for (let n = 0; n < totalFrames; n++) {
        const pcm = new Float32Array(frameSamples);
        for (let i = 0; i < frameSamples; i++) {
          pcm[i] = 0.35 * Math.sin(2 * Math.PI * 440 * (n * frameSamples + i) / 48000);
        }
        encoder.encode(new AudioData({
          format: "f32-planar", sampleRate: 48000, numberOfFrames: frameSamples,
          numberOfChannels: 1, timestamp: n * 20000, data: pcm,
        }));
      }
      await encoder.flush();
      encoder.close();
    }
    out.encoderError = encoderError;
    out.frameCount = frames.length;
    out.durations = [...new Set(frames.map((f) => f.duration))];
    out.frameByteSizes = frames.slice(0, 5).map((f) => f.data.length);
    out.frames = frames;
    return out;
  `);

  const { frames, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  if (chrome.logs.length) console.log("页面日志:", chrome.logs.slice(0, 10));

  if (frames.length) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify({
      source: `Chrome ${chrome.browserVersion} WebCodecs AudioEncoder, opus/48000/1, 440Hz sine, 20ms frames`,
      generatedAt: new Date().toISOString(),
      frames,
    }));
    console.log(`✓ 夹具已写入 ${FIXTURE}（${frames.length} 帧）`);
  }
} finally {
  await chrome.close();
  server.close();
}
