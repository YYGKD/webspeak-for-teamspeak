/**
 * S7 端到端全链路回归验收（MS-S7-01 ~ MS-S7-03）。
 *
 * 目标：用**真实**的 WebRTC 协议栈（Node 端无头 peer 测试双 = werift
 * `RTCPeerConnection`）连到生产同款 `WebRtcTransport`，把「DTLS 握手 / ICE 端口
 * 绑定 / 下行消费 / 超时淘汰 / UDP 封锁兜底 / TURN 中继穿透」全部跑成可观测的
 * 断言，而不是靠 mock 声称通过。
 *
 * 覆盖场景：
 *   ⓪ 前置：Worker 拉起、Router `channels: 2`、端口段常量 40000–40099；
 *   ① 真实 DTLS 握手 + ICE 绑定：UDP 候选上完成 ICE/DTLS，`dtlsTransport.state
 *      === "connected"`，选中的 candidate pair 远端端口落在端口段内，Opus 负载
 *      逐字节透传、可解码（RMS > 0）、时间戳按 960 samples 严格步进；
 *   ② 3 说话人并发加入 + 下行消费 + 超时淘汰：3 个 clientId 同时 ingest →
 *      `SpeakerProducerMap` 动态建 3 条 DirectTransport Producer → 同一条浏览器
 *      transport 上 3 条 Consumer（mid 0/1/2）分别收到 3 路独立 SSRC 的音频；
 *      停喂其中 1 人 → 2000ms idle 定时器回收，`speakerProducerClosed(reason:
 *      "idle")` 广播、Consumer 关闭、其余 2 人不受影响；
 *   ③ UDP 封锁（仅 ICE-over-TCP 连通）：客户端丢弃全部 UDP candidate pair，
 *      只保留 TCP pair，断言 DTLS 仍 connected 且选中 pair 为 `tcp`，音频照常送达；
 *   ④ UDP 全封 + TURN 可用：`iceTransportPolicy: "relay"` 的无头 peer 只经
 *      进程内极简 TURN server（RFC 5766 子集）拿 relay 候选，断言经中继后
 *      DTLS/ICE 仍能建立、下行音频仍能送达 —— 证明 `ice-credentials.ts` 签发的
 *      临时凭据链路端到端可用。
 *
 * 只读红线（规格 §10.1 / 门禁 M6）：本脚本**不引入任何 TS3 客户端**，媒体全部走
 * 内存回环与本地 socket；同时为满足 `! grep -rqE "\.sendVoice\s*\(" scripts/`，
 * 脚本内不出现该字面量（这里根本没有 TS3 写入口）。
 *
 * 运行方式：`node scripts/mediasoup-e2e.mjs`（退出码 0 = 全绿）。
 * 脚本自带极简 TS 运行时转译 loader，因此无需 tsx、无需先构建 dist 即可直跑源码。
 */
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// 0. 极简 TS 运行时转译 loader
//
// `node scripts/mediasoup-e2e.mjs` 必须能直接跑（验收命令不带 tsx），而源码树里的
// `src/**/*.ts` 有两处 Node 原生 strip-only 模式处理不了的东西：
//   1) 相对导入写的是编译产物后缀 `./x.js`（Node 原生不会回退到 `x.ts`）；
//   2) `constructor(private readonly x)` 参数属性（strip-only 模式直接抛错）。
// 因此注册一个只作用于 `src/**.ts` 的 resolve+load 钩子：`./x.js` → `x.ts`，并用
// `typescript` 的 `transpileModule` 做单文件转译（与 tsx 同路数）。
// 钩子模块用 data: URL 内联（不新增文件）；运行时不支持 data: URL 时回落到系统临时文件。
// ─────────────────────────────────────────────────────────────────────────────
const TS_HOOK_SOURCE = `
const TS_URL = ${JSON.stringify(pathToFileURL(join(ROOT, "node_modules", "typescript", "lib", "typescript.js")).href)};

/** src/** 下 \`./x.js\` 形式的相对导入回退到 \`x.ts\`。 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const fromSource = context.parentURL ? context.parentURL.includes("/src/") : false;
    if (fromSource && /\\.js$/.test(specifier) && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw error;
  }
}

/** 单文件转译 TS（覆盖参数属性等 strip-only 不支持的语法）。 */
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const ts = await import(TS_URL);
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const fileName = fileURLToPath(url);
  const output = ts.default.transpileModule(readFileSync(fileName, "utf8"), {
    compilerOptions: {
      module: ts.default.ModuleKind.ESNext,
      target: ts.default.ScriptTarget.ES2022,
      isolatedModules: true,
    },
    fileName,
  });
  return { format: "module", source: output.outputText, shortCircuit: true };
}
`;

/**
 * 注册 TS 转译钩子。优先用 data: URL 内联（不落盘）；若该运行时不支持，
 * 回落到系统临时目录中的钩子文件（不新增仓库文件）。
 */
function registerTsLoader(kind) {
  if (kind === "data-url") {
    register(`data:text/javascript,${encodeURIComponent(TS_HOOK_SOURCE)}`);
    return "data-url";
  }
  const hookPath = join(tmpdir(), `mediasoup-e2e-ts-hook-${process.pid}.mjs`);
  require("node:fs").writeFileSync(hookPath, TS_HOOK_SOURCE, "utf8");
  register(pathToFileURL(hookPath).href);
  return hookPath;
}

let hookOrigin = registerTsLoader("data-url");

/** 导入 `src/**` 下的 TS 模块；data: URL 钩子不可用时自动改用临时文件钩子重试一次。 */
async function loadSourceModule(relativePath) {
  const url = pathToFileURL(join(ROOT, relativePath)).href;
  try {
    return await import(url);
  } catch (error) {
    if (hookOrigin !== "data-url") throw error;
    hookOrigin = registerTsLoader("tmp-file");
    return import(url);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 依赖装载（只读源码，不触达任何 TS3 生产连接）
// ─────────────────────────────────────────────────────────────────────────────
const { RTCPeerConnection, useOPUS } = await import("werift");
// Opus 编解码器已随依赖解耦迁到测试侧，生产源码树不再直接依赖 @discordjs/opus。
const { createOpusEncoder, createOpusDecoder } = await import("./lib/opus-codec.mjs");
const {
  MEDIA_PORT_RANGE,
  createMediaWorker,
  createMediaRouter,
  createMediaWebRtcTransport,
} = await loadSourceModule("src/server/media-worker.ts");
const { SpeakerProducerMap, DEFAULT_IDLE_TIMEOUT_MS } = await loadSourceModule("src/server/speaker-producer-map.ts");
const { resolveIceServers, generateTurnUserid } = await loadSourceModule("src/server/ice-credentials.ts");

const [PORT_MIN, PORT_MAX] = MEDIA_PORT_RANGE;
const OPUS_PAYLOAD_TYPE = 111;
const CLOCK_RATE = 48_000;
const FRAME_SAMPLES = 960; // 20ms @ 48kHz
const LOOPBACK = "127.0.0.1";
const TURN_REALM = "webspeak.e2e";
const TURN_SECRET = "webspeak_e2e_turn_secret";

/** 本脚本声明的最小 ORTC 能力集（与 Router 的 opus/48000/2 对齐）。 */
const CLIENT_RTP_CAPABILITIES = {
  codecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: CLOCK_RATE,
      channels: 2,
      preferredPayloadType: OPUS_PAYLOAD_TYPE,
      rtcpFeedback: [],
    },
  ],
  headerExtensions: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. TURN 测试双（RFC 5766 子集：Allocate / Refresh / CreatePermission /
//    ChannelBind / ChannelData / Send / Data）。复用 werift 自带的 STUN 编解码
//    与 TURN 帧工具（绝对路径 require，绕开 package exports 限制），保证与客户端
//    的线格式完全一致。
// ─────────────────────────────────────────────────────────────────────────────
function loadTurnCodec() {
  const stunRoot = join(ROOT, "node_modules", "werift", "lib", "ice-server", "src");
  return {
    Message: require(join(stunRoot, "stun", "message.js")).Message,
    parseMessage: require(join(stunRoot, "stun", "message.js")).parseMessage,
    methods: require(join(stunRoot, "stun", "const.js")).methods,
    classes: require(join(stunRoot, "stun", "const.js")).classes,
    frame: require(join(stunRoot, "turn", "frame.js")),
  };
}

/**
 * 启动一个进程内 TURN server（测试双）。
 *
 * 只实现 werift TURN 客户端实际会走的那条路径，凭据校验严格按 coturn REST 方案：
 * username = `<过期 unix 秒>:<userid>`，password = base64(HMAC-SHA1(secret, username))，
 * MESSAGE-INTEGRITY 密钥 = MD5(username:realm:password)。也就是说服务端**不预置**
 * 密码，而是像 coturn 一样从 `static-auth-secret` 现算 —— 这样 `ice-credentials.ts`
 * 的签发结果能否被真实 TURN 接受，就是端到端可验证的。
 */
async function startTestTurnServer({ host, realm, secret }) {
  const dgram = await import("node:dgram");
  const { createHash, createHmac, randomBytes } = await import("node:crypto");
  const { Message, parseMessage, methods, classes, frame } = loadTurnCodec();

  const control = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.bind(0, host, resolve);
  });
  const port = control.address().port;
  const nonce = randomBytes(8);
  const allocations = new Map();
  const relayAddresses = [];
  const stats = { allocate: 0, refresh: 0, createPermission: 0, channelBind: 0, relayedToPeer: 0, relayedToClient: 0, unauthorized: 0 };

  const clientKey = (address, clientPort) => `${address}:${clientPort}`;
  /** coturn REST 语义：从 USERNAME 现算密码与完整性密钥，并校验有效期。 */
  const credentialOf = (username) => createHmac("sha1", secret).update(username).digest("base64");
  const integrityKeyOf = (username) =>
    createHash("md5").update(`${username}:${realm}:${credentialOf(username)}`).digest();
  const isFreshUsername = (username) => {
    const match = /^(\d+):(.+)$/.exec(String(username ?? ""));
    return Boolean(match) && Number(match[1]) > Math.floor(Date.now() / 1000);
  };

  const send = (message, address, clientPort, key) => {
    if (key) message.addMessageIntegrity(key);
    message.addFingerprint();
    control.send(message.bytes, clientPort, address);
  };
  const sendError = (request, address, clientPort, code, reason, key) => {
    const message = new Message(request.messageMethod, classes.ERROR, request.transactionId);
    message.setAttribute("ERROR-CODE", [code, reason]);
    message.setAttribute("REALM", realm);
    message.setAttribute("NONCE", nonce);
    send(message, address, clientPort, key);
  };
  const sendSuccess = (request, address, clientPort, key, attributes) => {
    const message = new Message(request.messageMethod, classes.RESPONSE, request.transactionId);
    for (const [name, value] of attributes) message.setAttribute(name, value);
    send(message, address, clientPort, key);
  };

  const bindRelay = () =>
    new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      socket.once("error", reject);
      socket.bind(0, host, () => resolve(socket));
    });

  const onPeerDatagram = (allocation) => (payload, peer) => {
    const channelNumber = allocation.channelsByPeer.get(`${peer.address}:${peer.port}`);
    const clientPort = allocation.clientPort;
    const clientAddress = allocation.clientAddress;
    if (channelNumber !== undefined) {
      control.send(frame.encodeChannelData(channelNumber, payload), clientPort, clientAddress);
    } else {
      const indication = new Message(methods.DATA, classes.INDICATION);
      indication.setAttribute("XOR-PEER-ADDRESS", [peer.address, peer.port]);
      indication.setAttribute("DATA", payload);
      control.send(indication.bytes, clientPort, clientAddress);
    }
    stats.relayedToClient += 1;
  };

  control.on("message", (data, rinfo) => {
    void handleDatagram(data, rinfo).catch((error) => {
      console.warn(`  [warn] TURN 测试双处理报文失败：${error instanceof Error ? error.message : String(error)}`);
    });
  });

  async function handleDatagram(data, rinfo) {
    const key = clientKey(rinfo.address, rinfo.port);

    // ChannelData：客户端 → peer 的媒体/STUN 直通。
    if (frame.isChannelData(data)) {
      const decoded = frame.decodeChannelData(data);
      const allocation = allocations.get(key);
      const peer = decoded && allocation?.channelsByNumber.get(decoded.channelNumber);
      if (!peer) return;
      allocation.relay.send(decoded.data, peer.port, peer.ip);
      stats.relayedToPeer += 1;
      return;
    }

    const request = parseMessage(data);
    if (!request) return;

    // Send indication：无 channel 时的兜底上行路径。
    if (request.messageClass === classes.INDICATION) {
      if (request.messageMethod === methods.SEND) {
        const allocation = allocations.get(key);
        const peerAddress = request.getAttributeValue("XOR-PEER-ADDRESS");
        const payload = request.getAttributeValue("DATA");
        if (allocation && peerAddress && payload) {
          allocation.relay.send(payload, peerAddress[1], peerAddress[0]);
          stats.relayedToPeer += 1;
        }
      }
      return;
    }
    if (request.messageClass !== classes.REQUEST) return;

    // 认证：首次 Allocate 无凭据 → 401 + REALM/NONCE；带凭据则按 coturn REST 现算密钥校验。
    const username = request.getAttributeValue("USERNAME");
    const authenticated = username && request.attributesKeys.includes("MESSAGE-INTEGRITY");
    if (!authenticated || !isFreshUsername(username)) {
      stats.unauthorized += 1;
      sendError(request, rinfo.address, rinfo.port, 401, "Unauthorized", undefined);
      return;
    }
    const integrityKey = integrityKeyOf(username);
    if (!parseMessage(data, integrityKey)) {
      stats.unauthorized += 1;
      sendError(request, rinfo.address, rinfo.port, 401, "Stale Nonce", integrityKey);
      return;
    }

    if (request.messageMethod === methods.ALLOCATE) {
      let allocation = allocations.get(key);
      if (!allocation) {
        const relay = await bindRelay();
        allocation = {
          relay,
          clientAddress: rinfo.address,
          clientPort: rinfo.port,
          relayAddress: relay.address().address,
          relayPort: relay.address().port,
          permissions: new Set(),
          channelsByNumber: new Map(),
          channelsByPeer: new Map(),
        };
        relay.on("message", onPeerDatagram(allocation));
        allocations.set(key, allocation);
        relayAddresses.push({ address: allocation.relayAddress, port: allocation.relayPort });
        stats.allocate += 1;
      }
      sendSuccess(request, rinfo.address, rinfo.port, integrityKey, [
        ["XOR-RELAYED-ADDRESS", [allocation.relayAddress, allocation.relayPort]],
        ["XOR-MAPPED-ADDRESS", [rinfo.address, rinfo.port]],
        ["LIFETIME", 600],
      ]);
      return;
    }

    const allocation = allocations.get(key);
    if (!allocation) {
      sendError(request, rinfo.address, rinfo.port, 437, "Allocation Mismatch", integrityKey);
      return;
    }
    if (request.messageMethod === methods.REFRESH) {
      stats.refresh += 1;
      sendSuccess(request, rinfo.address, rinfo.port, integrityKey, [["LIFETIME", 600]]);
      return;
    }
    if (request.messageMethod === methods.CREATE_PERMISSION) {
      const peerAddress = request.getAttributeValue("XOR-PEER-ADDRESS");
      if (peerAddress) allocation.permissions.add(peerAddress[0]);
      stats.createPermission += 1;
      sendSuccess(request, rinfo.address, rinfo.port, integrityKey, []);
      return;
    }
    if (request.messageMethod === methods.CHANNEL_BIND) {
      const channelNumber = request.getAttributeValue("CHANNEL-NUMBER");
      const peerAddress = request.getAttributeValue("XOR-PEER-ADDRESS");
      if (channelNumber !== undefined && peerAddress) {
        const peer = { ip: peerAddress[0], port: peerAddress[1] };
        allocation.permissions.add(peer.ip);
        allocation.channelsByNumber.set(channelNumber, peer);
        allocation.channelsByPeer.set(`${peer.ip}:${peer.port}`, channelNumber);
      }
      stats.channelBind += 1;
      sendSuccess(request, rinfo.address, rinfo.port, integrityKey, []);
      return;
    }
    sendError(request, rinfo.address, rinfo.port, 400, "Bad Request", integrityKey);
  }

  return {
    port,
    stats,
    relayAddresses,
    close: async () => {
      for (const allocation of allocations.values()) {
        try {
          allocation.relay.close();
        } catch {
          /* 幂等 */
        }
      }
      allocations.clear();
      await new Promise((resolve) => control.close(resolve));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 断言与工具
// ─────────────────────────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  const ok = predicate();
  if (!ok) console.warn(`  [warn] 等待超时：${label}（${timeoutMs}ms）`);
  return ok;
}

const inPortRange = (port) => Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;

/** 生成一段可解码的合成语音（440Hz 正弦，16bit 单声道 PCM）。 */
function makePcm(amplitude = 8_000, samples = FRAME_SAMPLES) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / CLOCK_RATE)), i * 2);
  }
  return pcm;
}

/** 峰值 RMS（对解码后的 16bit PCM）。 */
function peakRms(pcm) {
  const samples = Math.floor(pcm.length / 2);
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return samples ? Math.sqrt(sum / samples) : 0;
}

/**
 * 建立一个无头 peer：生成 offer → 把 DTLS 指纹交给 mediasoup `connect()` →
 * 用 mediasoup 的 ICE/DTLS 参数 + 每条 Consumer 的 SSRC 构造 answer。
 *
 * 这正是 mediasoup-client 在浏览器里做的事（SDP 由客户端生成、服务端只吃
 * dtlsParameters），这里用 werift 手工复刻，使没有浏览器的 CI 也能跑真实握手。
 */
async function createHeadlessPeer({ transport, consumers, udpBlocked = false, relayOnly = false, iceServers = [] }) {
  const config = {
    iceServers,
    codecs: { audio: [useOPUS({ payloadType: OPUS_PAYLOAD_TYPE })], video: [] },
    headerExtensions: { audio: [], video: [] },
    iceUseIpv4: true,
    // 仅在「UDP 封锁」场景收集 TCP 候选；其余场景不开 TCP 监听（少一份资源占用）。
    iceUseTcp: udpBlocked,
    // 显式把回环地址纳入本地候选（werift 默认会排除 loopback），使本机/CI 都能
    // 与 127.0.0.1 上的 mediasoup 候选配对成功。
    iceAdditionalHostAddresses: [LOOPBACK],
  };
  if (relayOnly) {
    // UDP 全封 + 只允许中继：只收集 TURN relay 候选。
    config.iceTransportPolicy = "relay";
  } else if (udpBlocked) {
    // 网络把 UDP 丢了：只允许远端 TCP 候选参与配对（ICE-over-TCP 兜底）。
    config.iceFilterCandidatePair = (pair) => pair.remoteCandidate.transport?.toLowerCase() === "tcp";
  }

  const peer = new RTCPeerConnection(config);
  const collectors = [];
  for (let i = 0; i < consumers.length; i += 1) {
    const transceiver = peer.addTransceiver("audio", { direction: "recvonly" });
    const collector = {
      transceiver,
      get label() {
        return `mid=${this.transceiver.mid}`;
      },
      packets: 0,
      payloads: [],
      ssrcs: new Set(),
      timestamps: [],
    };
    collectors.push(collector);
    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        collector.packets += 1;
        collector.ssrcs.add(rtp.header.ssrc);
        collector.timestamps.push(rtp.header.timestamp);
        if (collector.payloads.length < 64) collector.payloads.push(Buffer.from(rtp.payload));
      });
    });
  }

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const fingerprint = /a=fingerprint:sha-256 ([0-9A-F:]+)/i.exec(peer.localDescription.sdp)?.[1];
  if (!fingerprint) throw new Error("werift offer 中未找到 sha-256 DTLS 指纹");

  // 服务端登记客户端 DTLS 指纹：werift 作 DTLS client，mediasoup 作 server。
  await transport.connect({
    dtlsParameters: { role: "client", fingerprints: [{ algorithm: "sha-256", value: fingerprint }] },
  });

  const msFingerprint =
    transport.dtlsParameters.fingerprints.find((f) => f.algorithm === "sha-256") ??
    transport.dtlsParameters.fingerprints[0];
  const candidateLines = transport.iceCandidates.map(
    (c) =>
      `a=candidate:${c.foundation} 1 ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}` +
      `${c.tcpType ? ` tcptype ${c.tcpType}` : ""} generation 0`,
  );
  const mediaLines = [];
  for (const consumer of consumers) {
    const codec = consumer.rtpParameters.codecs[0];
    const ssrc = consumer.rtpParameters.encodings[0].ssrc;
    mediaLines.push(
      `m=audio 9 UDP/TLS/RTP/SAVPF ${codec.payloadType}`,
      `c=IN IP4 ${LOOPBACK}`,
      `a=ice-ufrag:${transport.iceParameters.usernameFragment}`,
      `a=ice-pwd:${transport.iceParameters.password}`,
      "a=ice-options:trickle",
      "a=ice-lite",
      `a=fingerprint:${msFingerprint.algorithm} ${msFingerprint.value}`,
      "a=setup:passive",
      "a=sendonly",
      `a=mid:${consumer.rtpParameters.mid}`,
      `a=rtcp:9 IN IP4 ${LOOPBACK}`,
      "a=rtcp-mux",
      `a=rtpmap:${codec.payloadType} opus/48000/2`,
      `a=ssrc:${ssrc} cname:${consumer.rtpParameters.rtcp.cname}`,
      `a=msid:webspeak ${consumer.rtpParameters.mid}`,
      ...candidateLines,
      "a=end-of-candidates",
    );
  }
  const answerSdp = [
    "v=0",
    `o=- ${Date.now()} 1 IN IP4 ${LOOPBACK}`,
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${consumers.map((c) => c.rtpParameters.mid).join(" ")}`,
    "a=msid-semantic:WMS *",
    ...mediaLines,
  ].join("\r\n");

  await peer.setRemoteDescription({ type: "answer", sdp: `${answerSdp}\r\n` });
  const connected = await waitFor(() => peer.connectionState === "connected", 25_000, "peer connectionState=connected");
  return { peer, collectors, connected };
}

/** 关闭一个无头 peer：先停 ICE（释放 werift 的 TCP/UDP 监听），再关连接。 */
async function closeHeadlessPeer(peer) {
  try {
    for (const iceTransport of peer.iceTransports ?? []) await iceTransport.stop?.();
  } catch {
    /* best effort */
  }
  await peer.close();
}

/** 读取选中的 candidate pair（解析 SDP candidate 串，得到 protocol/ip/port/type）。 */
function selectedPairOf(peer) {
  const pair = peer.iceTransports[0]?.getSelectedCandidatePair?.() ?? null;
  if (!pair) return null;
  const parse = (candidate) => {
    const bits = String(candidate?.candidate ?? "").split(" ");
    const tcpIndex = bits.indexOf("tcptype");
    return {
      protocol: bits[2]?.toLowerCase(),
      ip: bits[4],
      port: Number(bits[5]),
      type: bits[7],
      tcpType: tcpIndex >= 0 ? bits[tcpIndex + 1] : undefined,
    };
  };
  return { local: parse(pair.local), remote: parse(pair.remote) };
}

function decodeCollector(collector, decoder) {
  let decoded = 0;
  let decodeErrors = 0;
  let peak = 0;
  for (const payload of collector.payloads) {
    try {
      const rms = peakRms(decoder.decode(payload));
      decoded += 1;
      if (rms > peak) peak = rms;
    } catch {
      decodeErrors += 1;
    }
  }
  return { decoded, decodeErrors, peakRms: peak };
}

/** 持续向某个说话人喂帧（首帧同步建 Producer，后续帧复用）。 */
async function feedSpeaker(map, clientId, frame, count, intervalMs) {
  for (let i = 0; i < count; i += 1) {
    await map.ingest(clientId, frame);
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 场景执行
// ─────────────────────────────────────────────────────────────────────────────
const closers = [];
const cleanup = async () => {
  for (const close of closers.reverse()) {
    try {
      await close();
    } catch {
      /* best effort */
    }
  }
};

let worker;
let router;
const decoder = createOpusDecoder();
const encoder = createOpusEncoder();
const speechFrame = encoder.encode(makePcm());

try {
  console.log(`\n=== ⓪ 前置：TS loader=${hookOrigin}，worker / router / 端口段 ===`);
  worker = await createMediaWorker();
  check(
    "mediasoup Worker 拉起且 pid 有效",
    Number.isInteger(worker.pid) && worker.pid > 0 && !worker.closed && !worker.died,
    `pid=${worker.pid}`,
  );
  router = await createMediaRouter(worker);
  const opusCapability = router.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === "audio/opus");
  check("Router 以 channels: 2 创建", opusCapability?.channels === 2, `opus.channels=${opusCapability?.channels}`);
  check("媒体端口段为 40000–40099", PORT_MIN === 40_000 && PORT_MAX === 40_099, `[${PORT_MIN}, ${PORT_MAX}]`);

  // ─────────────── ① 真实 DTLS 握手 + ICE 端口绑定（UDP） ───────────────
  console.log("\n=== ① 真实 WebRtcTransport DTLS 握手 + ICE 端口绑定（UDP） ===");
  const udpTransport = await createMediaWebRtcTransport(router, { announcedAddress: LOOPBACK });
  closers.push(async () => udpTransport.close());
  const udpCandidate = udpTransport.iceCandidates.find((c) => c.protocol === "udp");
  const tcpCandidate = udpTransport.iceCandidates.find((c) => c.protocol === "tcp");
  check(
    "WebRtcTransport 同时下发 UDP/TCP 候选且端口落在 40000–40099",
    udpTransport.iceCandidates.length > 0 && udpTransport.iceCandidates.every((c) => inPortRange(c.port)),
    `udp=${udpCandidate?.port}, tcp=${tcpCandidate?.port}`,
  );
  check("TCP 候选为 passive（供 ICE-over-TCP 兜底）", tcpCandidate?.tcpType === "passive", `tcpType=${tcpCandidate?.tcpType}`);
  check(
    "announcedAddress 生效：UDP/TCP 候选地址均为注入的映射地址",
    udpCandidate?.address === LOOPBACK && tcpCandidate?.address === LOOPBACK,
    `udp.address=${udpCandidate?.address}, tcp.address=${tcpCandidate?.address}`,
  );

  const speakerMap = new SpeakerProducerMap(router, {});
  closers.push(async () => speakerMap.clear());
  await speakerMap.ingest(101, speechFrame);
  const singleConsumer = await udpTransport.consume({
    producerId: speakerMap.producerIdOf(101),
    rtpCapabilities: CLIENT_RTP_CAPABILITIES,
    paused: false,
  });
  closers.push(async () => singleConsumer.close());
  check(
    "Consumer 分配 mid=0 且负载类型 111",
    singleConsumer.rtpParameters.mid === "0" && singleConsumer.rtpParameters.codecs[0].payloadType === OPUS_PAYLOAD_TYPE,
    `mid=${singleConsumer.rtpParameters.mid}, pt=${singleConsumer.rtpParameters.codecs[0].payloadType}`,
  );

  const udpPeer = await createHeadlessPeer({ transport: udpTransport, consumers: [singleConsumer] });
  closers.push(() => closeHeadlessPeer(udpPeer.peer));
  check(
    "无头 peer 完成真实 ICE + DTLS 握手（connectionState=connected）",
    udpPeer.connected,
    `connectionState=${udpPeer.peer.connectionState}`,
  );
  const udpDtls = udpPeer.peer.dtlsTransports[0];
  check(
    "DTLS 握手状态 connected 且本端角色为 client",
    udpDtls?.state === "connected" && udpDtls?.role === "client",
    `state=${udpDtls?.state}, role=${udpDtls?.role}`,
  );
  const udpPair = selectedPairOf(udpPeer.peer);
  check(
    "选中 candidate pair 为 UDP 且远端端口落在媒体端口段",
    udpPair?.remote.protocol === "udp" && inPortRange(udpPair?.remote.port) && udpPair?.remote.ip === LOOPBACK,
    `local=${udpPair?.local.ip}:${udpPair?.local.port}/${udpPair?.local.protocol} → remote=${udpPair?.remote.ip}:${udpPair?.remote.port}/${udpPair?.remote.protocol}`,
  );
  check(
    "ICE 角色：客户端 controlling、服务端 ice-lite",
    udpPeer.peer.iceTransports[0]?.role === "controlling" && udpTransport.iceParameters.iceLite === true,
    `clientRole=${udpPeer.peer.iceTransports[0]?.role}, serverIceLite=${udpTransport.iceParameters.iceLite}`,
  );

  await feedSpeaker(speakerMap, 101, speechFrame, 25, 20);
  const udpArrived = await waitFor(() => udpPeer.collectors[0].packets >= 10, 8_000, "UDP 下行 RTP");
  const udpDecode = decodeCollector(udpPeer.collectors[0], decoder);
  check(
    "UDP 链路上收到下行 RTP",
    udpArrived,
    `packets=${udpPeer.collectors[0].packets}, ssrc=${[...udpPeer.collectors[0].ssrcs].join(",")}`,
  );
  check(
    "下行 Opus 负载逐字节透传（与注入帧一致）",
    udpPeer.collectors[0].payloads.length > 0 &&
      udpPeer.collectors[0].payloads.every((p) => p.equals(speechFrame)),
    `样例 ${udpPeer.collectors[0].payloads[0]?.length}B vs 注入 ${speechFrame.length}B`,
  );
  check(
    "下行音频可真实解码（Opus 解码零错误且 RMS > 0）",
    udpDecode.decoded > 0 && udpDecode.decodeErrors === 0 && udpDecode.peakRms > 0,
    `decoded=${udpDecode.decoded}, errors=${udpDecode.decodeErrors}, peakRms=${udpDecode.peakRms.toFixed(0)}`,
  );
  const deltas = udpPeer.collectors[0].timestamps.slice(1).map((ts, i) => (ts - udpPeer.collectors[0].timestamps[i]) >>> 0);
  check(
    "RTP 时间戳按 Opus 帧长（960 samples）严格步进",
    deltas.length >= 3 && deltas.every((d) => d === FRAME_SAMPLES),
    `Δts=${deltas.slice(0, 4).join(",")}`,
  );

  // ─────────────── ② 3 说话人并发 + 下行消费 + 超时淘汰 ───────────────
  console.log("\n=== ② 3 说话人并发加入 + 下行消费 + 2000ms idle 淘汰 ===");
  const speakerTransport = await createMediaWebRtcTransport(router, { announcedAddress: LOOPBACK });
  closers.push(async () => speakerTransport.close());
  const events = [];
  const speakerMap3 = new SpeakerProducerMap(router, {
    onNewSpeakerProducer: (clientId, producerId) => events.push({ type: "new", clientId, producerId }),
    onSpeakerProducerClosed: (clientId, producerId, reason) => events.push({ type: "closed", clientId, producerId, reason }),
  });
  closers.push(async () => speakerMap3.clear());

  const speakers = [201, 202, 203];
  await Promise.all(speakers.map((clientId) => speakerMap3.ingest(clientId, speechFrame)));
  const producerIds = speakers.map((clientId) => speakerMap3.producerIdOf(clientId));
  check(
    "3 说话人并发加入：各自动态创建 DirectTransport Producer",
    speakerMap3.size === 3 &&
      producerIds.every((id) => typeof id === "string" && id.length > 0) &&
      new Set(producerIds).size === 3,
    `size=${speakerMap3.size}, producerIds=${producerIds.join(",")}`,
  );
  check(
    "并发加入触发 3 次 newSpeakerProducer 广播",
    events.filter((e) => e.type === "new").length === 3,
    `new=${events.filter((e) => e.type === "new").length}`,
  );

  const consumers3 = [];
  for (const clientId of speakers) {
    consumers3.push(
      await speakerTransport.consume({
        producerId: speakerMap3.producerIdOf(clientId),
        rtpCapabilities: CLIENT_RTP_CAPABILITIES,
        paused: false,
      }),
    );
  }
  closers.push(async () => consumers3.forEach((c) => !c.closed && c.close()));
  check(
    "同一条浏览器 transport 上 3 条 Consumer 分配 mid 0/1/2",
    consumers3.map((c) => c.rtpParameters.mid).join(",") === "0,1,2",
    `mids=${consumers3.map((c) => c.rtpParameters.mid).join(",")}`,
  );

  const peer3 = await createHeadlessPeer({ transport: speakerTransport, consumers: consumers3 });
  closers.push(() => closeHeadlessPeer(peer3.peer));
  check("3 路下行会话完成 DTLS 握手", peer3.connected, `connectionState=${peer3.peer.connectionState}`);
  for (const clientId of speakers) await feedSpeaker(speakerMap3, clientId, speechFrame, 20, 20);
  const allThreeArrived = await waitFor(() => peer3.collectors.every((c) => c.packets >= 5), 8_000, "3 路下行 RTP");
  check(
    "3 路独立 SSRC 的下行音频均到达浏览器侧",
    allThreeArrived && new Set(peer3.collectors.flatMap((c) => [...c.ssrcs])).size === 3,
    peer3.collectors.map((c) => `${c.label}:${c.packets}pkts/${[...c.ssrcs].join("|")}`).join("  "),
  );
  const decoded3 = peer3.collectors.map((c) => decodeCollector(c, decoder));
  check(
    "3 路下行音频均可解码（Opus 零错误 + RMS > 0）",
    decoded3.every((d) => d.decoded > 0 && d.decodeErrors === 0 && d.peakRms > 0),
    decoded3.map((d) => `rms=${d.peakRms.toFixed(0)}`).join(", "),
  );

  // 停喂 202，其余两人继续说话 → 只有 202 被 idle 回收。
  const beforeEvict = peer3.collectors[1].packets;
  const keepAlive = (async () => {
    for (let i = 0; i < 14; i += 1) {
      await speakerMap3.ingest(speakers[0], speechFrame);
      await speakerMap3.ingest(speakers[2], speechFrame);
      await sleep(200);
    }
  })();
  const evicted = await waitFor(
    () => events.some((e) => e.type === "closed" && e.clientId === speakers[1]),
    DEFAULT_IDLE_TIMEOUT_MS + 4_000,
    "202 idle 淘汰",
  );
  await keepAlive;
  const evictEvent = events.find((e) => e.type === "closed" && e.clientId === speakers[1]);
  check(
    `${DEFAULT_IDLE_TIMEOUT_MS}ms idle 超时淘汰停喂的说话人并广播 speakerProducerClosed(reason=idle)`,
    evicted && evictEvent?.reason === "idle" && evictEvent?.producerId === producerIds[1],
    `reason=${evictEvent?.reason}, producerId=${evictEvent?.producerId}`,
  );
  check(
    "被淘汰说话人的 Consumer 同步关闭、其余两人仍在册",
    consumers3[1].closed === true &&
      consumers3[0].closed === false &&
      consumers3[2].closed === false &&
      speakerMap3.size === 2,
    `closed=${consumers3.map((c) => c.closed).join(",")}, size=${speakerMap3.size}`,
  );
  check(
    "淘汰后该路不再有下行 RTP（其余两路继续）",
    peer3.collectors[1].packets - beforeEvict < 5 && peer3.collectors[0].packets > beforeEvict,
    `被淘汰路新增 ${peer3.collectors[1].packets - beforeEvict} 包，其余 ${peer3.collectors[0].packets}/${peer3.collectors[2].packets} 包`,
  );

  // ─────────────── ③ UDP 封锁：仅 ICE-over-TCP ───────────────
  console.log("\n=== ③ UDP 封锁（仅 ICE-over-TCP 连通） ===");
  const tcpTransport = await createMediaWebRtcTransport(router, { announcedAddress: LOOPBACK });
  closers.push(async () => tcpTransport.close());
  const tcpSpeakerMap = new SpeakerProducerMap(router, {});
  closers.push(async () => tcpSpeakerMap.clear());
  await tcpSpeakerMap.ingest(301, speechFrame);
  const tcpConsumer = await tcpTransport.consume({
    producerId: tcpSpeakerMap.producerIdOf(301),
    rtpCapabilities: CLIENT_RTP_CAPABILITIES,
    paused: false,
  });
  closers.push(async () => tcpConsumer.close());
  const tcpPeer = await createHeadlessPeer({ transport: tcpTransport, consumers: [tcpConsumer], udpBlocked: true });
  closers.push(() => closeHeadlessPeer(tcpPeer.peer));
  const tcpPair = selectedPairOf(tcpPeer.peer);
  check("UDP 被封时经 ICE-over-TCP 建立连接（connectionState=connected）", tcpPeer.connected, `connectionState=${tcpPeer.peer.connectionState}`);
  check(
    "选中 candidate pair 为 TCP（local active → remote passive）",
    tcpPair?.remote.protocol === "tcp" &&
      tcpPair?.remote.tcpType === "passive" &&
      tcpPair?.local.tcpType === "active",
    `local=${tcpPair?.local.ip}:${tcpPair?.local.port}/${tcpPair?.local.protocol}/${tcpPair?.local.tcpType} → remote=${tcpPair?.remote.ip}:${tcpPair?.remote.port}/${tcpPair?.remote.protocol}/${tcpPair?.remote.tcpType}`,
  );
  check("TCP 通道远端端口仍落在 40000–40099", inPortRange(tcpPair?.remote.port), `remote.port=${tcpPair?.remote.port}`);
  await feedSpeaker(tcpSpeakerMap, 301, speechFrame, 25, 20);
  const tcpArrived = await waitFor(() => tcpPeer.collectors[0].packets >= 10, 8_000, "TCP 下行 RTP");
  const tcpDecode = decodeCollector(tcpPeer.collectors[0], decoder);
  check(
    "TCP 兜底链路上下行音频照常送达并可解码",
    tcpArrived && tcpDecode.decoded > 0 && tcpDecode.decodeErrors === 0 && tcpDecode.peakRms > 0,
    `packets=${tcpPeer.collectors[0].packets}, decoded=${tcpDecode.decoded}, errors=${tcpDecode.decodeErrors}, rms=${tcpDecode.peakRms.toFixed(0)}`,
  );

  // ─────────────── ④ UDP 全封 + TURN 中继穿透 ───────────────
  console.log("\n=== ④ UDP 全封 + TURN 可用：中继穿透 ===");
  const { createHmac } = await import("node:crypto");
  const turnUserid = generateTurnUserid("e2e0e2e0e2e0");
  const turnServer = await startTestTurnServer({ host: LOOPBACK, realm: TURN_REALM, secret: TURN_SECRET });
  closers.push(async () => turnServer.close());

  // 客户端拿到的是**服务端签发路径**（ice-credentials.ts → /api/public-config）的产物，
  // TURN 测试双则像 coturn 一样从 static-auth-secret 现算校验：两边必须自洽。
  process.env.WEBSPEAK_TURN_URLS = `turn:${LOOPBACK}:${turnServer.port}?transport=udp`;
  process.env.WEBSPEAK_TURN_SECRET = TURN_SECRET;
  process.env.WEBSPEAK_STUN_URLS = `stun:${LOOPBACK}:19302`;
  const issued = resolveIceServers(turnUserid).find((server) => server.urls.some((url) => url.startsWith("turn:")));
  const expectedCredential = createHmac("sha1", TURN_SECRET).update(issued?.username ?? "").digest("base64");
  check(
    "服务端签发的 TURN 临时凭据自洽（username=<expiry>:<webspeak_12hex>，credential=HMAC-SHA1）",
    /^\d{10}:webspeak_[0-9a-f]{12}$/.test(issued?.username ?? "") && issued?.credential === expectedCredential,
    `urls=${issued?.urls.join(",")}, username=${issued?.username}`,
  );

  const turnTransport = await createMediaWebRtcTransport(router, { announcedAddress: LOOPBACK });
  closers.push(async () => turnTransport.close());
  const turnSpeakerMap = new SpeakerProducerMap(router, {});
  closers.push(async () => turnSpeakerMap.clear());
  await turnSpeakerMap.ingest(401, speechFrame);
  const turnConsumer = await turnTransport.consume({
    producerId: turnSpeakerMap.producerIdOf(401),
    rtpCapabilities: CLIENT_RTP_CAPABILITIES,
    paused: false,
  });
  closers.push(async () => turnConsumer.close());
  const turnPeer = await createHeadlessPeer({
    transport: turnTransport,
    consumers: [turnConsumer],
    relayOnly: true,
    iceServers: [{ urls: issued.urls, username: issued.username, credential: issued.credential }],
  });
  closers.push(() => closeHeadlessPeer(turnPeer.peer));
  const turnPair = selectedPairOf(turnPeer.peer);
  const relayAddress = turnServer.relayAddresses[0];
  check(
    "relay 策略下客户端只用 TURN relay 候选（选中 relay，直连 host 候选不可用）",
    turnPair?.local.type === "relay" && turnPair?.remote.type === "host",
    `localType=${turnPair?.local.type}, remoteType=${turnPair?.remote.type}`,
  );
  check(
    "中继候选地址/端口与 TURN server 实际分配的 relay socket 一致",
    relayAddress !== undefined && turnPair?.local.ip === relayAddress.address && turnPair?.local.port === relayAddress.port,
    `pair=${turnPair?.local.ip}:${turnPair?.local.port} vs relay=${relayAddress?.address}:${relayAddress?.port}`,
  );
  check(
    "无头 peer 经 TURN 中继完成 DTLS 握手",
    turnPeer.connected,
    `connectionState=${turnPeer.peer.connectionState}, pair=${turnPair?.local.ip}:${turnPair?.local.port}/${turnPair?.local.type} → ${turnPair?.remote.ip}:${turnPair?.remote.port}/${turnPair?.remote.type}`,
  );
  check(
    "TURN 中继确实转发过双向流量（Allocate/ChannelBind 均发生）",
    turnServer.stats.allocate >= 1 && turnServer.stats.channelBind >= 1 && turnServer.stats.relayedToPeer > 0 && turnServer.stats.relayedToClient > 0,
    `allocate=${turnServer.stats.allocate}, channelBind=${turnServer.stats.channelBind}, →peer=${turnServer.stats.relayedToPeer}, →client=${turnServer.stats.relayedToClient}`,
  );
  await feedSpeaker(turnSpeakerMap, 401, speechFrame, 25, 20);
  const turnArrived = await waitFor(() => turnPeer.collectors[0].packets >= 10, 8_000, "TURN 下行 RTP");
  const turnDecode = decodeCollector(turnPeer.collectors[0], decoder);
  check(
    "TURN 中继链路上行下行音频均可达（Opus 可解码 + RMS > 0）",
    turnArrived && turnDecode.decoded > 0 && turnDecode.decodeErrors === 0 && turnDecode.peakRms > 0,
    `packets=${turnPeer.collectors[0].packets}, decoded=${turnDecode.decoded}, rms=${turnDecode.peakRms.toFixed(0)}`,
  );
} catch (error) {
  check("端到端脚本执行无异常", false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
} finally {
  await cleanup();
  try {
    worker?.close();
  } catch {
    /* 幂等 */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
} else {
  console.log("[MEDIASOUP_E2E_OK] 端到端全链路回归全绿");
}

// 显式收尾：werift 的 ICE 在 peer.close()/iceTransport.stop() 之后仍会残留少量
// dgram 句柄（其内部生命周期未完全跟随 RTCPeerConnection 释放）。不显式退出时
// 进程会一直挂到 CI 超时 —— 断言结果已经全部打印，这里刷完 stdout 再以确定性的
// 退出码结束，保证门禁判定稳定。
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(failed.length ? 1 : 0);
