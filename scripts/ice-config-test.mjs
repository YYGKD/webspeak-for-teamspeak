/**
 * ICE 配置单元测试：管理后台可配 STUN/外部 TURN（含静态凭据）。
 *
 * 四组套件：
 *   ① 纯函数 resolveIceServersFromEntries（src/server/ice-credentials.ts）
 *      - static 模式原样下发 {urls, username, credential}，不派生、不做 HMAC；
 *      - rest 模式沿用 coturn REST：username=<过期秒>:<userid>，credential=HMAC-SHA1；
 *      - stun 模式每条 URL 一个条目且不带凭据；
 *      - 失败关闭：TURN 缺凭据 / 无 URL 的条目被跳过，而不是下发一个连不上的中继。
 *   ② env 回退路径回归（resolveIceServers）
 *      - 现有 WEBSPEAK_STUN_URLS / WEBSPEAK_TURN_* 行为不变（升级不破坏老部署）。
 *   ③ 管理端持久化（AdminService + 临时 SQLite）
 *      - 保存后 getResolvedIceServers 返回配置内容；
 *      - 凭据在库内是密文，视图只回 hasCredential（明文绝不出库）；
 *      - 清空列表回退 env；keep/replace/remove 三态凭据语义；审计事件。
 *   ④ 校验拒绝（宁拒绝不静默丢弃）
 *      - 非法前缀、53 端口、turns:+udp、TURN 缺凭据模式、static 缺用户名、
 *        secret 过短、TTL 越界、展开后超过 8 条、id 重复。
 *   ⑤ schema v7 → v8 迁移
 *      - 建表且旧数据保留，schemaVersion 为 8。
 *
 * 用法：npx tsx scripts/ice-config-test.mjs
 */

process.env.WEBSPEAK_STUN_URLS = "stun:127.0.0.1:19302";
process.env.WEBSPEAK_TURN_URLS = "turn:127.0.0.1:3478?transport=udp";
process.env.WEBSPEAK_TURN_SECRET = "test_secret_123456";
delete process.env.WEBSPEAK_TURN_TTL_SECONDS;

const { createHmac } = await import("node:crypto");
const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { resolveIceServers, resolveIceServersFromEntries, generateTurnUserid } = await import("../src/server/ice-credentials.ts");
const { ICE_SERVER_MAX_ENTRIES, ICE_TTL_SECONDS_MAX, ICE_TTL_SECONDS_MIN } = await import("../src/server/webrtc-config.ts");
const { WebSpeakDatabase } = await import("../src/persistence/database.ts");
const { AdminService, AdminInputError } = await import("../src/admin/admin-service.ts");
const { loadOrCreateMasterSecret } = await import("../src/security/master-secret.ts");
const { decryptSecret } = await import("../src/security/secret-crypto.ts");

const TURN_SECRET = "test_secret_123456";
const USERNAME_RE = /^\d{10}:webspeak_[0-9a-f]{12}$/;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 期望的 coturn REST 凭据。 */
const expectedCredential = (username) => createHmac("sha1", TURN_SECRET).update(username).digest("base64");

/** 一条 stun/turn 条目的默认形态。 */
const entry = (overrides = {}) => ({
  kind: "turn",
  urls: "turn:turn.example.com:3478?transport=udp",
  credentialMode: "static",
  username: "user-1",
  credential: "pass-1",
  ttlSeconds: 1800,
  ...overrides,
});

console.log("=== ① 纯函数 resolveIceServersFromEntries ===");

// ---- 1) static：原样下发 ----
{
  const servers = resolveIceServersFromEntries([entry()], generateTurnUserid());
  const turn = servers[0];
  check(
    "static 模式原样下发 urls/username/credential（不派生）",
    servers.length === 1 && turn.urls[0] === "turn:turn.example.com:3478?transport=udp" && turn.username === "user-1" && turn.credential === "pass-1",
    JSON.stringify(turn),
  );
  check(
    "static 模式的 credential 不等于 HMAC 派生值（确认没走 REST 分支）",
    turn.credential !== expectedCredential(turn.username),
    `credential=${turn.credential}`,
  );
}

// ---- 2) rest：走 coturn REST ----
{
  const servers = resolveIceServersFromEntries([entry({ credentialMode: "rest", username: "", credential: TURN_SECRET })], generateTurnUserid());
  const turn = servers[0];
  const match = /^(\d+):(.*)$/.exec(turn.username ?? "");
  const expiryOk = match ? Number(match[1]) > Math.floor(Date.now() / 1000) : false;
  check("rest 模式 username 形如 <过期秒>:<userid>", USERNAME_RE.test(turn.username ?? "") && expiryOk, turn.username);
  check("rest 模式 credential = base64(HMAC-SHA1(secret, username))", turn.credential === expectedCredential(turn.username), turn.credential);
}

// ---- 3) stun：每条 URL 一个条目且无凭据 ----
{
  const servers = resolveIceServersFromEntries([entry({ kind: "stun", urls: "stun:a.example.com:3478, stun:b.example.com:3478", credentialMode: "none", username: "", credential: null })]);
  check(
    "stun 模式每条 URL 一个条目且不带凭据",
    servers.length === 2 && servers[0].urls[0] === "stun:a.example.com:3478" && servers[1].urls[0] === "stun:b.example.com:3478" && servers.every((server) => server.username === undefined && server.credential === undefined),
    JSON.stringify(servers),
  );
}

// ---- 4) 多条目顺序保留 ----
{
  const servers = resolveIceServersFromEntries([
    entry({ id: "a", kind: "stun", urls: "stun:s1:3478", credentialMode: "none", credential: null }),
    entry({ id: "b", urls: "turn:t1:3478", username: "u", credential: "p" }),
    entry({ id: "c", urls: "turn:t2:3478", credentialMode: "rest", credential: TURN_SECRET }),
  ]);
  check(
    "多条目按配置顺序输出（stun → static → rest）",
    servers.length === 3 && servers[0].urls[0] === "stun:s1:3478" && servers[1].username === "u" && USERNAME_RE.test(servers[2].username ?? ""),
    servers.map((server) => server.urls[0]).join(" | "),
  );
}

// ---- 5) 失败关闭：TURN 缺凭据被跳过 ----
{
  const servers = resolveIceServersFromEntries([entry({ credential: null })]);
  check("TURN 缺凭据时整条跳过（不下发连不上的中继）", servers.length === 0, `length=${servers.length}`);
}

// ---- 6) 失败关闭：空 urls 被跳过 ----
{
  const servers = resolveIceServersFromEntries([entry({ urls: "   ,  " })]);
  check("urls 为空时跳过", servers.length === 0, `length=${servers.length}`);
}

// ---- 7) turn + credentialMode none：只下发 urls ----
{
  const servers = resolveIceServersFromEntries([entry({ credentialMode: "none", credential: null, username: "" })]);
  check(
    "turn 且 credentialMode=none 时只下发 urls",
    servers.length === 1 && servers[0].username === undefined && servers[0].credential === undefined,
    JSON.stringify(servers[0]),
  );
}

// ---- 8) 无副作用：不改动入参数组 ----
{
  const input = [entry()];
  const before = JSON.stringify(input);
  resolveIceServersFromEntries(input);
  check("不修改入参数组", JSON.stringify(input) === before);
}

console.log("=== ② env 回退路径回归（resolveIceServers） ===");

// ---- 9) STUN 环境变量 ----
{
  const servers = resolveIceServers();
  check(
    "WEBSPEAK_STUN_URLS 逗号分隔时每条一个条目",
    servers.length === 2 && servers[0].urls[0] === "stun:127.0.0.1:19302",
    JSON.stringify(servers.map((server) => server.urls)),
  );
}

// ---- 10) TURN 环境变量仍走 REST ----
{
  const turn = resolveIceServers().find((server) => server.username !== undefined);
  check(
    "WEBSPEAK_TURN_* 仍产出 REST 临时凭据",
    Boolean(turn) && USERNAME_RE.test(turn.username) && turn.credential === expectedCredential(turn.username),
    turn ? turn.username : "(未找到 TURN 条目)",
  );
}

// ---- 11) 无 env 时回退内置公共 STUN ----
{
  const saved = process.env.WEBSPEAK_STUN_URLS;
  const savedUrls = process.env.WEBSPEAK_TURN_URLS;
  const savedSecret = process.env.WEBSPEAK_TURN_SECRET;
  delete process.env.WEBSPEAK_STUN_URLS;
  delete process.env.WEBSPEAK_TURN_URLS;
  delete process.env.WEBSPEAK_TURN_SECRET;
  const servers = resolveIceServers();
  check(
    "无环境变量时回退内置公共 STUN 且无 TURN",
    servers.length === 2 && servers.every((server) => server.username === undefined) && servers.every((server) => server.urls[0].startsWith("stun:")),
    JSON.stringify(servers.map((server) => server.urls[0])),
  );
  process.env.WEBSPEAK_STUN_URLS = saved;
  process.env.WEBSPEAK_TURN_URLS = savedUrls;
  process.env.WEBSPEAK_TURN_SECRET = savedSecret;
}

console.log("=== ③ 管理端持久化（AdminService + 临时 SQLite） ===");

const dir = mkdtempSync(join(tmpdir(), "webspeak-ice-"));
const dbPath = join(dir, "webspeak.db");
const masterSecret = loadOrCreateMasterSecret(join(dir, "master.key"));
const noopLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLogger; } };
const database = new WebSpeakDatabase(dbPath);
const admin = new AdminService(database, masterSecret, noopLogger, join(dir, "config.json"));

/** 一次完整的设置提交；iceServers 未给出即不触碰该表。 */
const submit = (overrides = {}) => admin.updateSettings({
  target: "127.0.0.1:9987",
  accessMode: "fixed",
  siteName: "WebSpeak",
  welcomeText: "",
  webRtcEnabled: false,
  relayNodes: [],
  ...overrides,
});

const expectReject = (name, code, run) => {
  try {
    run();
    check(name, false, "未抛出异常");
  } catch (error) {
    const actual = error instanceof AdminInputError ? error.code : `非 AdminInputError: ${error?.message}`;
    check(name, actual === code, `code=${actual}`);
  }
};

// ---- 12) 保存 static TURN 并解析 ----
{
  // The STUN entry deliberately gets an id that sorts after "ice-ext": the list
  // must come back in submitted order, not in id order. Every row written by one
  // save shares a created_at, so ordering by (created_at, id) would flip these two.
  submit({ iceServers: [{ kind: "stun", id: "ice-zzz-stun", urls: "stun:stun.example.com:3478", enabled: true }, entry({ id: "ice-ext", enabled: true })] });
  const servers = admin.getResolvedIceServers(generateTurnUserid());
  check(
    "保存后 getResolvedIceServers 返回 STUN + 静态 TURN",
    servers.length === 2 && servers[0].urls[0] === "stun:stun.example.com:3478" && servers[1].username === "user-1" && servers[1].credential === "pass-1",
    JSON.stringify(servers),
  );
  check(
    "条目顺序按提交顺序保留（不按 id 或时间戳排序）",
    servers[0].urls[0] === "stun:stun.example.com:3478" && servers[1].urls[0] === "turn:turn.example.com:3478?transport=udp",
    servers.map((server) => server.urls[0]).join(" | "),
  );
}

// ---- 12b) 顺序即偏好顺序：重排后必须原样返回 ----
// Placed after the credential/view checks because it rewrites the table with its
// own entries (the console submits the whole list on every save).
function checkOrderIsPreserved() {
  const first = { kind: "stun", id: "ice-order-a", urls: "stun:a.example.com:3478", enabled: true };
  const second = { kind: "stun", id: "ice-order-b", urls: "stun:b.example.com:3478", enabled: true };
  submit({ iceServers: [first, second] });
  const forward = admin.getResolvedIceServers().map((server) => server.urls[0]);
  submit({ iceServers: [second, first] });
  const reversed = admin.getResolvedIceServers().map((server) => server.urls[0]);
  check(
    "交换顺序后解析结果随之交换（顺序即浏览器偏好顺序）",
    forward[0] === "stun:a.example.com:3478" && reversed[0] === "stun:b.example.com:3478",
    `正序=${forward.join(",")} 反序=${reversed.join(",")}`,
  );
}

// ---- 13) 库内为密文 ----
{
  const row = database.listIceServers().find((item) => item.id === "ice-ext");
  const decrypted = row?.credentialEncrypted ? decryptSecret(row.credentialEncrypted, masterSecret) : null;
  check(
    "凭据在库内是 v1 密文且可解密回原值",
    Boolean(row?.credentialEncrypted?.startsWith("v1:")) && decrypted === "pass-1" && row.credentialEncrypted !== "pass-1",
    `stored=${String(row?.credentialEncrypted).slice(0, 12)}…`,
  );
}

// ---- 14) 视图不回传凭据 ----
{
  const view = admin.getAdminSettings().iceServers.find((item) => item.id === "ice-ext");
  check(
    "管理端视图只回 hasCredential，不含 credential/credentialEncrypted",
    view?.hasCredential === true && view?.credential === undefined && view?.credentialEncrypted === undefined,
    JSON.stringify(view),
  );
}

// ---- 15) 审计事件 ----
{
  const events = database.recentAudit(10);
  check("写入 ICE 配置产生 ICE_SERVERS_CHANGED 审计事件", events.some((event) => event.event === "ICE_SERVERS_CHANGED"), events.map((event) => event.event).join(","));
}

checkOrderIsPreserved();

// ---- 16) 清空列表回退 env ----
{
  submit({ iceServers: [] });
  const servers = admin.getResolvedIceServers();
  check(
    "清空 ice_servers 后回退环境变量（STUN + REST TURN）",
    database.listIceServers().length === 0 && servers.some((server) => server.urls[0] === "stun:127.0.0.1:19302") && servers.some((server) => server.username !== undefined),
    JSON.stringify(servers.map((server) => server.urls[0])),
  );
}

// ---- 17) 凭据三态：keep / replace / remove ----
{
  submit({ iceServers: [entry({ id: "ice-keep", enabled: true })] });
  const stored = database.listIceServers().find((item) => item.id === "ice-keep").credentialEncrypted;
  // keep：不带 credential 提交，密文不变
  submit({ iceServers: [entry({ id: "ice-keep", enabled: true, credential: undefined })] });
  const kept = database.listIceServers().find((item) => item.id === "ice-keep").credentialEncrypted;
  // replace：换一个新密码
  submit({ iceServers: [entry({ id: "ice-keep", enabled: true, credential: "pass-2" })] });
  const replaced = database.listIceServers().find((item) => item.id === "ice-keep").credentialEncrypted;
  const replacedPlain = decryptSecret(replaced, masterSecret);
  check(
    "credentialAction=keep 时密文保持不变",
    kept === stored,
    `keep=${kept === stored}`,
  );
  check(
    "credentialAction=replace 时换成新凭据",
    replaced !== stored && replacedPlain === "pass-2",
    `解密后=${replacedPlain}`,
  );
  // remove：清空凭据后（enabled 仍为 true）应被拒绝——static 模式必须有密码
  expectReject("credentialAction=remove 后 static 条目被拒绝（缺密码）", "INVALID_ICE_CREDENTIAL", () => {
    submit({ iceServers: [entry({ id: "ice-keep", enabled: true, credential: undefined, credentialAction: "remove" })] });
  });
  submit({ iceServers: [] });
}

console.log("=== ④ 校验拒绝 ===");

expectReject("非法 URL 前缀被拒绝", "INVALID_ICE_URLS", () => submit({ iceServers: [entry({ urls: "http://turn.example.com:3478" })] }));
expectReject("53 端口被拒绝（浏览器屏蔽）", "INVALID_ICE_URLS", () => submit({ iceServers: [entry({ urls: "turn:turn.example.com:53" })] }));
expectReject("turns: 带 transport=udp 被拒绝", "INVALID_ICE_URLS", () => submit({ iceServers: [entry({ urls: "turns:turn.example.com:5349?transport=udp" })] }));
expectReject("TURN 未选凭据方式被拒绝", "INVALID_ICE_CREDENTIAL_MODE", () => submit({ iceServers: [entry({ credentialMode: "none" })] }));
expectReject("static 模式缺用户名被拒绝", "INVALID_ICE_USERNAME", () => submit({ iceServers: [entry({ username: "" })] }));
expectReject("REST shared secret 少于 16 字符被拒绝", "INVALID_ICE_CREDENTIAL", () => submit({ iceServers: [entry({ credentialMode: "rest", username: "", credential: "short" })] }));
expectReject(
  `TTL 低于下限（${ICE_TTL_SECONDS_MIN}）被拒绝`,
  "INVALID_ICE_TTL",
  () => submit({ iceServers: [entry({ credentialMode: "rest", username: "", credential: TURN_SECRET, ttlSeconds: ICE_TTL_SECONDS_MIN - 1 })] }),
);
expectReject(
  `TTL 高于上限（${ICE_TTL_SECONDS_MAX}）被拒绝`,
  "INVALID_ICE_TTL",
  () => submit({ iceServers: [entry({ credentialMode: "rest", username: "", credential: TURN_SECRET, ttlSeconds: ICE_TTL_SECONDS_MAX + 1 })] }),
);
expectReject(
  `展开后超过 ${ICE_SERVER_MAX_ENTRIES} 条被拒绝`,
  "TOO_MANY_ICE_SERVERS",
  () => submit({
    iceServers: [
      { kind: "stun", urls: "stun:a:3478,stun:b:3478,stun:c:3478,stun:d:3478", enabled: true },
      { kind: "stun", urls: "stun:e:3478,stun:f:3478", enabled: true },
      { kind: "stun", urls: "stun:g:3478,stun:h:3478,stun:i:3478", enabled: true },
    ],
  }),
);
expectReject("重复的 ICE 条目 id 被拒绝", "INVALID_ICE_ID", () => submit({
  iceServers: [entry({ id: "ice-dup" }), entry({ id: "ice-dup", urls: "turn:other.example.com:3478" })],
}));
expectReject("静态凭据超过 512 字符被拒绝", "INVALID_ICE_CREDENTIAL", () => submit({ iceServers: [entry({ credential: "p".repeat(513) })] }));

// ---- 合法上界：恰好 8 条应被接受 ----
{
  let accepted = true;
  try {
    submit({
      iceServers: [
        { kind: "stun", urls: "stun:a:3478,stun:b:3478,stun:c:3478,stun:d:3478", enabled: true },
        { kind: "stun", urls: "stun:e:3478,stun:f:3478", enabled: true },
        { kind: "stun", urls: "stun:g:3478,stun:h:3478", enabled: true },
      ],
    });
  } catch {
    accepted = false;
  }
  check(`恰好 ${ICE_SERVER_MAX_ENTRIES} 条被接受（上界不误伤）`, accepted && admin.getResolvedIceServers().length === ICE_SERVER_MAX_ENTRIES, `accepted=${accepted}`);
  submit({ iceServers: [] });
}

console.log("=== ⑤ schema v7 → v8 迁移 ===");

// ---- 迁移：建表 + 旧数据保留 ----
{
  check("全新数据库 schemaVersion 为 8", database.schemaVersion === 8, `schemaVersion=${database.schemaVersion}`);
  submit({ iceServers: [entry({ id: "ice-migrate", enabled: true })] });
  database.close();
  // 把库降级回 v7 形态：删表 + 回写 user_version，模拟升级前的数据库。
  const legacy = new WebSpeakDatabase(dbPath);
  legacy.close();
  const raw = new WebSpeakDatabase(dbPath);
  raw.close();
  const { DatabaseSync } = await import("node:sqlite");
  const handle = new DatabaseSync(dbPath);
  handle.exec("DROP TABLE ice_servers; PRAGMA user_version = 7;");
  handle.close();
  const upgraded = new WebSpeakDatabase(dbPath);
  check(
    "v7 数据库重开后自动建出 ice_servers 表且 schemaVersion=8",
    upgraded.schemaVersion === 8 && Array.isArray(upgraded.listIceServers()) && upgraded.listIceServers().length === 0,
    `schemaVersion=${upgraded.schemaVersion}, rows=${upgraded.listIceServers().length}`,
  );
  check("迁移前生成的 .schema-7.bak 备份存在", existsSync(`${dbPath}.schema-7.bak`), `${dbPath}.schema-7.bak`);
  upgraded.close();
}

rmSync(dir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  ✗ ${item.name} — ${item.detail ?? ""}`);
  process.exitCode = 1;
}
