import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * 浏览器支持基线（与 README / 页脚文案保持一致）：
 *   Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+
 *
 * 这三条下限由「核心语音链路依赖的能力」倒推：
 *   - AudioWorklet（Chrome 66 / Firefox 76 / Safari 14.1）——采集走 worklet，
 *     缺失时降级到已废弃的 ScriptProcessor；
 *   - getDisplayMedia（Chrome 72 / Firefox 66 / Safari 13）——屏幕共享；
 *   - `zoom` 布局缩放（Chrome 全版本 / Safari / Firefox 126）——缺失时
 *     main.ts 会把 `--ui-scale` 固定为 1，回到 1x 设计基准尺寸。
 *
 * build.target 交给 esbuild 做语法降级；cssTarget 决定 CSS 压缩器保留哪些
 * 语法。注意两者都**不会**给 `color-mix()` 这类运行时特性做 polyfill ——
 * 那部分由 WebClient.vue 末尾的 `@supports not (...)` 静态回退覆盖。
 */
const BROWSER_TARGETS = ["chrome94", "edge94", "firefox102", "safari15.4"];

export default defineConfig({
  plugins: [vue()],
  build: {
    target: BROWSER_TARGETS,
    cssTarget: BROWSER_TARGETS,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3040",
      "/ws": {
        target: "ws://localhost:3040",
        ws: true,
      },
    },
  },
});
