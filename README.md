<div align="center">
  <a id="readme-top"></a>

  <img src="./image.png" alt="WebSpeak 项目横幅" width="100%" />

  <h1>WebSpeak</h1>

  <p><strong>让 TeamSpeak 自然地进入浏览器。</strong></p>
  <p>A self-hosted browser voice client for TeamSpeak 3 and TeamSpeak 6.</p>

  [![Latest Release](https://img.shields.io/github/v/release/YYGKD/webspeak-for-teamspeak?sort=semver&display_name=tag&style=flat-square&color=0f766e)](https://github.com/YYGKD/webspeak-for-teamspeak/releases/latest)
  [![Docker Image](https://github.com/YYGKD/webspeak-for-teamspeak/actions/workflows/docker-publish.yml/badge.svg?branch=master)](https://github.com/YYGKD/webspeak-for-teamspeak/actions/workflows/docker-publish.yml)
  [![License](https://img.shields.io/badge/license-AGPL--3.0--only-0f766e?style=flat-square)](./LICENSE)
  [![GitHub Stars](https://img.shields.io/github/stars/YYGKD/webspeak-for-teamspeak?style=flat-square&logo=github&color=0f766e)](https://github.com/YYGKD/webspeak-for-teamspeak/stargazers)
  <br />
  [![TeamSpeak](https://img.shields.io/badge/TeamSpeak-3%20%7C%206-2580C3?style=flat-square)](https://www.teamspeak.com/)
  [![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
  [![Vue](https://img.shields.io/badge/Vue-3-42B883?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/YYGKD/packages/container/package/webspeak)

  <p>
    <a href="./docs/README.zh-CN.md">简体中文文档</a> ·
    <a href="./docs/README.en.md">English documentation</a> ·
    <a href="./docs/README.de.md">Deutsche Dokumentation</a> ·
    <a href="./docs/README.ru.md">Русская документация</a> ·
    <a href="./docs/README.ja.md">日本語ドキュメント</a>
  </p>
</div>

## 项目简介 · Overview

| 逻辑 | 中文 | English |
| --- | --- | --- |
| **WHAT** | WebSpeak 是一个可自行部署的 TeamSpeak 3 / TeamSpeak 6 网页客户端与语音网关。 | WebSpeak is a self-hosted browser client and voice gateway for TeamSpeak 3 and TeamSpeak 6. |
| **WHY** | 无需安装桌面客户端，用户打开网页即可加入频道；部署者仍然掌控目标服务器、访问策略和数据。 | Users can join a voice channel from a browser without installing a desktop client, while the operator keeps control of servers, access, and data. |
| **HOW** | 部署后在管理员控制台配置 TeamSpeak 目标和访问方式，浏览器负责交互与音频，WebSpeak 负责网关连接。 | Configure the TeamSpeak target and access policy in the administration console. The browser handles interaction and audio; WebSpeak provides the gateway connection. |

## 架构与语音传输 · Architecture & Voice Transport

```text
浏览器 Browser ── WebRTC (mediasoup-client, Opus) ──► WebSpeak 网关 Gateway ──► TeamSpeak 3 / 6
浏览器 Browser ── WebSocket（仅 JSON 业务与媒体控制信令）──► WebSpeak 网关 Gateway
```

- **WebSocket 仅承担 JSON 业务与媒体控制信令**：频道/成员、聊天、屏幕共享协商与 WebRTC/mediasoup 握手信令；不再承载任何音频，入站二进制帧会收到 `UNSUPPORTED_BINARY_FRAME` 协议错误。
- **音频传输已全面由 WebRTC（mediasoup 单引擎）承载**：上行浏览器 `Producer` → 服务端 DirectTransport `Consumer` → TS3；下行 TS3 说话人 → DirectTransport `Producer` → 浏览器 `mediasoup-client` `Consumer`。
- 旧的 WebSocket 二进制音频兼容通道（1920 字节 PCM 帧 + 服务端 Opus 软转码）已**全面退役**，不再有 WS 音频回退路径。

**Architecture & Voice Transport**

- **WebSocket carries JSON business and media-control signaling only**: channels/members, chat, screen-share negotiation, and WebRTC/mediasoup handshake signaling. It no longer transports any audio, and inbound binary frames are answered with the `UNSUPPORTED_BINARY_FRAME` protocol error.
- **All audio is carried by WebRTC (the single mediasoup engine)**: uplink browser `Producer` → server DirectTransport `Consumer` → TS3; downlink TS3 speaker → DirectTransport `Producer` → browser `mediasoup-client` `Consumer`.
- The legacy WebSocket binary audio compatibility channel (1920-byte PCM frames + server-side Opus transcoding) is **fully retired**, with no WS audio fallback path.

## 浏览器兼容性 · Browser Compatibility

支持基线：**Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+**（含 iOS Safari 与 Android Chrome）。前端不按 UA 写分支，而是运行时探测能力矩阵（`web/src/services/browser-support.ts`），逐项降级：

| 能力 | Chromium（Chrome / Edge / Opera / 三星浏览器） | Firefox | Safari / iOS Safari |
| --- | --- | --- | --- |
| 实时语音（WebRTC + Opus） | ✅ | ✅ | ✅ |
| AudioWorklet 采集 | ✅ | ✅ | ✅（缺失时降级到 `ScriptProcessor`，延迟略高） |
| 输出设备选择（切换扬声器） | ✅ `AudioContext.setSinkId` | ✅ 惰性元素路由（见下） | ❌ 无 sink API，跟随系统音频路由 |
| 屏幕共享 | ✅ | ✅ | ✅ 桌面版；iOS 不支持 `getDisplayMedia` |
| 伴奏共享（采集显示音频） | ✅ | ❌ Gecko 不提供显示音频轨 | ❌ WebKit 不提供显示音频轨 |
| 麦克风自测录音回放 | ✅ `audio/webm` | ✅ `audio/webm` | ✅ `audio/mp4`（按 `MediaRecorder.isTypeSupported` 选择） |
| 解码诊断探针 | ✅ `webkitAudioDecodedByteCount` | ✅ 改用 RTP `totalAudioEnergy` | ✅ `webkitAudioDecodedByteCount` |

**扬声器选择如何做到 Chrome / Firefox 体验一致**（Firefox 153 + 真实扬声器实测，方法见下）

Firefox **有** `HTMLMediaElement.setSinkId`（自 116），**没有** `AudioContext.setSinkId`；其设备列表在授予麦克风权限后才出现（授权前 `enumerateDevices()` 只给 1 个 audioinput，`audiooutput` 为 0；授权后给出 2 个带真实名称的 `audiooutput`）。本应用的可听输出是 WebAudio 图，静音 `<audio>` 元素只驱动接收流 —— 所以单靠元素 `setSinkId` **改不了**实际出声。

因此播放层按能力矩阵的 `outputRoutingMode` 分两条路，**用户可见行为完全一致（同一个下拉框、同一份设备列表、切换即时生效）**：

| 内核 | `outputRoutingMode` | 机制 | 额外开销 |
| --- | --- | --- | --- |
| Chromium | `audioContext` | `AudioContext.setSinkId` 改整个上下文 | 无 |
| Firefox | `mediaElement` | **惰性**：只有用户选了非默认设备时，才把可听图接到 `MediaStreamAudioDestinationNode`，再用一个不静音的元素播放并 `setSinkId` | 仅在选择设备后多一级缓冲；不选则走 `ctx.destination`，零开销 |
| WebKit / Safari | `none` | 无任何 sink API，显示说明并指向系统级设置 | — |

实测各阶段落在哪个物理端点（元素 sink 固定指向**耳机**，因此 P3 具有判别力）：

| 阶段 | 播放路径 | 音响（Windows 默认）峰值 | 耳机峰值 |
| --- | --- | --- | --- |
| P1 | 仅 WebAudio 图（元素静音、sink 指向耳机） | **0.25000** | 0.00000 |
| P2 | `<audio>` 元素，`setSinkId(耳机)` | 0.00000 | **0.25045** |
| P3 | **仅 WebAudio 图，元素 sink 仍指向耳机** | **0.25000** | 0.00000 |
| P4 | `<audio>` 元素，`setSinkId(音响)` | **0.25046** | 0.00000 |

三条结论：**①** WebAudio 输出跟随**浏览器/系统的音频路由**（在系统「音量合成器」里把 Firefox 指定为耳机时，同一段代码就落到耳机；改回默认后落到音响——一次真实的因果对照）；**②** 元素级 `setSinkId` 双向都能生效；**③** 元素 `setSinkId` 单独用**无法**改道 WebAudio 图（P3 与 P1 完全相同）——这正是必须把混音接到元素上、而不能只给元素设 sink 的原因。

实现后的验收测量（`audiotest6.html`，复刻 `setOutputRouting()` 的建立 / 改接 / 拆卸 / 重建序列）：

| 阶段 | 动作 | 音响峰值 | 耳机峰值 |
| --- | --- | --- | --- |
| P1 | 默认：图在 `ctx.destination` | **0.25000** | 0.00000 |
| P2 | 选中耳机 → 惰性建立元素路由 | 0.00000 | **0.25046** |
| P3 | 切回默认 → 拆卸元素路由 | **0.25000** | 0.00000 |
| P4 | 再次选中耳机（重建） | 0.25000（边界瞬时） | **0.25034** |
| P5 | 元素路由切到音响 | **0.25046** | 0.00000 |

切换期间旧设备上的音会延续到异步改接完成（P4 音响列出现约 2 个采样点的残留），这是有意的——避免切换时出现断音。

其他要点：

- **阻断性条件只有四项**：HTTPS 安全上下文、`RTCPeerConnection`、`getUserMedia`、Web Audio。任一缺失会在入会页给出明确提示，而不是进房后静默无声。
- **降噪包必须惰性加载**：`@sapphi-red/web-noise-suppressor` 的模块顶层有 `class RnnoiseWorkletNode extends AudioWorkletNode {}`。静态 import 会在没有 AudioWorklet 的内核（旧 WebKit、关闭了 AudioWorklet 的加固配置、部分 WebView）里于应用启动时抛 `ReferenceError`，把整个页面打挂，使 `ScriptProcessor` 兜底永远无法执行。现在只在确认能力后 `await import()`，该包也被拆成独立的 1.4 KB 懒加载 chunk。
- **显示采集提示按内核筛选**：`displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio` 都是 Chromium 专有；WebKit 可能因未知字典成员整段拒绝 `getDisplayMedia`，因此只在确认支持时下发，并带一次 `video: true` 的最小约束重试。
- **远端音频 sink**：Blink / WebKit 必须把远端轨道挂到静音的 `<audio>` 元素上才会真正拉取解码，Gecko 不需要（但保留该元素无害）。
- **CSS 降级**：`color-mix()` 需要 Chrome 111 / Firefox 113 / Safari 16.2，高于支持基线，因此在 `WebClient.vue` 末尾有 `@supports not (color: color-mix(...))` 静态回退块，覆盖焦点轮廓、实心背景与静音/激活状态；`-webkit-backdrop-filter` 与标准属性成对书写以适配 Safari。`AdminView` 的选择态改用 `.choice.selected` 类，不再依赖需要 Firefox 121+ 的 `:has()`。
- **构建目标**：`web/vite.config.ts` 的 `build.target` / `build.cssTarget` 固定为 `chrome94 / edge94 / firefox102 / safari15.4`。注意 esbuild 只做语法降级，不会 polyfill `color-mix()` 这类运行时特性。
- **布局缩放**：`#app { zoom: var(--ui-scale) }` 在高分屏上放大 UI；Firefox 126 之前不支持 `zoom`，此时 `main.ts` 会把 `--ui-scale` 固定为 `1`，避免「缩放失效但仍按放大比例换算视口高度」导致的布局偏矮。

**Browser Compatibility**

Supported baseline: **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+** (including iOS Safari and Android Chrome). The frontend does not branch on the user agent; it probes a capability matrix at runtime (`web/src/services/browser-support.ts`) and degrades per feature:

| Capability | Chromium (Chrome / Edge / Opera / Samsung Internet) | Firefox | Safari / iOS Safari |
| --- | --- | --- | --- |
| Realtime voice (WebRTC + Opus) | ✅ | ✅ | ✅ |
| AudioWorklet capture | ✅ | ✅ | ✅ (falls back to `ScriptProcessor`, slightly higher latency) |
| Output device selection | ✅ `AudioContext.setSinkId` | ✅ lazy element routing (below) | ❌ no sink API; follows the system audio route |
| Screen sharing | ✅ | ✅ | ✅ desktop; iOS has no `getDisplayMedia` |
| Accompaniment (display audio) | ✅ | ❌ Gecko exposes no display audio track | ❌ WebKit exposes no display audio track |
| Microphone test playback | ✅ `audio/webm` | ✅ `audio/webm` | ✅ `audio/mp4` (chosen via `MediaRecorder.isTypeSupported`) |
| Decode diagnostics probe | ✅ `webkitAudioDecodedByteCount` | ✅ uses RTP `totalAudioEnergy` instead | ✅ `webkitAudioDecodedByteCount` |

**How speaker selection is made identical on Chrome and Firefox** (measured on Firefox 153 with real speakers; method below)

Firefox **has** `HTMLMediaElement.setSinkId` (since 116) and **has no** `AudioContext.setSinkId`. Its device list only appears after a microphone grant (before one, `enumerateDevices()` returns a single `audioinput` and zero `audiooutput`; after one it returns two `audiooutput` entries with real names). This app's audible output is the WebAudio graph, with a muted `<audio>` element only driving the receive stream — so element `setSinkId` on its own **cannot** move what you hear.

The playback layer therefore takes one of two paths, chosen from the capability matrix's `outputRoutingMode`, with **identical user-visible behaviour (same dropdown, same device list, switching takes effect immediately)**:

| Engine | `outputRoutingMode` | Mechanism | Added cost |
| --- | --- | --- | --- |
| Chromium | `audioContext` | `AudioContext.setSinkId` redirects the whole context | none |
| Firefox | `mediaElement` | **Lazy**: only once the user picks a non-default device is the audible graph rewired onto a `MediaStreamAudioDestinationNode` played by an unmuted `<audio>` element with `setSinkId` | one extra buffering stage, and only after a device is chosen; with no device chosen the graph stays on `ctx.destination` (zero cost) |
| WebKit / Safari | `none` | no sink API at all; shows an explanation pointing at the system-level setting | — |

Which physical endpoint each phase landed on (the element's sink is pinned to the **headphones**, which makes P3 discriminating):

| Phase | Playback path | Speakers (Windows default) peak | Headphones peak |
| --- | --- | --- | --- |
| P1 | WebAudio graph only (element silent, sink pinned to headphones) | **0.25000** | 0.00000 |
| P2 | `<audio>` element, `setSinkId(headphones)` | 0.00000 | **0.25045** |
| P3 | **WebAudio graph only, element sink still pinned to headphones** | **0.25000** | 0.00000 |
| P4 | `<audio>` element, `setSinkId(speakers)` | **0.25046** | 0.00000 |

Three conclusions: **①** WebAudio output follows the **browser/OS audio route** — the same code played on the headphones while Windows' per-app setting routed Firefox there, and on the speakers once the route went back to Default, which is a genuine causal comparison; **②** element-level `setSinkId` works in both directions; **③** element `setSinkId` on its own **cannot** redirect the WebAudio graph (P3 is identical to P1) — which is exactly why the mix has to be routed *through* an element rather than merely setting a sink on one.

Acceptance measurement after implementing it (`audiotest6.html`, replaying `setOutputRouting()`'s create / rewire / release / re-create sequence):

| Phase | Action | Speakers peak | Headphones peak |
| --- | --- | --- | --- |
| P1 | default: graph on `ctx.destination` | **0.25000** | 0.00000 |
| P2 | headphones chosen → lazy element route created | 0.00000 | **0.25046** |
| P3 | back to default → element route released | **0.25000** | 0.00000 |
| P4 | headphones chosen again (re-created) | 0.25000 (boundary only) | **0.25034** |
| P5 | element route switched to speakers | **0.25046** | 0.00000 |

Audio keeps playing on the previous device until the async rewire completes (P4 shows roughly two samples on the speakers), which is deliberate: switching a device must not produce a gap.

Other notes:

- **The noise-suppressor must be imported lazily**: `@sapphi-red/web-noise-suppressor` has `class RnnoiseWorkletNode extends AudioWorkletNode {}` at module top level. A static import throws `ReferenceError` during application start-up on any engine without AudioWorklet (older WebKit, privacy-hardened configurations, some WebViews), which takes the whole page down and makes the `ScriptProcessor` fallback unreachable. It is now `await import()`ed only after the capability check, which also splits the package into its own 1.4 KB lazy chunk.

- **Only four blocking conditions**: a secure HTTPS context, `RTCPeerConnection`, `getUserMedia`, and Web Audio. A missing one produces an explicit message on the join page instead of silent audio after joining.
- **Display-capture hints are filtered per engine**: `displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio` are Chromium-only; WebKit may reject the whole `getDisplayMedia` dictionary on an unknown member, so they are only sent when confirmed supported, with one minimal-constraint `video: true` retry.
- **Remote audio sink**: Blink / WebKit only start pulling and decoding a remote track once it is attached to a muted `<audio>` element; Gecko does not need it (keeping the element is harmless).
- **CSS fallbacks**: `color-mix()` needs Chrome 111 / Firefox 113 / Safari 16.2, above the baseline, so `WebClient.vue` ends with an `@supports not (color: color-mix(...))` block covering focus outlines, solid backgrounds, and muted/active states; `-webkit-backdrop-filter` is written alongside the standard property for Safari. `AdminView` selection state now uses a `.choice.selected` class instead of `:has()`, which needs Firefox 121+.
- **Build targets**: `build.target` / `build.cssTarget` in `web/vite.config.ts` are pinned to `chrome94 / edge94 / firefox102 / safari15.4`. esbuild only downlevels syntax; it does not polyfill runtime features such as `color-mix()`.
- **Layout scaling**: `#app { zoom: var(--ui-scale) }` enlarges the UI on high-resolution viewports. Firefox before 126 has no `zoom`, so `main.ts` pins `--ui-scale` to `1` there, avoiding a layout that is shorter than the viewport because the height is still divided by an ineffective scale.

## 文档 · Documentation

- [简体中文](./docs/README.zh-CN.md)
- [English](./docs/README.en.md)
- [Deutsch](./docs/README.de.md)
- [Русский](./docs/README.ru.md)
- [日本語](./docs/README.ja.md)

## 许可证 · License · Lizenz · Лицензия · ライセンス

WebSpeak 使用 [GNU Affero General Public License v3.0 only](./LICENSE) 发布。你可以使用、研究、修改和再分发本项目；如果修改后的版本通过网络向用户提供服务，需要按照 AGPL-3.0 向这些用户提供对应源代码。

WebSpeak is released under the [GNU Affero General Public License v3.0 only](./LICENSE). If a modified version is offered to users over a network, its corresponding source code must be offered under AGPL-3.0.

WebSpeak wird unter der [GNU Affero General Public License v3.0 only](./LICENSE) veröffentlicht. Bei Bereitstellung einer veränderten Version über ein Netzwerk muss der entsprechende Quellcode unter AGPL-3.0 angeboten werden.

WebSpeak распространяется по лицензии [GNU Affero General Public License v3.0 only](./LICENSE). Если изменённая версия предоставляется пользователям через сеть, соответствующий исходный код должен быть доступен этим пользователям на условиях AGPL-3.0.

WebSpeak は [GNU Affero General Public License v3.0 only](./LICENSE) の下で公開されています。変更版をネットワーク経由でユーザーに提供する場合は、対応するソースコードを AGPL-3.0 に従ってユーザーに提供する必要があります。

### 来源与衍生说明 · Origin & derivative

本仓库是 [`EchoSixHIYA/WebSpeak-client-for-TeamSpeak`](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak) 的**衍生版本**，上游基线为 `v0.2.4`（本仓库标签 `upstream-v0.2.4`）。自 `v0.2.5` 起对源码所作的修改及日期，记录在 [`CHANGELOG.md`](./CHANGELOG.md)；完整声明见 [`NOTICE`](./NOTICE)。

This repository is a **derivative** of [`EchoSixHIYA/WebSpeak-client-for-TeamSpeak`](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak), based on upstream `v0.2.4` (tagged `upstream-v0.2.4` here). Changes made to the source since `v0.2.5`, and their dates, are recorded in [`CHANGELOG.md`](./CHANGELOG.md); see [`NOTICE`](./NOTICE) for the full statement.

<div align="right"><a href="#readme-top">返回顶部 · Back to top ↑</a></div>
