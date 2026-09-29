/**
 * 跨浏览器兼容层（Blink / Gecko / WebKit）。
 *
 * 这个模块是浏览器差异的**唯一事实来源**：内核与版本识别、能力矩阵、以及
 * 由能力矩阵推导出的降级清单，都在这里算好。UI 与语音链路只消费结论，
 * 不再各自散落 `'webkitFoo' in window` 之类的探测。
 *
 * 三条约定：
 *  1. 探测是**惰性 + 记忆化**的，且在 SSR / 无 window 环境下返回保守默认值，
 *     绝不在模块加载期抛错。
 *  2. 能力探测只回答「API 在不在」，不回答「权限给不给」；权限问题仍由
 *     getUserMedia / getDisplayMedia 的实际调用结果决定。
 *  3. 任何可选能力缺失都只降级、不阻断。真正阻断的只有
 *     `webRtc` / `getUserMedia` / `audioContext` 三项（外加 HTTPS）。
 */

export type BrowserEngine = "blink" | "gecko" | "webkit" | "edgehtml" | "unknown";

export type BrowserFamily =
  | "chrome"
  | "edge"
  | "opera"
  | "samsung-internet"
  | "firefox"
  | "safari"
  | "ios-safari"
  | "unknown";

export interface BrowserIdentity {
  family: BrowserFamily;
  engine: BrowserEngine;
  /** 人类可读标签，例如 "Firefox 128" / "Safari 17 (iOS)"。 */
  label: string;
  /** 主版本号；识别不出时为 0。 */
  major: number;
  version: string;
  isMobile: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  /** 所有 Chromium 系内核（含 Edge/Opera/三星浏览器/安卓 Chrome）。 */
  isChromium: boolean;
  isFirefox: boolean;
  isSafari: boolean;
  isFirefoxBased: boolean;
  isWebKitBased: boolean;
}

export interface BrowserCapabilities {
  /** HTTPS / localhost 安全上下文：getUserMedia 的硬前提。 */
  secureContext: boolean;
  webRtc: boolean;
  getUserMedia: boolean;
  enumerateDevices: boolean;
  audioContext: boolean;
  audioWorklet: boolean;
  /** 已废弃但仍在所有内核可用，是 AudioWorklet 缺失时的采集兜底。 */
  scriptProcessor: boolean;
  mediaRecorder: boolean;
  /** mic 自测录音优先使用的 MIME；按内核差异挑（Safari 不给 webm）。 */
  preferredRecorderMimeType: string;
  getDisplayMedia: boolean;
  /**
   * 显示采集能否带音频（系统/标签页声音）。
   * 目前只有 Chromium 会把显示音频交给 getDisplayMedia，Gecko 与 WebKit
   * 只会返回纯视频轨 —— 伴奏共享依赖它，所以必须在入口处就拦下来。
   */
  displayAudioCapture: boolean;
  /**
   * Chromium 专有的显示采集提示（displaySurface / selfBrowserSurface /
   * systemAudio / windowAudio / restrictOwnAudio）。不支持的字典成员按
   * WebIDL 应被忽略，但 WebKit 历史上对未知成员更敏感，因此按能力筛选。
   */
  displayCaptureHints: boolean;
  audioContextSinkId: boolean;
  mediaElementSinkId: boolean;
  /** 输出设备选择：任一 sink API 可用即为 true（**事实**能力）。 */
  outputDeviceSelection: boolean;
  /**
   * 可听输出**如何**改道。UI 按 `!== "none"` 显隐扬声器选择，播放层按它选机制。
   *
   * 本应用的可听输出是 WebAudio 图，静音 `<audio>` 元素只负责驱动接收流。
   * 两条可行路径：
   *   - `"audioContext"`：`AudioContext.setSinkId`（Chromium）。整个上下文一起改道，
   *     零额外缓冲。
   *   - `"mediaElement"`：只有 `HTMLMediaElement.setSinkId`（Firefox 116+）。
   *     必须把可听图接到 `MediaStreamAudioDestinationNode`，再用一个不静音的
   *     元素播放它并 setSinkId —— 实测这是唯一能改道 WebAudio 输出的办法
   *     （元素 setSinkId 单独用改不了 WebAudio 图）。代价是多一级缓冲，所以
   *     只在用户真的选了非默认设备时才惰性切换。
   *   - `"none"`：Safari/WebKit，无 sink API。
   */
  outputRoutingMode: "audioContext" | "mediaElement" | "none";
  /** Chrome 的 webkitAudioDecodedByteCount，用于「轨道里到底有没有可解码音频」探针。 */
  decodedAudioByteCounter: boolean;
  /** RTCRtpTransceiver.setCodecPreferences。 */
  codecPreferences: boolean;
  /** MediaStreamTrack.contentHint（WebKit 未实现，写入会被静默忽略）。 */
  contentHint: boolean;
  rtcStats: boolean;
  clipboard: boolean;
  /**
   * 远端 WebRTC 音频轨是否必须挂到一个 HTMLMediaElement 才会被真正拉取解码。
   * Blink / WebKit 需要（元素就是「请求播放」的 sink），Gecko 不需要但无害。
   */
  needsMediaElementSink: boolean;
  /** 运行时 CSS 能力：用于决定是否启用现代样式增强。 */
  cssColorMix: boolean;
  cssDvh: boolean;
  cssHas: boolean;
  cssBackdropFilter: boolean;
  cssZoom: boolean;
}

export type SupportTier = "full" | "good" | "limited" | "unsupported";

export interface SupportDegradation {
  /** 稳定的能力键，UI 用它做文案映射。 */
  key: keyof BrowserCapabilities | "secureContext";
  /** 中文说明，沿用既有 UI 的 `localizedMessage()` 文案表。 */
  message: string;
}

export interface BrowserSupportReport {
  identity: BrowserIdentity;
  capabilities: BrowserCapabilities;
  tier: SupportTier;
  /** 阻断性原因（中文）；可用时为 null。 */
  blockingReason: string | null;
  /** 稳定错误码，便于日志与诊断。 */
  blockingCode: string;
  degradations: SupportDegradation[];
}

/* ------------------------------------------------------------------ *
 * 内核与版本识别
 * ------------------------------------------------------------------ */

/**
 * iPadOS 13+ 的 Safari 默认伪装成 macOS（`Macintosh; Intel Mac OS X`），
 * 只能靠触摸点数把它和真正的桌面 Safari 区分开。
 */
function isIPadDisguisedAsMac(ua: string): boolean {
  if (!/Macintosh|Mac OS X/.test(ua)) return false;
  if (typeof navigator === "undefined") return false;
  return navigator.maxTouchPoints > 1;
}

function matchVersion(ua: string, pattern: RegExp): string {
  const matched = pattern.exec(ua);
  return matched?.[1] ?? "";
}

function majorOf(version: string): number {
  const parsed = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 按 UA 识别内核与产品。
 *
 * 顺序很关键：Chromium 系的内核 token 会互相包含（Edge 带 Chrome，Opera 带
 * Chrome 和 Edge 的变体），所以必须从最具体的产品往最宽的内核退。
 */
export function detectBrowserIdentity(userAgent?: string): BrowserIdentity {
  const ua = typeof userAgent === "string"
    ? userAgent
    : (typeof navigator !== "undefined" ? navigator.userAgent : "");

  const isAndroid = /Android/i.test(ua);
  const iOSDevice = /iPhone|iPod/i.test(ua) || (/iPad/i.test(ua)) || isIPadDisguisedAsMac(ua);
  const isMobile = isAndroid || iOSDevice || /Mobile|Tablet/i.test(ua);

  const chromiumEngine = /Chrome|Chromium|CriOS/i.test(ua);
  /**
   * 旧版 Edge（EdgeHTML，Edge ≤ 18）在 UA 里同时伪装成 Chrome，必须单独识别，
   * 否则会被当成 Blink —— 那样就会错误地下发 `displaySurface` 等 Chromium 提示、
   * 并把它的 WebRTC 当成 Chrome 的。
   *
   * 判别式刻意区分大小写：EdgeHTML 写 `Edge/`，而 Chromium 版 Edge 写 `Edg/`、
   * 安卓版写 `EdgA/`、iOS 版写 `EdgiOS/`，都不等于 `Edge/`。
   */
  const legacyEdge = /Edge\//.test(ua);
  // iOS 上所有浏览器都被 Apple 强制使用 WebKit，只是产品名不同。
  const iOSChrome = iOSDevice && /CriOS\//i.test(ua);
  const iOSFirefox = iOSDevice && /FxiOS\//i.test(ua);
  const iOSEdge = iOSDevice && /EdgiOS\//i.test(ua);

  let family: BrowserFamily = "unknown";

  if (iOSEdge) {
    family = "edge";
  } else if (iOSChrome) {
    family = "chrome";
  } else if (iOSFirefox || /Firefox\/|FxiOS\//i.test(ua)) {
    family = "firefox";
  } else if (legacyEdge || /Edg[A-Z]?\//i.test(ua)) {
    family = "edge";
  } else if (/OPR\/|Opera/i.test(ua)) {
    family = "opera";
  } else if (/SamsungBrowser/i.test(ua)) {
    family = "samsung-internet";
  } else if (iOSDevice) {
    family = "ios-safari";
  } else if (/Safari\//i.test(ua) && !chromiumEngine) {
    family = "safari";
  } else if (chromiumEngine) {
    family = "chrome";
  }

  let version = "";
  switch (family) {
    case "edge":
      version = iOSEdge
        ? matchVersion(ua, /EdgiOS\/([\d.]+)/i)
        : legacyEdge
          ? matchVersion(ua, /Edge\/([\d.]+)/)
          : matchVersion(ua, /Edg[A-Z]?\/([\d.]+)/i);
      break;
    case "opera": version = matchVersion(ua, /(?:OPR|Opera)\/([\d.]+)/i); break;
    case "samsung-internet": version = matchVersion(ua, /SamsungBrowser\/([\d.]+)/i); break;
    case "firefox": version = matchVersion(ua, /(?:Firefox|FxiOS)\/([\d.]+)/i); break;
    case "ios-safari": version = matchVersion(ua, /OS (\d+[._]\d+(?:[._]\d+)?)/i).replace(/_/g, "."); break;
    case "safari": version = matchVersion(ua, /Version\/([\d.]+)/i); break;
    default: version = matchVersion(ua, /(?:Chrome|Chromium|CriOS)\/([\d.]+)/i); break;
  }

  // 内核由**平台**决定，而不是由产品名决定：iOS 上的 Chrome/Edge/Firefox 都是
  // WebKit，把它们当成 Blink 会让 displayCaptureHints / displayAudioCapture /
  // needsMediaElementSink 全部判错。
  const isFirefox = family === "firefox" && !iOSFirefox;
  const isSafari = family === "safari" || family === "ios-safari";
  const engine: BrowserEngine = legacyEdge
    ? "edgehtml"
    : isFirefox
      ? "gecko"
      : (isSafari || iOSDevice || iOSChrome || iOSEdge || iOSFirefox)
        ? "webkit"
        : chromiumEngine
          ? "blink"
          : "unknown";
  const isChromium = engine === "blink";

  const productName: Record<BrowserFamily, string> = {
    chrome: iOSChrome ? "Chrome (iOS)" : isAndroid ? "Chrome (Android)" : "Chrome",
    edge: iOSEdge ? "Edge (iOS)" : "Edge",
    opera: "Opera",
    "samsung-internet": "Samsung Internet",
    firefox: iOSFirefox ? "Firefox (iOS)" : "Firefox",
    safari: "Safari",
    "ios-safari": /iPad/i.test(ua) || isIPadDisguisedAsMac(ua) ? "Safari (iPadOS)" : "Safari (iOS)",
    unknown: "Unknown browser",
  };

  const major = majorOf(version);

  return {
    family,
    engine,
    label: version ? `${productName[family]} ${major || version}` : productName[family],
    major,
    version,
    isMobile,
    isIOS: iOSDevice,
    isAndroid,
    isChromium,
    isFirefox,
    isSafari,
    isFirefoxBased: engine === "gecko",
    isWebKitBased: engine === "webkit",
  };
}

/* ------------------------------------------------------------------ *
 * 能力探测
 * ------------------------------------------------------------------ */

function cssSupports(property: string, value: string): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  try {
    return CSS.supports(property, value);
  } catch {
    return false;
  }
}

/**
 * `CSS.supports(<conditionText>)`：单参数形式，用于 `selector(...)` 之类的
 * 条件文本。注意不能用 `CSS.supports("selector(:has(a))", "true")` —— 双参数
 * 形式会把第一个参数当**属性名**解析，`selector(...)` 不是属性名，因此在支持
 * `:has()` 的浏览器上也会返回 false。
 */
function cssSupportsCondition(conditionText: string): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  try {
    return CSS.supports(conditionText);
  } catch {
    return false;
  }
}

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  // Safari 只做 audio/mp4；Chromium / Gecko 用 audio/webm。
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // isTypeSupported 在个别内核上会抛错，继续试下一个。
    }
  }
  return "";
}

/**
 * 探测当前环境的能力矩阵。结果按需计算并缓存（能力在页面生命周期内不变）。
 */
export function detectCapabilities(): BrowserCapabilities {
  if (typeof window === "undefined") {
    return {
      secureContext: false,
      webRtc: false,
      getUserMedia: false,
      enumerateDevices: false,
      audioContext: false,
      audioWorklet: false,
      scriptProcessor: false,
      mediaRecorder: false,
      preferredRecorderMimeType: "",
      getDisplayMedia: false,
      displayAudioCapture: false,
      displayCaptureHints: false,
      audioContextSinkId: false,
      mediaElementSinkId: false,
      outputDeviceSelection: false,
      outputRoutingMode: "none",
      decodedAudioByteCounter: false,
      codecPreferences: false,
      contentHint: false,
      rtcStats: false,
      clipboard: false,
      needsMediaElementSink: false,
      cssColorMix: false,
      cssDvh: false,
      cssHas: false,
      cssBackdropFilter: false,
      cssZoom: false,
    };
  }

  const identity = detectBrowserIdentity();
  const media = navigator.mediaDevices as MediaDevices | undefined;

  const audioContextSinkId = (() => {
    // AudioContext 需要实例化才能查 setSinkId，这里只查原型，避免为了探测
    // 就创建一个被自动播放策略挂起的上下文。
    try {
      const ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      return typeof ctor === "function" && typeof (ctor.prototype as { setSinkId?: unknown }).setSinkId === "function";
    } catch {
      return false;
    }
  })();

  const mediaElementSinkId = typeof HTMLMediaElement !== "undefined"
    && typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function";

  // 以下三项按**内核**判定，而不是按产品：iOS 上的 Chrome/Edge 也是 WebKit，
  // 用 isChromium 会把它们误判成 Blink。
  const isBlink = identity.engine === "blink";
  const isWebKit = identity.engine === "webkit";

  return {
    secureContext: window.isSecureContext === true,
    webRtc: typeof RTCPeerConnection === "function",
    getUserMedia: typeof media?.getUserMedia === "function",
    enumerateDevices: typeof media?.enumerateDevices === "function",
    audioContext: typeof window.AudioContext === "function"
      || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext === "function",
    audioWorklet: typeof AudioWorkletNode === "function" && typeof AudioWorkletNode.prototype === "object",
    scriptProcessor: typeof BaseAudioContext !== "undefined"
      && typeof (BaseAudioContext.prototype as { createScriptProcessor?: unknown }).createScriptProcessor === "function",
    mediaRecorder: typeof MediaRecorder === "function",
    preferredRecorderMimeType: pickRecorderMimeType(),
    getDisplayMedia: typeof media?.getDisplayMedia === "function",
    // 只有 Blink 会把显示采集的音频轨交出来；Gecko 自 2021 起在 Linux 上部分
    // 支持，但跨平台不可依赖，按内核判定更诚实。
    displayAudioCapture: isBlink,
    displayCaptureHints: isBlink,
    audioContextSinkId,
    mediaElementSinkId,
    outputDeviceSelection: audioContextSinkId || mediaElementSinkId,
    outputRoutingMode: audioContextSinkId ? "audioContext" : mediaElementSinkId ? "mediaElement" : "none",
    decodedAudioByteCounter: "webkitAudioDecodedByteCount" in HTMLMediaElement.prototype,
    codecPreferences: typeof RTCRtpTransceiver !== "undefined"
      && typeof RTCRtpTransceiver.prototype.setCodecPreferences === "function",
    contentHint: typeof MediaStreamTrack !== "undefined" && "contentHint" in MediaStreamTrack.prototype,
    rtcStats: typeof RTCPeerConnection !== "undefined"
      && typeof RTCPeerConnection.prototype.getStats === "function",
    clipboard: typeof navigator.clipboard?.writeText === "function",
    // Blink 与 WebKit 都必须把远端轨道挂到 HTMLMediaElement 上才会真正拉取解码；
    // Gecko 不需要（保留元素也无害）。EdgeHTML 与 Blink 行为一致，一并算上。
    needsMediaElementSink: isBlink || isWebKit || identity.engine === "edgehtml",
    cssColorMix: cssSupports("color", "color-mix(in srgb, red, blue)"),
    cssDvh: cssSupports("height", "100dvh"),
    // `:has()` 需要 Firefox 121+，高于支持基线，所以 UI 已改为类名驱动；
    // 这里只如实上报，供诊断使用。
    cssHas: cssSupportsCondition("selector(:has(*))") || cssSupportsCondition("selector(:has(a))"),
    cssBackdropFilter: cssSupports("backdrop-filter", "blur(2px)") || cssSupports("-webkit-backdrop-filter", "blur(2px)"),
    cssZoom: cssSupports("zoom", "1"),
  };
}

let cachedCapabilities: BrowserCapabilities | null = null;

/** `detectCapabilities()` 的记忆化封装。 */
export function getBrowserCapabilities(): BrowserCapabilities {
  if (!cachedCapabilities) cachedCapabilities = detectCapabilities();
  return cachedCapabilities;
}

/** 清空能力缓存（仅测试用）。 */
export function resetBrowserCapabilityCache(): void {
  cachedCapabilities = null;
}

/* ------------------------------------------------------------------ *
 * 报告：把能力矩阵折成「能不能用 / 差什么」
 * ------------------------------------------------------------------ */

/**
 * 生成兼容性报告。
 *
 * 阻断条件只有四个（HTTPS、WebRTC、getUserMedia、Web Audio）；其余缺失全部
 * 记进 `degradations`，由 UI 决定怎么提示。
 */
export function getBrowserSupportReport(): BrowserSupportReport {
  const identity = detectBrowserIdentity();
  const capabilities = getBrowserCapabilities();
  const degradations: SupportDegradation[] = [];

  let blockingReason: string | null = null;
  let blockingCode = "";

  if (!capabilities.secureContext) {
    blockingReason = "语音功能需要 HTTPS 安全连接";
    blockingCode = "INSECURE_CONTEXT";
  } else if (!capabilities.webRtc) {
    blockingReason = "当前浏览器不支持 WebRTC 实时语音，请更换最新版 Chrome、Edge、Firefox 或 Safari";
    blockingCode = "WEBRTC_UNSUPPORTED";
  } else if (!capabilities.getUserMedia) {
    blockingReason = "当前浏览器不支持麦克风访问";
    blockingCode = "GET_USER_MEDIA_UNSUPPORTED";
  } else if (!capabilities.audioContext) {
    blockingReason = "当前浏览器不支持 Web Audio 音频处理";
    blockingCode = "WEB_AUDIO_UNSUPPORTED";
  }

  if (!capabilities.audioWorklet) {
    degradations.push({
      key: "audioWorklet",
      message: "当前浏览器不支持 AudioWorklet，已切换到兼容采集模式（延迟略高）",
    });
  }
  if (capabilities.outputRoutingMode === "none") {
    degradations.push({
      key: "outputRoutingMode",
      // 只有 WebKit/Safari 会命中：它没有任何 sink API。Chromium 与 Firefox 都能
      // 在页面内切换扬声器（机制不同、体验一致），所以这两边不再提示。
      message: "当前浏览器无法在页面内切换扬声器，输出跟随系统音频设置（可在系统音量合成器中为浏览器单独指定输出设备）",
    });
  }
  if (!capabilities.mediaRecorder) {
    degradations.push({
      key: "mediaRecorder",
      message: "当前浏览器不支持本地录音回放，麦克风自测将只显示实时电平",
    });
  }
  if (!capabilities.getDisplayMedia) {
    degradations.push({
      key: "getDisplayMedia",
      message: "当前浏览器不支持屏幕共享",
    });
  } else if (!capabilities.displayAudioCapture) {
    degradations.push({
      key: "displayAudioCapture",
      message: "当前浏览器不支持采集显示音频，伴奏共享不可用",
    });
  }

  let tier: SupportTier;
  if (blockingReason) {
    tier = "unsupported";
  } else if (capabilities.audioWorklet && capabilities.outputRoutingMode !== "none" && capabilities.displayAudioCapture && capabilities.mediaRecorder) {
    tier = "full";
  } else if (capabilities.audioWorklet) {
    tier = "good";
  } else {
    tier = "limited";
  }

  return { identity, capabilities, tier, blockingReason, blockingCode, degradations };
}
