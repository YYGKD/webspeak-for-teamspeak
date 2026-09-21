/**
 * 公网端到端复验：真实 Chrome 经 https://tsweb.yygkd.com 走完整生产链路，
 * 读取 SFU 下行的 inbound-rtp 统计。
 *
 * 与 chrome-sfu-probe.mjs 的分工：那个把真实 Chrome 接到本机的
 * WebRtcAudioSession 上（隔离变量用）；这个连生产，验证"部署 + 反代 + 隧道 +
 * 媒体直连"整条链路。
 *
 * 为什么必须两个浏览器：网关不会把音频回送给发送者本人
 * （voice-bridge 里 `data.clientId === selfId` 直接 return），
 * 所以需要一个说话人 + 一个听众。用两个独立 Chrome 实例（各自独立
 * user-data-dir），避免"同一浏览器只能有一条保持身份的连接"的限制。
 *
 * 用法：node scripts/chrome-prod-e2e.mjs [--headful] [--seconds=15]
 */
import { launchChrome, sleep } from "./lib/cdp.mjs";
import { ORIGIN, joinAs as joinApp, waitForWebRtc } from "./lib/app-session.mjs";

const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SECONDS = Number(argOf("seconds", "15"));
const HEADFUL = process.argv.includes("--headful");
const CHANNEL = argOf("channel", "");
// 模拟"缺 WebCodecs 的浏览器"（较老的 Safari / 部分 Firefox / WebView）：
// 在页面脚本执行前摘掉 AudioDecoder，验证硬门槛已移除、WebRTC 路径仍可用。
const NO_WEBCODECS = process.argv.includes("--no-webcodecs");

const NO_WEBCODECS_INJECT = "try { delete window.AudioDecoder; } catch {} Object.defineProperty(window, 'AudioDecoder', { value: undefined, configurable: true });";

async function joinAs(chrome, nickname) {
  const state = await joinApp(chrome, nickname, {
    injectBeforeLoad: NO_WEBCODECS ? NO_WEBCODECS_INJECT : null,
    channel: CHANNEL,
  });
  await waitForWebRtc(chrome, nickname);
  return state;
}

const speaker = await launchChrome({ headful: HEADFUL });
const listener = await launchChrome({ headful: HEADFUL });
console.log(`说话人 Chrome: ${speaker.browserVersion}  noWebCodecs=${NO_WEBCODECS}`);
console.log(`听众   Chrome: ${listener.browserVersion}`);

try {
  const a = await joinAs(speaker, "复验-说话人");
  console.log("说话人已进入语音空间:", JSON.stringify(a));
  const gate = await listener.session.evaluate(`
    return { bodyText: document.body.innerText.replace(/\n+/g, " | ").slice(0, 220) };
  `).catch(() => ({ bodyText: "" }));
  console.log("听众连接后页面文本片段:", gate.bodyText);
  const b = await joinAs(listener, "复验-听众");
  console.log("听众已进入语音空间:", JSON.stringify(b));

  console.log(`\n观察 ${SECONDS}s …`);
  await sleep(SECONDS * 1000);

  const listenerView = await listener.session.evaluate(`
    const api = window.__webspeakSfu;
    if (!api) return { error: "没有 __webspeakSfu" };

    // 注意：window.__webspeakSfu 是 getter，每次访问才生成新快照。
    // 必须每次重新取，否则读到的永远是同一份缓存（第一版的采样就是这么错的）。
    const activeNow = () => {
      const snapshot = window.__webspeakSfu;
      return (snapshot.slots || []).find((s) => s.clientId !== null) ?? null;
    };

    // 单次采样不可靠：假麦克风是断续的蜂鸣音，瞬时窗口可能正好落在静音段。
    // 连续采 4s，取最大值 —— 只要音频真的流过应用的分析器，max 一定 > 0。
    const series = [];
    const boxSeries = [];
    for (let i = 0; i < 40; i++) {
      const s = activeNow();
      series.push(s ? s.rms : null);
      if (i % 8 === 0) {
        const box = document.querySelector("div[style*='2147483647']");
        boxSeries.push(box ? (box.textContent.match(/rms=[\d.]+/) || ["?"])[0] : "无诊断框");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const maxRms = Math.max(0, ...series.filter((v) => typeof v === "number"));

    const before = activeNow();
    let afterRebuild = null;
    if (before) {
      api.rebuildSlot(before.slot);
      await new Promise((r) => setTimeout(r, 2500));
      afterRebuild = activeNow();
    }

    return {
      audioContextState: window.__webspeakSfu.audioContextState,
      slotCount: window.__webspeakSfu.slotCount,
      speakerMap: window.__webspeakSfu.speakerMap,
      slots: window.__webspeakSfu.slots,
      maxRmsOver4s: Number(maxRms.toFixed(5)),
      nonZeroRmsSamples: series.filter((v) => typeof v === "number" && v > 0).length,
      rmsSeries: series.map((v) => (typeof v === "number" ? Number(v.toFixed(4)) : v)),
      diagnosticsRmsSeries: boxSeries,
      afterRebuild,
      peerStats: await api.peerStats(),
      // 槽位数的代价：SDP 体积随 m-line 数线性增长
      sdpBytes: (() => { const n = api.negotiation(); return n ? { offer: n.offerSdp?.length ?? null, answer: n.answerSdp?.length ?? null, transceivers: n.transceivers.length } : null; })(),
      diagnosticsBox: (document.querySelector("div[style*='2147483647']") || {}).textContent ?? null,
    };
  `);
  console.log("\n================ 听众侧（下行） ================");
  console.log(JSON.stringify(listenerView, null, 2));

  const speakerView = await speaker.session.evaluate(`
    const api = window.__webspeakSfu;
    if (!api) return { error: "没有 __webspeakSfu" };
    // 说话人侧自证：本地麦克风到底有没有在产生音频（它的 slots 是空的，
    // 因为没有任何人转发给它，所以只看上行统计与页面上的本地说话指示）。
    return {
      peerStats: await api.peerStats(),
      selfSpeaking: /正在说话/.test(document.body.innerText),
      bodyText: document.body.innerText.replace(/\\n+/g, " | ").slice(0, 300),
    };
  `);
  console.log("\n================ 说话人侧（上行） ================");
  console.log(JSON.stringify(speakerView, null, 2));
} finally {
  await speaker.close();
  await listener.close();
}
