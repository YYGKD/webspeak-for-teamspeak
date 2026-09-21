/**
 * SpeakerRegistry 的行为验证 —— 重点回答 C3："超过 slot 数的人同时说话会怎样"。
 *
 * 背景：每个浏览器会话预分配 K 条 audio m-line（WEBSPEAK_SFU_SLOTS，默认 8），
 * 说话人被分配到空闲 slot 上转发。slot 用尽时的策略是"淘汰最久未活跃的说话人"。
 *
 * 这里要回答两个问题：
 *   1. 恰好 K 个说话人时，slot 是否稳定（不来回换）？
 *   2. 超过 K 个时，是"某个人被挤掉"还是"每帧都在互相挤"？后者会让
 *      assignSlot → replaceRTP 每帧触发一次，对端 jitter buffer 持续失稳。
 *
 * 用法：npx tsx scripts/speaker-registry-test.mjs
 */
import { SpeakerRegistry } from "../src/server/speaker-registry.js";

const FRAME = Buffer.alloc(40, 0x5a);
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 跑 n 轮，每轮让每个 clientId 各发一帧；返回 slot 归属的变化次数。 */
function runRoundRobin(registry, clientIds, ticks) {
  const owner = new Map();
  let reassignments = 0;
  const history = [];
  for (let tick = 0; tick < ticks; tick++) {
    for (const clientId of clientIds) {
      const result = registry.ingest(clientId, FRAME);
      if (!result) continue;
      if (owner.get(clientId) !== result.slot) {
        owner.set(clientId, result.slot);
        reassignments++;
      }
    }
    history.push(JSON.stringify(registry.snapshot()));
  }
  return { reassignments, owner, history };
}

// ---- 1) 恰好 K 个说话人：slot 应当稳定 ----
{
  const registry = new SpeakerRegistry(8);
  const { reassignments } = runRoundRobin(registry, [1, 2, 3, 4, 5, 6, 7, 8], 40);
  check("恰好 8 个说话人时 slot 稳定", reassignments === 8, `40 轮共 ${reassignments} 次归属变化（期望 8 = 每人首次分配）`);
}

// ---- 2) K+1 个说话人：会不会每帧互相挤？ ----
{
  const registry = new SpeakerRegistry(8);
  const { reassignments, history } = runRoundRobin(registry, [1, 2, 3, 4, 5, 6, 7, 8, 9], 40);
  const uniqueLayouts = new Set(history).size;
  const perTick = (reassignments / 40).toFixed(2);
  console.log(`   9 个说话人 / 8 个 slot：40 轮共 ${reassignments} 次归属变化（${perTick} 次/轮），布局 ${uniqueLayouts} 种`);
  // 修复前这里是 360 次（每帧一次）；修复后应当是 8 次（前 8 人各分配一次，
  // 第 9 人挤不进来被丢弃），布局稳定为 1 种。
  check("超过 K 个说话人时 slot 不再抖动", reassignments === 8 && uniqueLayouts === 1,
    `实际 ${reassignments} 次 / ${uniqueLayouts} 种布局（期望 8 次 / 1 种）`);
}

// ---- 2b) 有人停顿后，挤不进来的那个人应当接管他的 slot ----
{
  const registry = new SpeakerRegistry(8);
  const speakers = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const id of speakers) registry.ingest(id, FRAME);
  const quiet = registry.ingest(9, FRAME);
  check("大家都在说时第 9 人挤不进来（帧被丢弃）", quiet === null, `ingest(9) 返回 ${quiet === null ? "null" : "slot " + quiet.slot}`);
  // 让 client 1 静默超过淘汰门槛
  await new Promise((r) => setTimeout(r, 2100));
  for (const id of [2, 3, 4, 5, 6, 7, 8]) registry.ingest(id, FRAME);
  const taken = registry.ingest(9, FRAME);
  check("有人停顿后第 9 人接管其 slot", taken !== null && taken.slot === 0,
    `client1 占 slot 0 且已静默 >2s，client9 拿到 ${taken === null ? "null" : "slot " + taken.slot}`);
}

// ---- 3) 粘性：说话人持续说话就保住自己的 slot ----
{
  const registry = new SpeakerRegistry(8);
  const first = registry.ingest(42, FRAME);
  for (let i = 0; i < 50; i++) registry.ingest(42, FRAME);
  const again = registry.ingest(42, FRAME);
  check("同一说话人 slot 粘性", first.slot === again.slot, `slot ${first.slot} → ${again.slot}`);
}

// ---- 4) 静默超时后释放 slot ----
{
  const registry = new SpeakerRegistry(8, 30);
  const a = registry.ingest(1, FRAME);
  await new Promise((r) => setTimeout(r, 60));
  const b = registry.ingest(2, FRAME);
  check("静默超时后 slot 被回收给别人", a.slot === b.slot, `client1 用 slot ${a.slot}，静默 60ms(阈值 30ms) 后 client2 拿到 slot ${b.slot}`);
}

// ---- 5) 人数不足时不会误淘汰 ----
{
  const registry = new SpeakerRegistry(8);
  const { reassignments } = runRoundRobin(registry, [1, 2, 3], 40);
  check("3 个说话人时零抖动", reassignments === 3, `40 轮共 ${reassignments} 次（期望 3）`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) process.exitCode = 1;
