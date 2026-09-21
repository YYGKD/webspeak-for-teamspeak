/**
 * 驱动生产 WebSpeak 页面的公共逻辑 —— 多个验证脚本共用。
 *
 * 抽出来的理由：C1/C2/C4 三个验证都要"打开页面 → 填昵称 → 进语音空间 →
 * 读统计"，复制三份必然走样。这里只放这一步，场景差异留在各自的脚本里。
 */
import { sleep } from "./cdp.mjs";

export const ORIGIN = "https://tsweb.yygkd.com";

/** 把值写进受控输入框：Vue 只听原生 setter 派发的事件。 */
const FILL_HELPER = `
  const fill = (selector, value) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
`;

/**
 * 打开页面并以指定昵称进入语音空间。
 *
 * @param injectBeforeLoad 在页面脚本执行前注入的 JS（用于模拟能力缺失、
 *   挂钩播放节点等）。必须走 Page.addScriptToEvaluateOnNewDocument，
 *   否则应用已经初始化完了，改 window 没用。
 */
export async function joinAs(chrome, nickname, { injectBeforeLoad = null, timeoutSeconds = 30, channel = "" } = {}) {
  if (injectBeforeLoad) {
    await chrome.session.send("Page.addScriptToEvaluateOnNewDocument", { source: injectBeforeLoad });
  }
  await chrome.navigate(ORIGIN);
  await sleep(2500);
  const filled = await chrome.session.evaluate(`${FILL_HELPER}
    return { filled: fill("input:not([type=checkbox]):not([type=radio])", ${JSON.stringify(nickname)}) };
  `);
  if (!filled.filled) throw new Error(`${nickname}: 找不到昵称输入框`);
  if (channel) {
    // 目标频道留空时由 TS 服务器的默认频道决定；两个人可能落到不同频道而听不到彼此。
    // 要做音频验证就必须显式指定同一个频道。
    await chrome.session.evaluate(`${FILL_HELPER}
      return { filled: fill("#channel", ${JSON.stringify(channel)}) };
    `);
  }
  await sleep(300);
  const clicked = await chrome.session.evaluate(`
    const button = document.querySelector("button.connect-button")
      || [...document.querySelectorAll("button")].find((b) => /进入语音空间/.test(b.textContent));
    if (!button) return { clicked: false };
    button.click();
    return { clicked: true };
  `);
  if (!clicked.clicked) throw new Error(`${nickname}: 找不到连接按钮`);

  for (let i = 0; i < timeoutSeconds; i++) {
    await sleep(1000);
    const state = await chrome.session.evaluate(`
      return {
        hasApi: Boolean(window.__webspeakSfu),
        webrtcActive: window.__webspeakSfu ? window.__webspeakSfu.webrtcActive : null,
        slotCount: window.__webspeakSfu ? window.__webspeakSfu.slotCount : null,
        text: document.body.innerText.slice(0, 160).replace(/\\n/g, " | "),
      };
    `).catch(() => ({ hasApi: false }));
    if (state.hasApi) return state;
  }
  const state = await chrome.session.evaluate(`return { text: document.body.innerText.slice(0, 400).replace(/\\n/g, " | ") }`);
  throw new Error(`${nickname}: ${timeoutSeconds}s 内未进入语音空间 —— ${state.text}`);
}

/** 只等页面进入 WebRTC 激活状态（用于必须走 WebRTC 的场景）。 */
export async function waitForWebRtc(chrome, nickname, timeoutSeconds = 30) {
  for (let i = 0; i < timeoutSeconds; i++) {
    const state = await chrome.session.evaluate(`
      return { webrtcActive: window.__webspeakSfu ? window.__webspeakSfu.webrtcActive : null };
    `).catch(() => ({ webrtcActive: null }));
    if (state.webrtcActive === true) return true;
    await sleep(1000);
  }
  throw new Error(`${nickname}: ${timeoutSeconds}s 内 WebRTC 未激活`);
}

/**
 * 连续采样某个 slot 的 rms，取最大值。
 *
 * 两个坑都在这里处理掉了：
 *  1. `window.__webspeakSfu` 是 getter，必须每次重新取，否则读到的是同一份快照；
 *  2. 单次瞬时值会落在语音间隙上（假麦克风是断续蜂鸣音），必须取最大值。
 */
export async function measureActiveSlot(chrome, samples = 40, intervalMs = 100) {
  return chrome.session.evaluate(`
    const activeNow = () => {
      const snapshot = window.__webspeakSfu;
      if (!snapshot) return null;
      return (snapshot.slots || []).find((s) => s.clientId !== null) ?? null;
    };
    const series = [];
    const clientIds = [];
    for (let i = 0; i < ${samples}; i++) {
      const s = activeNow();
      series.push(s ? s.rms : null);
      clientIds.push(s ? s.clientId : null);
      await new Promise((r) => setTimeout(r, ${intervalMs}));
    }
    const numeric = series.filter((v) => typeof v === "number");
    const current = activeNow();
    return {
      maxRms: numeric.length ? Math.max(...numeric) : 0,
      nonZero: numeric.filter((v) => v > 0).length,
      total: numeric.length,
      slot: current ? current.slot : null,
      clientId: current ? current.clientId : null,
      gain: current ? current.gain : null,
      sinkPaused: current ? current.sinkPaused : null,
      speakerMap: (window.__webspeakSfu.speakerMap) || null,
      peerStats: await window.__webspeakSfu.peerStats(),
    };
  `);
}

/** 只取 speakerMap 与当前 slot 归属，用于观察换源。 */
export async function readSlotOwnership(chrome) {
  return chrome.session.evaluate(`
    const snapshot = window.__webspeakSfu;
    if (!snapshot) return null;
    const active = (snapshot.slots || []).filter((s) => s.clientId !== null);
    return { speakerMap: snapshot.speakerMap || null, active: active.map((s) => ({ slot: s.slot, clientId: s.clientId, rms: s.rms })) };
  `);
}

/** 读某个 mid 的下行统计（找 jitter buffer 相关的非闸门指标）。 */
export async function readInbound(chrome) {
  return chrome.session.evaluate(`
    const api = window.__webspeakSfu;
    if (!api) return null;
    const stats = await api.peerStats();
    const inbound = (stats && stats.inbound) || [];
    return inbound
      .filter((e) => e.kind === "audio")
      .map((e) => ({
        mid: e.mid,
        packetsReceived: e.packetsReceived,
        packetsLost: e.packetsLost,
        totalSamplesReceived: e.totalSamplesReceived,
        concealedSamples: e.concealedSamples,
        jitterBufferEmittedCount: e.jitterBufferEmittedCount,
        // 换源（slot 复用）时若时间戳不连续，这里会明显增长 ——
        // 比 concealedSamples 更能反映"换人后对端有没有被卡一下"。
        // 注意 totalSamplesReceived 是**包含** concealedSamples 的，
        // 而静默期 NetEq 会一直补音，所以 concealed 单独看没有判别力。
        removedSamplesForAcceleration: e.removedSamplesForAcceleration,
        insertedSamplesForDeceleration: e.insertedSamplesForDeceleration,
      }));
  `);
}
