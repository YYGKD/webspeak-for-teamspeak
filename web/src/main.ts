import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import WebClient from "./views/WebClient.vue";
import AdminView from "./views/AdminView.vue";
import DemoView from "./views/DemoView.vue";
import "./services/theme.js";

const BASELINE_WIDTH = 1920;
const BASELINE_HEIGHT = 1080;
const MAX_UI_SCALE = 1.5;

/**
 * `zoom` 在 Firefox 126 之前完全没有实现（Safari / Blink 早就支持）。
 *
 * 缩放本身是锦上添花，但 `--ui-scale` 还被 `--app-vh: calc(100dvh / var(--ui-scale))`
 * 消费：如果浏览器忽略 `zoom` 却仍然按放大后的 ui-scale 去算视口高度，布局就会
 * 比真实视口矮一截。所以在不支持 `zoom` 的内核上必须把 scale 固定回 1，让
 * 「缩放」和「按缩放换算的视口高度」始终同步。
 */
const ZOOM_SUPPORTED = typeof CSS !== "undefined"
  && typeof CSS.supports === "function"
  && CSS.supports("zoom", "1");

function applyUiScale(): void {
  if (!ZOOM_SUPPORTED) {
    document.documentElement.style.setProperty("--ui-scale", "1");
    return;
  }
  // Keep the current 1080p layout as the reference. Only enlarge the UI when
  // both viewport dimensions provide more space; smaller windows keep the
  // existing responsive rules instead of shrinking text until it becomes hard
  // to read.
  const scale = Math.min(
    MAX_UI_SCALE,
    Math.max(1, Math.min(window.innerWidth / BASELINE_WIDTH, window.innerHeight / BASELINE_HEIGHT)),
  );
  document.documentElement.style.setProperty("--ui-scale", scale.toFixed(4));
}

applyUiScale();
window.addEventListener("resize", applyUiScale, { passive: true });

const routes = [
  { path: "/", name: "webclient", component: WebClient },
  { path: "/join", name: "join", component: WebClient },
  { path: "/demo", name: "demo", component: DemoView },
  { path: "/admin/:pathMatch(.*)*", name: "admin", component: AdminView },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
