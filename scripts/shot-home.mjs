/**
 * 截生产首页（连接表单）的图，用于改动前后的视觉核对。
 * 用法：node scripts/shot-home.mjs <输出路径> [宽] [高]
 */
import { launchChrome, sleep } from "./lib/cdp.mjs";
import { ORIGIN } from "./lib/app-session.mjs";

const out = process.argv[2] ?? "/tmp/home.png";
const width = Number(process.argv[3] ?? 1440);
const height = Number(process.argv[4] ?? 900);
const url = process.argv[5] ?? ORIGIN;
// --dark：模拟系统深色偏好。用来验证"默认主题"是否还跟着系统走。
// 必须用 CDP 的 setEmulatedMedia，--force-dark-mode 是浏览器自身的深色 UI，不是 prefers-color-scheme。
const DARK = process.argv.includes("--dark");

const chrome = await launchChrome({ headful: true, extraArgs: [`--window-size=${width},${height}`] });
try {
  await chrome.session.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  if (DARK) {
    await chrome.session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
  }
  await chrome.navigate(url);
  await sleep(3000);
  await chrome.screenshot(out);
  console.log(`已截图: ${out} (${width}x${height}) ${url}`);

  const theme = await chrome.session.evaluate(`
    return { dataTheme: document.documentElement.dataset.theme,
             prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
             stored: localStorage.getItem("webspeak:theme") };
  `);
  console.log("主题:", JSON.stringify(theme));
  const dump = await chrome.session.evaluate(`
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className ?? "").toString().slice(0, 70),
      href: el.getAttribute?.("href") ?? null,
      text: (el.textContent ?? "").trim().slice(0, 40),
      visible: el.offsetParent !== null,
    });
    const header = document.querySelector("header, .site-header, .app-header, .landing-header") || document.body;
    return {
      headerTag: header.tagName + "." + (header.className ?? ""),
      headerHtmlPreview: header.outerHTML.slice(0, 1400),
      links: [...document.querySelectorAll("a")].map(describe).filter((a) => a.visible),
    };
  `);
  console.log("--- 头部结构预览 ---");
  console.log(dump.headerHtmlPreview);
  console.log("--- 可见链接 ---");
  for (const l of dump.links) console.log(`  ${l.tag} "${l.text}" href=${l.href} cls=${l.cls}`);
} finally {
  await chrome.close();
}
