/**
 * 浏览器兼容层测试（`web/src/services/browser-support.ts`）。
 *
 * 只测**纯函数**部分：UA → 内核/产品识别。能力矩阵依赖真实的浏览器对象
 * （`HTMLMediaElement.prototype`、`CSS.supports` 等），在 Node 下无法真实覆盖，
 * 因此这里只断言「同样输入必然得到同样内核判定」这条最容易被 UA 解析顺序搞坏
 * 的契约 —— iOS 上的 Chrome/Edge/Firefox 全是 WebKit、旧版 Edge 不是 Blink。
 *
 * 运行：npx tsx scripts/browser-support-test.mjs
 */
import { detectBrowserIdentity } from "../web/src/services/browser-support.ts";

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const UAS = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91",
  legacyEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36 Edge/18.17763",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0",
  samsung: "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  firefoxWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  firefoxEsr: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  safariFloor: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15",
  iOS_safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  iOS_chrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  iOS_firefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15",
  iOS_edge: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/120.0 Mobile/15E148 Safari/605.1.15",
  iPadSafari: "Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
};

/** [UA, 期望 family, 期望 engine, 期望主版本] */
const CASES = [
  ["Chrome 120 / Windows", UAS.chromeWin, "chrome", "blink", 120],
  ["Edge 120 / Windows", UAS.edgeWin, "edge", "blink", 120],
  ["Legacy EdgeHTML 18", UAS.legacyEdge, "edge", "edgehtml", 18],
  ["Opera 105", UAS.opera, "opera", "blink", 105],
  ["Samsung Internet 23", UAS.samsung, "samsung-internet", "blink", 23],
  ["Chrome 120 / Android", UAS.androidChrome, "chrome", "blink", 120],
  ["Firefox 121 / Windows", UAS.firefoxWin, "firefox", "gecko", 121],
  ["Firefox 102 ESR (baseline floor)", UAS.firefoxEsr, "firefox", "gecko", 102],
  ["Safari 17.2 / macOS", UAS.safariMac, "safari", "webkit", 17],
  ["Safari 15.4 (baseline floor)", UAS.safariFloor, "safari", "webkit", 15],
  ["Safari 17 / iPhone", UAS.iOS_safari, "ios-safari", "webkit", 17],
  ["Chrome 120 / iPhone (CriOS)", UAS.iOS_chrome, "chrome", "webkit", 120],
  ["Firefox 120 / iPhone (FxiOS)", UAS.iOS_firefox, "firefox", "webkit", 120],
  ["Edge 120 / iPhone (EdgiOS)", UAS.iOS_edge, "edge", "webkit", 120],
  ["Safari 17 / iPad", UAS.iPadSafari, "ios-safari", "webkit", 17],
  ["Empty UA", "", "unknown", "unknown", 0],
];

console.log("browser-support: UA → engine/product detection");
for (const [name, ua, family, engine, major] of CASES) {
  const got = detectBrowserIdentity(ua);
  check(`${name} → family`, got.family === family, `got ${got.family}, want ${family}`);
  check(`${name} → engine`, got.engine === engine, `got ${got.engine}, want ${engine}`);
  check(`${name} → major`, got.major === major, `got ${got.major}, want ${major}`);
  check(`${name} → label non-empty`, typeof got.label === "string" && got.label.length > 0);
}

console.log("browser-support: engine-derived flags");
// iOS 上的 Chrome/Edge/Firefox 一律是 WebKit：把它们当 Blink 会让
// displayCaptureHints / displayAudioCapture / needsMediaElementSink 全部判错。
for (const [name, ua] of [["iOS Chrome", UAS.iOS_chrome], ["iOS Edge", UAS.iOS_edge], ["iOS Firefox", UAS.iOS_firefox]]) {
  const identity = detectBrowserIdentity(ua);
  check(`${name} isChromium === false`, identity.isChromium === false);
  check(`${name} isWebKitBased === true`, identity.isWebKitBased === true);
  check(`${name} isMobile === true`, identity.isMobile === true);
  check(`${name} engine === webkit`, identity.engine === "webkit");
}
const desktopChrome = detectBrowserIdentity(UAS.chromeWin);
check("desktop Chrome isChromium === true", desktopChrome.isChromium === true);
check("desktop Chrome isWebKitBased === false", desktopChrome.isWebKitBased === false);
check("desktop Chrome isMobile === false", desktopChrome.isMobile === false);
const firefox = detectBrowserIdentity(UAS.firefoxWin);
check("Firefox isFirefox === true", firefox.isFirefox === true);
check("Firefox isChromium === false", firefox.isChromium === false);
check("Firefox isFirefoxBased === true", firefox.isFirefoxBased === true);
const safari = detectBrowserIdentity(UAS.safariMac);
check("Safari isSafari === true", safari.isSafari === true);
const legacyEdge = detectBrowserIdentity(UAS.legacyEdge);
check("legacy Edge isChromium === false", legacyEdge.isChromium === false);

console.log("browser-support: display labels");
// 标签会出现在页脚提示里，必须能区分产品与平台。
check("Firefox label names the product", detectBrowserIdentity(UAS.firefoxWin).label === "Firefox 121");
check("macOS Safari label", detectBrowserIdentity(UAS.safariMac).label === "Safari 17");
check("iPhone Safari label carries the platform", detectBrowserIdentity(UAS.iOS_safari).label === "Safari (iOS) 17");
check("iPad Safari label carries the platform", detectBrowserIdentity(UAS.iPadSafari).label === "Safari (iPadOS) 17");
check("iOS Chrome label names both", detectBrowserIdentity(UAS.iOS_chrome).label === "Chrome (iOS) 120");
check("Android Chrome label names the platform", detectBrowserIdentity(UAS.androidChrome).label === "Chrome (Android) 120");
check("unknown browser has a label", detectBrowserIdentity("").label === "Unknown browser");

if (failures === 0) {
  console.log(`\n✓ browser-support-test: ${checks} assertions passed`);
} else {
  console.error(`\n✗ browser-support-test: ${failures} of ${checks} assertions failed`);
  process.exit(1);
}
