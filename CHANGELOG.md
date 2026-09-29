# Changelog

## [0.2.7] — 2026-09-30

### 中文

- 新增**跨内核浏览器兼容层**（`web/src/services/browser-support.ts`）：运行时探测内核与版本，产出统一的能力矩阵与降级清单，取代散落在各处的 `'webkitFoo' in window` 式分支。支持基线为 **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+**（含 iOS Safari 与 Android Chrome），页脚不再写死「Chrome / Edge 94+」。
- **阻断条件收敛为四项**：HTTPS 安全上下文、`RTCPeerConnection`、`getUserMedia`、Web Audio。任一缺失在入会页给出明确原因；其余能力缺失一律降级并在页面提示，不再出现「进了房但没声音」的静默失败。
- 修复**输出设备选择在 Firefox/Safari 上形同虚设**：此前只要探测到 `getDisplayMedia` 就露出扬声器下拉框，而两个内核都没有实现 `setSinkId`。现在 `outputDeviceSupported` 直接来自能力矩阵，不支持的内核显示明确说明而非无效控件。
- 修复**伴奏共享在 Firefox/Safari 上必然失败**：`getDisplayMedia` 在 Gecko/WebKit 只返回视频轨，此前仅凭「API 存在」就放行，用户选完来源只会得到「所选来源没有可共享音频」。现在以 `displayAudioCapture`（Chromium 专有）为门槛。
- 修复**显示采集约束可能被 WebKit 整段拒绝**：`displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio` 均为 Chromium 专有，现在按内核筛选下发，并在遇到 `TypeError` 时以最小约束 `video: true` 重试一次；屏幕共享与伴奏共享两条路径同样处理。
- 修复**麦克风自测在无 `MediaRecorder` 的内核上会永久停在测试态**：此前自动停止的 5 秒定时器只在录制分支里设置，录制器构造失败时测试态永不结束。现在定时器无条件设置，并按 `MediaRecorder.isTypeSupported` 选择容器（Safari 走 `audio/mp4`，不再假定 `audio/webm`）。
- 修复**Gecko 上缺少解码诊断手段**：`webkitAudioDecodedByteCount` 为 Blink/WebKit 专有，`probeElement` 在 Firefox 上恒为 `null`；现补充基于 RTP `totalAudioEnergy` / `audioLevel` 的 `readConsumerAudioEnergy()` 作为跨内核判据。
- 修复**Firefox 126 之前高分屏布局偏矮**：`#app { zoom: var(--ui-scale) }` 被忽略，但 `--app-vh: calc(100dvh / var(--ui-scale))` 仍按放大比例换算，导致布局比真实视口矮一截。现在 `main.ts` 先检测 `CSS.supports("zoom", "1")`，不支持时把 `--ui-scale` 固定为 `1`。
- 样式兼容：新增 `@supports not (color: color-mix(in srgb, red, blue))` 静态回退块，覆盖焦点轮廓、实心半透明背景与静音/激活状态（`color-mix()` 需 Chrome 111 / Firefox 113 / Safari 16.2，高于支持基线）；`backdrop-filter` 与 `-webkit-backdrop-filter` 成对书写以适配 Safari；`AdminView` 的单选选择态改用 `.choice.selected` 类，不再依赖需要 Firefox 121+ 的 `:has()`。
- 构建基线：`web/vite.config.ts` 的 `build.target` 与 `build.cssTarget` 固定为 `chrome94 / edge94 / firefox102 / safari15.4`。esbuild 只做语法降级，不 polyfill `color-mix()` 这类运行时特性——这也是上一项静态回退必须存在的原因。
- **真机验证**（Chrome 154 / Firefox 155 / Playwright WebKit 26.6，共 170 条断言）：能力矩阵与各内核**独立实测**的平台事实逐项一致（sink API、`webkitAudioDecodedByteCount`、`AudioWorklet`、`MediaRecorder`、`getDisplayMedia`、CSS 能力等），三个内核均能挂载应用且无未捕获异常，`@supports not (color-mix)` 回退块的 25 条选择器全部命中真实类名、6 条声明在隔离环境下确实生效、键盘焦点轮廓可见，`zoom` 守卫在伪造 `CSS.supports("zoom","1")===false` 后正确把 `--ui-scale` 固定为 `1`。
- 修复**无 AudioWorklet 内核上应用启动即崩溃**（真机实测发现的硬故障）：`@sapphi-red/web-noise-suppressor` 的模块顶层是 `class RnnoiseWorkletNode extends AudioWorkletNode {}`，静态 import 会在 WebKit / 关闭 AudioWorklet 的配置 / 部分 WebView 里于启动阶段抛 `ReferenceError`，整页白屏，`ScriptProcessor` 兜底永远执行不到。改为按需 `await import()`，该包同时被拆成独立的 1.4 KB 懒加载 chunk。
- 修正 **Firefox 的扬声器选择判断**（实测 Firefox 155）：Firefox 自 116 起有 `HTMLMediaElement.setSinkId`，但没有 `AudioContext.setSinkId`；本应用的可听输出是 WebAudio 图、静音元素不发声，因此元素级 sink 改不了实际出声。UI 改为按新增能力位 `webAudioOutputRouting`（= `AudioContext.setSinkId`）显隐，Firefox 上显示说明文字而不是无效下拉框；README 中「Firefox 未实现 setSinkId」的表述已更正。
- 修正 `CSS.supports` 的选择器探测写法：实测 `CSS.supports("selector(:has(*))", "true")` 在 Chrome 154 / Firefox 155 / WebKit 26.6 上**全部返回 false**（双参数形式把首参当属性名解析），必须用单参数的 `CSS.supports("selector(:has(*))")`。
- **在真实 Firefox 153 + 真实扬声器上完成了可听链路的客观验证**（自建 WASAPI 探针：读端点峰值表 + 按端点归因音频会话 PID，350 ms 采样）。结论逐条落地：① Firefox **有** `HTMLMediaElement.setSinkId`（授权麦克风后才列出 2 个带真实名称的 `audiooutput`，未授权时为 0）；② 元素级 `setSinkId` **双向都能生效**（目标端点 0.250，另一端点恰好 0）；③ WebAudio 输出跟随浏览器/系统的音频路由——把同一段代码在「系统音量合成器里将 Firefox 指定为耳机」与「改回默认」两种设置下各测一次，声音分别落在耳机与音响，构成真实的因果对照；④ 元素 `setSinkId` **无法**改道 WebAudio 图（判别性实验：元素 sink 固定指向耳机，WebAudio 音仍留在音响，耳机端点恒为 0.00000）。因此「按 `webAudioOutputRouting` 显隐页面内扬声器选择」的做法得到实测支持。
- 据此修正文案：原先提示「将使用默认输出设备」不准确（实际跟随浏览器/系统路由，此机上恰恰是**非**默认的耳机），改为说明「输出跟随系统音频设置，可在系统音量合成器中为浏览器单独指定」，并在设置面板同步更新（5 语言）。
- **实现惰性元素路由，让 Chrome 与 Firefox 的扬声器选择体验一致**：能力矩阵新增 `outputRoutingMode`（`audioContext` / `mediaElement` / `none`），UI 统一按 `!== "none"` 显隐——Chrome 与 Firefox 露出同一个下拉框、同一份设备列表、切换即时生效；Safari/WebKit 因无任何 sink API 仍显示说明（不在本次适配范围）。Chromium 走 `AudioContext.setSinkId`（零额外开销）；Firefox 只在用户**真的选了非默认设备**时才把可听图改接到 `MediaStreamAudioDestinationNode`，再用一个不静音的 `<audio>` 元素播放并 `setSinkId` —— 不选设备就仍走 `ctx.destination`，因此没有人为所有 Firefox 用户增加缓冲延迟。所有可听连接统一走 `outputBus(ctx)`（说话人分析节点、通知音），拆卸/回滚/AudioContext 关闭时都有对应收口，切换过程不断音。
- 移除 `applySpeakerSink()` 这类「逐个给静音拉流元素设 sink」的旧逻辑并删除 `SinkAudioElement` 类型：那些元素是静音的拉流驱动，设置它们的 sink 从来不影响用户实际听到的声音。设置面板的扬声器下拉框在 Firefox 上恢复可用。
- **验收测量**（`audiotest6.html`，复刻 `setOutputRouting()` 的建立 → 改接 → 拆卸 → 重建序列，WASAPI 端点峰值客观判定）：默认路径在 Windows 默认设备（0.25000）；选中耳机后惰性建立元素路由，声音精确出现在耳机（0.25046）而默认设备归零；切回默认后拆卸成功、声音回到默认设备；再次选中与跨设备切换同样正确。切换期间旧设备上的音延续到异步改接完成（约 2 个采样点），这是有意的——避免切换出现断音。
- 修复 **Firefox 下紧凑控件文字折行**（用户报告：顶部栏「网络性能」折成两行、「退出」竖排）。根因是 CJK 标签的**最小内容宽度只有一个字符**，而这类控件的宽度恰好等于「图标 + 标签 + 内边距」，标签正好占满文字宽度——于是约 1px 的字体度量差异就能翻转结果。实测（真实构建产物，Chrome 154 / Firefox 155）：两内核都把 `.performance-trigger` 排成 ~136px，但标签拿到的宽度是 Chrome 44.0px / Firefox 43.1px，而「网络性能」需要约 44px，因此 Firefox 折行、Chrome 不折，且**与窗口宽度无关**（1400px 下同样折行）。
- 修法：给紧凑控件加一组 `white-space: nowrap`（让标签的最小内容宽度等于完整文字宽度，flex 的 `min-width: auto` 便不再把它压到折行），并让 `.workspace-actions { flex: 0 0 auto }` —— 空间不足时由自带省略号的 `.breadcrumbs` 承担收缩，而不是破坏按钮文字；`.breadcrumbs { overflow: hidden }` 兜住极端窄宽度。规则只列**模板里真正用到**的类名（`.nav-rail` / `.rail-button` / `.control-dock` / `.mic-mode-switch` / `.quick-action` / `.settings-nav-item` / `.live-pill` / `.github-button` 等旧布局类名只剩 CSS）。
- 为此新增布局测量装置（`.local/browser-verify/layout-probe.html` + `layout-compare.mjs`）：加载**真实编译产物 CSS**、按真实类名与 scope 属性重建在用界面，并对每一行做宽度扫描，比对 Chrome 与 Firefox。修复前该装置定位出 5 处同类折行（含顶部栏、成员面板、设置面板），修复后**在用界面的引擎差异为 0**；同时排除了两个假阳性（`.breadcrumbs strong` 的 `overflow/scrollWidth` 是省略号设计的正常表现；两个 `display: inline` 的 span 其 `clientWidth` 按规范恒为 0，不算裁切）。
- 页脚文案压缩：可见部分改为只列浏览器名「Chrome · Edge · Firefox · Safari」，精确的最低版本移到既有的悬停提示里（提示现为「支持版本：… + 检测到的浏览器 + 降级项」）。实测窄宽度下开始折行的阈值：原「Chrome / Edge 94+」为 360px，加上版本矩阵后升到 500px，压缩后回到 **400px**，且两个内核完全一致。可见文字比以前更短、覆盖的浏览器却更多（旧文案只提 Chrome/Edge），信息没有丢失。
- 记录可复现的验证装置与全部原始读数（`.local/browser-verify/audio-findings.md`、`AudioProbe.cs`、`sample-audio.ps1`、`audiotest2/3.html`），并把「惰性切换的元素级路由」列为下一步方案：P2 已证明该做法有效，但要为所有 Firefox 用户的听感链路增加一级缓冲，因此只能在用户真正选择非默认设备时启用。

### English

- Added a **cross-engine browser compatibility layer** (`web/src/services/browser-support.ts`): engine and version detection at runtime produce one capability matrix and one degradation list, replacing the ad-hoc `'webkitFoo' in window` checks scattered across the UI. The supported baseline is **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+** (including iOS Safari and Android Chrome), and the footer no longer hardcodes “Chrome / Edge 94+”.
- **Blocking conditions are down to four**: a secure HTTPS context, `RTCPeerConnection`, `getUserMedia`, and Web Audio. A missing one reports the reason on the join page; every other gap degrades with a visible notice instead of failing silently as “joined but no audio”.
- Fixed **output-device selection being a no-op on Firefox/Safari**: the speaker dropdown appeared whenever `getDisplayMedia` existed, although neither engine implements `setSinkId`. `outputDeviceSupported` now comes from the capability matrix, so unsupported engines show an explanation rather than a dead control.
- Fixed **accompaniment sharing always failing on Firefox/Safari**: `getDisplayMedia` returns a video-only stream on Gecko/WebKit, but the entry point only checked that the API existed, so picking a source always ended in “the selected source has no shareable audio”. It is now gated on `displayAudioCapture` (Chromium only).
- Fixed **display-capture constraints possibly being rejected wholesale by WebKit**: `displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio` are all Chromium-only. They are now sent per engine, with one minimal-constraint `video: true` retry on `TypeError`, on both the screen-share and accompaniment paths.
- Fixed **the microphone test hanging forever on engines without `MediaRecorder`**: the 5-second auto-stop timer was only armed inside the recording branch, so a failed recorder construction left the test active indefinitely. The timer is now unconditional, and the container is chosen via `MediaRecorder.isTypeSupported` (Safari gets `audio/mp4`; `audio/webm` is no longer assumed).
- Fixed **the missing decode diagnostic on Gecko**: `webkitAudioDecodedByteCount` is Blink/WebKit only, so `probeElement` always returned `null` on Firefox. `readConsumerAudioEnergy()` now provides a cross-engine signal from RTP `totalAudioEnergy` / `audioLevel`.
- Fixed **a short layout on high-resolution viewports in Firefox before 126**: `#app { zoom: var(--ui-scale) }` was ignored, yet `--app-vh: calc(100dvh / var(--ui-scale))` still divided by the enlarged scale. `main.ts` now checks `CSS.supports("zoom", "1")` and pins `--ui-scale` to `1` when unsupported.
- Style compatibility: an `@supports not (color: color-mix(in srgb, red, blue))` fallback block now covers focus outlines, solid translucent backgrounds, and muted/active states (`color-mix()` needs Chrome 111 / Firefox 113 / Safari 16.2, above the baseline); `backdrop-filter` is written together with `-webkit-backdrop-filter` for Safari; the `AdminView` radio selection state uses a `.choice.selected` class instead of `:has()`, which needs Firefox 121+.
- Build baseline: `build.target` and `build.cssTarget` in `web/vite.config.ts` are pinned to `chrome94 / edge94 / firefox102 / safari15.4`. esbuild only downlevels syntax and does not polyfill runtime features such as `color-mix()` — which is exactly why the static fallback above is required.
- **Verified on real engines** (Chrome 154 / Firefox 155 / Playwright WebKit 26.6, 170 assertions): every capability in the matrix agrees with an independently measured platform fact (sink APIs, `webkitAudioDecodedByteCount`, `AudioWorklet`, `MediaRecorder`, `getDisplayMedia`, CSS support). All three engines mount the app with no uncaught exceptions. The `@supports not (color-mix)` fallback's 25 selectors all resolve against real component class names, six of its declarations demonstrably take effect in isolation, the keyboard focus outline stays visible, and the `zoom` guard pins `--ui-scale` to `1` once `CSS.supports("zoom","1")` is stubbed to `false`.
- Fixed a **hard boot crash on engines without AudioWorklet**, found by the real-browser run: `@sapphi-red/web-noise-suppressor` declares `class RnnoiseWorkletNode extends AudioWorkletNode {}` at module top level, so a static import throws `ReferenceError` during start-up on WebKit, privacy-hardened configurations, and some WebViews — blanking the page before the `ScriptProcessor` fallback could ever run. It is now `await import()`ed on demand, which also splits the package into a 1.4 KB lazy chunk.
- Corrected the **Firefox speaker-selection verdict** (measured on Firefox 155): Firefox has `HTMLMediaElement.setSinkId` since 116 but no `AudioContext.setSinkId`. This app's audible output is the WebAudio graph and the muted element produces no sound, so an element-level sink change cannot move what you hear. The UI now keys on a new `webAudioOutputRouting` capability (= `AudioContext.setSinkId`) and shows an explanatory line on Firefox instead of a dead dropdown; the README claim that Firefox never implemented `setSinkId` is corrected.
- Corrected the `CSS.supports` selector probe: `CSS.supports("selector(:has(*))", "true")` returns **false** on Chrome 154, Firefox 155 and WebKit 26.6 (the two-argument form parses the first argument as a property name). The one-argument form is required.
- **Objectively verified the audible path on real Firefox 153 with real speakers**, using a purpose-built WASAPI probe (per-endpoint peak meters + per-endpoint audio-session PID attribution, sampled every 350 ms). Findings: ① Firefox **has** `HTMLMediaElement.setSinkId`, and lists two named `audiooutput` devices — but only after a microphone grant (zero before one); ② element `setSinkId` **works in both directions** (0.250 on the target, exactly 0 on the other endpoint); ③ WebAudio output follows the **browser/OS audio route** — the same code was measured twice, once with Windows' per-app output set to the headphones and once back on Default, and the sound landed on the headphones and the speakers respectively, which is a genuine causal comparison; ④ element `setSinkId` **cannot** redirect the WebAudio graph (discriminating test: with the element pinned to the headphones the WebAudio tone stayed on the speakers and the headphones endpoint read exactly `0.00000`). Gating in-page speaker selection on `webAudioOutputRouting` is therefore confirmed by measurement.
- Corrected the notice text accordingly: "falls back to the default output device" was wrong (output follows the browser/OS route, which on this machine is the **non-default** headphones). It now says output follows the system audio setting and can be assigned per-app in the system volume mixer, with the settings panel updated to match in all five languages.
- **Implemented lazy element routing so speaker selection behaves identically on Chrome and Firefox.** The capability matrix gains `outputRoutingMode` (`audioContext` / `mediaElement` / `none`) and the UI gates on `!== "none"` — Chrome and Firefox get the same dropdown, the same device list, and switching that takes effect immediately; Safari/WebKit has no sink API and still shows an explanation (explicitly out of scope). Chromium uses `AudioContext.setSinkId` (zero added cost); Firefox rewires the audible graph onto a `MediaStreamAudioDestinationNode` played by an **unmuted** `<audio>` element with `setSinkId` **only once the user actually picks a non-default device** — with no device chosen the graph stays on `ctx.destination`, so no Firefox user pays for extra buffering. All audible connections go through `outputBus(ctx)` (speaker analysers, notification tones), with teardown, rollback and AudioContext-close paths handled, and no gap in audio while switching.
- Removed the old `applySpeakerSink()` "set a sink on every muted pull-driver element" logic and the `SinkAudioElement` type: those elements are muted pull drivers and setting their sink never affected what the user heard. The speaker dropdown is now functional on Firefox.
- **Acceptance measurement** (`audiotest6.html`, replaying `setOutputRouting()`'s create → rewire → release → re-create sequence, judged objectively with WASAPI endpoint peak meters): the default path stays on the Windows default device (0.25000); choosing the headphones lazily creates the element route and the sound appears exactly on the headphones (0.25046) while the default endpoint drops to zero; switching back releases it and audio returns to the default device; re-selecting and cross-device switching are also correct. Audio continues on the previous device until the async rewire completes (about two samples), which is deliberate — switching a device must not produce a gap.
- Fixed **CJK labels wrapping inside compact controls in Firefox** (reported: the header's「网络性能」broke onto two lines and「退出」stacked vertically). The cause is that a CJK label's **min-content width is a single character**, while these controls are sized as "icon + label + padding" — so the label gets exactly its text width and a ~1px font-metric difference flips the result. Measured on the real build (Chrome 154 / Firefox 155): both engines lay `.performance-trigger` out at ~136px, but the label box gets 44.0px in Chrome vs 43.1px in Firefox while「网络性能」needs ~44px, so Firefox wraps and Chrome does not — **at every window width, including 1400px**.
- Fix: a grouped `white-space: nowrap` rule for compact controls (making the label's minimum size equal its full text width, so flex `min-width: auto` can no longer squeeze it into wrapping), plus `.workspace-actions { flex: 0 0 auto }` so the shrink falls on the self-ellipsizing `.breadcrumbs` instead of on button text, plus `.breadcrumbs { overflow: hidden }` for extreme cases. The rule lists only classes **actually used in the template** — several older layout classes (`.nav-rail`, `.rail-button`, `.control-dock`, `.mic-mode-switch`, `.quick-action`, `.settings-nav-item`, `.live-pill`, `.github-button`, …) survive only in CSS.
- Added a layout harness for this (`.local/browser-verify/layout-probe.html` + `layout-compare.mjs`): it loads the **real compiled CSS**, rebuilds the shipped chrome with real class names and scope attributes, and sweeps every row's width comparing Chrome with Firefox. Before the fix it located five instances of the same defect (header, member panel, settings panel); after it, **engine divergence across the live chrome is 0**. It also cleared two false positives (`.breadcrumbs strong` reporting `scrollWidth > clientWidth` is the ellipsis design working; two `display: inline` spans have a spec-defined `clientWidth` of 0 and are not clipping).
- Compressed the footer text: the visible part now lists only browser names — "Chrome · Edge · Firefox · Safari" — and the precise minimum versions moved into the existing tooltip (which now shows "Supported: … + detected browser + degradations"). Measured narrow-width wrap thresholds: the original "Chrome / Edge 94+" wrapped at 360px, adding the version matrix pushed that to 500px, and the compressed form is back to **400px**, identical in both engines. The visible text is shorter than before yet covers more browsers (the old string mentioned only Chrome/Edge), so no information is lost.
- Recorded the reproducible rig and all raw readings (`.local/browser-verify/audio-findings.md`, `AudioProbe.cs`, `sample-audio.ps1`, `audiotest2/3.html`), and scoped the follow-up: the lazy element-based routing is proven feasible (phase P2), but it adds a buffering stage to every Firefox user's audible path, so it must only be switched in when a non-default device is actually selected.

### Deutsch

- Neue **engineübergreifende Browser-Kompatibilitätsschicht** (`web/src/services/browser-support.ts`): Engine- und Versionserkennung zur Laufzeit erzeugen eine einheitliche Fähigkeitsmatrix und eine Degradationsliste und ersetzen die verstreuten `'webkitFoo' in window`-Prüfungen. Die unterstützte Basis ist **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+** (inklusive iOS-Safari und Android-Chrome); die Fußzeile nennt nicht mehr fest „Chrome / Edge 94+“.
- **Nur noch vier blockierende Bedingungen**: sicherer HTTPS-Kontext, `RTCPeerConnection`, `getUserMedia` und Web Audio. Fehlt eine davon, nennt die Beitrittsseite den Grund; alle anderen Lücken werden sichtbar degradiert statt still als „beigetreten, aber ohne Ton“ zu enden.
- Behoben: **Ausgabegerätewahl war in Firefox/Safari wirkungslos** – die Lautsprecherauswahl erschien, sobald `getDisplayMedia` existierte, obwohl keine der beiden Engines `setSinkId` implementiert. `outputDeviceSupported` stammt jetzt aus der Fähigkeitsmatrix, sodass nicht unterstützte Engines eine Erklärung statt eines toten Bedienelements zeigen.
- Behoben: **Begleitton schlug in Firefox/Safari immer fehl** – `getDisplayMedia` liefert in Gecko/WebKit nur eine Audiospur-freie Videospur, der Einstieg prüfte aber nur die Existenz der API. Jetzt gilt `displayAudioCapture` (nur Chromium) als Bedingung.
- Behoben: **Anzeige-Aufnahmebedingungen konnten von WebKit komplett abgelehnt werden** – `displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio` sind Chromium-spezifisch. Sie werden nun je Engine gesendet, mit einem erneuten Versuch mit minimalen Bedingungen (`video: true`) bei `TypeError` – auf beiden Pfaden (Bildschirmfreigabe und Begleitton).
- Behoben: **der Mikrofontest blieb auf Engines ohne `MediaRecorder` dauerhaft aktiv** – der 5-Sekunden-Timer wurde nur im Aufnahmezweig gesetzt. Der Timer ist jetzt unbedingt, und der Container wird über `MediaRecorder.isTypeSupported` gewählt (Safari erhält `audio/mp4`; `audio/webm` wird nicht mehr angenommen).
- Behoben: **fehlende Decoder-Diagnose in Gecko** – `webkitAudioDecodedByteCount` gibt es nur in Blink/WebKit, daher lieferte `probeElement` in Firefox immer `null`. `readConsumerAudioEnergy()` nutzt jetzt RTP `totalAudioEnergy` / `audioLevel` als engineübergreifendes Signal.
- Behoben: **zu kurzes Layout auf hochauflösenden Viewports in Firefox vor 126** – `#app { zoom: var(--ui-scale) }` wurde ignoriert, `--app-vh: calc(100dvh / var(--ui-scale))` teilte aber weiter durch den vergrößerten Faktor. `main.ts` prüft jetzt `CSS.supports("zoom", "1")` und fixiert `--ui-scale` auf `1`, wenn nicht unterstützt.
- Stil-Kompatibilität: Ein `@supports not (color: color-mix(in srgb, red, blue))`-Block deckt nun Fokusrahmen, halbtransparente Hintergründe sowie Stumm-/Aktivzustände ab (`color-mix()` braucht Chrome 111 / Firefox 113 / Safari 16.2, also mehr als die Basis); `backdrop-filter` wird zusammen mit `-webkit-backdrop-filter` geschrieben; der Auswahlzustand in `AdminView` nutzt die Klasse `.choice.selected` statt `:has()` (braucht Firefox 121+).
- Build-Basis: `build.target` und `build.cssTarget` in `web/vite.config.ts` sind auf `chrome94 / edge94 / firefox102 / safari15.4` fixiert. esbuild senkt nur Syntax ab und polyfillt keine Laufzeitfunktionen wie `color-mix()` – genau deshalb ist der statische Rückfall oben erforderlich.
- **Auf echten Engines verifiziert** (Chrome 154 / Firefox 155 / Playwright WebKit 26.6, 170 Assertions): Jede Fähigkeit der Matrix stimmt mit einer unabhängig gemessenen Plattformtatsache überein (Sink-APIs, `webkitAudioDecodedByteCount`, `AudioWorklet`, `MediaRecorder`, `getDisplayMedia`, CSS-Unterstützung). Alle drei Engines laden die Anwendung ohne unbehandelte Ausnahme. Alle 25 Selektoren des `@supports not (color-mix)`-Blocks treffen echte Klassennamen, sechs seiner Deklarationen wirken nachweislich in Isolation, der Fokusrahmen bleibt sichtbar, und die `zoom`-Absicherung fixiert `--ui-scale` auf `1`, sobald `CSS.supports("zoom","1")` auf `false` gestubbt wird.
- Behebung eines **harten Startabsturzes auf Engines ohne AudioWorklet**, gefunden durch den Echtlauf: `@sapphi-red/web-noise-suppressor` deklariert `class RnnoiseWorkletNode extends AudioWorkletNode {}` auf Modulebene, daher wirft ein statischer Import beim Start in WebKit, in gehärteten Konfigurationen und in manchen WebViews einen `ReferenceError` und lässt die Seite leer, bevor der `ScriptProcessor`-Rückfall greifen kann. Jetzt wird das Paket bedarfsweise `await import()`iert und in einen 1,4-KB-Lazy-Chunk ausgelagert.
- Korrektur des **Firefox-Urteils zur Lautsprecherauswahl** (gemessen auf Firefox 155): Firefox hat seit 116 `HTMLMediaElement.setSinkId`, aber kein `AudioContext.setSinkId`. Die hörbare Ausgabe dieser Anwendung ist der WebAudio-Graph, das stummgeschaltete Element erzeugt keinen Ton – eine Sink-Änderung am Element bewegt also nichts Hörbares. Die Oberfläche richtet sich jetzt nach der neuen Fähigkeit `webAudioOutputRouting` (= `AudioContext.setSinkId`) und zeigt in Firefox einen Hinweistext statt eines wirkungslosen Auswahlfelds; die README-Aussage, Firefox habe `setSinkId` nie implementiert, ist korrigiert.
- Korrektur der `CSS.supports`-Selektorprüfung: `CSS.supports("selector(:has(*))", "true")` liefert in Chrome 154, Firefox 155 und WebKit 26.6 **false** (die Zwei-Argument-Form deutet das erste Argument als Eigenschaftsnamen). Erforderlich ist die Ein-Argument-Form.
- **Hörpfad auf echtem Firefox 153 mit echten Lautsprechern objektiv verifiziert** (eigens gebaute WASAPI-Sonde: Peaks pro Endpunkt plus Zuordnung der Audio-Sitzungen per PID, Abtastung alle 350 ms). Befunde: ① Firefox **hat** `HTMLMediaElement.setSinkId` und listet zwei benannte `audiooutput`-Geräte – aber erst nach einer Mikrofonfreigabe (davor null); ② elementweises `setSinkId` **wirkt in beide Richtungen**; ③ WebAudio folgt der **browserigenen Audiowege**, nicht dem Windows-Standardgerät; ④ elementweises `setSinkId` **kann den WebAudio-Graphen nicht umleiten** – bei auf die Lautsprecher fixiertem Element blieb der WebAudio-Ton auf den Kopfhörern und der Lautsprecher-Endpunkt zeigte exakt `0.00000`. Die Beschränkung der Seitenauswahl auf `webAudioOutputRouting` ist damit messtechnisch bestätigt.
- Hinweistext entsprechend korrigiert: „verwendet das Standardausgabegerät“ war falsch (die Ausgabe folgt der Browser-/System-Wege, hier den **nicht** standardmäßigen Kopfhörern). Jetzt: Ausgabe folgt der System-Audioeinstellung, pro App im System-Lautstärkemixer zuweisbar – Einstellungsfeld in allen fünf Sprachen angepasst.
- **Lazy-Element-Routing implementiert, damit die Lautsprecherauswahl in Chrome und Firefox identisch funktioniert.** Die Fähigkeitsmatrix erhält `outputRoutingMode` (`audioContext` / `mediaElement` / `none`), die Oberfläche richtet sich nach `!== "none"`: Chrome und Firefox bekommen dieselbe Auswahlliste, dieselbe Geräteliste und sofort wirksames Umschalten; Safari/WebKit hat keine Sink-API und zeigt weiterhin einen Hinweis (ausdrücklich außerhalb des Umfangs). Chromium nutzt `AudioContext.setSinkId` (keine Zusatzkosten); Firefox hängt den hörbaren Graphen erst dann auf einen `MediaStreamAudioDestinationNode` um, der von einem **nicht stummgeschalteten** `<audio>`-Element mit `setSinkId` abgespielt wird, **wenn der Nutzer tatsächlich ein Nicht-Standardgerät wählt** – ohne Auswahl bleibt der Graph auf `ctx.destination`, sodass niemand für zusätzliche Pufferung zahlt. Alle hörbaren Verbindungen laufen über `outputBus(ctx)` (Analyser der Sprecher, Benachrichtigungstöne); Abbau, Rollback und das Schließen des AudioContext sind abgedeckt, ohne Lücke beim Umschalten.
- Die alte `applySpeakerSink()`-Logik (Sink auf jedes stummgeschaltete Pull-Element setzen) und der Typ `SinkAudioElement` wurden entfernt: Diese Elemente sind stummgeschaltete Pull-Treiber, ihr Sink hatte nie Einfluss auf das tatsächlich Gehörte. Die Lautsprecherauswahl ist in Firefox nun funktionsfähig.
- **Abnahmemessung** (`audiotest6.html`, die Sequenz Erzeugen → Umhängen → Freigeben → Neu-Erzeugen aus `setOutputRouting()`, objektiv über WASAPI-Endpunkt-Peaks): Der Standardpfad bleibt auf dem Windows-Standardgerät (0.25000); die Wahl der Kopfhörer erzeugt das Element-Routing und der Ton erscheint exakt auf den Kopfhörern (0.25046), während der Standardendpunkt auf null fällt; das Zurückschalten gibt es frei und der Ton kehrt zurück; erneutes Auswählen und geräteübergreifendes Umschalten sind ebenfalls korrekt. Der Ton läuft bis zum Abschluss des asynchronen Umhängens auf dem vorherigen Gerät weiter (etwa zwei Samples) – bewusst, damit das Umschalten keine Lücke erzeugt.

### Русский

- Добавлен **кроссдвижковый слой совместимости браузеров** (`web/src/services/browser-support.ts`): определение движка и версии во время выполнения даёт единую матрицу возможностей и единый список деградаций вместо разрозненных проверок `'webkitFoo' in window`. Поддерживаемая база — **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+** (включая iOS Safari и Android Chrome); в подвале больше не указано жёстко «Chrome / Edge 94+».
- **Блокирующих условий осталось четыре**: защищённый контекст HTTPS, `RTCPeerConnection`, `getUserMedia` и Web Audio. При отсутствии любого из них страница входа объясняет причину; все остальные пробелы деградируют с видимым уведомлением, а не молчаливым «подключился, но без звука».
- Исправлено: **выбор устройства вывода не работал в Firefox/Safari** — список динамиков показывался при наличии `getDisplayMedia`, хотя ни один из этих движков не реализует `setSinkId`. Теперь `outputDeviceSupported` берётся из матрицы возможностей, и неподдерживаемые движки показывают пояснение вместо нерабочего элемента управления.
- Исправлено: **аккомпанемент всегда отказывал в Firefox/Safari** — `getDisplayMedia` в Gecko/WebKit возвращает только видеодорожку, а точка входа проверяла лишь наличие API. Теперь условие — `displayAudioCapture` (только Chromium).
- Исправлено: **WebKit мог полностью отклонить ограничения захвата экрана** — `displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio` специфичны для Chromium. Теперь они отправляются с учётом движка, с одной повторной попыткой в минимальных ограничениях (`video: true`) при `TypeError` — на обоих путях: демонстрация экрана и аккомпанемент.
- Исправлено: **тест микрофона навсегда оставался активным в движках без `MediaRecorder`** — 5-секундный таймер устанавливался только в ветке записи. Теперь таймер безусловный, а контейнер выбирается через `MediaRecorder.isTypeSupported` (Safari получает `audio/mp4`; `audio/webm` больше не предполагается).
- Исправлено: **отсутствие диагностики декодирования в Gecko** — `webkitAudioDecodedByteCount` есть только в Blink/WebKit, поэтому `probeElement` в Firefox всегда возвращал `null`. Теперь `readConsumerAudioEnergy()` использует RTP `totalAudioEnergy` / `audioLevel` как кроссдвижковый признак.
- Исправлено: **заниженная высота макета на экранах высокого разрешения в Firefox до 126** — `#app { zoom: var(--ui-scale) }` игнорировался, но `--app-vh: calc(100dvh / var(--ui-scale))` по-прежнему делил на увеличенный масштаб. Теперь `main.ts` проверяет `CSS.supports("zoom", "1")` и фиксирует `--ui-scale` в `1`, если поддержки нет.
- Совместимость стилей: блок `@supports not (color: color-mix(in srgb, red, blue))` покрывает контуры фокуса, полупрозрачные фоны и состояния «выключен звук»/«активно» (`color-mix()` требует Chrome 111 / Firefox 113 / Safari 16.2, то есть больше базы); `backdrop-filter` пишется вместе с `-webkit-backdrop-filter`; состояние выбора в `AdminView` использует класс `.choice.selected` вместо `:has()` (нужен Firefox 121+).
- База сборки: `build.target` и `build.cssTarget` в `web/vite.config.ts` зафиксированы на `chrome94 / edge94 / firefox102 / safari15.4`. esbuild только понижает синтаксис и не полифилит runtime-возможности вроде `color-mix()` — именно поэтому статический запасной вариант выше обязателен.
- **Проверено на реальных движках** (Chrome 154 / Firefox 155 / Playwright WebKit 26.6, 170 утверждение): каждая возможность матрицы совпала с независимо измеренным фактом платформы (sink-API, `webkitAudioDecodedByteCount`, `AudioWorklet`, `MediaRecorder`, `getDisplayMedia`, поддержка CSS). Все три движка загружают приложение без необработанных исключений. Все 25 селекторов блока `@supports not (color-mix)` находят реальные имена классов, шесть его объявлений действительно срабатывают в изоляции, контур фокуса остаётся видимым, а защита `zoom` фиксирует `--ui-scale` в `1`, как только `CSS.supports("zoom","1")` подменяется на `false`.
- Исправлено **жёсткое падение при запуске на движках без AudioWorklet**, найденное реальным прогоном: `@sapphi-red/web-noise-suppressor` объявляет `class RnnoiseWorkletNode extends AudioWorkletNode {}` на уровне модуля, поэтому статический импорт бросает `ReferenceError` при старте в WebKit, в ужесточённых конфигурациях и в некоторых WebView — страница остаётся пустой, и запасной `ScriptProcessor` не успевает включиться. Теперь пакет подгружается через `await import()` по требованию и вынесен в отдельный ленивый чанк на 1,4 КБ.
- Исправлен **вывод о выборе динамиков в Firefox** (измерено на Firefox 155): с версии 116 у Firefox есть `HTMLMediaElement.setSinkId`, но нет `AudioContext.setSinkId`. Слышимый выход этого приложения — граф WebAudio, а приглушённый элемент не издаёт звука, поэтому смена sink у элемента не меняет то, что вы слышите. Интерфейс теперь опирается на новую возможность `webAudioOutputRouting` (= `AudioContext.setSinkId`) и показывает в Firefox пояснение вместо нерабочего списка; утверждение в README, что Firefox никогда не реализовывал `setSinkId`, исправлено.
- Исправлена проверка селекторов через `CSS.supports`: `CSS.supports("selector(:has(*))", "true")` возвращает **false** в Chrome 154, Firefox 155 и WebKit 26.6 (двухаргументная форма разбирает первый аргумент как имя свойства). Нужна одноаргументная форма.
- **Звуковой тракт объективно проверен на реальном Firefox 153 с реальными динамиками** (собственный WASAPI-зонд: пиковые метры по эндпоинтам плюс привязка звуковых сессий по PID, опрос каждые 350 мс). Выводы: ① в Firefox **есть** `HTMLMediaElement.setSinkId`, и он показывает два именованных устройства `audiooutput` — но только после выдачи доступа к микрофону (до этого ноль); ② `setSinkId` для элемента **работает в обе стороны**; ③ вывод WebAudio следует **собственному маршруту браузера**, а не устройству по умолчанию в Windows; ④ `setSinkId` для элемента **не может** перенаправить граф WebAudio — при закреплённом на динамиках элементе тон WebAudio оставался в наушниках, а пик динамиков был ровно `0.00000`. Тем самым ограничение выбора динамиков в интерфейсе через `webAudioOutputRouting` подтверждено измерением.
- Текст подсказки исправлен: «будет использовано устройство по умолчанию» было неверно (вывод следует маршруту браузера/системы, здесь — на **не** стандартное устройство, наушники). Теперь: вывод следует системной настройке звука и назначается для приложения в системном микшеере громкости; панель настроек обновлена на всех пяти языках.
- **Реализована ленивая маршрутизация через элемент, чтобы выбор динамиков в Chrome и Firefox работал одинаково.** В матрице возможностей появилось `outputRoutingMode` (`audioContext` / `mediaElement` / `none`), а интерфейс ориентируется на `!== "none"`: Chrome и Firefox получают один и тот же список, один и тот же перечень устройств и мгновенно применяемое переключение; в Safari/WebKit sink-API нет, там по-прежнему показывается пояснение (явно вне области работ). Chromium использует `AudioContext.setSinkId` (без дополнительных затрат); Firefox переключает слышимый граф на `MediaStreamAudioDestinationNode`, который воспроизводит **не приглушённый** элемент `<audio>` с `setSinkId`, и **только когда пользователь действительно выбрал не стандартное устройство** — без выбора граф остаётся на `ctx.destination`, поэтому никто не платит за лишнюю буферизацию. Все слышимые соединения идут через `outputBus(ctx)` (анализаторы говорящих, звуки уведомлений); разборка, откат и закрытие AudioContext обработаны, переключение идёт без разрыва звука.
- Удалена старая логика `applySpeakerSink()` (установка sink каждому приглушённому элементу-«драйверу») и тип `SinkAudioElement`: эти элементы приглушены и их sink никогда не влиял на то, что слышит пользователь. Выбор динамиков в Firefox теперь работает.
- **Приёмочное измерение** (`audiotest6.html`, повторяет последовательность `setOutputRouting()`: создание → переключение → освобождение → повторное создание; объективная оценка по пиковым метрам эндпоинтов WASAPI): путь по умолчанию остаётся на стандартном устройстве Windows (0.25000); выбор наушников лениво создаёт маршрут через элемент, и звук появляется точно в наушниках (0.25046), а стандартный эндпоинт падает до нуля; возврат к стандартному освобождает маршрут и звук возвращается; повторный выбор и переключение между устройствами также корректны. Звук продолжает идти на прежнее устройство до завершения асинхронного переключения (около двух сэмплов) — это сделано намеренно, чтобы при смене устройства не было разрыва.

### 日本語

- **エンジン横断のブラウザ互換レイヤー**（`web/src/services/browser-support.ts`）を追加しました。実行時にエンジンとバージョンを判定し、単一のケイパビリティ・マトリクスと劣化リストを生成します。散在していた `'webkitFoo' in window` 形式の判定はこれに置き換わりました。対応ベースラインは **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+**（iOS Safari と Android Chrome を含む）で、フッターの「Chrome / Edge 94+」固定表記は廃止しました。
- **ブロック条件は 4 つに収束**しました。安全な HTTPS コンテキスト、`RTCPeerConnection`、`getUserMedia`、Web Audio です。いずれかが欠ける場合は参加ページで理由を明示し、それ以外の不足は可視の通知付きで劣化します。「入室したのに無音」という無言の失敗はなくなります。
- 修正: **Firefox/Safari で出力デバイス選択が無効**でした。`getDisplayMedia` の有無だけでスピーカー選択欄を表示していましたが、どちらのエンジンも `setSinkId` を実装していません。`outputDeviceSupported` はケイパビリティ・マトリクス由来になり、非対応エンジンでは死んだコントロールではなく説明を表示します。
- 修正: **Firefox/Safari で伴奏共有が必ず失敗**していました。Gecko/WebKit の `getDisplayMedia` は映像トラックのみを返しますが、入口では API の存在しか確認していませんでした。`displayAudioCapture`（Chromium のみ）を条件にしました。
- 修正: **WebKit が表示キャプチャ制約を丸ごと拒否する可能性**。`displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio` はすべて Chromium 固有です。エンジンに応じて送信し、`TypeError` 時は最小制約 `video: true` で 1 回再試行します（画面共有と伴奏共有の両経路）。
- 修正: **`MediaRecorder` のないエンジンでマイクテストが永久に終わらない**問題。5 秒の自動停止タイマーが録音分岐の中でしか設定されていませんでした。タイマーは無条件になり、コンテナは `MediaRecorder.isTypeSupported` で選択します（Safari は `audio/mp4`、`audio/webm` は仮定しません）。
- 修正: **Gecko でデコード診断が欠落**。`webkitAudioDecodedByteCount` は Blink/WebKit 専用のため、Firefox では `probeElement` が常に `null` を返していました。RTP の `totalAudioEnergy` / `audioLevel` を使う `readConsumerAudioEnergy()` をエンジン横断の指標として追加しました。
- 修正: **Firefox 126 以前の高解像度ビューポートでレイアウトが縦に短くなる**問題。`#app { zoom: var(--ui-scale) }` が無視される一方、`--app-vh: calc(100dvh / var(--ui-scale))` は拡大率で除算し続けていました。`main.ts` が `CSS.supports("zoom", "1")` を判定し、非対応時は `--ui-scale` を `1` に固定します。
- スタイル互換: `@supports not (color: color-mix(in srgb, red, blue))` のフォールバックブロックで、フォーカス輪郭・半透明の実背景・ミュート/アクティブ状態をカバーしました（`color-mix()` は Chrome 111 / Firefox 113 / Safari 16.2 が必要でベースラインを超えます）。`backdrop-filter` は `-webkit-backdrop-filter` と併記し、`AdminView` の選択状態は Firefox 121+ が必要な `:has()` ではなく `.choice.selected` クラスを使用します。
- ビルド基準: `web/vite.config.ts` の `build.target` と `build.cssTarget` を `chrome94 / edge94 / firefox102 / safari15.4` に固定しました。esbuild は構文を下げるだけで `color-mix()` のような実行時機能はポリフィルしません。これが上記の静的フォールバックを必要とする理由です。
- **実エンジンで検証済み**（Chrome 154 / Firefox 155 / Playwright WebKit 26.6、170 アサーション）: マトリクスの各機能が、独立に測定したプラットフォーム事実と一致しました（sink API、`webkitAudioDecodedByteCount`、`AudioWorklet`、`MediaRecorder`、`getDisplayMedia`、CSS 対応）。3 エンジンすべてで未捕捉例外なくアプリがマウントします。`@supports not (color-mix)` ブロックの 25 個のセレクタはすべて実在するクラス名に一致し、6 個の宣言が分離環境で実際に効くこと、フォーカス輪郭が表示されること、`CSS.supports("zoom","1")` を `false` にスタブすると `zoom` ガードが `--ui-scale` を `1` に固定することを確認しました。
- 実機検証で見つかった、**AudioWorklet のないエンジンでの起動時クラッシュ**を修正: `@sapphi-red/web-noise-suppressor` はモジュール直下で `class RnnoiseWorkletNode extends AudioWorkletNode {}` を宣言しているため、静的 import は WebKit、強化設定、一部の WebView で起動時に `ReferenceError` を投げ、`ScriptProcessor` フォールバックが動く前にページが白紙になります。必要時に `await import()` する形に変更し、あわせて 1.4 KB の遅延チャンクに分割しました。
- **Firefox のスピーカー選択の判定を修正**（Firefox 155 で実測）: Firefox は 116 以降 `HTMLMediaElement.setSinkId` を持ちますが `AudioContext.setSinkId` はありません。このアプリの可聴出力は WebAudio グラフで、ミュートされた要素は音を出さないため、要素側の sink 変更では実際の出力は変わりません。UI は新しいケイパビリティ `webAudioOutputRouting`（= `AudioContext.setSinkId`）で出し分け、Firefox では無効なドロップダウンではなく説明文を表示します。README の「Firefox は setSinkId を実装していない」という記述も訂正しました。
- `CSS.supports` によるセレクタ判定を修正: `CSS.supports("selector(:has(*))", "true")` は Chrome 154 / Firefox 155 / WebKit 26.6 の**すべてで false** を返します（2 引数形式は第 1 引数をプロパティ名として解釈します）。1 引数形式が必要です。
- **実機の Firefox 153 と実スピーカーで可聴経路を客観検証**（自作 WASAPI プローブ: エンドポイントごとのピークメーター＋音声セッションの PID 帰属、350 ms 間隔でサンプリング）。結果: ① Firefox には `HTMLMediaElement.setSinkId` が**あり**、名前付きの `audiooutput` を 2 件列挙します — ただしマイク許可後だけで、許可前は 0 件。② 要素の `setSinkId` は**双方向で機能**します。③ WebAudio の出力は Windows の既定デバイスではなく**ブラウザ自身の音声経路**に従います。④ 要素の `setSinkId` は **WebAudio グラフを迂回できません** — 要素の sink をスピーカーに固定しても WebAudio の音はヘッドホンに残り、スピーカー端点のピークは正確に `0.00000` でした。したがって、ページ内スピーカー選択を `webAudioOutputRouting` で出し分ける判断は測定によって裏付けられました。
- 文言を修正: 「既定の出力デバイスを使用します」は不正確でした（実際はブラウザ／システムの経路に従い、この環境では**既定ではない**ヘッドホン）。現在は「出力はシステムの音声設定に従い、システムの音量ミキサーでアプリごとに割り当て可能」とし、設定パネルも 5 言語すべてで更新しました。
- **遅延（レイジー）な要素ルーティングを実装し、Chrome と Firefox でスピーカー選択の挙動を一致させました。** ケイパビリティ・マトリクスに `outputRoutingMode`（`audioContext` / `mediaElement` / `none`）を追加し、UI は `!== "none"` で出し分けます。Chrome と Firefox は同じドロップダウン・同じデバイス一覧・即時反映の切り替えを得ます。Safari/WebKit は sink API を持たないため従来どおり説明を表示します（今回の対象外）。Chromium は `AudioContext.setSinkId`（追加コストなし）。Firefox は**ユーザーが実際に非既定デバイスを選んだときだけ**、可聴グラフを `MediaStreamAudioDestinationNode` に繋ぎ替え、**ミュートしていない** `<audio>` 要素で再生して `setSinkId` します。デバイスを選ばなければグラフは `ctx.destination` のままなので、Firefox の全ユーザーが余分なバッファリングを負担することはありません。可聴経路はすべて `outputBus(ctx)` を通し（話者アナライザー、通知音）、解体・ロールバック・AudioContext クローズの各経路も処理済みで、切り替え時に音が途切れません。
- 旧来の `applySpeakerSink()`（ミュートされたプル用要素それぞれに sink を設定）と `SinkAudioElement` 型を削除しました。これらの要素はミュートされたプル用ドライバで、sink の設定が実際に聞こえる音へ影響することはありませんでした。Firefox でもスピーカー選択が機能するようになりました。
- **受け入れ測定**（`audiotest6.html`。`setOutputRouting()` の作成 → 繋ぎ替え → 解放 → 再作成の順序を再現し、WASAPI の端点ピークで客観判定）: 既定経路は Windows の既定デバイスのまま（0.25000）。ヘッドホンを選ぶとレイジーに要素ルーティングが作られ、音は正確にヘッドホンへ（0.25046）、既定端点はゼロに。既定へ戻すと解放されて音が戻り、再選択とデバイス間の切り替えも正しく動作します。切り替え中は非同期の繋ぎ替えが完了するまで以前のデバイスで音が続きます（約 2 サンプル）。これは切り替えで無音の隙間を作らないための意図的な挙動です。

## [0.2.6] — 2026-09-26

### 中文

- 新增**管理后台可配置的 STUN / 外部 TURN**：在管理控制台的服务器设置里直接维护 ICE 服务器列表（STUN 与 TURN 可并存），不再需要改 systemd unit 或环境变量。支持两类 TURN 凭据：**静态用户名/密码**（第三方 TURN 服务常见形式）与 **coturn REST 共享密钥**（密钥留在服务端，每次页面加载签发一份短期临时凭据）。配置存在数据库里，密码与共享密钥以 AES-256-GCM 密文保存，接口只返回「是否已保存」，明文永不回传页面；每次变更写入 `ICE_SERVERS_CHANGED` 审计事件。
- 配置优先级：管理后台列表非空时以其为准；列表为空则回退到原有环境变量（`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`），因此**升级后既有部署行为完全不变**，无需改动任何服务器配置。语音与屏幕共享共用同一份解析结果，不会出现两条链路配置不一致。
- 保存时严格校验并**拒绝**而非静默丢弃：地址必须以 `stun:`/`stuns:`/`turn:`/`turns:` 开头、端口 1–65535 且禁用 53（浏览器会屏蔽）、`turns:` 不允许 `transport=udp`、TURN 条目必须选择凭据方式、展开后下发到浏览器的最多 8 条（与屏幕共享侧既有上限一致）。
- 数据库 schema 升级到 v8（新增 `ice_servers` 表），迁移前自动生成 `.schema-7.bak` 快照。
- 修复管理后台「三态凭据」（服务器密码 / 中继令牌 / 中继节点令牌 / ICE 凭据）的默认值缺陷：接口在调用方未提供操作类型时会自行填入 `keep`，导致**只提交凭据、不提交操作类型**的请求被静默忽略并报「凭据缺失」。现在判定统一收归服务端——显式操作优先，否则「提供了非空凭据」即视为替换，「未提供或空串」一律保留；清空只能用显式 `remove`（空串不再被当作清空，避免表单占位值误删已保存的凭据）。同时修复 `/api/admin/server/test` 在只提交新密码时会拿旧密码去测试的问题。`scripts/ice-config-test.mjs` 扩到 46 项断言。
- 新增 `scripts/ice-config-test.mjs`（46 项断言）：静态与临时凭据派生、环境变量回退、加密存储与视图脱敏、全部校验拒绝路径、凭据三态契约、v7→v8 迁移；`npm test` 现为 9 个套件。

### English

- Added **admin-console-configurable STUN / external TURN**: maintain the ICE server list (STUN and TURN side by side) in the console's server settings, with no need to touch the systemd unit or environment variables. Two TURN credential schemes are supported: **static username/password** (what third-party TURN services hand out) and the **coturn REST shared secret** (the secret stays on the server and a fresh short-lived credential is issued on every page load). Entries live in the database; passwords and shared secrets are stored as AES-256-GCM ciphertext, the API returns only “stored or not”, and plaintext never travels back to the browser. Every change writes an `ICE_SERVERS_CHANGED` audit event.
- Precedence: a non-empty console list wins; an empty list falls back to the existing environment variables (`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`), so **an upgrade changes nothing for an existing deployment** and no server configuration has to be edited. Voice and screen sharing resolve to the same list, so the two paths cannot disagree.
- Saving validates strictly and **rejects** instead of silently dropping: addresses must start with `stun:`/`stuns:`/`turn:`/`turns:`, use port 1–65535 and not port 53 (browsers block it), `turns:` must not request `transport=udp`, a TURN entry must choose a credential scheme, and at most 8 entries may reach a browser (the ceiling the screen-share path already enforced).
- Database schema moves to v8 (new `ice_servers` table); a `.schema-7.bak` snapshot is written before the migration.
- Fixed the default-value defect in the admin console's three-state credentials (server password / relay token / relay-node token / ICE credential): the API filled in `keep` whenever the caller omitted the action, so a request that **supplied a credential but no action** was silently ignored and then rejected as “missing”. The decision now lives on the server alone — an explicit action wins, otherwise a non-empty credential means replace and an absent or empty value always means keep; clearing requires an explicit `remove` (an empty string is no longer read as “clear”, so a form placeholder cannot delete a stored credential). Also fixed `/api/admin/server/test` probing the stored password when a new one had been submitted. `scripts/ice-config-test.mjs` grows to 46 assertions.
- Added `scripts/ice-config-test.mjs` (46 assertions): static vs. ephemeral credential derivation, the environment fallback, encrypted storage and redacted views, every rejection path, the three-state credential contract and the v7→v8 migration. `npm test` now runs 9 suites.

### Deutsch

- **In der Admin-Konsole konfigurierbares STUN / externes TURN**: Die ICE-Serverliste (STUN und TURN nebeneinander) wird direkt in den Servereinstellungen der Konsole gepflegt – ohne systemd-Unit oder Umgebungsvariablen anzufassen. Zwei TURN-Anmeldeverfahren werden unterstützt: **statischer Benutzername/Passwort** (was Drittanbieter ausgeben) und das **coturn-REST-Shared-Secret** (das Secret bleibt auf dem Server, pro Seitenaufruf wird ein kurzlebiges Zugangsdatum ausgestellt). Die Einträge liegen in der Datenbank; Passwörter und Secrets werden als AES-256-GCM-Chiffrat gespeichert, die API liefert nur „gespeichert oder nicht“, Klartext gelangt nie zurück in den Browser. Jede Änderung schreibt ein `ICE_SERVERS_CHANGED`-Audit-Ereignis.
- Vorrang: Eine nicht leere Liste in der Konsole gewinnt; eine leere Liste fällt auf die bestehenden Umgebungsvariablen zurück (`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`) – **ein Upgrade ändert für ein bestehendes Deployment nichts**, es muss keine Serverkonfiguration angepasst werden. Sprache und Bildschirmfreigabe nutzen dieselbe Liste, ein Auseinanderlaufen ist ausgeschlossen.
- Beim Speichern wird streng geprüft und **abgelehnt** statt still verworfen: Adressen müssen mit `stun:`/`stuns:`/`turn:`/`turns:` beginnen, Port 1–65535 nutzen und nicht Port 53 (von Browsern blockiert), `turns:` darf kein `transport=udp` anfordern, ein TURN-Eintrag muss ein Anmeldeverfahren wählen, und höchstens 8 Einträge erreichen einen Browser (dieselbe Obergrenze wie beim Bildschirmfreigabe-Pfad).
- Das Datenbankschema steigt auf v8 (neue Tabelle `ice_servers`); vor der Migration wird ein `.schema-7.bak`-Schnappschuss geschrieben.
- Fehler bei den dreistufigen Zugangsdaten der Admin-Konsole behoben (Serverpasswort / Relay-Token / Relay-Knoten-Token / ICE-Zugangsdatum): Die API trug `keep` ein, sobald der Aufrufer die Aktion wegließ, sodass eine Anfrage, die **ein Zugangsdatum ohne Aktion** übermittelte, stillschweigend verworfen und als „fehlt“ abgelehnt wurde. Die Entscheidung liegt jetzt allein beim Server: Eine ausdrückliche Aktion gewinnt, andernfalls bedeutet ein nicht leeres Zugangsdatum „ersetzen“ und ein fehlender oder leerer Wert immer „behalten“; Löschen erfordert ein ausdrückliches `remove` (ein leerer String gilt nicht mehr als „löschen“, damit ein Formularplatzhalter keine gespeicherten Zugangsdaten entfernt). Ebenfalls behoben: `/api/admin/server/test` prüfte das gespeicherte Passwort, wenn ein neues übermittelt wurde. `scripts/ice-config-test.mjs` wächst auf 46 Assertions.
- `scripts/ice-config-test.mjs` hinzugefügt (46 Assertions): statische vs. kurzlebige Anmeldedaten, der Umgebungs-Fallback, verschlüsselte Speicherung und redigierte Ansichten, alle Ablehnungspfade, der dreistufige Vertrag und die Migration v7→v8. `npm test` führt jetzt 9 Suiten aus.

### Русский

- **Настраиваемые в админ-консоли STUN / внешний TURN**: список ICE-серверов (STUN и TURN вместе) ведётся прямо в настройках сервера в консоли — без правки systemd-юнита и переменных окружения. Поддерживаются две схемы аутентификации TURN: **статическое имя пользователя и пароль** (то, что выдают сторонние сервисы) и **общий секрет coturn REST** (секрет остаётся на сервере, а при каждой загрузке страницы выдаются свежие краткосрочные учётные данные). Записи хранятся в базе; пароли и секреты — в виде шифртекста AES-256-GCM, API возвращает только «сохранено или нет», открытый текст никогда не попадает обратно в браузер. Каждое изменение пишет событие аудита `ICE_SERVERS_CHANGED`.
- Приоритет: непустой список в консоли имеет приоритет; пустой список откатывается к существующим переменным окружения (`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`), поэтому **обновление ничего не меняет для существующего развёртывания** и не требует правки конфигурации сервера. Голос и демонстрация экрана используют один и тот же список — расхождение между ними исключено.
- При сохранении выполняется строгая проверка и **отказ** вместо тихого отбрасывания: адрес должен начинаться с `stun:`/`stuns:`/`turn:`/`turns:`, использовать порт 1–65535 и не порт 53 (браузеры его блокируют), `turns:` не должен запрашивать `transport=udp`, для записи TURN нужно выбрать схему аутентификации, а до браузера доходит не более 8 записей (тот же предел, что и в пути демонстрации экрана).
- Схема базы данных обновлена до v8 (новая таблица `ice_servers`); перед миграцией создаётся снимок `.schema-7.bak`.
- Исправлен дефект значений по умолчанию у трёхпозиционных учётных данных админ-консоли (пароль сервера / токен ретранслятора / токен узла ретрансляции / учётные данные ICE): API подставлял `keep`, когда вызывающая сторона не указывала действие, из-за чего запрос, **передавший учётные данные без действия**, молча игнорировался и отклонялся как «отсутствует». Теперь решение принимает только сервер: явное действие имеет приоритет, иначе непустые учётные данные означают замену, а отсутствующее или пустое значение — всегда сохранение; очистка требует явного `remove` (пустая строка больше не считается «очистить», чтобы заполнитель формы не удалил сохранённые данные). Также исправлено: `/api/admin/server/test` проверял сохранённый пароль, когда был передан новый. `scripts/ice-config-test.mjs` вырос до 46 проверок.
- Добавлен `scripts/ice-config-test.mjs` (46 проверок): статические и краткосрочные учётные данные, откат к переменным окружения, шифрованное хранение и обезличенные представления, все пути отказа, трёхпозиционный контракт учётных данных и миграция v7→v8. `npm test` теперь запускает 9 наборов.

### 日本語

- **管理コンソールで設定できる STUN / 外部 TURN**：ICE サーバー一覧（STUN と TURN を併記可）をコンソールのサーバー設定で直接管理でき、systemd ユニットや環境変数を触る必要がありません。TURN の認証方式は 2 種類に対応：**固定のユーザー名とパスワード**（サードパーティ製 TURN サービスが発行する形式）と **coturn REST 共有シークレット**（シークレットはサーバーに留め、ページ読み込みごとに短命な認証情報を発行）。設定はデータベースに保存され、パスワードとシークレットは AES-256-GCM の暗号文として保持、API は「保存済みかどうか」のみを返し、平文がブラウザに戻ることはありません。変更のたびに `ICE_SERVERS_CHANGED` の監査イベントを記録します。
- 優先順位：コンソールの一覧が空でなければそれを採用し、空なら既存の環境変数（`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`）にフォールバックします。したがって**アップグレードしても既存のデプロイの挙動は変わらず**、サーバー設定の変更も不要です。音声と画面共有は同じ解決結果を使うため、両者が食い違うことはありません。
- 保存時は厳格に検証し、黙って捨てずに**拒否**します：アドレスは `stun:`/`stuns:`/`turn:`/`turns:` で始まり、ポートは 1〜65535（53 はブラウザが遮断するため不可）、`turns:` に `transport=udp` は指定不可、TURN の項目は認証方式の選択が必須、ブラウザに届くのは最大 8 件（画面共有側と同じ上限）。
- データベーススキーマを v8 に更新（`ice_servers` テーブルを追加）。移行前に `.schema-7.bak` スナップショットを作成します。
- 管理コンソールの三状態認証情報（サーバーパスワード / 中継トークン / 中継ノードのトークン / ICE 認証情報）の既定値の不具合を修正：呼び出し側が操作種別を省略すると API が `keep` を補っていたため、**認証情報だけを送ったリクエスト**が黙って無視され「認証情報がありません」と拒否されていました。判定はサーバー側に一元化し、明示的な操作を最優先、次に「空でない認証情報」は置換、「未指定または空文字」は常に保持とし、消去には明示的な `remove` が必要です（空文字は消去とみなさないため、フォームのプレースホルダーが保存済みの認証情報を削除することはありません）。あわせて `/api/admin/server/test` が新しいパスワードを送っても保存済みのパスワードで検査していた問題も修正。`scripts/ice-config-test.mjs` は 46 件に拡張。
- `scripts/ice-config-test.mjs`（46 件のアサーション）を追加：固定／短命な認証情報の生成、環境変数へのフォールバック、暗号化保存とマスクされた表示、すべての拒否パス、認証情報の三状態契約、v7→v8 移行をカバー。`npm test` は 9 スイートになりました。

## [0.2.5] — 2026-09-26

### 中文

- **BREAKING**：WebRTC 媒体引擎全量切换为 mediasoup 单引擎，旧 werift 引擎与「SFU 预分配槽位」模型彻底退役。说话人改为按 `clientId ↔ producerId ↔ consumerId` 动态发布/订阅，不再有预分配 audio m-line 与槽位上限。环境变量 `WEBSPEAK_SFU_SLOTS` 已移除；`werift` 移入 `devDependencies`（仅供无头测试替身使用）。运维发布注意：新版本不再使用 `scripts/patch-werift-ntp.mjs`，请同步删除生产 systemd unit 里的 `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` 拦截项，并确保随镜像分发 `vendor/mediasoup-worker/`。
- **BREAKING**：WebSocket 二进制音频兼容通道全面退役，实时语音全面收敛到纯 WebRTC（mediasoup）架构。服务端不再接收任何二进制音频帧（入站二进制帧返回 `UNSUPPORTED_BINARY_FRAME` 协议错误），移除服务端 Opus 软转码，`@discordjs/opus` 迁入 `devDependencies`（仅供无头测试套件使用），下行音频仅经 mediasoup DirectTransport 转发；前端移除 PCM 采集上行、二进制接收与兼容播放图。WebSocket 现仅承担 JSON 业务与媒体控制信令；WebRTC 协商重试（2s/5s）耗尽后不再回退到兼容通道，而是给出明确的网络诊断与重试指引。
- 新增「频道说明」标签：作为频道页面的默认视图排在标签栏最前，进入频道即展示当前频道的说明文本，支持 TeamSpeak 说明中的加粗、斜体、下划线、删除线、颜色与链接，正文里普通的方括号保持不变；频道未填写说明时给出引导空态。说明按需通过 `channelinfo` 读取，因此在没有频道列表权限的服务器上也能正常显示。
- 屏幕共享改为经网关 **mediasoup SFU 中央转发**：网页观众之间不再建立点对点连接，发起端只推 1 路画面（屏幕视频与系统音频各为一路），网关按需分发给每位观看者，观众增加不再放大发起端上行带宽；与 TeamSpeak 6 原生客户端互通仍走 P2P。
- 屏幕共享优先协商 **H.264**（可走显卡硬件编码、CPU 占用低，VP8 兜底）并放宽下行带宽上限，解决高动态画面因 CPU 过载掉帧的问题。
- 修复共享标签页/窗口时画面分辨率被压到约 1/4：发送端降级策略改为按共享来源选择——标签页/窗口共享保分辨率，整屏共享且帧率 ≥30 FPS 时保帧率。
- 修复三个屏幕共享交互缺陷：观众停止观看会清空直播端性能面板；无观众时发起者换频道会误杀刚开播的共享；全屏观看的画面稳定性加固。性能面板新增「发送给观看者」的实际编码输出分辨率。
- 修复切换音频输入/输出设备后听不到他人说话：麦克风切换改为原地换轨（不再重建传输层），扬声器切换追加 `AudioContext` 恢复与拉流节点 sink 同步。
- 新增 `npm test`：一条命令串联 worker 校验与编解码、说话人映射、上行管线、设备切换、屏幕共享 SFU、端到端、TURN 凭据共 8 个回归套件。

### English

- **BREAKING**: WebRTC media is now mediasoup-only; the werift engine and the pre-allocated “SFU slot” model are fully retired. Speakers are published and subscribed dynamically via `clientId ↔ producerId ↔ consumerId`, with no reserved audio m-lines and no slot ceiling. The `WEBSPEAK_SFU_SLOTS` environment variable is removed, and `werift` moved to `devDependencies` (headless test double only). Operators: the new build no longer uses `scripts/patch-werift-ntp.mjs`, so remove the `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` guard from the production systemd unit and make sure `vendor/mediasoup-worker/` ships with the image.
- **BREAKING**: The WebSocket binary audio compatibility channel is fully retired and realtime voice now runs entirely on the pure WebRTC (mediasoup) architecture. The server no longer accepts binary audio frames (inbound binary frames receive the `UNSUPPORTED_BINARY_FRAME` protocol error) and server-side Opus transcoding is gone — `@discordjs/opus` moved to `devDependencies` (used only by the headless test suite) — and downlink audio flows solely through the mediasoup DirectTransport; the frontend drops PCM capture/uplink, binary reception, and the compatibility playback graph. WebSocket now carries JSON business and media-control signaling only, and exhausting the WebRTC retries (2s/5s) no longer falls back to a compatibility channel but surfaces a clear network diagnosis and retry guidance.
- Added a “Channel description” tab: it leads the tab strip as the channel page's default view and shows the current channel's description as soon as you enter, rendering TeamSpeak's bold, italic, underline, strike-through, color, and link markup while leaving ordinary bracketed text untouched; a guiding empty state appears when the channel has no description. Descriptions are fetched on demand through `channelinfo`, so servers without channel-list permission keep working.
- Screen sharing now goes through **mediasoup SFU central forwarding** in the gateway: web viewers no longer connect peer-to-peer, the sharer pushes a single stream (screen video and system audio as separate tracks), and the gateway fans it out to each viewer — adding viewers no longer multiplies the sharer's upstream bandwidth. Interop with native TeamSpeak 6 clients stays peer-to-peer.
- Screen sharing now negotiates **H.264** first (GPU hardware encoding, low CPU, with VP8 as fallback) and allows a higher downlink bitrate ceiling, fixing frame drops caused by CPU overuse on high-motion content.
- Fixed the share resolution collapsing to roughly a quarter when sharing a tab or window: the sender's degradation policy now follows the source — tab/window shares keep resolution, whole-screen shares at ≥30 FPS keep frame rate.
- Fixed three screen-share interaction defects: a viewer stopping playback cleared the broadcaster's performance panel; an owner changing channel with no viewers killed a just-started share; and fullscreen playback stability was hardened. The performance panel now also reports the actual encoded output resolution sent to viewers.
- Fixed losing other participants' audio after switching the input or output device: microphone switching now replaces the track in place (no transport teardown), and speaker switching re-asserts `AudioContext` resume plus sink synchronization.
- Added `npm test`: one command runs all eight regression suites — worker verification plus codec, speaker map, upstream pipeline, audio device, screen-share SFU, end-to-end and TURN credentials.

### Deutsch

- **BREAKING**: WebRTC-Medien laufen jetzt ausschließlich über mediasoup; die werift-Engine und das Modell der vorab reservierten „SFU-Slots“ sind vollständig entfernt. Sprecher werden dynamisch über `clientId ↔ producerId ↔ consumerId` publiziert und abonniert – ohne reservierte Audio-m-Lines und ohne Slot-Obergrenze. Die Umgebungsvariable `WEBSPEAK_SFU_SLOTS` entfällt, `werift` wandert nach `devDependencies` (nur noch als Headless-Testdouble). Betriebshinweis: Der neue Build nutzt `scripts/patch-werift-ntp.mjs` nicht mehr – entfernen Sie den `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify`-Eintrag aus der produktiven systemd-Unit und liefern Sie `vendor/mediasoup-worker/` mit dem Image aus.
- **BREAKING**: Der binäre WebSocket-Audio-Kompatibilitätskanal ist vollständig entfernt; Echtzeit-Sprache läuft jetzt ausschließlich über die reine WebRTC-Architektur (mediasoup). Der Server nimmt keine binären Audioframes mehr an (eingehende Binärframes erhalten den Protokollfehler `UNSUPPORTED_BINARY_FRAME`), die serverseitige Opus-Transkodierung entfällt – `@discordjs/opus` wandert nach `devDependencies` (nur noch für die Headless-Testsuite) – und die Downlink-Audioübertragung erfolgt ausschließlich über den mediasoup-DirectTransport; das Frontend entfernt PCM-Aufnahme/Uplink, Binärempfang und den Kompatibilitäts-Wiedergabegraphen. WebSocket transportiert jetzt nur noch JSON-Business- und Mediensteuerungs-Signalisierung, und erschöpfte WebRTC-Wiederholungen (2s/5s) führen zu keiner Fallback-Verbindung mehr, sondern zu einer klaren Netzwerkdiagnose und einem Wiederholungshinweis.
- Neuer Tab „Kanalbeschreibung“: Er steht als Standardansicht am Anfang der Tab-Leiste und zeigt die Beschreibung des aktuellen Kanals direkt beim Betreten; dargestellt werden Fett, Kursiv, Unterstrichen, Durchgestrichen, Farben und Links aus TeamSpeak, gewöhnliche Klammertexte bleiben unverändert, und ohne Beschreibung erscheint ein Hinweis. Die Beschreibung wird bedarfsweise über `channelinfo` geladen, sodass Server ohne Kanal-Listen-Berechtigung weiter funktionieren.
- Bildschirmfreigabe läuft jetzt über die **zentrale mediasoup-SFU-Weiterleitung** des Gateways: Web-Zuschauer verbinden sich nicht mehr direkt, der Teilende sendet einen einzigen Stream (Bildschirmvideo und Systemaudio als getrennte Spuren), und das Gateway verteilt ihn an jeden Zuschauer – zusätzliche Zuschauer vervielfachen die Upload-Bandbreite nicht mehr. Die Interoperabilität mit nativen TeamSpeak-6-Clients bleibt Peer-to-Peer.
- Die Bildschirmfreigabe verhandelt jetzt zuerst **H.264** (Hardware-Encoding über die GPU, geringe CPU-Last, VP8 als Fallback) und erlaubt eine höhere Downlink-Bitratengrenze – das behebt Bildverluste durch CPU-Überlast bei stark bewegten Inhalten.
- Behoben: Beim Teilen eines Tabs oder Fensters fiel die Auflösung auf etwa ein Viertel. Die Degradierungsstrategie des Senders richtet sich jetzt nach der Quelle – Tab-/Fensterfreigaben behalten die Auflösung, Ganzbildschirm-Freigaben mit ≥30 FPS die Bildrate.
- Drei Interaktionsfehler der Bildschirmfreigabe behoben: Beendete ein Zuschauer die Wiedergabe, wurde die Leistungsanzeige des Teilenden geleert; ein Kanalwechsel des Teilenden ohne Zuschauer beendete eine gerade gestartete Freigabe; die Stabilität der Vollbildwiedergabe wurde verbessert. Die Leistungsanzeige zeigt jetzt zusätzlich die tatsächlich kodierte Ausgabeauflösung.
- Behoben: Nach dem Wechsel von Eingabe- oder Ausgabegerät war kein anderer Teilnehmer mehr zu hören. Der Mikrofonwechsel ersetzt die Spur jetzt an Ort und Stelle (kein Transportabbau mehr), der Lautsprecherwechsel stellt `AudioContext`-Resume und Sink-Synchronisierung sicher.
- `npm test` hinzugefügt: ein Befehl führt alle acht Regressionssuiten aus – Worker-Prüfung sowie Codec, Sprecher-Mapping, Upstream-Pipeline, Audiogeräte, Bildschirmfreigabe-SFU, End-to-End und TURN-Anmeldedaten.

### Русский

- **BREAKING**: Медиа WebRTC теперь работает только на mediasoup; движок werift и модель предварительно выделенных «SFU-слотов» полностью выведены из эксплуатации. Говорящие публикуются и подписываются динамически по `clientId ↔ producerId ↔ consumerId`, без резервирования audio m-line и без ограничения на число слотов. Переменная окружения `WEBSPEAK_SFU_SLOTS` удалена, а `werift` перенесён в `devDependencies` (только для безголового тестового двойника). Внимание при выпуске: новая сборка больше не использует `scripts/patch-werift-ntp.mjs` — удалите строку `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` из рабочего systemd-юнита и поставляйте `vendor/mediasoup-worker/` вместе с образом.
- **BREAKING**: Бинарный аудиоканал совместимости через WebSocket полностью выведен из эксплуатации; голос в реальном времени теперь работает исключительно на чистой архитектуре WebRTC (mediasoup). Сервер больше не принимает бинарные аудиокадры (входящие бинарные кадры получают ошибку протокола `UNSUPPORTED_BINARY_FRAME`), серверное транскодирование Opus удалено — `@discordjs/opus` перенесён в `devDependencies` (используется только безголовым набором тестов) — а нисходящее аудио идёт исключительно через mediasoup DirectTransport; фронтенд убирает захват/восходящий поток PCM, приём бинарных кадров и граф совместимого воспроизведения. WebSocket теперь передаёт только JSON-бизнес и сигнализацию управления медиа, а исчерпание повторных попыток WebRTC (2s/5s) больше не приводит к откату на канал совместимости — выводится понятная диагностика сети и рекомендация повторить.
- Добавлен раздел «Описание канала»: он открывается по умолчанию и стоит первым в панели разделов, показывая описание текущего канала сразу при входе; поддерживаются полужирный, курсив, подчёркивание, зачёркивание, цвет и ссылки TeamSpeak, при этом обычный текст в квадратных скобках не изменяется; если описания нет, выводится подсказка. Описание запрашивается по требованию через `channelinfo`, поэтому серверы без права на список каналов продолжают работать.
- Демонстрация экрана теперь идёт через **центральную пересылку mediasoup SFU** в шлюзе: веб-зрители больше не соединяются напрямую, демонстрирующий отправляет один поток (видео экрана и системный звук отдельными дорожками), а шлюз раздаёт его каждому зрителю — рост числа зрителей больше не умножает исходящую полосу. Совместимость с нативными клиентами TeamSpeak 6 остаётся одноранговой.
- Демонстрация экрана теперь в первую очередь согласует **H.264** (аппаратное кодирование на GPU, низкая нагрузка на CPU, VP8 как запасной вариант) и допускает более высокий предел битрейта — это устраняет потерю кадров из-за перегрузки CPU на динамичных сценах.
- Исправлено: при демонстрации вкладки или окна разрешение падало примерно до четверти. Стратегия деградации отправителя теперь зависит от источника — демонстрация вкладки/окна сохраняет разрешение, демонстрация всего экрана при ≥30 FPS сохраняет частоту кадров.
- Исправлены три дефекта взаимодействия: остановка просмотра зрителем очищала панель производительности вещателя; смена канала вещателем без зрителей завершала только что начатую трансляцию; повышена стабильность полноэкранного воспроизведения. Панель производительности теперь также показывает фактическое разрешение кодированного вывода.
- Исправлено: после переключения устройства ввода или вывода перестали быть слышны другие участники. Переключение микрофона теперь заменяет дорожку на месте (без пересоздания транспорта), а переключение динамика восстанавливает `AudioContext` и синхронизацию sink.
- Добавлена команда `npm test`: одна команда запускает все восемь наборов регрессионных тестов — проверка worker, кодеки, карта говорящих, восходящий конвейер, аудиоустройства, SFU демонстрации экрана, сквозной тест и учётные данные TURN.

### 日本語

- **BREAKING**: WebRTC メディアは mediasoup 単一エンジンに完全移行し、werift エンジンと「SFU スロット事前割り当て」モデルは廃止しました。話者は `clientId ↔ producerId ↔ consumerId` で動的に publish/subscribe され、audio m-line の予約やスロット上限はありません。環境変数 `WEBSPEAK_SFU_SLOTS` は削除し、`werift` は `devDependencies` へ移動（ヘッドレステスト代替のみ）。運用注意：新ビルドは `scripts/patch-werift-ntp.mjs` を使用しないため、本番 systemd unit の `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` を削除し、`vendor/mediasoup-worker/` をイメージに同梱してください。
- **BREAKING**: WebSocket のバイナリ音声互換チャネルを完全廃止し、リアルタイム音声は純粋な WebRTC（mediasoup）アーキテクチャに完全移行しました。サーバーはバイナリ音声フレームを受け付けなくなり（受信バイナリフレームには `UNSUPPORTED_BINARY_FRAME` プロトコルエラーを返します）、サーバー側の Opus 変換を撤去、`@discordjs/opus` は `devDependencies` へ移動（ヘッドレステスト専用）し、下り音声は mediasoup DirectTransport 経由のみで転送します。フロントエンドは PCM 取得・上り送信、バイナリ受信、互換再生グラフを撤去しました。WebSocket は JSON ビジネスとメディア制御シグナリングのみを担い、WebRTC ネゴシエーションの再試行（2s/5s）を使い切っても互換チャネルへは戻らず、明確なネットワーク診断と再試行案内を表示します。
- 「チャンネル説明」タブを追加：タブ列の先頭に既定の表示として配置し、入室時に現在のチャンネルの説明を表示します。TeamSpeak の太字・斜体・下線・取り消し線・色・リンクを描画し、本文中の通常の角括弧はそのまま。説明がない場合は案内の空状態を表示。説明は `channelinfo` で必要なときだけ取得するため、チャンネル一覧の権限がないサーバーでも動作します。
- 画面共有はゲートウェイの **mediasoup SFU による中央転送**に変更しました。Web 視聴者は直接接続せず、共有者は 1 本のストリーム（画面映像とシステム音声は別トラック）を送るだけで、ゲートウェイが各視聴者へ配信します。視聴者が増えても共有者の上り帯域は増えません。TeamSpeak 6 ネイティブクライアントとの相互視聴は従来どおりピアツーピアです。
- 画面共有は **H.264** を優先してネゴシエーションするようにし（GPU ハードウェア符号化で CPU 負荷が低く、VP8 はフォールバック）、下りビットレート上限も緩和しました。動きの激しい画面で CPU 過負荷によりフレームが落ちる問題を解消します。
- タブ/ウィンドウ共有時に解像度が約 1/4 に落ちる問題を修正。送信側の降格戦略をソースに応じて選択するようにしました——タブ/ウィンドウ共有は解像度を維持、全画面共有かつ ≥30 FPS はフレームレートを維持。
- 画面共有の 3 つの操作不具合を修正：視聴者が視聴を終了すると配信者のパフォーマンスパネルが消える、視聴者ゼロで配信者がチャンネルを移動すると開始直後の共有が終了する、全画面視聴の安定性を強化。パネルに実際の符号化出力解像度も表示します。
- 入出力デバイスを切り替えると他の参加者の声が聞こえなくなる問題を修正。マイク切り替えはトラックをその場で差し替え（トランスポートを再構築しない）、スピーカー切り替えは `AudioContext` の再開と sink 同期を保証します。
- `npm test` を追加：worker 検証とコーデック、話者マップ、上りパイプライン、オーディオデバイス、画面共有 SFU、エンドツーエンド、TURN 資格情報の計 8 スイートを 1 コマンドで実行します。

## [0.2.4] — 2026-09-22

### 中文

- 新增跨端 P2P 屏幕共享：浏览器用户可以与 TeamSpeak 6 原生客户端互相发现、发起和观看屏幕共享；浏览器之间以及浏览器与原生客户端之间的媒体流优先通过 WebRTC/ICE 直连，WebSpeak 仅负责会话鉴权、共享状态和 SDP/ICE 信令转发，不承载屏幕媒体流量。
- 默认使用 TeamSpeak 官方 STUN 服务发现直连候选，并支持管理员显式配置外部 TURN；即使使用 TURN，媒体也经过外部服务而不是 WebSpeak 网关。
- 新增屏幕共享直播状态、观众人数、播放器音量、全屏和退出控制，并提供发送端/接收端 WebRTC 实时统计。
- 提供浏览器屏幕采集分辨率和帧率设置，最高支持 1080p、60 FPS；设置改为独立弹窗，避免成员卡片被撑高。
- 新增首页访客编号，并优化屏幕共享成员卡片和观看交互。

### English

- Added cross-platform P2P screen sharing: browser users can discover, start, and watch screen shares with native TeamSpeak 6 clients. Media between browsers, and between a browser and a native client, prefers a direct WebRTC/ICE path; WebSpeak handles session authorization, share state, and SDP/ICE signaling only and does not carry screen media.
- Added TeamSpeak's public STUN services for direct-candidate discovery by default, with optional administrator-configured external TURN. Even with TURN, media uses the external service rather than the WebSpeak gateway.
- Added live screen-share status, viewer counts, player volume, fullscreen, and exit controls, plus live sender/receiver WebRTC statistics.
- Added browser capture-resolution and frame-rate controls up to 1080p and 60 FPS; moved the controls into a standalone modal so member cards no longer stretch.
- Added homepage visitor numbering and refined screen-share member-card and viewing interactions.

### Deutsch

- Plattformübergreifendes P2P-Bildschirmteilen ergänzt: Browsernutzer können Bildschirmfreigaben mit nativen TeamSpeak-6-Clients erkennen, starten und ansehen. Die Medienübertragung zwischen Browsern sowie zwischen Browser und nativem Client nutzt möglichst direkte WebRTC-/ICE-Verbindungen; WebSpeak übernimmt nur Sitzungsberechtigung, Freigabestatus und SDP-/ICE-Signalisierung und transportiert keine Bildschirmmedien.
- Öffentliche TeamSpeak-STUN-Dienste werden standardmäßig zur Ermittlung direkter Kandidaten verwendet; ein externes TURN kann ausdrücklich durch den Administrator konfiguriert werden. Auch mit TURN läuft die Medienübertragung über den externen Dienst und nicht über das WebSpeak-Gateway.
- Live-Status, Zuschauerzahl, Lautstärke, Vollbild- und Beenden-Steuerung für Bildschirmfreigaben sowie laufende WebRTC-Statistiken für Sender und Empfänger ergänzt.
- Aufnahmeauflösung und Bildrate im Browser bis 1080p und 60 FPS konfigurierbar; die Einstellungen wurden in ein eigenes Modal verschoben, damit Mitgliederkarten nicht mehr in die Höhe wachsen.
- Besucherzählung auf der Startseite ergänzt und die Interaktion von Bildschirmfreigabe-Karten und Player verbessert.

### Русский

- Добавлена кроссплатформенная P2P-трансляция экрана: пользователи браузера могут обнаруживать, запускать и смотреть трансляции вместе с нативными клиентами TeamSpeak 6. Медиа между браузерами, а также между браузером и нативным клиентом по возможности передаётся напрямую через WebRTC/ICE; WebSpeak отвечает только за авторизацию сессии, состояние трансляции и SDP/ICE-сигналы и не переносит медиаданные экрана.
- По умолчанию добавлено обнаружение прямых кандидатов через публичные STUN-сервисы TeamSpeak; администратор может явно настроить внешний TURN. Даже при использовании TURN медиа идёт через внешний сервис, а не через шлюз WebSpeak.
- Добавлены статус трансляции, число зрителей, громкость проигрывателя, полноэкранный режим и выход, а также текущая статистика WebRTC для отправителя и получателя.
- Добавлены настройки разрешения и частоты кадров захвата в браузере до 1080p и 60 FPS; настройки вынесены в отдельное окно, чтобы карточки участников не растягивались.
- Добавлен номер посетителя на главной странице и улучшено управление карточками и просмотром трансляций.

### 日本語

- クロスプラットフォーム P2P 画面共有を追加しました。ブラウザユーザーは TeamSpeak 6 ネイティブクライアントと互いに画面共有を検出・開始・視聴できます。ブラウザ間、およびブラウザとネイティブクライアント間のメディアは可能な限り WebRTC/ICE で直接送信され、WebSpeak はセッション認証、共有状態、SDP/ICE シグナリングだけを担当し、画面メディアは運びません。
- 初期設定で TeamSpeak 公開 STUN サービスによる直接候補の検出に対応し、管理者が外部 TURN を明示的に設定できるようにしました。TURN 使用時もメディアは外部サービスを経由し、WebSpeak ゲートウェイは経由しません。
- 配信状態、視聴者数、プレーヤー音量、全画面、終了操作と、送信側・受信側の WebRTC 統計を追加しました。
- ブラウザの画面取得設定で最大 1080p / 60 FPS を選択できます。設定を独立したモーダルに移し、メンバーカードが縦に伸びないようにしました。
- ホームページの訪問者番号を追加し、画面共有カードと視聴操作を改善しました。

## [0.2.3] — 2026-09-19

### 中文

- 新增频道成员调度入口：保留拖放移动，并在右键菜单提供“调度到”二级菜单和“我所在的频道”快捷项。
- 支持按 TeamSpeak 权限直接移动成员；具备权限时无需重复输入频道密码，无权限时不提供该操作。
- 支持成员头像显示、麦克风静音状态同步和保存身份恢复，并增强指针拖动兼容性。
- 更新中文、English、Deutsch、Русский、日本語五种语言的功能截图和文档页面。
- 修复高分辨率桌面端管理员设置页面底部内容被裁切的问题，并收紧中继卡片的宽度约束。

### English

- Added member-management entry points: drag-and-drop remains available, while the context menu now provides a “Move to” submenu with a “My channel” shortcut.
- Added permission-aware direct member moves: authorized users can move clients without redundant channel-password prompts, while the action is unavailable without the required TeamSpeak permission.
- Added client-avatar display, microphone mute-state synchronization, and remembered-identity recovery, with improved pointer-drag compatibility.
- Refreshed feature screenshots and documentation pages for all five supported languages.
- Fixed clipped lower content in the high-resolution desktop admin settings page and tightened relay-card width constraints.

### Deutsch

- Neue Einstiege für die Mitgliederverwaltung: Ziehen und Ablegen bleibt verfügbar, zusätzlich bietet das Kontextmenü ein Untermenü „Verschieben nach“ mit dem Eintrag „Mein Kanal“.
- Direkte, berechtigungsabhängige Mitgliederverschiebung ergänzt: Benutzer mit den erforderlichen TeamSpeak-Rechten benötigen keine erneute Kanalpasswortabfrage; ohne diese Rechte steht die Aktion nicht zur Verfügung.
- Anzeige von Client-Avataren, Synchronisierung des Mikrofon-Stummschaltstatus und Wiederherstellung gespeicherter Identitäten ergänzt; Zeigerbedienung verbessert.
- Funktionsscreenshots und Dokumentationsseiten für alle fünf unterstützten Sprachen aktualisiert.
- Das Abschneiden unterer Inhalte in den Admin-Einstellungen bei hoher Desktop-Auflösung behoben und die Breitenbegrenzung der Relay-Karten verbessert.

### Русский

- Добавлены способы управления участниками: перетаскивание сохранено, а в контекстном меню появился пункт «Переместить в» с быстрым вариантом «Мой канал».
- Добавлено прямое перемещение с учётом прав TeamSpeak: пользователям с нужными правами не нужно повторно вводить пароль канала, а без этих прав действие недоступно.
- Добавлены отображение аватаров клиентов, синхронизация состояния микрофона и восстановление сохранённой идентичности; улучшено перетаскивание указателем.
- Обновлены функциональные скриншоты и страницы документации для всех пяти поддерживаемых языков.
- Исправлено обрезание нижнего содержимого настроек администратора на десктопах с высоким разрешением и ограничена ширина карточек ретрансляторов.

### 日本語

- メンバー操作を追加しました。ドラッグ＆ドロップに加えて、コンテキストメニューに「移動先」サブメニューと「自分のチャンネル」ショートカットを用意しました。
- TeamSpeak 権限に応じた直接移動を追加しました。必要な権限があればチャンネルパスワードを再入力せずに移動でき、権限がなければ操作は表示されません。
- クライアントアバターの表示、マイクミュート状態の同期、保存した ID の復元に対応し、ポインター操作も改善しました。
- 対応する 5 言語すべての機能スクリーンショットとドキュメントページを更新しました。
- 高解像度デスクトップで管理設定の下部が切れる問題を修正し、中継カードの幅制約を改善しました。

## [0.2.2] — 2026-09-17

### 中文

- 提供可开关的浏览器端麦克风降噪功能。
- 优化前端音量交互逻辑：桌面端悬停麦克风和整体音量按钮即可调整，降噪开关收纳在麦克风菜单中。
- 在 PR #2 基础上优化错误提示和错误代码显示。
- 提供俄语和日语界面支持，并支持按语言单独调整欢迎文字。

### English

- Added optional browser-side microphone noise suppression.
- Refined volume interaction: desktop microphone and master-volume controls open on hover, with noise suppression in the microphone menu.
- Improved error messages and error-code display on top of PR #2.
- Added Russian and Japanese UI support and per-language welcome text configuration.

### Deutsch

- Optionale browserseitige Mikrofon-Geräuschunterdrückung hinzugefügt.
- Lautstärkeinteraktion verbessert: Desktop-Mikrofon- und Gesamtlautstärkeregler öffnen sich beim Überfahren; die Geräuschunterdrückung befindet sich im Mikrofonmenü.
- Fehlertexte und Fehlercodes auf Basis von PR #2 verbessert.
- Russische und japanische Oberfläche sowie sprachabhängige Begrüßungstexte ergänzt.

### Русский

- Добавлено опциональное шумоподавление микрофона в браузере.
- Улучшено управление громкостью: на компьютере регуляторы открываются при наведении, а шумоподавление находится в меню микрофона.
- Улучшены сообщения и коды ошибок на основе PR #2.
- Добавлены русский и японский интерфейсы и отдельная настройка приветствия для каждого языка.

### 日本語

- ブラウザ側で任意に使えるマイクノイズ抑制を追加しました。
- 音量操作を改善し、デスクトップではマイクと全体音量のボタンにカーソルを合わせると調整画面を表示し、ノイズ抑制をマイクメニューにまとめました。
- PR #2 を基にエラー表示とエラーコードを改善しました。
- ロシア語・日本語 UI と言語別ウェルカム文の設定を追加しました。

## [0.2.1] — 2026-09-13

### 中文

- 统一首页连接错误显示：保留错误代码，未知错误安全截断，并显示可追溯的服务端原因。
- 默认支持 IPv6 TeamSpeak 目标，并补充主机、运行时和网络条件说明。

### English

- Unified connection-error display on the welcome page: preserve error codes, safely truncate unknown codes, and show traceable server reasons.
- Added default IPv6 TeamSpeak target support and documented the required host, runtime, and network conditions.

### Deutsch

- Verbindungsfehler auf der Willkommensseite vereinheitlicht: Fehlercodes bleiben erhalten, unbekannte Codes werden sicher gekürzt und nachvollziehbare Serverursachen angezeigt.
- IPv6-Ziele für TeamSpeak standardmäßig unterstützt und erforderliche Host-, Laufzeit- und Netzwerkbedingungen dokumentiert.

## [0.2.0] — 2026-09-10

### 中文

- 新增 README“高级功能”章节，补充 WebRTC 与中继服务器的配置和使用步骤。
- 明确 WebRTC 的 UDP 端口、安全组与防火墙要求，以及中继令牌和管理员控制台配置方式。
- 标注中继服务为 WebSpeak 自带实现；同时注明 WebRTC 使用 MIT 许可的 `werift` 依赖，TeamSpeak 连接使用项目维护的 SDK fork。
- 细分 TeamSpeak 连接失败原因，服务器需要密码时提示用户输入密码并重试。
- 优化管理员历史连接日志：能够追溯时显示具体原因，无法追溯时使用通用失败提示，不猜测历史原因。
- 新增正式中继部署模式：中继实例不提供前台和管理员后台，只接受带令牌的网关转发会话。
- 管理员可配置多个中继节点，访客可在欢迎页为当前连接选择直连或指定中继。
- 修复用户正常断开后被管理员运维日志误显示为“请求失败”的问题。

### English

- Added an “Advanced features” section to the README with WebRTC and relay configuration and usage steps.
- Documented WebRTC UDP, security-group, and firewall requirements, plus relay-token and administration-console setup.
- Clarified that the relay is built into WebSpeak, while WebRTC uses the MIT-licensed `werift` dependency and TeamSpeak connectivity uses the project-maintained SDK fork.
- Classified TeamSpeak connection failures and prompt users for a server password with a retry when authentication requires one.
- Improved administrator connection history: show a specific reason when available and use a generic failure message when older records cannot be traced, without guessing.
- Added a formal relay deployment mode: relay instances expose no visitor or admin UI and accept only token-authenticated gateway sessions.
- Administrators can configure multiple relay nodes, and visitors can choose direct access or a specific relay for each connection.
- Fixed normal user disconnects being shown as “request failed” in administrator connection history.

### Deutsch

- Einen Abschnitt „Erweiterte Funktionen“ mit Anleitungen für WebRTC und Relay-Server zur README hinzugefügt.
- UDP-, Sicherheitsgruppen- und Firewall-Anforderungen für WebRTC sowie Relay-Token und Administrationskonfiguration dokumentiert.
- Klargestellt, dass das Relay Bestandteil von WebSpeak ist; WebRTC verwendet die MIT-lizenzierte Abhängigkeit `werift`, die TeamSpeak-Verbindung den projektgepflegten SDK-Fork.
- TeamSpeak-Verbindungsfehler genauer klassifiziert und bei erforderlichem Serverpasswort eine Eingabe mit Wiederholung angeboten.
- Den Verlauf der Administrator-Verbindungen verbessert: verfügbare Ursachen werden angezeigt, ältere nicht nachvollziehbare Einträge erhalten eine allgemeine Fehlermeldung statt einer Vermutung.
- Einen dedizierten Relay-Bereitstellungsmodus ergänzt: Relay-Instanzen stellen keine Besucher- oder Admin-Oberfläche bereit und akzeptieren nur Gateway-Sitzungen mit Token.
- Administratoren können mehrere Relay-Knoten konfigurieren; Besucher wählen pro Verbindung Direktzugriff oder ein bestimmtes Relay.
- Behoben, dass normale Benutzertrennungen im Administrationsverlauf als „Anfrage fehlgeschlagen“ erschienen.

## [0.1.8] — 2026-09-08

### 中文

- Docker 默认使用 host 网络，支持网关访问同机 TeamSpeak 并直接暴露 WebRTC UDP 端口。
- 开放模式统一校验用户提交的目标地址，包括管理员默认目标，修复本机与内网目标绕过限制的问题。
- TeamSpeak SDK 连接握手增加 15 秒超时，失败连接会及时清理。
- 网络性能面板改为持续监测，打开后每 3 秒更新一次延迟与丢包率。

### English

- Docker now uses host networking by default, allowing the gateway to reach a local TeamSpeak server and expose the WebRTC UDP range directly.
- Open access now validates every submitted target, including the administrator default, closing loopback and private-network bypasses.
- Added a 15-second TeamSpeak SDK handshake timeout with prompt cleanup after failed connections.
- The network performance panel now measures continuously and refreshes latency and packet loss every 3 seconds while open.

### Deutsch

- Docker verwendet standardmäßig das Host-Netzwerk, damit das Gateway einen lokalen TeamSpeak-Server erreicht und den WebRTC-UDP-Bereich direkt bereitstellt.
- Der offene Zugriffsmodus prüft nun jedes Ziel einschließlich des Administrator-Standards und schließt Umgehungen für Loopback- und private Netze.
- Für den TeamSpeak-SDK-Handshake gilt jetzt ein Timeout von 15 Sekunden; fehlgeschlagene Verbindungen werden zeitnah bereinigt.
- Das Netzwerkleistungsfeld misst bei geöffneter Ansicht fortlaufend und aktualisiert Latenz und Paketverlust alle 3 Sekunden.

## [0.1.7] — 2026-09-06

### 中文

- 增加 Deutsch 界面支持和 Telegram 群组入口。
- 增加桌面端整体音量滑块，默认收起并在悬停时展开。
- 修复伴奏音量忽大忽小的问题。
- 增加可展开的网络性能面板，显示浏览器、WebSpeak 与 TeamSpeak 之间的延迟和丢包率。
- 管理员连接测试改用服务端多次主机 Ping 并显示丢包率，不再创建临时 TeamSpeak 客户端。
- 统一中文、English、Deutsch 的旗帜代码语言菜单。
- 修复 TeamSpeak 使用 TCP 探测导致的误报丢包，并修正语言菜单异常留白。
- 移除 WebRTC 桥接中的 RMS 静音帧过滤，安静帧仅用于发言状态指示，不再丢弃。
- 修复 Docker 运行环境缺少 ICMP Ping 工具导致管理员测试误报 100% 丢包。

### English

- Added German UI support and a Telegram community link.
- Added a compact desktop master-volume slider that expands on hover.
- Fixed accompaniment volume fluctuations.
- Added an expandable network performance panel with latency and packet loss across the browser, WebSpeak, and TeamSpeak path.
- Updated the administrator connection test to use repeated host pings, report packet loss, and avoid creating temporary TeamSpeak clients.
- Unified the Chinese, English, and German flag/code language menu.
- Fixed false packet-loss reports caused by probing the TeamSpeak UDP service with TCP, and corrected excess space in the language menu.
- Removed RMS-based silence filtering from the WebRTC bridge; quiet frames are now retained for the codec timeline.
- Fixed Docker admin diagnostics falsely reporting 100% packet loss when the runtime lacked the ICMP ping tool.

### Deutsch

- Deutsche Benutzeroberfläche und Telegram-Community-Link hinzugefügt.
- Kompakten Gesamtlautstärkeregler für den Desktop ergänzt, der sich beim Überfahren öffnet.
- Schwankende Lautstärke bei der Begleittonfreigabe behoben.
- Aufklappbares Netzwerkleistungsfeld mit Latenz und Paketverlust zwischen Browser, WebSpeak und TeamSpeak ergänzt.
- Verbindungstest in der Administration auf wiederholte Host-Pings mit Paketverlustanzeige umgestellt, ohne temporäre TeamSpeak-Clients zu erzeugen.
- Einheitliches Sprachmenü mit Flaggen und Sprachcodes für Chinesisch, Englisch und Deutsch ergänzt.
- Falsche Paketverlustmeldungen durch TCP-Prüfung des UDP-Dienstes behoben und übermäßigen Leerraum im Sprachmenü korrigiert.
- RMS-basierte Stillefilterung aus der WebRTC-Brücke entfernt; leise Frames bleiben nun im Codec-Zeitverlauf erhalten.
- Falsche 100-%-Paketverlustmeldungen behoben, wenn dem Docker-Laufzeitimage das ICMP-Ping-Tool fehlte.

## [0.1.6] — 2026-09-04

### 中文

- 新增保持身份并发连接提醒，避免同一浏览器复用身份造成连接卡住。
- 新增桌面端伴奏共享功能。
- 新增网站 favicon，并更新仓库 README 主视觉。

### English

- Added a warning for concurrent remembered-identity connections in the same browser.
- Added desktop accompaniment sharing.
- Added a site favicon and refreshed the repository README branding.

## [0.1.5] — 2026-09-04

### 中文

- 修复并优化主题切换按钮，首次点击即可切换，并使用太阳/月亮图标。
- 修复浏览器身份保存与退出后的保持逻辑。

### English

- Fixed and refined the theme toggle so the first click switches themes, with sun/moon icons.
- Fixed browser identity persistence across exit and return.

All notable changes to WebSpeak are documented here. Versions follow SemVer.

## [0.1.4] — 2026-09-03

### 中文

- 修复 WebRTC 语音收发与发言状态同步。
- 修复频道文字消息在 WebSpeak 客户端之间无法互收。
- 优化管理员页面、运行日志换行和移动端顶部布局。
- 首页新增 Bilibili 入口，管理员登录页新增返回首页。

### English

- Fixed WebRTC voice transport and speaking-state synchronization.
- Fixed channel text messages between WebSpeak clients.
- Refined admin pages, log wrapping, and narrow-screen header layout.
- Added the Bilibili profile link and the admin-login home link.

## [0.1.3] — 2026-09-03

### Added

- Optional WebRTC audio transport for deployments that need lower and more stable realtime voice latency.
- A self-contained WebRTC media service controlled by one administrator switch; the gateway derives the media host from the current WebSpeak address and owns a fixed UDP range.
- Migrated the TeamSpeak integration to the maintained `EchoSixHIYA/teamspeak-js` fork, including live directory snapshots and member/channel synchronization.

### Changed

- WebRTC audio uses negotiated Opus parameters and a bounded newest-frame mixer instead of allowing stale audio to accumulate.
- The browser keeps the WebSocket path available for signaling, control, and compatibility fallback; Docker Compose publishes the built-in `40000–40099/UDP` media range alongside the web port.

### Fixed

- Prevented duplicate playback when WebRTC and the WebSocket audio path overlap during negotiation or fallback.
- Made WebRTC teardown and fallback explicit so a failed negotiation does not leave a server-side media session behind.
- Corrected native Opus decoder usage and cleaned up negotiated payload handling for TeamSpeak-to-browser audio.

### Verification

- After allowing inbound `40000–40099/UDP` on the public WebSpeak host, two browser sessions were tested against the same TeamSpeak target with WebRTC enabled: audio frames flowed in both directions, packet drops remained at `0`, ingress frame gaps peaked at about `27 ms`, and egress gaps peaked at about `81–83 ms`.
- The measured WebRTC path stayed below the previous WebSocket jitter peaks of about `268–376 ms` in the same browser test setup; these figures describe the observed test path, not a universal latency guarantee.

## [0.1.2] — 2026-09-02

### Added

- Current-version badge and a direct changelog link on the welcome page, next to the prominent GitHub repository button.
- Mobile member actions through a three-dot menu, while desktop member actions remain available through the context menu.

### Changed

- Mobile and narrow-screen header controls now collapse longer labels into icons to preserve usable spacing.
- The welcome page and connected workspace now present the GitHub, version, changelog, admin, theme, language, exit, and microphone controls as a consistent responsive control group.
- The version shown on the welcome page is read from the gateway's public configuration so it stays aligned with the running backend.
- Consolidated the post-0.1.1 mobile voice controls, microphone mute replacement for focus-dependent PTT, automatic protocol detection, simplified Docker Compose startup, and live-demo documentation.

### Fixed

- Replaced the visually off-center settings glyph and normalized icon alignment for settings-related controls across the client.
- Fixed narrow-screen exit and microphone controls so their text-collapse rules apply correctly.
- Bounded browser and gateway voice buffering, reset stale browser playback queues, and exposed low-overhead in-memory audio counters for diagnosing jitter without per-frame log writes.
- Moved microphone frame assembly to an `AudioWorklet` with a compatibility fallback to `ScriptProcessorNode`; both paths emit fixed 960-sample frames.

## [0.1.1] — 2026-09-02

### Added

- M009 admin operations dashboard for managed invites, active-session inspection, per-session termination, diagnostics, logs, audit access, diagnostic report download, and SQLite backup export.
- Persistent managed invites with expiry, optional maximum uses, revocation, hashed opaque tokens, and encrypted TeamSpeak credentials at rest.
- Mobile-aware invite joining through the `invite` URL parameter without placing a TeamSpeak password in the URL.
- M010 hardening for per-peer join-ticket rate limiting and bounded rotating runtime logs.
- Bilingual README documentation with parallel Chinese and English feature, deployment, security, and operations sections.

### Changed

- Database schema is now version 2 and migrates existing version 1 installations transactionally with a migration copy.
- Admin overview and diagnostics use the application package version instead of a hard-coded display value.
- The README architecture section now uses GitHub-native Markdown instead of a Mermaid rich-display block.
- The README badge set now uses stable static Shields badges without a repository-metadata 404 dependency.
- Version tags publish Windows/Linux deployment packages to GitHub Releases and publish the matching Docker image.
- Removed the focus-dependent normal browser Space-key PTT mode and replaced it with a one-click microphone mute/unmute control on desktop and mobile.
- Persisted the microphone mute state in browser preferences and suppresses upstream audio before it is sent to TeamSpeak while muted.

### Fixed

- Late WebSpeak browser sessions now reconcile and merge the complete TeamSpeak directory, so members who joined earlier remain visible.
- Private-message delivery no longer disconnects the browser session.
- Member actions are presented through the right-click context menu with hover feedback.
- Docker release builds copy the root `postinstall` patch script before running `npm ci`.
- Release builds skip `npm version` when the project version already matches the requested version, preventing false `Version not changed` failures.

### Verification

- `npm test` — 51 tests passed.
- `npm run build` — backend TypeScript build passed.
- `npm run web:build` — frontend production build passed.
- `npm audit --omit=dev --audit-level=high` — no high or critical vulnerabilities reported.
- Local `/demo` browser checks passed at the documented narrow and desktop widths; `/demo` does not connect to TeamSpeak.

Real TS3/TS6 interoperability, Android microphone behavior, multi-client smoke, and the 24-hour long-run gate require their respective test environments and are not claimed by this local release check.

## [0.1.0] — 2026-08-31

- First normalized release with the browser client, TeamSpeak 3 / 6 gateway, browser audio controls, access modes, administrator operations, and AGPL-3.0-only licensing.
