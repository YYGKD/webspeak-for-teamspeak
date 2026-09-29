# WebSpeak · English

[Project home](../README.md) · [简体中文](./README.zh-CN.md) · [Deutsch](./README.de.md) · [Русский](./README.ru.md) · [日本語](./README.ja.md)

WebSpeak is a self-hosted browser client and voice gateway for TeamSpeak 3 and TeamSpeak 6. Visitors can join channels without installing a desktop client, while administrators manage the target servers, access policy, and runtime state from the web console.

> **Derivative work**: this repository is based on [`EchoSixHIYA/WebSpeak-client-for-TeamSpeak`](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak) (upstream baseline `v0.2.4`). Changes made to the source since `v0.2.5`, and their dates, are listed in [CHANGELOG](../CHANGELOG.md); see [NOTICE](../NOTICE) for the full statement.

## ✨ Features

| Capability | Description |
| --- | --- |
| TeamSpeak compatibility | Supports TeamSpeak 3 and TeamSpeak 6 and automatically detects the target protocol. |
| Screen sharing | Between web viewers the gateway forwards media through the **mediasoup SFU** (the sharer pushes one stream, so more viewers do not raise upstream bandwidth; video and system audio as separate tracks). Interop with native TeamSpeak 6 clients still uses a direct WebRTC/ICE path. |
| IPv6 targets | IPv6 TeamSpeak targets and IPv6 addresses resolved from hostnames are supported by default. |
| Channels and members | Browse the channel tree, see live member states, and switch channels. |
| Realtime voice | Opus audio is carried end to end by the bundled WebRTC (single mediasoup engine) low-latency transport; WebSocket handles JSON business and media-control signaling only. |
| Audio controls | Select microphones and speakers, adjust volume, test the microphone, mute, use VOX, and control member volume. |
| Browser-side noise suppression | Optional microphone noise suppression runs at the browser capture stage, without adding server-side audio processing. |
| Messaging and actions | Channel chat, server chat, private messages, poke actions, and whisper targets. |
| Desktop accompaniment | Select an audio-enabled window or browser tab and share its sound with the current channel. |
| Identity and access | Remembered identity, visitor-defined targets, and revocable expiring invite links. |
| Administration | Manage targets, access policy, WebRTC, relays, invites, sessions, logs, diagnostics, and backups. |
| User experience | Chinese, English, German, Russian, and Japanese UI, light/dark themes, and responsive desktop/mobile layouts. |
| Self-hosting | Data stays with the operator; Docker, Windows x64, and Linux x64 deployment options are provided. |

## 🖼️ Screenshots

The screenshots show the English welcome page, voice workspace, audio controls, and member menu.

### Welcome page

<p align="center"><img src="./screenshots/webspeak-en-home.png" alt="WebSpeak English welcome page" width="100%" /></p>

### Voice workspace

<p align="center"><img src="./screenshots/webspeak-en.png" alt="WebSpeak English voice workspace" width="100%" /></p>

### Audio controls

<p align="center"><img src="./screenshots/webspeak-en-audio.png" alt="WebSpeak English audio controls" width="100%" /></p>

### Member menu

<p align="center"><img src="./screenshots/webspeak-en-menu.png" alt="WebSpeak English member menu" width="100%" /></p>

## 🧩 Advanced features

These features are optional. Realtime voice always runs over the bundled WebRTC (mediasoup); WebSocket carries JSON business and media-control signaling only, and the legacy WebSocket audio compatibility transport is fully retired. Configure them under **Administration → Servers**; saved changes apply to new connections.

### 1. WebRTC low-latency voice

WebRTC moves browser voice to a realtime media path and also enables desktop accompaniment. The current WebSpeak gateway provides it directly; no separate media server is required.

1. Sign in at `/admin` and open **Advanced settings** on the **Servers** page.
2. While WebRTC is disabled, choose the UDP start and end ports. The default range is `40000–40099`.
3. Allow the complete `40000–40099` range for **both UDP and TCP** in the WebSpeak host's security group and firewall (TCP backs ICE-over-TCP).
4. Enable **WebRTC** and save. New visitors will negotiate WebRTC; if a network cannot establish WebRTC (for example UDP/TCP blocked by a firewall), the UI shows a clear network diagnosis and retry guidance instead of falling back to any WebSocket audio channel.

The port range is locked while WebRTC is enabled. Disable and save WebRTC before changing it, then update the firewall rules. Public deployments also need HTTPS.

Media is served by the built-in **mediasoup** engine (single engine): speakers are published and subscribed dynamically via `clientId ↔ producerId ↔ consumerId`, with no reserved audio m-lines and no slot ceiling. All related environment variables are optional:

- `MEDIASOUP_WORKER_BIN`: path to the mediasoup worker binary; by default the prebuilt `vendor/mediasoup-worker/` artifact shipped with the package is used and verified against its SHA256. Release packages and the Docker image already bundle it, so it normally needs no configuration.
- `WEBSPEAK_MAX_SPEAKERS`: concurrent published speakers per session (1–64, default 32).
- `WEBSPEAK_MEDIA_PUBLIC_HOST`: public media address for proxy/port-mapped deployments (written into the ICE candidate `announcedAddress`); omit it when the media address equals the listen address.

### Screen sharing (SFU central forwarding)

Screen sharing between web viewers goes through **mediasoup SFU central forwarding** in the WebSpeak gateway: the sharer pushes **one** stream to the gateway, and the gateway fans it out to each viewer on demand. Adding viewers therefore does **not** increase the sharer's upstream bandwidth, and no browser-to-browser connection is needed — it works even when both sides sit behind symmetric NAT, a corporate network, or a mobile hotspot.

- **Dual track**: screen video and system audio (when "share audio" is ticked in the browser picker) are separate tracks, kept in sync on the viewer side.
- **Codec**: H.264 preferred (GPU hardware encoding, low CPU), falling back to VP8.
- **Resolution and frame rate**: share settings offer up to 1080p and 60 FPS; the capture never exceeds the selected source itself (for a tab, that ceiling is the tab's viewport). Under bandwidth pressure the trade-off follows the source: **tab/window shares keep resolution** (documents and code stay legible), while **whole-screen shares at ≥30 FPS keep frame rate** (video and games stay smooth).
- **Viewer side**: live status, viewer count, player volume, fullscreen and exit controls; up to **32** web viewers per share.
- **Performance panel**: shows the capture size next to the actual encoded output size, frame rate, bitrate, loss and limiting reason, so you can tell whether the bottleneck is capture, encoding, or the network.

Interop with the **native TeamSpeak 6 client** remains peer-to-peer: both sides connect directly over WebRTC/ICE (reusing the same ICE configuration as voice — your own STUN plus an optional external TURN), and WebSpeak only handles session authorization, share state, and SDP/ICE signaling — it does **not** carry that media. With TURN configured the media may use that external service, but never the WebSpeak gateway.

### STUN and TURN servers

Browsers use ICE servers to discover their public mapping (STUN) and to fall back to a relay (TURN) on symmetric NAT or when UDP is blocked. The built-in public STUN works with no configuration.

- **Admin console (recommended)**: the **STUN / TURN servers** card on the `/admin` → “Server” page. Add as many STUN and TURN entries as you need, **no restart required**. Leave it empty to keep using the server environment variables (`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`), so an upgrade changes nothing for an existing deployment.
- **Two TURN credential schemes**: **static username/password** (what most third-party TURN services offer) and the **coturn REST shared secret** (the secret stays on the server and a short-lived credential is issued per page load). Passwords and secrets are stored as AES-256-GCM ciphertext; the API only reports whether one is stored, and plaintext never reaches the browser.
- **Order is preference**: the list order is the order browsers try, so put the more reliable server first.
- **Caveats**: a static credential is handed to every visitor, which publishes a reusable relay account — set a quota with your provider. `turns:` (TURN over TLS) requires a certificate from a **CA the browser trusts** with a SAN matching the hostname; self-signed certificates are rejected because browsers only trust their built-in root list. Port 53 is blocked by browsers and must not be used.

### 2. Relay mode

Use a relay when a TeamSpeak server rejects connections from another region or when the direct path is unstable. It is not a VPN: it forwards only the TeamSpeak traffic of the current WebSpeak session, while the visitor still chooses the target server in the web page.

A relay instance is a dedicated forwarding service with no visitor page or administration console. It accepts only gateway sessions with a matching token. Use a random token of at least 16 characters.

#### Run from source

```bash
git clone --depth 1 https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak.git
cd WebSpeak-client-for-TeamSpeak
npm ci --ignore-scripts
npm run prepare:sdk
npm run build
WEBSPEAK_MODE=relay \
WEBSPEAK_RELAY_TOKEN='replace-with-a-long-random-token' \
WEBSPEAK_RELAY_HOST='0.0.0.0' \
WEBSPEAK_RELAY_PORT='39087' \
node dist/index.js
```

Windows PowerShell:

```powershell
$env:WEBSPEAK_MODE = "relay"
$env:WEBSPEAK_RELAY_TOKEN = "replace-with-a-long-random-token"
$env:WEBSPEAK_RELAY_HOST = "0.0.0.0"
$env:WEBSPEAK_RELAY_PORT = "39087"
node .\dist\index.js
```

#### Run from a release package

Download and extract the appropriate package from [Releases](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/latest):

```bash
# Linux
export WEBSPEAK_MODE=relay
export WEBSPEAK_RELAY_TOKEN='replace-with-a-long-random-token'
export WEBSPEAK_RELAY_HOST='0.0.0.0'
export WEBSPEAK_RELAY_PORT='39087'
./runtime/node ./dist/index.js
```

On Windows PowerShell, set the same variables and run `.\runtime\node.exe .\dist\index.js`.

#### Run with Docker

```bash
docker run -d --name webspeak-relay --restart unless-stopped --network host \
  -e WEBSPEAK_MODE=relay \
  -e WEBSPEAK_RELAY_TOKEN='replace-with-a-long-random-token' \
  -e WEBSPEAK_RELAY_PORT='39087' \
  ghcr.io/echosixhiya/webspeak:latest
```

Allow the relay host's UDP listen port, `39087` by default.

#### Enable it in the gateway

1. Open **Administration → Servers → Relay server** and add one or more nodes.
2. Set a custom display name, endpoint such as `relay.example.com#39087`, and matching token for each node, then save.
3. Visitors can choose direct access or one of the configured relays on the welcome page.

Disable and save the relay configuration to remove the relay option from the welcome page.

### 3. Dependencies and attribution

- The relay service is built into WebSpeak with Node.js standard libraries; it does not use GOST, sing-box, or another proxy framework.
- WebRTC media is carried by [mediasoup](https://mediasoup.org/) `3.27.1` (ISC license). The former werift engine is retired and kept only as a test double in development dependencies.
- TeamSpeak protocol connectivity uses the project-maintained [EchoSixHIYA/teamspeak-js](https://github.com/EchoSixHIYA/teamspeak-js) SDK fork.

## 🧾 Changelog

| Version | Date | Summary |
| --- | --- | --- |
| [v0.2.5](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.5) | 2026-09-26 | Moved the WebRTC engine fully to mediasoup and retired the WebSocket binary audio channel; screen sharing now uses SFU central forwarding (H.264 hardware encoding first, video and system audio as separate tracks) and fixes for resolution collapsing to a quarter, the broadcaster's panel being cleared when a viewer left, and a just-started share being killed on a channel change; fixed losing audio after switching devices; added `npm test`. |
| [v0.2.4](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.4) | 2026-09-22 | Added cross-platform P2P screen sharing between browsers and native TeamSpeak 6 clients; added STUN/external-TURN configuration, live player and viewer state, 1080p/60 FPS capture settings, and WebRTC statistics; refined screen-share interactions and added visitor numbering. |
| [v0.2.3](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.3) | 2026-09-19 | Added channel member scheduling and permission-aware direct moves; added avatar, mute-state, and remembered-identity support; refreshed feature screenshots and documentation for all five languages. |
| [v0.2.2](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.2) | 2026-09-17 | Added browser-side microphone noise suppression, Russian and Japanese UI, and per-language welcome text; refined volume interaction and error messages/codes on top of PR #2. |
| [v0.2.1](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.1) | 2026-09-13 | Improved welcome-page connection errors, preserved and safely truncated error codes, and added default IPv6 target support. |
| [v0.2.0](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.0) | 2026-09-10 | Added server-password prompts, formal relay mode, multiple relay selection, and administrator connection-reason reporting. |
| [v0.1.8](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.1.8) | 2026-09-08 | Simplified Docker deployment, supported local TeamSpeak targets, added a 15-second connection timeout, and made network monitoring continuous. |
| [v0.1.7](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.1.7) | 2026-09-06 | Added German, Telegram, network performance, and master-volume features; fixed accompaniment volume fluctuation. |
| [v0.1.6](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.1.6) | 2026-09-04 | Added desktop accompaniment, remembered-identity guidance, and the site icon; fixed WebRTC member volume. |
| [v0.1.5](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.1.5) | 2026-09-04 | Fixed identity persistence and refined the theme toggle. |
| [v0.1.4](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.1.4) | 2026-09-03 | Fixed WebRTC and channel chat and refined administration, logs, and mobile layouts. |
| [v0.1.3](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.1.3) | 2026-09-03 | Added bundled WebRTC, migrated the TeamSpeak SDK, and improved member synchronization and voice buffering. |

See the complete history in [CHANGELOG.md](../CHANGELOG.md).

## 🚀 Deployment

| Method | Best for | Environment |
| --- | --- | --- |
| Docker Compose (recommended) | Long-running servers, simple upgrades, and persistent data | Docker Engine + Docker Compose |
| Release package | Running without Node.js or build dependencies | Windows x64 or Linux x64 |
| From source | Development, debugging, and customization | Node.js 22.5+, Git, and native build tools |

> Docker is optional: you can also run the built output directly under a systemd unit (`ExecStart=node dist/index.js`, working directory set to the deployment folder, data in `data/`), which suits hosts where Docker is not allowed. Upgrading then means "build locally → replace the artifacts → restart the service".

### Docker Compose (recommended)

```bash
git clone --depth 1 https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak.git
cd WebSpeak-client-for-TeamSpeak
docker compose pull
docker compose up -d
```

Open `http://<your-host>:3040` after startup. If using a reverse proxy, point it to that address. When WebRTC is enabled, allow the UDP/TCP port range shown in the administration console. Data is stored in the `webspeak-data` volume.

```bash
docker compose ps
docker compose logs -f webspeak
```

Upgrade:

```bash
git pull --ff-only
docker compose pull
docker compose up -d
```

Do not run `docker compose down -v`; it removes the database and administrator settings.

### Release package

Download the matching `windows-x64.zip` or `linux-x64.tar.gz` from [GitHub Releases](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/latest), extract it into a dedicated directory, and run `start-webspeak.cmd` on Windows or `./start-webspeak.sh` on Linux. Packages include the Node.js runtime and production dependencies.

### From source

```bash
git clone https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak.git
cd WebSpeak-client-for-TeamSpeak
npm ci --ignore-scripts     # skips mediasoup's postinstall: the worker binary ships in vendor/
npm run verify:worker       # verifies the SHA256 of vendor/mediasoup-worker/
npm run prepare:sdk
npm --prefix web ci
npm --prefix web run build
npm run build
npm start
```

The production runtime needs **no native transcoding dependency**: `@discordjs/opus` now lives in `devDependencies` and is only used by the offline tests (run `npm rebuild @discordjs/opus` if you want to execute them). Run the full regression suite with `npm test` — worker verification plus codec, speaker map, upstream pipeline, audio device, screen-share SFU, end-to-end, TURN-credentials and ICE configuration, nine suites in total.

### First-time setup

1. Open `http://<your-host>:3040/admin`.
2. Sign in with `admin` / `admin` and immediately set a new password of at least 12 characters.
3. Configure the TeamSpeak target and access mode under **Servers**, for example `voice.example.com#9987`.
4. Configure HTTPS for public access; when WebRTC is enabled, allow the UDP/TCP port range shown in the console.

## ⚠️ Requirements and notes

| Area | Requirement or note |
| --- | --- |
| Browser | Supported baseline: **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+** (including iOS Safari and Android Chrome). Microphone and window audio normally require HTTPS. Per-engine differences and fallbacks are listed under “Browser Compatibility” in the repository README. |
| Output device selection | Only Chromium engines can genuinely switch speakers (`AudioContext.setSinkId`). Firefox 116+ has `HTMLMediaElement.setSinkId` but no `AudioContext.setSinkId`, and this app's audible output comes from the WebAudio graph, so Firefox also falls back to the system default device; the settings panel says so explicitly. |
| Accompaniment | Chromium desktop only, and requires WebRTC. Firefox/Safari `getDisplayMedia` exposes no display audio track, so the entry point is unavailable there. Enable audio sharing when selecting a window or tab. |
| TeamSpeak network | The WebSpeak host must reach the target TeamSpeak server; the default voice port is `9987`. |
| Web network | The service uses `3040/TCP`; public deployments should expose the page and WebSocket through an HTTPS reverse proxy. |
| IPv6 | Write literal targets as `[2001:db8::1]#9987`. The host/container needs routed IPv6, IPv6 enabled in the OS and Node.js, and the relevant firewall rules. |
| WebRTC | The default range is `40000–40099` for UDP and TCP; allow it and disable WebRTC before changing the range. |
| Remembered identity | One browser identity can hold one active remembered connection. Disable it for parallel connections or use another browser profile. |
| Data | Docker data is in `webspeak-data`; release packages and source installs use `data/`. Back up before upgrades. |
| Session limit | One instance accepts up to 100 active browser sessions. |
