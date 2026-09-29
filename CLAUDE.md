# WebSpeak — TeamSpeak Browser Gateway

Server-side bridge that lets users join TeamSpeak voice channels from a browser. No TS client install needed.

## Architecture

```text
Browser ── WebRTC (mediasoup-client, Opus) ──► WebSpeak gateway ──► TeamSpeak 3 / 6
Browser ── WebSocket (JSON business + media control signaling only) ──► WebSpeak gateway
```

- Realtime audio runs **entirely over WebRTC** on a single in-process **mediasoup** engine. The legacy werift engine, the pre-allocated SFU slot model, and the WebSocket binary audio compatibility channel are all retired.
  - Downlink: TS3 `voiceData` → `speaker-producer-map` DirectTransport `Producer` → browser `mediasoup-client` consumer.
  - Uplink: browser `Producer` → server DirectTransport `Consumer` → `tsClient.sendVoice` / `sendWhisper`.
  - `WEBSPEAK_SFU_SLOTS` no longer exists; speaker count is bounded by `WEBSPEAK_MAX_SPEAKERS` (1–64, default 32).
  - There is **no WS audio fallback**: when WebRTC negotiation exhausts its retries the client reports `WEBRTC_UNAVAILABLE` with network guidance instead of degrading to a WS channel.
- WebSocket carries **JSON business and media-control signaling only** (channels/members, chat, screen-share negotiation, mediasoup/WebRTC handshake). Inbound binary frames are rejected with the `UNSUPPORTED_BINARY_FRAME` protocol error.
- Each browser user = one independent TS3 virtual client via `@echosixhiya/teamspeak-client`
- The browser still captures mic audio for local level/VOX metering, but no longer sends PCM over the socket
- Server-side Opus transcoding is gone; `@discordjs/opus` is a `devDependency` used only by the headless test suite (`scripts/lib/opus-codec.mjs`)
- Server sends Opus to TS via `client.sendVoice(data, codec=4)`
- Channel/member list fetched via TS6 WebQuery HTTP API (port 10080, requires API key)

## Project Structure

```
web/                         # Vue 3 + Vite frontend (SPA)
  src/services/browser-support.ts       # Engine/version sniffing, capability matrix, degradation list
  src/composables/useVoiceWebSocket.ts  # WS JSON client, mic level/VOX, WebRTC + playback
  src/views/WebClient.vue               # Connect form + channel/member tree
src/
  index.ts                    # Entry point, config loading, server startup
  config.ts                   # AppConfig interface + load/save
  logger.ts                   # Pino wrapper
  server/
    server.ts                 # Express + HTTPS + WS setup
    voice-bridge.ts           # /ws/voice endpoint, JSON protocol, media signaling, WebQuery API
    ts-client.ts              # TS3Client wrapper around @echosixhiya/teamspeak-client
```

## Browser Compatibility

Support baseline: **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+** (incl. iOS Safari, Android Chrome).

`web/src/services/browser-support.ts` is the **single source of truth** for browser differences: engine/version detection, the capability matrix, and the derived degradation list. `checkSupport()` returns only `report.blockingReason`; do not reintroduce ad-hoc `'webkitFoo' in window` probes elsewhere.

- Only four blocking conditions: secure context, `RTCPeerConnection`, `getUserMedia`, Web Audio. Everything else degrades.
- Chromium-only extras: display-capture hints (`displaySurface` / `selfBrowserSurface` / `systemAudio` / `windowAudio` / `restrictOwnAudio`) and display **audio** capture (accompaniment). `accompanimentSupported` must stay gated on `displayAudioCapture`, not merely on `getDisplayMedia` existing.
- **Speaker selection is gated on `outputRoutingMode !== "none"`, so Chrome and Firefox behave identically** (same dropdown, same device list, switching takes effect immediately). The playback layer picks the mechanism from `outputRoutingMode`:
  - `"audioContext"` (Chromium): `AudioContext.setSinkId` redirects the whole context. No added cost.
  - `"mediaElement"` (Firefox): **lazy** element routing in `setOutputRouting()` — only once the user picks a non-default device is the audible graph rewired onto a `MediaStreamAudioDestinationNode` played by an **unmuted** `<audio>` element with `setSinkId`. With no device chosen the graph stays on `ctx.destination`, so nobody pays the extra buffering stage by default. All audible connections must go through `outputBus(ctx)` (speaker `analyserNode`s and notification oscillators do); `releaseElementOutputRouting()` rewires back and is called on transport teardown and when the AudioContext is closed.
  - `"none"` (WebKit/Safari): shows an explanation pointing at the OS-level per-app output setting. Not a target, but handled honestly.
  - Why the element has to be an audible sink and not just a pull driver: measured on real Firefox 153 with real speakers (WASAPI endpoint peak meters + per-endpoint session attribution) — WebAudio output follows the **browser/OS audio route**, element `setSinkId` works in both directions, but element `setSinkId` alone **cannot** redirect the WebAudio graph (tone stayed put, other endpoint read exactly 0). Routing the mix *through* an element is the only thing that works.
  - Do not reintroduce `applySpeakerSink()`-style per-speaker element sink setting: those elements are muted pull drivers and it never affected what the user heard.
  - Evidence, reproduction rig and the post-implementation acceptance run: `.local/browser-verify/audio-findings.md`, `AudioProbe.cs`, `sample-audio.ps1`, `audiotest2.html` (device availability), `audiotest3/4.html` (routing proof), `audiotest6.html` (create/rewire/release acceptance).
- **Input device selection is a different story and needs no gating.** Microphone choice is a plain `getUserMedia({ deviceId: { exact } })` constraint; measured on real Firefox 153 it is honoured (the reported `deviceId` matched the request and `autoGainControl` came back as requested rather than at its `true` default). Do not extend the output-side capability gating to `#input-device` — Firefox users keep full microphone selection, and the AudioWorklet capture path also works there.
- **`@sapphi-red/web-noise-suppressor` must stay lazily imported.** Its module top level has `class RnnoiseWorkletNode extends AudioWorkletNode {}`, so a static import throws `ReferenceError` at start-up on any engine without AudioWorklet — killing the page before the `ScriptProcessor` fallback can run (this was a real boot crash in WebKit). Keep the type-only import and the `await import()` inside `createRnnoiseNode()`.
- `webkitAudioDecodedByteCount` is Blink/WebKit only; the Gecko equivalent is RTP `totalAudioEnergy` via `readConsumerAudioEnergy()`.
- `displayMediaOptions()` filters the Chromium hints per engine, and both `getDisplayMedia` call sites retry once with `video: true` on a `TypeError`.
- CSS: `color-mix()` needs Chrome 111 / Firefox 113 / Safari 16.2 — above the baseline. `WebClient.vue` ends with an `@supports not (color: color-mix(...))` fallback block for focus outlines, solid backgrounds, and muted/active states; only genuinely decorative `box-shadow` mixes are left without a fallback. `-webkit-backdrop-filter` is always written alongside the standard property. Do not use `:has()` without a class-based fallback (needs Firefox 121+). Note the fallback's `var()` references mean it must not be tested in isolation without the theme tokens.
- `web/vite.config.ts` pins `build.target` / `build.cssTarget` to `chrome94 / edge94 / firefox102 / safari15.4`. esbuild only downlevels syntax — it does not polyfill `color-mix()`.
- `#app { zoom: var(--ui-scale) }` needs Firefox 126+; `main.ts` pins `--ui-scale` to `1` when `CSS.supports("zoom", "1")` is false, so the layout and the `--app-vh` derivation never disagree.
- Use the **one-argument** `CSS.supports("selector(:has(*))")` form for selector support. The two-argument form is parsed as a property/value pair and returns `false` even in engines that do support `:has()` (confirmed in Chrome, Firefox and WebKit).

- **CJK control labels must carry `white-space: nowrap`.** A CJK label has a *min-content width of one character*, so a flex item holding it collapses into a vertical column as soon as it is squeezed. These controls are sized as "icon + label + padding", i.e. the label gets **exactly** its text width, so a ~1px font-metric difference flips the outcome. Measured on the real build (Chrome 154 / Firefox 155): the header's `.performance-trigger` is laid out at ~136px by both engines, but the label box gets 44.0px in Chrome vs 43.1px in Firefox while「网络性能」needs ~44px — Chrome keeps one line, Firefox wraps to two, **at every window width including 1400px**. `WebClient.vue` therefore has a grouped `white-space: nowrap` rule for compact controls, plus `.workspace-actions { flex: 0 0 auto }` so the shrink falls on `.breadcrumbs` (which ellipsizes) instead of on button text, plus `.breadcrumbs { overflow: hidden }`. When adding a new compact control, add it to that rule.
- Keep that rule limited to classes **actually used in the template** — several older layout classes (`.nav-rail`, `.rail-button`, `.control-dock`, `.mic-mode-switch`, `.chat-tabs`' former siblings, `.quick-action`, `.settings-nav-item`, `.live-pill`, `.github-button`, …) exist only in CSS now, and listing them is misleading.
- The layout harness is `.local/browser-verify/layout-probe.html` + `layout-compare.mjs`: it loads the **real compiled CSS**, rebuilds the live chrome with real class names and scope attributes, and sweeps each row's width in Chrome and Firefox, reporting labels that break. Two traps it already handles, both of which produced false results first time round: (1) Vue's scoped rules are `.cls[data-v-xxxx]`, so probe elements **must** carry every scope attribute or almost no app CSS applies; (2) `Element.getClientRects()` returns one rect for a block element however many lines it has (flex children get blockified), so wrap detection needs `Range.getClientRects()` — and must ignore `display: inline` boxes, whose `clientWidth` is spec-defined 0 and whose `scrollWidth` engines disagree on.

### Verifying browser behaviour
`scripts/browser-support-test.mjs` covers UA→engine/product detection (91 assertions, no browser needed, part of `npm test`). Anything platform-dependent has to be measured on real engines — a local Playwright harness for that lives outside the repo at `.local/browser-verify/` (Chromium/Firefox/WebKit, run `node server.mjs` then `node verify.mjs`). Playwright's WebKit on Windows ships without the media stack, so its `RTCPeerConnection`/`getDisplayMedia`/`MediaRecorder` readings are `false` and do **not** describe shipping Safari.

## Key Technical Details

### Audio Pipeline (pure WebRTC / mediasoup)
1. Browser mic → `getUserMedia` (48kHz mono) → WebRTC `Producer` (Opus) published on the server `send` transport; mic level/VOX metering stays local.
2. Server DirectTransport `Consumer` → `tsClient.sendVoice(opus, 4)` / `sendWhisper`.
3. Downlink: TS3 `voiceData` → per-speaker DirectTransport `Producer` → browser `mediasoup-client` `Consumer` → per-speaker WebAudio playback graph.
4. No PCM frames, no server-side Opus encoding, and no binary WebSocket frames on the audio path. Exhausting the WebRTC retries (2s/5s) ends in `WEBRTC_UNAVAILABLE`, never a fallback channel.

Audio flow counters are kept in memory and exposed in admin session summaries. Do not add per-frame persistent logging to the voice path.

### Test-only Opus
Server-side Opus transcoding was retired, so `@discordjs/opus` is no longer imported by production code. It is a `devDependency` loaded only by the headless test suite through `scripts/lib/opus-codec.mjs`.

### ICE Configuration (STUN / TURN)
`AdminService.getResolvedIceServers(userid?)` is the single source for both voice (`/api/public-config`, wired through `WebServerOptions.iceServers`) and screen sharing (`voiceBridgeOptions.screenShareIceServers`, wired in `index.ts`), so the two paths cannot disagree. Precedence: enabled rows in the `ice_servers` table → `WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS` → built-in public STUN. Two credential schemes: `static` (username/password handed to the browser verbatim) and `rest` (coturn shared secret; a fresh `<expiry>:<userid>` + HMAC-SHA1 credential per call, keeping the per-user quota bucket). Secrets go through `encryptSecret()` and never leave the server — the admin API returns only `hasCredential`. `listIceServers()` orders by `rowid` because one save writes every row with the same `created_at`, and list order is the browser's preference order. Validation rejects rather than truncates (`normalizeIceServers`): prefix whitelist, no port 53, `turns:` cannot carry `transport=udp`, and at most `ICE_SERVER_MAX_ENTRIES` (8) entries may reach a browser.

### WebSocket Message Routing
- Text frames → JSON only: business commands (`listChannels`, `switchChannel`, chat, …), screen-share signaling, and mediasoup/WebRTC media signaling
- Binary frames → rejected with the `UNSUPPORTED_BINARY_FRAME` protocol error (the WS audio channel is retired)
- Frames are decoded as UTF-8 strings; malformed JSON is answered with an `INVALID_JSON` protocol error

### Event Handlers
Must be registered BEFORE `tsClient.connect()` because `clientEnter`/`clientLeave` fire during handshake.

### Channel List
Uses TS6 WebQuery HTTP API (`http://tsHost:tsQueryPort/1/channellist`) with `x-api-key` header. Falls back empty if `tsApiKey` not configured. Regular TS3 voice clients lack permission for `listChannels`/`listClients`.

### Config (config.json)
```json
{
  "port": 3040, "tsHost": "127.0.0.1", "tsPort": 9987,
  "tsQueryPort": 10080, "tsServerProtocol": "ts6",
  "tsApiKey": "", "voiceToken": "change-me", "maxClients": 10
}
```

## Build & Deploy
```bash
npm ci --ignore-scripts
npm run prepare:sdk
npm --prefix web ci
# Acceptance baseline (must be zero errors):
npm run build && npm --prefix web run build
node dist/index.js
```

`@discordjs/opus` is a `devDependency`: rebuild it (`npm rebuild @discordjs/opus --foreground-scripts`) only when running the headless test suite, never to build or run the gateway.

Media worker binaries are vendored under `vendor/mediasoup-worker/` and verified by `node scripts/verify-worker.mjs` (sha256 vs `SHA256SUMS`). Docker and CI run that check; never let mediasoup fall back to downloading a worker at runtime.

## Git
- `origin` — `https://github.com/YYGKD/webspeak-for-teamspeak` (this project's own repo; push here)
- `upstream` — `https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak` (the project this one derives from; `git fetch upstream && git merge upstream/master` to sync)
- GitHub access from this machine goes through a local proxy: `git config --global http.https://github.com.proxy http://127.0.0.1:6666`
- Attribution/licensing: derivative work under AGPL-3.0-only — see `NOTICE` (upstream baseline is tagged `upstream-v0.2.4`)
- `webspeak-update.tar.gz` is in .gitignore (deployment artifact)
- No secrets in source; config.json is gitignored

## Known Limitations
- Browser baseline: Chrome / Edge 94+, Firefox 102+, Safari 15.4+ (see Browser Compatibility above)
- HTTPS required (self-signed cert OK, generated in `certs/`)
- Max 32 concurrent users (TS3 license limit)
- `tsApiKey` required for channel list; voice works without it
- Output-device selection works on Chromium and Firefox (different mechanisms, same UX); accompaniment remains Chromium-only because Gecko exposes no display audio track
