/**
 * S2 媒体内核验收测试（media-worker.ts + ice-credentials.ts）。
 *
 * 覆盖：
 *   ① Worker 正常拉起且 pid 有效；
 *   ② Router 以 `channels: 2` 成功创建（并核对 ORTC mediaCodecs 声明）；
 *   ③ 对抗断言：Router 传入 `channels: 1` 必然抛 `UnsupportedError`；
 *   ④ `announcedAddress` 解析正确（注入 WEBSPEAK_MEDIA_PUBLIC_HOST 时 candidate 含该地址）；
 *   ⑤ 分配的 UDP / TCP 端口严格落在 [40000, 40099]；
 *   ⑥ ice-credentials.ts 导出的凭据符合规范且无写死 `:webspeak` 残留。
 *
 * 用法：npx tsx scripts/media-worker-test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ④：注入公网媒体地址（media-worker 在创建 transport 时读取）。
process.env.WEBSPEAK_MEDIA_PUBLIC_HOST = "media.example.test";
// ⑥：TURN 凭据派生需要 URL + secret（缺 secret 时按失败关闭处理，不下发 TURN）。
process.env.WEBSPEAK_TURN_URLS = "turn:127.0.0.1:3478";
process.env.WEBSPEAK_TURN_SECRET = "test_secret_123456";

const { createHmac } = await import("node:crypto");
const mediasoup = await import("mediasoup");
const {
  MEDIA_CODECS,
  MEDIA_PORT_RANGE,
  createMediaWorker,
  createMediaRouter,
  createMediaWebRtcTransport,
  resolveMediaPublicHost,
} = await import("../src/server/media-worker.ts");
const { generateTurnUserid, buildTurnCredentials, resolveIceServers, resolveStunUrls } = await import(
  "../src/server/ice-credentials.ts"
);

const [PORT_MIN, PORT_MAX] = MEDIA_PORT_RANGE;
const PUBLIC_HOST = "media.example.test";
const USERID_RE = /^webspeak_[0-9a-f]{12}$/;
const USERNAME_RE = /^\d{10,}:webspeak_[0-9a-f]{12}$/;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 关闭一个可能为 undefined 的资源，忽略重复关闭。 */
const closeQuietly = (resource) => {
  try {
    if (resource && typeof resource.close === "function" && !resource.closed) resource.close();
  } catch {
    /* best effort */
  }
};

let worker;
let router;
let transportWithAnnounced;
let transportWithoutAnnounced;

try {
  // ───────────────────────── ① Worker 拉起 ─────────────────────────
  console.log("=== ① Worker 拉起与生命周期 ===");
  worker = await createMediaWorker();
  check(
    "Worker 正常拉起且 pid 有效",
    Number.isInteger(worker.pid) && worker.pid > 0 && !worker.closed && !worker.died,
    `pid=${worker.pid}, closed=${worker.closed}, died=${worker.died}`,
  );

  // ───────────────────────── ② Router channels:2 ─────────────────────────
  console.log("\n=== ② Router 以 channels: 2 创建 ===");
  const audioCodecs = MEDIA_CODECS.filter((codec) => codec.kind === "audio");
  const videoCodecs = MEDIA_CODECS.filter((codec) => codec.kind === "video");
  const declared = audioCodecs[0];
  check(
    "MEDIA_CODECS 存在且仅存在 1 条 audio/opus 48000/2 PT=111",
    audioCodecs.length === 1 &&
      declared?.kind === "audio" &&
      declared.mimeType === "audio/opus" &&
      declared.clockRate === 48000 &&
      declared.channels === 2 &&
      declared.preferredPayloadType === 111,
    JSON.stringify(audioCodecs),
  );
  // F1：直接复用第 78 行已声明的 `videoCodecs`，严禁再次 `const videoCodecs = ...`。
  const declaredVideo = videoCodecs[0];
  const fallbackVideo = videoCodecs[1];
  const h264Feedback = [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "ccm", parameter: "fir" },
    { type: "goog-remb" },
    { type: "transport-cc" },
  ];
  check(
    "MEDIA_CODECS 恰存在 2 条 video codec，且 H.264 优先 / VP8 兜底",
    videoCodecs.length === 2 &&
      declaredVideo?.kind === "video" &&
      declaredVideo.mimeType === "video/H264" &&
      fallbackVideo?.kind === "video" &&
      fallbackVideo.mimeType === "video/VP8",
    JSON.stringify(videoCodecs.map((codec) => codec.mimeType)),
  );
  check(
    "首条 video/H264 逐字段锁定 90000 与 packetization-mode/profile-level-id/level-asymmetry-allowed",
    declaredVideo?.clockRate === 90000 &&
      declaredVideo.parameters?.["packetization-mode"] === 1 &&
      declaredVideo.parameters?.["profile-level-id"] === "42e01f" &&
      declaredVideo.parameters?.["level-asymmetry-allowed"] === 1,
    JSON.stringify(declaredVideo?.parameters),
  );
  check(
    "首条 video/H264 声明 5 项 RTCP 反馈（nack / nack-pli / ccm-fir / goog-remb / transport-cc）",
    Array.isArray(declaredVideo?.rtcpFeedback) &&
      declaredVideo.rtcpFeedback.length === 5 &&
      JSON.stringify(declaredVideo.rtcpFeedback) === JSON.stringify(h264Feedback),
    JSON.stringify(declaredVideo?.rtcpFeedback),
  );
  check(
    "次条 video/VP8 兜底声明完整：90000 且 RTCP 反馈结构与 H.264 一致",
    fallbackVideo?.clockRate === 90000 &&
      JSON.stringify(fallbackVideo.rtcpFeedback) === JSON.stringify(h264Feedback),
    JSON.stringify({ clockRate: fallbackVideo?.clockRate, rtcpFeedback: fallbackVideo?.rtcpFeedback }),
  );

  router = await createMediaRouter(worker);
  const opusCapability = router.rtpCapabilities.codecs?.find(
    (codec) => codec.mimeType.toLowerCase() === "audio/opus",
  );
  check(
    "Router 以 channels: 2 创建成功",
    typeof router.id === "string" && router.id.length > 0 && opusCapability?.channels === 2,
    `routerId=${router.id}, opus.channels=${opusCapability?.channels}`,
  );

  // ───────────────────────── ③ 对抗：channels:1 ─────────────────────────
  console.log("\n=== ③ 对抗断言：channels: 1 必然抛错 ===");
  let thrown;
  try {
    await worker.createRouter({ mediaCodecs: [{ ...declared, channels: 1 }] });
  } catch (error) {
    thrown = error;
  }
  const UnsupportedError = mediasoup.errors?.UnsupportedError;
  const isUnsupported =
    thrown instanceof Error &&
    (thrown.name === "UnsupportedError" ||
      (typeof UnsupportedError === "function" && thrown instanceof UnsupportedError));
  check(
    "Router 传入 channels: 1 抛 UnsupportedError",
    isUnsupported,
    thrown ? `${thrown.name}: ${thrown.message}` : "未抛错（危险：mediasoup 行为已漂移）",
  );

  // ───────────────────────── ④ announcedAddress ─────────────────────────
  console.log("\n=== ④ announcedAddress 公网映射 ===");
  check(
    "resolveMediaPublicHost 归一化 host / host:port / URL",
    resolveMediaPublicHost("media.example.test") === PUBLIC_HOST &&
      resolveMediaPublicHost("media.example.test:8443") === PUBLIC_HOST &&
      resolveMediaPublicHost("https://media.example.test:8443/path") === PUBLIC_HOST,
    `裸主机/带端口/完整 URL 均归一化为 ${PUBLIC_HOST}`,
  );
  check(
    "resolveMediaPublicHost 空值返回 undefined",
    resolveMediaPublicHost("") === undefined && resolveMediaPublicHost("null") === undefined,
    "空串 / null 视为未配置",
  );

  transportWithAnnounced = await createMediaWebRtcTransport(router);
  const announcedCandidates = transportWithAnnounced.iceCandidates;
  const announcedUdp = announcedCandidates.find((candidate) => candidate.protocol === "udp");
  const announcedTcp = announcedCandidates.find((candidate) => candidate.protocol === "tcp");
  check(
    "注入 WEBSPEAK_MEDIA_PUBLIC_HOST 时 UDP/TCP candidate 均含该地址",
    announcedUdp?.address === PUBLIC_HOST && announcedTcp?.address === PUBLIC_HOST,
    `udp.address=${announcedUdp?.address}, tcp.address=${announcedTcp?.address}`,
  );

  // 未配置时省略 announcedAddress：candidate 退回监听地址。
  const savedHost = process.env.WEBSPEAK_MEDIA_PUBLIC_HOST;
  delete process.env.WEBSPEAK_MEDIA_PUBLIC_HOST;
  check("未配置时 resolveMediaPublicHost() 返回 undefined", resolveMediaPublicHost() === undefined, "环境变量已清空");
  transportWithoutAnnounced = await createMediaWebRtcTransport(router);
  const plainUdp = transportWithoutAnnounced.iceCandidates.find((candidate) => candidate.protocol === "udp");
  check(
    "未配置时不注入 announcedAddress（candidate 为监听地址）",
    plainUdp !== undefined && plainUdp.address !== PUBLIC_HOST,
    `udp.address=${plainUdp?.address}`,
  );
  process.env.WEBSPEAK_MEDIA_PUBLIC_HOST = savedHost;

  // ───────────────────────── ⑤ 端口段 ─────────────────────────
  console.log("\n=== ⑤ 端口段 [40000, 40099] ===");
  const inRange = (port) => Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
  check(
    "UDP candidate 端口落在端口段内",
    inRange(announcedUdp?.port),
    `udp.port=${announcedUdp?.port}`,
  );
  check(
    "TCP candidate 端口落在端口段内",
    inRange(announcedTcp?.port),
    `tcp.port=${announcedTcp?.port}`,
  );
  check(
    "同端口段下多 transport 的候选端口均在区间内",
    [transportWithAnnounced, transportWithoutAnnounced]
      .flatMap((t) => t.iceCandidates)
      .every((candidate) => inRange(candidate.port)),
    `端口段=[${PORT_MIN}, ${PORT_MAX}]`,
  );

  // ───────────────────────── ⑥ ice-credentials ─────────────────────────
  console.log("\n=== ⑥ ice-credentials 凭据规范 ===");
  check(
    "resolveStunUrls 导出且返回非空列表",
    typeof resolveStunUrls === "function" && resolveStunUrls().length >= 1,
    resolveStunUrls().join(", "),
  );
  check(
    "generateTurnUserid 合法后缀透传 + 缺省随机均匹配 /^webspeak_[0-9a-f]{12}$/",
    generateTurnUserid("0123456789ab") === "webspeak_0123456789ab" &&
      USERID_RE.test(generateTurnUserid()) &&
      generateTurnUserid() !== generateTurnUserid(),
    `样例：${generateTurnUserid()}`,
  );

  const [turnEntry] = resolveIceServers().filter((server) => server.urls.some((url) => url.startsWith("turn:")));
  const username = turnEntry?.username ?? "";
  const [expiryRaw, userid] = username.split(":");
  const expectedCredential = createHmac("sha1", "test_secret_123456").update(username).digest("base64");
  check(
    "resolveIceServers TURN username 严格为 <过期秒>:<webspeak_12位hex>",
    USERNAME_RE.test(username) && USERID_RE.test(userid ?? ""),
    `username=${username}`,
  );
  check(
    "credential = base64(HMAC-SHA1(secret, username))",
    turnEntry?.credential === expectedCredential && Number(expiryRaw) > Math.floor(Date.now() / 1000),
    `credential=${turnEntry?.credential}`,
  );

  const direct = buildTurnCredentials("test_secret_123456", 300, generateTurnUserid("deadbeefcafe"));
  check(
    "buildTurnCredentials 导出且签名一致",
    USERNAME_RE.test(direct.username) &&
      direct.username.split(":")[1] === "webspeak_deadbeefcafe" &&
      direct.credential === createHmac("sha1", "test_secret_123456").update(direct.username).digest("base64"),
    `username=${direct.username}`,
  );

  const source = readFileSync(join(root, "src", "server", "ice-credentials.ts"), "utf8");
  check(
    "ice-credentials.ts 无写死 `:webspeak` 残留",
    !/:webspeak/.test(source) && !username.endsWith(":webspeak"),
    `源码匹配数=${(source.match(/:webspeak/g) ?? []).length}`,
  );
} catch (error) {
  console.error(`\n[FATAL] 测试执行异常：${error instanceof Error ? error.stack : String(error)}`);
  results.push({ name: "测试执行无异常", ok: false, detail: String(error) });
} finally {
  closeQuietly(transportWithAnnounced);
  closeQuietly(transportWithoutAnnounced);
  closeQuietly(router);
  closeQuietly(worker);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  process.exitCode = 1;
}
