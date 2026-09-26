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
- Browser must support WebRTC and `AudioWorklet` (current Chrome/Edge/Firefox/Safari)
- HTTPS required (self-signed cert OK, generated in `certs/`)
- Max 32 concurrent users (TS3 license limit)
- `tsApiKey` required for channel list; voice works without it
