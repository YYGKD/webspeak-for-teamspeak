/**
 * TeamSpeak 只读侦察 + 音频源计数。
 *
 * 目的：确定 SFU 的 slot 数 K —— 需要知道"同时有多少个音频源"。
 * 做法：以观察者身份加入频道，统计收到的 voiceData 来自多少个不同的 clientId。
 *
 * 用法：
 *   node scripts/ts-recon.mjs [host:port] [nickname] [channelName]
 *   OBSERVE_MS=60000 node scripts/ts-recon.mjs
 */
import { Client, generateIdentity, clientMove } from "@echosixhiya/teamspeak-client";

const target = process.argv[2] ?? "47.116.35.38:9987";
const nickname = process.argv[3] ?? "WebSpeak-Recon";
const channelId = process.argv[4]; // 频道 ID（数字），不传则留在默认位置
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 30_000);

const client = new Client(generateIdentity(8), target, nickname, {
  serverPassword: "",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

let frames = 0;
const bySource = new Map();
client.on("voiceData", ({ clientId, data }) => {
  frames++;
  const e = bySource.get(clientId) ?? { frames: 0, bytes: 0 };
  e.frames++; e.bytes += data.length;
  bySource.set(clientId, e);
});

await client.connect();
await client.waitConnected(AbortSignal.timeout(15000));
console.log(`✓ 已连接 ${target}  昵称=${nickname}  clid=${client.clientID()}  cid=${client.channelID()}`);

// 显式入频道 —— 语音是频道内转发的，cid=0（不在任何频道）收不到任何东西
if (channelId) {
  try {
    await clientMove(client, client.clientID(), BigInt(channelId));
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`  已移动到 cid=${client.channelID()}`);
  } catch (e) {
    console.log(`  ✗ 移动失败: ${e?.message ?? e}`);
  }
}
console.log();

// 频道/成员列表需要权限，普通客户端通常没有 —— 失败不中断
for (const cmd of ["channellist", "clientlist"]) {
  try {
    const rows = await client.execCommandWithResponse(cmd, 8000);
    console.log(`${cmd}: ${rows.length} 条`);
    for (const r of rows.slice(0, 20)) {
      const label = r.channel_name ?? r.client_nickname ?? JSON.stringify(r).slice(0, 60);
      console.log(`  ${label}  (${JSON.stringify(r).slice(0, 90)})`);
    }
  } catch (e) {
    console.log(`${cmd}: 权限不足（${e?.id ?? "?"}）— 预期行为`);
  }
}

console.log(`\n观察 ${OBSERVE_MS / 1000} 秒…`);
await new Promise((r) => setTimeout(r, OBSERVE_MS));

console.log(`\n========== 结果 ==========`);
console.log(`总帧数: ${frames}`);
console.log(`音频源数: ${bySource.size}   ← 这就是 K 的下界`);
if (bySource.size) {
  console.log(`\n每源明细（满速 ≈ ${(OBSERVE_MS / 20).toFixed(0)} 帧）:`);
  for (const [id, e] of [...bySource].sort((a, b) => b[1].frames - a[1].frames)) {
    const duty = ((e.frames / (OBSERVE_MS / 20)) * 100).toFixed(0);
    console.log(`  clid=${id}  ${e.frames} 帧  ${(e.bytes / 1024).toFixed(1)}KB  占空比≈${duty}%`);
  }
} else {
  console.log("\n未收到任何音频 —— 频道里没人说话，或观察者不在说话人的频道");
}

await client.disconnect();
process.exit(0);
