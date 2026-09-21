/**
 * 生产场景验证：C2（换源）与 C4（兼容通道回退）。
 *
 * 用法：
 *   npx tsx scripts/chrome-prod-scenarios.mjs --scenario=handover --headful
 *   npx tsx scripts/chrome-prod-scenarios.mjs --scenario=ws --headful
 *
 * C2 换源：说话人 A 离开、说话人 B 接管同一个 slot。要验证的是
 *   - speakerMap 的归属确实换了人；
 *   - 换源之后下行音频继续（rms > 0）；
 *   - removedSamplesForAcceleration 不因换源而异常增长
 *     （werift 的 replaceRTP 截断 bug 会在这里留下明显痕迹）。
 *
 * C4 兼容通道：把 RTCPeerConnection 摘掉，逼客户端走 WS 回退路径，
 *   并挂钩 AudioBufferSourceNode.start 直接量"应用到底播出了什么"。
 *   这条路径靠 WebCodecs 的 AudioDecoder 解码，与 WebRTC 完全不同的实现。
 */
import { launchChrome, sleep } from "./lib/cdp.mjs";
import { joinAs, joinAs as joinApp, measureActiveSlot, readInbound, readSlotOwnership, waitForWebRtc } from "./lib/app-session.mjs";

const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SCENARIO = argOf("scenario", "handover");
const HEADFUL = process.argv.includes("--headful");
const OBSERVE = Number(argOf("seconds", "10"));

/** 摘掉 WebRTC 并挂钩播放节点 —— 用于 C4。 */
const WS_INJECT = `
  (() => {
    const state = { count: 0, maxRms: 0, lastAt: 0, error: null };
    window.__wsPlayback = state;
    try {
      const proto = (window.AudioContext || window.webkitAudioContext).prototype;
      const original = proto.createBufferSource;
      proto.createBufferSource = function () {
        const source = original.call(this);
        const start = source.start.bind(source);
        source.start = function (...args) {
          try {
            const buffer = source.buffer;
            if (buffer) {
              const data = buffer.getChannelData(0);
              let peak = 0;
              for (let i = 0; i < data.length; i += 8) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
              state.count++;
              if (peak > state.maxRms) state.maxRms = peak;
              state.lastAt = Date.now();
            }
          } catch (e) { state.error = String(e); }
          return start(...args);
        };
        return source;
      };
    } catch (e) { state.error = String(e); }
    try { delete window.RTCPeerConnection; } catch (e) {}
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined, configurable: true });
  })();
`;

async function runHandover() {
  const speakerA = await launchChrome({ headful: HEADFUL });
  const speakerB = await launchChrome({ headful: HEADFUL });
  const listener = await launchChrome({ headful: HEADFUL });
  console.log(`说话人A/说话人B/听众 Chrome: ${speakerA.browserVersion}`);
  try {
    const aState = await joinAs(speakerA, "换源-说话人A");
    const lState = await joinAs(listener, "换源-听众");
    console.log("A 状态:", JSON.stringify(aState));
    console.log("听众状态:", JSON.stringify(lState));
    await waitForWebRtc(speakerA, "换源-说话人A");
    await waitForWebRtc(listener, "换源-听众");
    console.log("双方 WebRTC 已激活，等待 A 占住一个 slot …");

    // 必须等 A 真的拿到 slot 才算"换源前" —— 假麦克风是断续的，
    // 没拿到 slot 就往下走等于什么都没测。
    let before = null;
    for (let i = 0; i < 30; i++) {
      before = await readSlotOwnership(listener);
      if (before && before.active.length > 0) break;
      await sleep(1000);
    }
    console.log("换源前听众侧归属:", JSON.stringify(before));
    if (!before || before.active.length === 0) {
      console.log("✗ 说话人 A 始终没有拿到 slot —— 本次无法验证换源（假麦克风没产生语音？）");
      return;
    }
    const inboundBefore = await readInbound(listener);

    // A 离开：关掉它的浏览器 → WS 断开 → 网关 clientLeave → registry.release
    console.log("说话人 A 离开 …");
    await speakerA.close();
    await sleep(3000);

    const afterLeave = await readSlotOwnership(listener);
    console.log("A 离开后听众侧归属:", JSON.stringify(afterLeave));

    console.log("说话人 B 进入 …");
    await joinAs(speakerB, "换源-说话人B");
    await sleep(4000);

    const afterJoin = await readSlotOwnership(listener);
    console.log("B 进入后听众侧归属:", JSON.stringify(afterJoin));

    console.log(`观察 ${OBSERVE}s …`);
    await sleep(OBSERVE * 1000);

    const measured = await measureActiveSlot(listener, 40, 100);
    const inboundAfter = await readInbound(listener);
    console.log("\n================ 换源后听众侧 ================");
    console.log(JSON.stringify({
      maxRms: measured.maxRms,
      nonZeroRmsSamples: measured.nonZero,
      samples: measured.total,
      slot: measured.slot,
      clientId: measured.clientId,
      gain: measured.gain,
      sinkPaused: measured.sinkPaused,
      speakerMap: measured.speakerMap,
      inboundBefore,
      inboundAfter,
    }, null, 2));
  } finally {
    await speakerB.close().catch(() => {});
    await listener.close().catch(() => {});
    await speakerA.close().catch(() => {});
  }
}

async function runWs() {
  const speaker = await launchChrome({ headful: HEADFUL });
  const listener = await launchChrome({ headful: HEADFUL });
  console.log(`说话人/听众 Chrome: ${speaker.browserVersion}`);
  try {
    await joinAs(speaker, "兼容-说话人");
    const listenerState = await joinAs(listener, "兼容-听众", { injectBeforeLoad: WS_INJECT });
    console.log("听众进入语音空间:", JSON.stringify(listenerState));
    const webrtc = await listener.session.evaluate(`
      return { webrtcActive: window.__webspeakSfu ? window.__webspeakSfu.webrtcActive : null,
               hasRtcp: typeof RTCPeerConnection };
    `);
    console.log("听众侧通道判定:", JSON.stringify(webrtc), "（webrtcActive=false 表示走的是兼容通道）");

    console.log(`观察 ${OBSERVE}s …`);
    await sleep(OBSERVE * 1000);

    const playback = await listener.session.evaluate(`
      const state = window.__wsPlayback || { count: 0, maxRms: 0, error: "未注入" };
      const recent = state.lastAt ? Math.round((Date.now() - state.lastAt) / 1000) : null;
      return { count: state.count, maxRms: state.maxRms, lastPlayedSecondsAgo: recent, error: state.error };
    `);
    console.log("\n================ 兼容通道可听输出 ================");
    console.log(JSON.stringify(playback, null, 2));
    console.log("（count = 应用创建并启动的 AudioBufferSource 数量，maxRms = 这些缓冲区的峰值）");
  } finally {
    await speaker.close().catch(() => {});
    await listener.close().catch(() => {});
  }
}

/** 昵称用例：验证中文昵称能不能进、以及长度边界在哪（按字节还是按字符）。 */
async function runNickname() {
  const cases = ["奶龙", "测试用户", "一二三四五六七八九十", "一二三四五六七八九十一", "TestUser", "TesterLongNickname1234567890"];
  for (const nickname of cases) {
    const chars = [...nickname].length;
    const bytes = Buffer.byteLength(nickname, "utf8");
    const chrome = await launchChrome({ headful: HEADFUL });
    let verdict;
    try {
      await joinApp(chrome, nickname, { timeoutSeconds: 5 });
      // joinApp 只看 __webspeakSfu 是否挂上（页面一加载就有），所以成功与否要另外判：
      // 进到房间的标志是顶栏出现「退出」；失败时连接表单会留下错误横幅。
      let joined = false;
      let seen = "";
      for (let i = 0; i < 18; i++) {
        await sleep(1000);
        const snap = await chrome.session.evaluate(`
          const errorEl = document.querySelector(".alert.error, .reconnect-banner, .form-error");
          return {
            inRoom: /退出/.test(document.body.innerText),
            error: errorEl ? errorEl.innerText.replace(/
+/g, " ").slice(0, 160) : null,
            text: document.body.innerText.replace(/
+/g, " ").slice(0, 200),
          };
        `).catch(() => ({ inRoom: false, error: null, text: "" }));
        if (snap.inRoom) { joined = true; break; }
        if (snap.error) { seen = snap.error; break; }
        seen = snap.text;
      }
      verdict = joined ? "✓ 进入成功" : `✗ 未进入 —— ${seen || "(无错误提示)"}`;
    } catch (error) {
      verdict = `✗ 抛错 —— ${String(error.message).slice(0, 160)}`;
    } finally {
      await chrome.close().catch(() => {});
    }
    console.log(`${String(chars).padStart(3)} 字符 / ${String(bytes).padStart(3)} 字节  ${JSON.stringify(nickname)}  ${verdict}`);
  }
}

if (SCENARIO === "nickname") await runNickname();
else if (SCENARIO === "handover") await runHandover();
else if (SCENARIO === "ws") await runWs();
else throw new Error(`未知场景: ${SCENARIO}`);
