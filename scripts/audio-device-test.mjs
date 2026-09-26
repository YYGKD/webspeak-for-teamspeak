/**
 * S4-01 音频设备切换与原地换轨验收测试（web/src/composables/useVoiceWebSocket.ts）。
 *
 * 覆盖台账 T5 的 A2/A4 断言：
 *   A2 静态断言：用 awk 抽取 `setInputDevice` / `setNoiseSuppressionEnabled` 的
 *     真实函数体（带严格非空守卫，抽取为空即抛错，杜绝假阳性），断言两个函数体内
 *     不再出现 `stopWebRtcTransport` / `startWebRtcTransport` —— 换麦与降噪切换
 *     不再拆毁重建 WebRTC 传输层；并断言全文死函数
 *     `recoverAudioAfterFailedInputChange` 出现次数严格为 0。
 *   A4 单设备行为断言：在仅有一个设备（deviceId=`"default"`，等价 CI 无头或
 *     单麦/单扬声器场景）的内存桩下，直接执行上述 awk 抽出的**真实函数体**，验证：
 *       ① 换麦与降噪切换只调用原地换轨 `replaceWebRtcAudioTrack`（底层 replaceTrack），
 *          并支持基于当前 deviceId 的重入切换；
 *       ② 传输层拆建桩（全局陷阱）零调用，证明"只换轨、不重协商"；
 *       ③ 输出切换在 AudioContext 挂起时调用 `resume()`，sinkId 落到 `"default"`。
 *
 * 只读红线（规格 §10.1）：本脚本只读源码 + 内存桩，不连接任何生产服务，且脚本内
 * 不出现点号调用的 sendVoice 字面量，满足 `! grep -rqE "\.sendVoice\s*\(" scripts/`。
 *
 * 用法：npx tsx scripts/audio-device-test.mjs
 */
const { readFileSync } = await import("node:fs");
const { execFileSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");

const SOURCE_URL = new URL("../web/src/composables/useVoiceWebSocket.ts", import.meta.url);
const SOURCE_FILE = fileURLToPath(SOURCE_URL);
const source = readFileSync(SOURCE_URL, "utf8");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * 用 awk 按花括号深度抽取指定函数的**函数体**（不含签名行与最外层闭合括号）。
 *
 * 签名行计入起始深度；自签名之后逐行累加花括号净值，净值归零即到达函数末尾，
 * 该行（最外层闭合括号）不输出。目标函数体内不含字符串/注释花括号，深度计数可靠。
 */
function extractFunctionBody(fnName) {
  const program = String.raw`
BEGIN { started = 0; depth = 0 }
!started {
  if ($0 ~ /^[[:space:]]*(async[[:space:]]+)?function[[:space:]]+${fnName}\(/) { started = 1; line = $0; depth = gsub(/\{/, "{", line) - gsub(/\}/, "}", line); next }
  next
}
{
  d = gsub(/\{/, "{") - gsub(/\}/, "}")
  if (depth + d <= 0) exit
  depth += d
  print
}`.trim();
  const body = execFileSync("awk", [program, SOURCE_FILE], { encoding: "utf8" });
  const nonEmpty = body.split("\n").filter((line) => line.trim() !== "");
  // 非空守卫：抽取为空或近乎为空时明确抛错，防止"抽不到 → 断言恒真"的假阳性。
  if (nonEmpty.length <= 2) {
    throw new Error(`awk 抽取 ${fnName} 函数体失败：非空行仅 ${nonEmpty.length} 行（要求 > 2），拒绝假阳性`);
  }
  return { body, nonEmptyCount: nonEmpty.length };
}

/** 在内存桩作用域中执行抽出的真实函数体（体内含 await，故包一层 async IIFE）。 */
async function runFunctionBody(bodyText, scope, args = {}) {
  const bound = { ...scope, ...args };
  const names = Object.keys(bound);
  const factory = new Function(...names, `return (async () => {\n${bodyText}\n})();`);
  return await factory(...names.map((name) => bound[name]));
}

// 传输层拆建全局陷阱：真实函数体若回退到旧逻辑，自由标识符会命中这些桩并计数。
const transportTraps = { stop: 0, start: 0 };
globalThis.stopWebRtcTransport = () => { transportTraps.stop += 1; };
globalThis.startWebRtcTransport = async () => { transportTraps.start += 1; };

try {
  // ───────────────────── A2 awk 抽取与函数体静态断言 ─────────────────────
  console.log("=== A2 awk 抽取与换轨函数体静态断言 ===");
  const inputBody = extractFunctionBody("setInputDevice");
  const noiseBody = extractFunctionBody("setNoiseSuppressionEnabled");
  const replaceBody = extractFunctionBody("replaceWebRtcAudioTrack");

  check("awk 抽取 setInputDevice 函数体（非空守卫通过）", inputBody.nonEmptyCount > 2,
    `非空 ${inputBody.nonEmptyCount} 行`);
  check("awk 抽取 setNoiseSuppressionEnabled 函数体（非空守卫通过）", noiseBody.nonEmptyCount > 2,
    `非空 ${noiseBody.nonEmptyCount} 行`);
  check("抽取结果为函数体本身（已剔除签名行）",
    !inputBody.body.includes("function setInputDevice") && !noiseBody.body.includes("function setNoiseSuppressionEnabled"),
    "签名行未混入");

  for (const [name, extracted] of [["setInputDevice", inputBody], ["setNoiseSuppressionEnabled", noiseBody]]) {
    const banned = ["stopWebRtcTransport", "startWebRtcTransport"].filter((token) => extracted.body.includes(token));
    check(`${name} 函数体内零 stopWebRtcTransport / startWebRtcTransport`, banned.length === 0,
      banned.length ? `残留=${banned.join(", ")}` : "零残留");
    check(`${name} 函数体显式调用原地换轨 replaceWebRtcAudioTrack`,
      extracted.body.includes("replaceWebRtcAudioTrack"), "只换轨、不重协商");
  }

  const deadCount = source.split("recoverAudioAfterFailedInputChange").length - 1;
  check("全文死函数 recoverAudioAfterFailedInputChange 出现次数严格为 0", deadCount === 0, `出现 ${deadCount} 次`);

  check("原地换轨函数 replaceWebRtcAudioTrack 调用 micProducer.replaceTrack({ track })",
    /replaceTrack\(\s*\{\s*track:/.test(replaceBody.body), "换轨 API 契约");

  // ───────────────────── A4 单设备行为断言（真实函数体 + 内存桩）─────────────────────
  console.log("\n=== A4 单设备/当前 deviceId 行为断言 ===");

  {
    // 单设备环境：唯一输入设备 deviceId = "default"；连续两次切到同一设备模拟重入。
    const inputCalls = [];
    const storageWrites = [];
    const selectedInputDeviceId = { value: "default" };
    const inputScope = {
      micStream: { id: "single-mic" },
      micProducer: { closed: false },
      selectedInputDeviceId,
      localStorage: { setItem: (key, value) => storageWrites.push([key, value]) },
      saveAudioPreferences: async () => {},
      startMicrophone: async () => { inputCalls.push("startMicrophone"); },
      replaceWebRtcAudioTrack: async () => { inputCalls.push("replaceTrack"); },
      refreshAudioDevices: async () => {},
      setMicrophoneError: (error) => { inputCalls.push(`error:${error?.message ?? error}`); },
    };
    await runFunctionBody(inputBody.body, inputScope, { deviceId: "default" });
    await runFunctionBody(inputBody.body, inputScope, { deviceId: "default" });
    const replaceCount = inputCalls.filter((call) => call === "replaceTrack").length;
    check("单设备换麦两次均触发原地换轨 replaceTrack（重入切换）",
      replaceCount === 2 && !inputCalls.some((call) => call.startsWith("error:")),
      `replaceTrack=${replaceCount}, calls=[${inputCalls.join(",")}]`);
    check("单设备换麦零传输层拆建（全局陷阱）",
      transportTraps.stop === 0 && transportTraps.start === 0,
      `stop=${transportTraps.stop}, start=${transportTraps.start}`);
    check("单设备换麦后 deviceId 落库且未回滚",
      selectedInputDeviceId.value === "default" && storageWrites.at(-1)?.[1] === "default",
      `deviceId=${selectedInputDeviceId.value}, writes=${storageWrites.length}`);
  }

  {
    // 单设备环境：降噪开关切换与同值重入幂等。
    const nsCalls = [];
    const noiseSuppressionEnabled = { value: false };
    const noiseScope = {
      noiseSuppressionEnabled,
      saveAudioPreferences: async () => {},
      micStream: { id: "single-mic" },
      startMicrophone: async () => { nsCalls.push("startMicrophone"); },
      micProducer: { closed: false },
      replaceWebRtcAudioTrack: async () => { nsCalls.push("replaceTrack"); },
      setMicrophoneError: (error) => { nsCalls.push(`error:${error?.message ?? error}`); },
    };
    await runFunctionBody(noiseBody.body, noiseScope, { enabled: true });
    const replaceAfterFirst = nsCalls.filter((call) => call === "replaceTrack").length;
    const before = nsCalls.length;
    await runFunctionBody(noiseBody.body, noiseScope, { enabled: true });
    check("单设备开启降噪触发一次原地换轨 replaceTrack",
      noiseSuppressionEnabled.value === true && replaceAfterFirst === 1, `calls=[${nsCalls.join(",")}]`);
    check("同值重入被幂等短路（不重复换轨）", nsCalls.length === before, `新增调用=${nsCalls.length - before}`);
    check("降噪切换零传输层拆建（全局陷阱）",
      transportTraps.stop === 0 && transportTraps.start === 0,
      `stop=${transportTraps.stop}, start=${transportTraps.start}`);
  }

  {
    // 单设备环境：唯一输出设备 deviceId = "default"，AudioContext 处于挂起态。
    const outputDeviceBody = extractFunctionBody("setOutputDevice");
    const sinkIds = [];
    const outputCalls = [];
    let resumeCount = 0;
    const ctx = { state: "suspended", resume: async () => { resumeCount += 1; outputCalls.push("resume"); } };
    const outputScope = {
      selectedOutputDeviceId: { value: "" },
      outputDevices: [{ deviceId: "default" }],
      getAudioCtx: () => ctx,
      setAudioSink: async (_ctx, deviceId) => { sinkIds.push(deviceId); },
      applySpeakerSink: (deviceId) => outputCalls.push(`applySpeakerSink:${deviceId}`),
      syncAudioContextNotice: () => {},
      saveAudioPreferences: async () => {},
      localStorage: { setItem: () => {} },
    };
    await runFunctionBody(outputDeviceBody.body, outputScope, { deviceId: "default" });
    check("单设备输出切换在 AudioContext 挂起时调用 resume()",
      resumeCount === 1 && outputCalls.includes("resume"), `resume=${resumeCount}`);
    check("单设备输出切换 sinkId 落到当前设备 \"default\"",
      sinkIds.length === 1 && sinkIds[0] === "default", `sinkIds=[${sinkIds.join(",")}]`);
  }
} catch (error) {
  console.error(`\n✗ 测试执行中断：${error instanceof Error ? error.stack : String(error)}`);
  results.push({ name: "测试执行未中断", ok: false, detail: String(error) });
} finally {
  delete globalThis.stopWebRtcTransport;
  delete globalThis.startWebRtcTransport;
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  process.exitCode = 1;
}
