/**
 * T5 单元测试：TURN 凭据派生规范 + 双 Cookie 纯模块。
 *
 * 两组套件：
 *   ① TURN 凭据规范（src/server/ice-credentials.ts）
 *      - generateTurnUserid(rawSuffix?) 对「合法 12 位 hex / 缺省 / 非法输入」
 *        恒满足 /^webspeak_[0-9a-f]{12}$/，且缺省时每次随机独立。
 *      - resolveIceServers(userid?) 的 username 严格为 `<过期 unix 秒>:<userid>`，
 *        credential 与 HMAC-SHA1(static-auth-secret, username) 一致；无 `:webspeak`
 *        死命名字面量残留。
 *   ② Cookie 纯模块（src/server/http-cookies.ts）
 *      - 直接从纯模块导入，彻底避开 server.ts 对 opus / werift 原生模块的间接依赖。
 *      - readVisitorNumberCookie / readDeviceIdCookie 的解析与校验边界。
 *      - collectPublicConfigCookies 的双 Cookie 数组化协议（长度恰好 2、互不覆盖）。
 *
 * 用法：npx tsx scripts/turn-credentials-test.mjs
 */

// 验收标准 #2：用例执行前显式设置环境变量（动态 import 保证先于模块求值）。
process.env.WEBSPEAK_TURN_URLS = "turn:127.0.0.1:3478";
process.env.WEBSPEAK_TURN_SECRET = "test_secret_123456";

const { createHmac } = await import("node:crypto");
const { generateTurnUserid, resolveIceServers } = await import("../src/server/ice-credentials.ts");
const {
  VISITOR_NUMBER_COOKIE,
  WEBSPEAK_DEVICE_COOKIE,
  readVisitorNumberCookie,
  readDeviceIdCookie,
  collectPublicConfigCookies,
} = await import("../src/server/http-cookies.ts");

const TURN_SECRET = "test_secret_123456";
const DEFAULT_TTL_SECONDS = 1800;
const USERID_RE = /^webspeak_[0-9a-f]{12}$/;
const USERNAME_RE = /^\d{10}:webspeak_[0-9a-f]{12}$/;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 从 username `<expiry>:<userid>` 中拆出两段；格式不符返回 null。 */
function splitUsername(username) {
  const match = /^(\d+):(.*)$/.exec(username ?? "");
  return match ? { expiry: Number(match[1]), userid: match[2] } : null;
}

/** 计算 coturn REST 方案下的期望凭据。 */
const expectedCredential = (username) => createHmac("sha1", TURN_SECRET).update(username).digest("base64");

console.log("=== ① TURN 凭据派生规范（src/server/ice-credentials.ts） ===");

// ---- 1) generateTurnUserid：合法 12 位 hex 原样采用 ----
{
  const suffix = "0123456789ab";
  const uid = generateTurnUserid(suffix);
  check("generateTurnUserid(合法12位hex) 原样拼接", uid === `webspeak_${suffix}`, `得到 ${uid}`);
}

// ---- 2) generateTurnUserid：缺省 / 非法输入一律回退随机且严格匹配正则 ----
{
  const invalidInputs = [
    ["缺省 undefined", undefined],
    ["空串", ""],
    ["大写 hex", "0123456789AB"],
    ["11 位", "0123456789a"],
    ["13 位", "0123456789abc"],
    ["含非 hex 字符", "0123456789zz"],
    ["带 webspeak_ 前缀（应视作非法裸串）", "webspeak_0123456789ab"],
  ];
  const outcomes = invalidInputs.map(([label, raw]) => {
    const uid = generateTurnUserid(raw);
    const ok = USERID_RE.test(uid) && uid !== `webspeak_${raw}`;
    return { label, uid, ok };
  });
  const allOk = outcomes.every((o) => o.ok);
  check(
    "generateTurnUserid(缺省/非法输入) 回退随机且匹配 /^webspeak_[0-9a-f]{12}$/",
    allOk,
    outcomes.map((o) => `${o.label}→${o.uid}`).join("；"),
  );
}

// ---- 3) generateTurnUserid：缺省时随机独立（连续两次不同） ----
{
  const a = generateTurnUserid();
  const b = generateTurnUserid();
  check("generateTurnUserid() 连续两次随机独立", a !== b && USERID_RE.test(a) && USERID_RE.test(b), `${a} vs ${b}`);
}

// ---- 4) resolveIceServers：STUN 恒在，TURN 追加为末条 ----
{
  const servers = resolveIceServers();
  const turnEntries = servers.filter((s) => s.urls.some((u) => u.startsWith("turn:")));
  const stunEntries = servers.filter((s) => s.urls.every((u) => u.startsWith("stun:")));
  check(
    "resolveIceServers() 含 STUN 且追加唯一 TURN 条目",
    stunEntries.length >= 1 && turnEntries.length === 1 && servers[servers.length - 1] === turnEntries[0],
    `${servers.length} 条：STUN ${stunEntries.length}，TURN ${turnEntries.length}`,
  );
  check(
    "TURN 条目 urls 取自 WEBSPEAK_TURN_URLS",
    turnEntries[0]?.urls.length === 1 && turnEntries[0].urls[0] === "turn:127.0.0.1:3478",
    JSON.stringify(turnEntries[0]?.urls),
  );
}

// ---- 5) resolveIceServers：username 格式 <expiry>:<userid> + 默认 TTL ----
{
  const before = Math.floor(Date.now() / 1000);
  const [turn] = resolveIceServers().filter((s) => s.urls.some((u) => u.startsWith("turn:")));
  const parsed = splitUsername(turn?.username);
  const expectedExpiry = before + DEFAULT_TTL_SECONDS;
  check(
    "username 严格匹配 <10位过期秒>:<webspeak_12位hex>",
    parsed !== null && USERNAME_RE.test(turn.username),
    `username=${turn?.username}`,
  );
  check(
    "过期时间为 now + 默认 TTL(1800s)",
    parsed !== null && Math.abs(parsed.expiry - expectedExpiry) <= 5,
    `expiry=${parsed?.expiry}，期望≈${expectedExpiry}`,
  );
}

// ---- 6) resolveIceServers：credential 与 HMAC-SHA1 校验一致 ----
{
  const [turn] = resolveIceServers().filter((s) => s.urls.some((u) => u.startsWith("turn:")));
  const expect = expectedCredential(turn.username);
  check(
    "credential = base64(HMAC-SHA1(secret, username))",
    turn.credential === expect && /^[A-Za-z0-9+/]{27}=$/.test(turn.credential),
    `credential=${turn.credential}`,
  );
}

// ---- 7) resolveIceServers(userid)：合法 userid 透传复用 ----
{
  const uid = generateTurnUserid("deadbeefcafe");
  const [turn] = resolveIceServers(uid).filter((s) => s.urls.some((u) => u.startsWith("turn:")));
  const parsed = splitUsername(turn.username);
  check(
    "resolveIceServers(合法 userid) 透传复用该 userid",
    parsed !== null && parsed.userid === uid && USERNAME_RE.test(turn.username),
    `userid=${parsed?.userid}，期望 ${uid}`,
  );
}

// ---- 8) resolveIceServers()：未传参时每次随机独立 userid ----
{
  const uidOf = (servers) => splitUsername(servers.filter((s) => s.urls.some((u) => u.startsWith("turn:")))[0]?.username)?.userid;
  const a = uidOf(resolveIceServers());
  const b = uidOf(resolveIceServers());
  check(
    "resolveIceServers() 每次签发独立随机 userid",
    a !== undefined && b !== undefined && a !== b && USERID_RE.test(a) && USERID_RE.test(b),
    `${a} vs ${b}`,
  );
}

// ---- 9) 无 `:webspeak` 死命名字面量残留 ----
{
  const [turn] = resolveIceServers().filter((s) => s.urls.some((u) => u.startsWith("turn:")));
  const parsed = splitUsername(turn.username);
  const hasDeadLiteral =
    turn.username.endsWith(":webspeak") || !parsed || parsed.userid === "webspeak" || !USERID_RE.test(parsed.userid);
  check(
    "username 无旧死命名 `:webspeak` 残留（userid 恒为 webspeak_<hex>）",
    !hasDeadLiteral,
    `username=${turn.username}`,
  );
}

// ---- 10) 边界：配置了 URL 但缺 secret 时失败关闭，不下发 TURN ----
{
  const saved = process.env.WEBSPEAK_TURN_SECRET;
  delete process.env.WEBSPEAK_TURN_SECRET;
  const servers = resolveIceServers();
  const hasTurn = servers.some((s) => s.urls.some((u) => u.startsWith("turn:")));
  process.env.WEBSPEAK_TURN_SECRET = saved;
  check("边界：缺 secret 失败关闭（仅 STUN）", hasTurn === false, `TURN 条目数=${hasTurn ? 1 : 0}`);
}

// ---- 11) 边界：WEBSPEAK_TURN_TTL_SECONDS 生效 ----
{
  const saved = process.env.WEBSPEAK_TURN_TTL_SECONDS;
  process.env.WEBSPEAK_TURN_TTL_SECONDS = "300";
  const before = Math.floor(Date.now() / 1000);
  const [turn] = resolveIceServers().filter((s) => s.urls.some((u) => u.startsWith("turn:")));
  const parsed = splitUsername(turn?.username);
  if (saved === undefined) delete process.env.WEBSPEAK_TURN_TTL_SECONDS;
  else process.env.WEBSPEAK_TURN_TTL_SECONDS = saved;
  check(
    "边界：TTL 环境变量生效（300s）",
    parsed !== null && Math.abs(parsed.expiry - (before + 300)) <= 5,
    `expiry=${parsed?.expiry}，期望≈${before + 300}`,
  );
}

console.log("\n=== ② Cookie 纯模块（src/server/http-cookies.ts） ===");

const VALID_DEVICE_ID = "0123456789abcdef0123456789abcdef";

// ---- 12) 常量名锁定 ----
check(
  "Cookie 名常量锁定",
  VISITOR_NUMBER_COOKIE === "webspeak_visitor_number" && WEBSPEAK_DEVICE_COOKIE === "webspeak_device_id",
  `${VISITOR_NUMBER_COOKIE} / ${WEBSPEAK_DEVICE_COOKIE}`,
);

// ---- 13) readVisitorNumberCookie 正常解析 ----
{
  const cases = [
    ["单条", "webspeak_visitor_number=42", 42],
    ["夹在其他 Cookie 之间", "a=1; webspeak_visitor_number=7; b=2", 7],
    ["值带空格", "webspeak_visitor_number= 8 ", 8],
    ["前导零", "webspeak_visitor_number=007", 7],
  ];
  const outcomes = cases.map(([label, header, want]) => ({ label, got: readVisitorNumberCookie(header), want }));
  check(
    "readVisitorNumberCookie 正常解析",
    outcomes.every((o) => o.got === o.want),
    outcomes.map((o) => `${o.label}:${o.got}`).join("；"),
  );
}

// ---- 14) readVisitorNumberCookie 非法输入一律 null ----
{
  const cases = [
    ["undefined", undefined],
    ["空串", ""],
    ["缺失该 Cookie", "other=1"],
    ["非数字", "webspeak_visitor_number=abc"],
    ["零（非正）", "webspeak_visitor_number=0"],
    ["负数", "webspeak_visitor_number=-5"],
    ["超出安全整数", "webspeak_visitor_number=99999999999999999999"],
  ];
  const outcomes = cases.map(([label, header]) => ({ label, got: readVisitorNumberCookie(header) }));
  check(
    "readVisitorNumberCookie 非法输入返回 null",
    outcomes.every((o) => o.got === null),
    outcomes.map((o) => `${o.label}:${o.got}`).join("；"),
  );
}

// ---- 15) readDeviceIdCookie 正常解析 ----
{
  const cases = [
    ["单条", `webspeak_device_id=${VALID_DEVICE_ID}`],
    ["夹在其他 Cookie 之间", `a=1; webspeak_device_id=${VALID_DEVICE_ID}; b=2`],
    ["值带空格", `webspeak_device_id= ${VALID_DEVICE_ID} `],
  ];
  const outcomes = cases.map(([label, header]) => ({ label, got: readDeviceIdCookie(header) }));
  check(
    "readDeviceIdCookie 正常解析 32 位 hex",
    outcomes.every((o) => o.got === VALID_DEVICE_ID),
    outcomes.map((o) => `${o.label}:${o.got === VALID_DEVICE_ID ? "ok" : o.got}`).join("；"),
  );
}

// ---- 16) readDeviceIdCookie 非法输入一律 null ----
{
  const cases = [
    ["undefined", undefined],
    ["空串", ""],
    ["缺失该 Cookie", "other=1"],
    ["大写 hex", "webspeak_device_id=0123456789ABCDEF0123456789ABCDEF"],
    ["31 位", "webspeak_device_id=0123456789abcdef0123456789abcde"],
    ["33 位", "webspeak_device_id=0123456789abcdef0123456789abcdef0"],
    ["含非 hex 字符", "webspeak_device_id=0123456789abcdef0123456789abcde z"],
  ];
  const outcomes = cases.map(([label, header]) => ({ label, got: readDeviceIdCookie(header) }));
  check(
    "readDeviceIdCookie 非法输入返回 null",
    outcomes.every((o) => o.got === null),
    outcomes.map((o) => `${o.label}:${o.got}`).join("；"),
  );
}

// ---- 17) collectPublicConfigCookies：双 Cookie 数组化，长度恰好 2、互不覆盖 ----
{
  const cookies = collectPublicConfigCookies({ visitorNumber: 5, deviceId: VALID_DEVICE_ID });
  const combined = cookies.join(", ");
  const ok =
    cookies.length === 2 &&
    cookies[0] === `${VISITOR_NUMBER_COOKIE}=5; Max-Age=31536000; Path=/; SameSite=Lax` &&
    cookies[1] === `${WEBSPEAK_DEVICE_COOKIE}=${VALID_DEVICE_ID}; Max-Age=31536000; Path=/; SameSite=Lax` &&
    combined.includes(VISITOR_NUMBER_COOKIE) &&
    combined.includes(WEBSPEAK_DEVICE_COOKIE);
  check("collectPublicConfigCookies 返回长度恰好 2 且互不覆盖", ok, JSON.stringify(cookies));
}

// ---- 18) collectPublicConfigCookies：secure 追加 Secure ----
{
  const cookies = collectPublicConfigCookies({ visitorNumber: 9, deviceId: VALID_DEVICE_ID, secure: true });
  check(
    "secure:true 时两条均追加 ; Secure",
    cookies.length === 2 && cookies.every((c) => c.endsWith("; Secure")),
    JSON.stringify(cookies),
  );
}

// ---- 19) collectPublicConfigCookies：按需下发（0~2 条） ----
{
  const onlyVisitor = collectPublicConfigCookies({ visitorNumber: 3 });
  const onlyDevice = collectPublicConfigCookies({ deviceId: VALID_DEVICE_ID });
  const none = collectPublicConfigCookies({ visitorNumber: null, deviceId: null });
  const undefinedParams = collectPublicConfigCookies({});
  check(
    "按需下发：单条 / 单条 / 空数组",
    onlyVisitor.length === 1 &&
      onlyVisitor[0].startsWith(`${VISITOR_NUMBER_COOKIE}=`) &&
      onlyDevice.length === 1 &&
      onlyDevice[0].startsWith(`${WEBSPEAK_DEVICE_COOKIE}=`) &&
      none.length === 0 &&
      undefinedParams.length === 0,
    `visitor=${onlyVisitor.length}，device=${onlyDevice.length}，null=${none.length}，未传=${undefinedParams.length}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exitCode = 1;
}
