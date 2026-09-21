/**
 * 通用布局测量：在指定视口下打印若干选择器的位置/尺寸与关键计算样式，
 * 用来把"看起来挤/重叠"变成可核对的数字。
 *
 * 用法：npx tsx scripts/measure-layout.mjs <url> <宽> <高> <选择器...>
 * 例：  npx tsx scripts/measure-layout.mjs https://tsweb.yygkd.com 390 844 ".join-footer" ".join-content"
 */
import { launchChrome, sleep } from "./lib/cdp.mjs";

const [url, widthArg, heightArg, ...selectors] = process.argv.slice(2);
if (!url || !widthArg || !heightArg || selectors.length === 0) {
  console.error("用法: npx tsx scripts/measure-layout.mjs <url> <宽> <高> <选择器...>");
  process.exit(1);
}
const width = Number(widthArg);
const height = Number(heightArg);

const chrome = await launchChrome({ headful: true, extraArgs: [`--window-size=${width},${height}`] });
try {
  await chrome.session.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await chrome.navigate(url);
  await sleep(2500);

  const result = await chrome.session.evaluate(`
    const round = (n) => Math.round(n * 10) / 10;
    const describe = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        selector: el.className ? "." + String(el.className).split(" ").join(".") : el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 40),
        rect: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), bottom: round(r.bottom) },
        style: {
          display: cs.display, flexWrap: cs.flexWrap, alignItems: cs.alignItems,
          minHeight: cs.minHeight, whiteSpace: cs.whiteSpace, flexShrink: cs.flexShrink,
          rowGap: cs.rowGap, columnGap: cs.columnGap, padding: cs.padding,
        },
        lines: Math.round(r.height / parseFloat(cs.lineHeight || "1")),
      };
    };
    const out = { viewport: { w: innerWidth, h: innerHeight }, scrollHeight: document.documentElement.scrollHeight, targets: [], children: [] };
    for (const sel of ${JSON.stringify(selectors)}) {
      const el = document.querySelector(sel);
      if (!el) { out.targets.push({ selector: sel, missing: true }); continue; }
      out.targets.push(describe(el));
      out.children.push({ parent: sel, kids: [...el.children].map(describe) });
    }
    return out;
  `);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await chrome.close();
}
