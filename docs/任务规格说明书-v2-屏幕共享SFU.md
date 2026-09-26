# 任务规格说明书 v3（终审放行版）

**题目**：WebSpeak 屏幕共享接入 mediasoup SFU 视频流中央分发（方案 B 落地）
**版本**：v3.0（依据第二轮对抗性复审 7 项修复清单终审修订，替代 v2）
**日期**：2026-09-25
**状态**：终审放行 —— 可进入实施

---

## 0. 修订说明

### 0.1 v3 相对 v2 的变更（二审 7 项修复点）

| # | 级别 | 缺陷 | v3 修复要点 |
|---|---|---|---|
| R1 | 阻断 | `pipeToRouter` 默认 `keepId: true`：同 Worker 内管道 Producer 复用源 ID（mediasoup 3.27.1 `Router.js:623` `keepId ? producer.id : utils.generateUUIDv4()`），与源 Producer 的 Worker 级 ID 冲突必抛错 | 显式传 `{ producerId, router: viewerSession.router, keepId: false }`；管道 Producer ID 为新 UUID，与源不同（§5.2）；同步修正 §2/§3/§5.5/§8.3 表述与断言 |
| R2 | 阻断 | §5.2 管道缓存以「整记录」粒度命中：视频先 pipe 后，后续系统音频到达时被缓存整体挡住，观众永远收不到音频 | 缓存改为**按轨道独立补齐（merge）**：视频、音频分别判缺、分别 pipe、合并写回（§5.2） |
| R3 | 高 | 同一观众并发请求（join + list + 推送竞态）导致 double-pipe | `ensureScreenSharePipe` 增加 in-flight Promise 去重：缓存与 Promise 表双闸（§5.2，H7 强化） |
| R4 | 高 | §5.8/§6.3 引用不存在的 mediasoup-client 事件 `producerclose` | 修正为真实事件：`consumer.on("trackended", ...)` 与 `consumer.on("@close", ...)`，辅以服务端 `screenShareVideoClosed` / `screenShareStopped` 信令驱动清理（§5.8、§6.3、§7） |
| R5 | 高 | §8.4 `npm run web:build` 实际为 `cd web && npx vite build`，**不含** `vue-tsc` 类型检查 | 前端验收命令明确为 `npm --prefix web run build`（`vue-tsc --noEmit && vite build`，见 `web/package.json`）；删去「全仓库统一」表述（§8.1、§8.4、§10） |
| R6 | 中 | §5.5 `screenShareList` 对每条流 eager pipe：仅浏览列表即为每条流建立管道，资源浪费且与 D2「惰性」矛盾 | `screenShareList` 应答**不执行** pipe、不填 producer 字段；仅在观众实际 `screenShareJoin` 或收到 `screenShareProducers` 推送时惰性 pipe（§5.5）；§8.3 增加走真实 `mediaProduce` 分流、断言 `attachUpstreamPipeline` 未被触达的脚本级验证 |
| R7 | 中 | 前端 `mediaClient` 未就绪时 consume 时序未定义；`ScreenShareStream` 接口扩充未显式列出；红线 #3「不新增端口」与同 Worker PipeTransport 的关系含糊 | §6.2/§6.3 增加 `mediaClient` 就绪守卫（`await mediaClient.ensureRecvReady()`）；§4/§6 显式列出 `ScreenShareStream` 接口扩充（`videoProducerId?` / `audioProducerId?`）与 `upsertScreenShareStream` 同步透传；红线 #3 澄清「严禁新增对外公网监听端口，mediasoup 既有 Worker 内部回环 PipeTransport 除外」（§6.5、§9） |

### 0.2 v2 相对 v1 的变更（一审 B1–B4 / H1–H9，沿用保留）

| 编号 | 缺陷 | 修订要点 |
|---|---|---|
| B1 | 跨 Router 分发机制缺失 | `router.pipeToRouter()` 跨 Router 管道分发（§5.2，v3 修正 keepId 语义） |
| B2 | 屏幕系统音频未支持 | 发起端双轨 Produce（screen-video + screen-audio），观众端双轨 Consume 组装 `MediaStream`（§5.4、§6.2、§6.3） |
| B3 | 屏幕流误入 TS3 上行管线；media-client 未纳入改动范围 | `mediaProduce` 显式分流；`MediaProduceOptions` 增加 `encodings`；`web/src/services/media-client.ts` 纳入 §4（§5.3、§6.1） |
| B4 | 测试命令不统一、codec 断言过期 | 脚本统一 `npx tsx scripts/xxx.mjs`；更新 `media-worker-test.mjs` 断言（§8） |
| H1 | 迟到观众拿不到 Producer 句柄 | `ScreenShareStreamDescription` 扩展 `videoProducerId?` / `audioProducerId?`（按观众解析的 pipe Producer ID）（§5.5） |
| H2 | Web 观众误触发发起端 P2P Offer | Web 观众 `screenShareJoin` 不再向发起端下发 `screenShareViewerJoined`（§5.6） |
| H3 | 广播作用域与排除语义不清 | 复用 `broadcastScreenMessage()`，锁定 `targetKey + channelId`，显式 `excludeEntryId: ownerEntryId`（§5.7） |
| H4 | 停止共享/推流关闭时观众端悬挂 | Producer 级联关闭 + 服务端信令驱动观众端清理（§5.8，v3 修正客户端事件名） |
| H5 | 码率天花板路径不统一 | 统一以 `screenShareBitrateCeiling()` + `MediaClient.produce` 的 `encodings` 为准（§6.2） |
| H6 | 断线/重连清理缺口 | entry 断开、换频道时级联清理 pipe 状态与观众名册（§5.8） |
| H7 | 重复 join / 重复 pipe 未去重 | 按轨道幂等缓存 + in-flight Promise 去重双闸（§5.2，v3 强化） |
| H8 | 规模与资源上限未定义 | 单流观众软上限 32，超限返回 `SCREEN_SHARE_VIEWER_LIMIT_REACHED`（§5.9） |
| H9 | 浏览器自动播放策略阻塞 | 观众端拉流后显式 `resumeConsumer`（§6.3） |

---

## 1. 背景与目标

### 1.1 现状

- Web 客户端间的屏幕共享目前走 **P2P mesh**：每位观众与发起端各建一条 `RTCPeerConnection`，服务端仅做 `screenShareSignal` 信令转发（`src/server/voice-bridge.ts` `relayScreenShareSignal`）。发起端上行带宽随观众数线性增长，是已验证的瓶颈。
- 原生 TS6 观众通过 `respondjoinstreamrequest` / `streamsignaling` 与发起端建立 P2P（peerId 形如 `ts-viewer-<clid>`），该路径由 TeamSpeak 协议规定，**不在本次改造范围**。
- 语音媒体面已是 mediasoup SFU：每个 `WebClientEntry` 惰性建立独立 `MediaSession`（独立 `Router`，`voice-bridge.ts:315`），所有会话共享**同一个 mediasoup Worker**；`MEDIA_CODECS` 当前仅声明 `audio/opus`（`src/server/media-worker.ts:65`）。

### 1.2 目标

Web 观众收看 Web 发起端的屏幕共享时，改走 mediasoup SFU 中央分发：

1. 发起端的屏幕视频/音频经现有 `sendTransport` 上行到其 `Router`；
2. 服务端用 `router.pipeToRouter({ keepId: false })` 把屏幕 Producer 管道到每位观众的 `Router`；
3. 观众在自己的 `recvTransport` 上 consume 管道 Producer，收双轨流；
4. 原生 TS6 观众的 P2P 路径保持原样，回归为零。

### 1.3 非目标

- 不改造原生 TS6 屏幕共享的收看/发布协议路径。
- 不引入 Simulcast/SVC 多层分发（单 encoding + 码率天花板即可，见 H5）。
- 不改动 TS3 语音上行管线（`UpstreamAudioPipeline`）的任何行为。

---

## 2. 总体架构

```
发起端 entry (owner)                          观众 entry (viewer) xN
┌─────────────────────┐                      ┌──────────────────────┐
│ getDisplayMedia()   │                      │ recvTransport        │
│  ├─ video track ────┼─ produce ─► Router A ══ pipeToRouter ═► Router B ─► consume ─► video track ┐
│  └─ audio track ────┼─ produce ─► (screen-video/audio)   (keepId:false,            consume ─► audio track ┤
└─────────────────────┘                       新 UUID PipeProducer)                   └► MediaStream([v,a]) ─► <video>
        │                                                                             ▲
        │  同一 mediasoup Worker（pipeToRouter 前置条件）                                │ resumeConsumer 解锁播放（H9）
        ▼
  screen Producer 不进入 attachUpstreamPipeline（TS3 语音管线，B3）
```

要点：

- **单 Worker 前提**：pipeToRouter 要求源/目标 Router 在同一 Worker（否则需 `listenInfo`/`listenIp` 等 RTC 管道参数）。当前 `ensureMediaSession` 用全局唯一 Worker 建 Router，前提天然满足；本规格禁止引入第二个 Worker（见 §9 红线 #3）。
- **`keepId: false` 强制项（R1）**：同 Worker 管道必须显式传 `keepId: false`。默认值 `true` 会让管道 Producer 复用源 Producer ID（mediasoup 3.27.1 实测 `Router.js:623`），与源 Producer 的 Worker 级唯一 ID 冲突而抛错。因此管道 Producer ID **一律为新 UUID、与源 ID 不同**。
- **每观众一条管道**：pipeToRouter 在目标 Router 上生成新的 PipeProducer（新 UUID）。因此观众实际 consume 的 producerId 是**按观众解析的**，服务端在 `screenShareJoined` 应答与 `screenShareProducers` 推送中按请求者填充（H1，§5.5）。
- **信令复用**：下行订阅完全复用现有 `mediaConsume` / `mediaConsumerResume` 命令，不新增媒体信令类型；屏幕共享域新增 `screenShareProducers` 与 `screenShareVideoClosed` 两条定向消息（§7）。

---

## 3. 关键设计决策

### D1：pipeToRouter 而非共享 Router

保留「每客户端一个 Router」的隔离语义（`MediaSession` 注释明确：共享 Router 会让一个会话的 Producer 泄漏到另一个会话的 rtpCapabilities 视图）。pipeToRouter 是 mediasoup 官方多 Router 互通标准，管道 Producer 只出现在被显式管道的观众 Router 上，不扩大任何 rtpCapabilities 视图。

### D2：Producer ID 按观众解析，而非全局广播源 ID

`transport.consume({ producerId })` 要求 Producer 位于该 transport 所属 Router 上。源 Producer 在发起端 Router，观众无法直接 consume；且 `keepId: false` 下管道 Producer ID 为每条管道独立生成的新 UUID（R1）。因此 `ScreenShareStreamDescription.videoProducerId/audioProducerId` 的语义定义为「**对当前请求者可见的（管道后）Producer ID**」，由服务端在定向应答/推送时惰性 pipe 并填充；广播消息与列表接口中该两字段一律缺省（详见 §5.5）。

### D3：屏幕流与语音流共用 sendTransport，靠 appData 分流

不新建 transport。屏幕双轨复用发起端既有 `sendTransport`，以 `appData.mediaType`（`"screen-video"` / `"screen-audio"`）与 `kind === "video"` 双重判据在服务端的 `mediaProduce` 处分流（B3，§5.3）。

### D4：观众端 Consumer 清理以真实事件 + 服务端信令双驱动（R4）

mediasoup-client 的 `Consumer` **没有** `producerclose` 事件。可用事实：

- 对端 Producer 关闭导致本端 Consumer 被服务端关闭时，Consumer 触发 `"@close"`（内部通知，mediasoup-client 文档公开的 observer 事件）；
- 媒体轨实际结束时，Consumer 触发 `"trackended"`；
- 服务端掌握全部级联语义，可定向推送 `screenShareVideoClosed` / `screenShareStopped`。

观众端清理以 `consumer.on("@close")` / `consumer.on("trackended")` 为本地兜底，以服务端定向信令为主驱动，双保险（§6.3）。

---

## 4. 文件改动范围

| 文件 | 改动性质 | 内容摘要 |
|---|---|---|
| `src/server/media-worker.ts` | 修改 | `MEDIA_CODECS` 增加 `video/VP8`（§5.1） |
| `src/server/screen-share.ts` | 修改 | `ScreenShareStreamDescription` 扩展 `videoProducerId?` / `audioProducerId?`；新增 `screenShareProducers` / `screenShareVideoClosed` 定向消息类型（§5.5、§7） |
| `src/server/voice-bridge.ts` | 修改 | mediaProduce 分流（B3）、pipeToRouter 分发（B1/R1/R2/R3）、join/广播行为（H1–H3）、级联清理（H4/H6/R4）、幂等与上限（H7/H8） |
| `src/constants.ts` | 修改 | 新增 `SCREEN_SHARE_MAX_WEB_VIEWERS`（H8，§5.9） |
| `web/src/services/media-client.ts` | 修改 | `MediaProduceOptions` 增加 `encodings?: types.RtpEncodingParameters[]`（B3/H5，§6.1）；新增/导出 recv 方向就绪守卫 `ensureRecvReady()`（R7，§6.1） |
| `web/src/composables/useVoiceWebSocket.ts` | 修改 | 发起端双轨 produce（B2/H5）、观众端 SFU 订阅与双轨组装（B2/H9/R4）、Web 观众 P2P 路径下线（H2）、状态机（§6.4）、**`ScreenShareStream` 接口扩充与 `upsertScreenShareStream` 同步透传（R7，§6.5）** |
| `scripts/media-worker-test.mjs` | 修改 | codec 断言从 `MEDIA_CODECS.length === 1` 平滑更新为按 audio/video 注册情况检查（B4，§8.2） |
| `scripts/screen-share-sfu-test.mjs` | 新增 | pipeToRouter 分发（`keepId:false` 断言）+ TS3 管线隔离（真实 `mediaProduce` 分流路径）的脚本级验证（§8.3） |

明确**不改**：`src/server/speaker-producer-map.ts`（只订阅 audio，增加 video codec 后无行为变化）、TS6 原生流相关代码路径、`UpstreamAudioPipeline`。

---

## 5. 服务端改动详述（`voice-bridge.ts` / `screen-share.ts` / `media-worker.ts` / `constants.ts`）

### 5.1 `MEDIA_CODECS` 增加 video/VP8

在 `src/server/media-worker.ts:65` 的数组中追加：

```ts
{
  kind: "video",
  mimeType: "video/VP8",
  clockRate: 90000,
  rtcpFeedback: [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "ccm", parameter: "fir" },
    { type: "goog-remb" },
    { type: "transport-cc" },
  ],
},
```

- 选 VP8 与前端既有 `preferScreenShareCodecs` 的偏好一致，保持 P2P 与 SFU 两条路径的 codec 一致。
- 音频 codec 声明（`audio/opus` 48000/2 PT=111）逐字节保持不变；TS3 语音链路的 SDP 语义不受影响。
- 该变更属 §9 红线 #3 修订后的允许项：仅在既有 Worker 的 codec 声明内扩展，不新增 Worker/进程/对外端口。

### 5.2 跨 Router 分发：pipeToRouter（B1、R1、R2、R3、H7）

`ScreenStreamRecord` 扩展：

```ts
interface ScreenStreamRecord extends ScreenShareStreamDescription {
  // ……既有字段……
  /** 发起端 Router 上的源 Producer ID（尚未推流时为 undefined）。 */
  sfuVideoProducerId?: string;
  sfuAudioProducerId?: string;
  /**
   * viewerEntryId → 该观众 Router 上的管道 Producer ID。
   * 按轨道独立存放（R2）：视频与音频可分别就绪、分别补齐。
   */
  pipedByViewerEntryId: Map<string, { videoProducerId?: string; audioProducerId?: string }>;
}

/** (streamId, viewerEntryId) → 进行中的 pipe Promise（R3 并发去重闸）。 */
private screenSharePipeInflight = new Map<string, Promise<{ videoProducerId?: string; audioProducerId?: string } | null>>();
```

分发函数（新私有方法）：

```ts
private async ensureScreenSharePipe(
  stream: ScreenStreamRecord,
  viewerEntryId: string,
): Promise<{ videoProducerId?: string; audioProducerId?: string } | null>
```

语义（严格按序）：

1. **R3 并发去重**：以 `${stream.streamId}:${viewerEntryId}` 为 key 查 `screenSharePipeInflight`：命中则直接 `await` 并返回同一 Promise 结果（同观众并发 join/推送/重试共享一次 pipe，杜绝 double-pipe）。未命中则将后续步骤包装为 Promise 写入该表，`finally` 中删除。
2. 若 `stream.sfuVideoProducerId` 缺失（发起端尚未推流）→ 返回 `null`（观众进入等待态，见 §5.5）。
3. **R2 按轨道独立补齐（merge）**，取代 v2 的整记录缓存命中即返回：
   - 取既有缓存 `const cached = stream.pipedByViewerEntryId.get(viewerEntryId)`；
   - **视频轨**：若 `cached?.videoProducerId` 缺失 → 执行 pipe（见下），成功后将 `videoProducerId` 合并写入缓存；
   - **音频轨**：若 `stream.sfuAudioProducerId` 存在且 `cached?.audioProducerId` 缺失 → 执行音频 pipe，成功后合并写入缓存；
   - 两轨均有缓存则零调用直接返回。**「视频先推、音频后到」场景下，第二次调用只会补 pipe 音频轨**（R2 修复点）。
4. 单轨 pipe 实现（R1，`keepId: false` 为强制项）：

   ```ts
   // 确保观众媒体会话存在：entry.media 为 null 时复用 ensureMediaSession(entry, …)
   // 惰性建立（观众可能未开语音、尚未建 Router）。
   const { pipeProducer } = await ownerSession.router.pipeToRouter({
     producerId: sourceProducerId,          // sfuVideoProducerId 或 sfuAudioProducerId
     router: viewerSession.router,
     keepId: false,                          // R1：同 Worker 下默认 true 必与源 ID 冲突抛错
   });
   // pipeProducer.id 为新 UUID，与源 Producer ID 不同。
   ```

5. 返回合并后的 `{ videoProducerId?, audioProducerId? }`。
6. 失败处理：pipe 抛错 → 清理本次已生成的半成品 PipeProducer（`pipeProducer.close()`）、**不写入缓存**（保留下次重试能力）、记日志、向该观众回 `screenShareError`（`SCREEN_SHARE_PIPE_FAILED`），**不影响**其他观众与发起端；in-flight 表条目在 `finally` 中正常移除。

幂等性论证（H7）：重复 `pipeToRouter` 同一 (producer, router) 对会抛错；本函数靠「按轨道缓存命中 + in-flight Promise 去重」双闸保证任意并发/重复调用下至多 pipe 一次/轨。

`pipeToRouter` 在同 Worker 内为纯内存回环 PipeTransport，无对外端口、无新进程，符合修订后红线 #3（§9）。

### 5.3 `mediaProduce` 分流：隔离 TS3 上行管线（B3）

在 `mediaProduce` 分支（`voice-bridge.ts:1422` 起）中，`transport.produce()` 成功之后、`attachUpstreamPipeline` 之前插入显式判据：

```ts
const mediaType = (command.payload.appData as Record<string, unknown> | undefined)?.mediaType;
const isScreenShare =
  mediaType === "screen-video" ||
  mediaType === "screen-audio" ||
  producer.kind === "video";
```

- `isScreenShare === true`：
  - **严禁**调用 `attachUpstreamPipeline`——只有麦克风语音流允许进入 TS3 音频管线。`session.upstreams` 不出现屏幕 Producer 条目。
  - **跳过** `entry.microphoneMuted` / `entry.accompanimentActive` 的 appData 初值回写（这两字段仅描述麦克风状态）。
  - 调用新方法 `registerScreenShareProducer(entry, producer, mediaType)`：
    - 依 `appData.streamId` 定位 `ScreenStreamRecord`，校验 `stream.ownerEntryId === entry.id`，否则回 `screenShareError`（`SCREEN_SHARE_NOT_OWNER`）并 `producer.close()`；
    - 写入 `sfuVideoProducerId` / `sfuAudioProducerId`；
    - 对 `stream.viewerEntryIds` 中每位观众 `ensureScreenSharePipe`（走 §5.2 的 merge 语义，后到音频自动补 pipe，R2），成功后向该观众定向发送 `screenShareProducers`（§7，解决「观众先到、推流后到」及「视频先到、音频后到」两个时序场景，H1/R2）。
- `isScreenShare === false`：行为与现状逐行一致（挂上行管线）。

### 5.4 屏幕系统音频（B2，服务端侧）

- `screen-audio` Producer 与 `screen-video` 走完全相同的 pipe/consume 路径，无特判；`stream.audio === false` 时 `sfuAudioProducerId` 恒缺省，观众端按单轨处理。
- TS3 侧不发布屏幕音频轨道（不进 `UpstreamAudioPipeline` 已保证），原生 TS6 观众的音频仍由既有 `publishBrowserScreenStream` 路径承载，本次不改动。

### 5.5 迟/早到观众的 Producer 句柄（H1、R6）

`src/server/screen-share.ts` 的 `ScreenShareStreamDescription` 扩展：

```ts
export interface ScreenShareStreamDescription {
  // ……既有字段……
  /**
   * 对**当前请求者**可见的 SFU Producer ID（pipeToRouter keepId:false 之后、位于请求者
   * Router 上的 PipeProducer，新 UUID）。仅 browser 来源、已推流、且已为该请求者
   * 惰性 pipe 时存在；广播消息与 screenShareList 应答中一律缺省（R6）。
   */
  videoProducerId?: string;
  audioProducerId?: string;
}
```

- `describeScreenStream` 拆为两态：
  - **广播态**（`screenShareStarted` / `screenShareStopped` 等广播）：不填 producer 字段（broadcast 无法对每个接收者给不同 ID，填了就是错的）。
  - **定向态**（新方法 `describeScreenStreamForViewer(stream, viewerEntryId)`，async）：调用 `ensureScreenSharePipe` 后填充该观众的管道 Producer ID。**仅用于 `screenShareJoin` 的 `screenShareJoined` 应答**——「实际观看」是唯一触发惰性 pipe 的入口。
- **R6：`screenShareList` 收敛为纯列表**：应答直接复用广播态描述，**不执行** eager pipe、不填 producer 字段。理由：浏览列表不等于观看，为每条列出流建管道是纯浪费且放大 `SCREEN_SHARE_PIPE_FAILED` 面。观众从列表点击观看时走 `screenShareJoin` → 定向态应答，一次往返拿到 pipe 后的 ID，时序与 v2 等价（均无需额外往返）。
- 观众端因此**无需任何额外往返**：`screenShareJoined` 到手即可直接 `mediaConsume`（H1 验收点）。
- 若定向态下 `ensureScreenSharePipe` 返回 `null`（发起端未推流），字段缺省，观众进入等待态，待 §5.3 的 `screenShareProducers` 推送。

### 5.6 Web 观众不再触发发起端 P2P（H2）

- `screenShareJoin` 处理中删除向发起端发送 `screenShareViewerJoined` 的分支（现 `voice-bridge.ts:1663-1669`）。该消息此后**仅可能在原生 TS 观众路径出现**（peerId 以 `ts-viewer-` 前缀，由 TS 通知驱动，见 `buildNativeViewerPeerId`，`voice-bridge.ts:2450`），Web 观众的 join 对发起端完全静默。
- `screenShareSignal` 转发收窄（`relayScreenShareSignal`）：
  - browser 来源流：保留 `owner <-> ts-viewer-*` 的原生观众转发；
  - **拒绝** Web 观众 → 发起端（及反向）的 P2P 信令，回 `screenShareError`（`SCREEN_SHARE_SIGNAL_FORBIDDEN`，message 提示该流已走 SFU）。发起端前端同步删除对 Web 观众 offer 的应答逻辑（§6.4），双保险。
- 前端既有的 `screenShareNativeViewerJoined` → `startNativeScreenShareViewer` 路径原样保留。

### 5.7 广播作用域与排除语义（H3）

- 所有屏幕共享生命周期广播（`screenShareStarted` / `screenShareStopped` / `screenShareViewerCount` 及后续新增）**只允许**经 `broadcastScreenMessage()` 发出——该函数已锁定 `targetKey + channelId` 双作用域（`voice-bridge.ts:1767`），禁止新增旁路遍历 `this.entries` 的发送。
- `screenShareStarted` 广播显式传 `excludeEntryId: stream.ownerEntryId`（现状已如此，固化为规范）：发起端自身的卡片状态由其请求应答（`screenShareStarted owner:true`）承载，不依赖广播。
- 按观众的 Producer 通知（`screenShareProducers`）与关闭通知（`screenShareVideoClosed`）一律 `sendToEntry` 定向发送，**不得广播**（ID 是按观众解析的，广播即串号）。

### 5.8 生命周期与级联清理（H4、H6、R4）

| 事件 | 清理动作 |
|---|---|
| 发起端关闭 screen Producer（track.stop → transportclose/@close） | mediasoup 自动级联关闭各观众 Router 上的 PipeProducer 及其 Consumer；服务端在源 Producer 的 `close` 监听中：① 清空 `sfuVideoProducerId` / `sfuAudioProducerId` 与所有 `pipedByViewerEntryId` 对应轨字段；② 向每位观众**定向**发送 `screenShareVideoClosed`（视频轨）或更新后的 `screenShareProducers`（仅音频轨关闭、视频仍在时）驱动前端清理（R4，§7）。前端本地再以 `consumer.on("@close")` / `consumer.on("trackended")` 兜底（§6.3） |
| `screenShareStop` / `stopScreenStream` | 在既有逻辑前增加：主动 `close()` 两个源 Producer（触发上述级联），清空 `pipedByViewerEntryId` 与该 stream 的全部 in-flight 条目；再执行既有 TS6 `stopstream`、广播 `screenShareStopped`、名册清理 |
| 观众 entry 断开 / 换频道 | 复用既有 `leaveScreenStream` / `reconcileScreenShareAfterClientMove` 挂接点：从 `viewerEntryIds` 与 `pipedByViewerEntryId` 移除该 entry，清理其 in-flight 条目；其 Router 随 `closeMediaSession` 关闭，PipeProducer 自动消亡 |
| 发起端 entry 断开 | 走既有「owner 离开 → `stopScreenStream(stream, "owner-disconnected")`」路径，级联同上 |
| 发起端语音 Producer（麦克风）关闭 | 与屏幕 Producer 无关，**不得**误清屏幕状态（靠 appData/kind 判据区分） |

### 5.9 规模上限（H8）

- 每位观众产生 1–2 对 PipeTransport 端点与 1–2 个 PipeProducer；N 观众即 N 倍。设单流 Web 观众软上限 **32**：
  - `screenShareJoin` 时 `stream.viewerEntryIds.size >= 32` → 回 `screenShareError`（`SCREEN_SHARE_VIEWER_LIMIT_REACHED`）；
  - 上限值放入 `src/constants.ts` 命名常量 `SCREEN_SHARE_MAX_WEB_VIEWERS`，便于调参。
- 本规格不引入 LRU 淘汰；超限即拒绝，行为可预期。

---

## 6. 前端改动详述（`media-client.ts` / `useVoiceWebSocket.ts`）

### 6.1 `MediaProduceOptions` 扩展与 recv 就绪守卫（B3、H5、R7）

`web/src/services/media-client.ts:40`：

```ts
export interface MediaProduceOptions {
  track: MediaStreamTrack;
  appData?: types.AppData;
  codecOptions?: types.ProducerCodecOptions;
  /** 透传给 transport.produce()，用于码率/帧率天花板（屏幕共享 H5）。 */
  encodings?: types.RtpEncodingParameters[];
}
```

`MediaClient.produce`（:177）将 `encodings` 原样透传至 `transport.produce({...})`。信令层接口不变（encodings 经 mediasoup-client 协商后体现在 `rtpParameters.encodings` 内，随既有 `mediaProduce` 消息上行）。

**R7 就绪守卫**：新增（或导出既有惰性流程的）公开方法：

```ts
/** 确保 recv 方向媒体会话就绪（device 加载 + recvTransport 建立）。幂等，可并发调用。 */
async ensureRecvReady(): Promise<void>
```

`consume(producerId)` 的契约明确为「调用前必须 `await ensureRecvReady()`」，由调用方（§6.3）负责；`consume` 内部对未就绪状态直接抛错而非静默等待，避免悬挂。send 方向对称地以既有惰性建连流程为准（§6.2 在 produce 前显式 await，下同）。

### 6.2 发起端：双轨 Produce + 统一码率天花板（B2、H5、R7）

`startScreenShare` 流程改为：

1. `getDisplayMedia({ video: true, audio: <系统音频开关> })`；
2. 发送 `screenShareStart`（`audio` 标志按实际音轨存在与否上报）；
3. 收到 `screenShareStarted owner:true`（含 `streamId`）后，**先确保 send 方向媒体会话就绪（R7 就绪守卫：`mediaClient` 存在且 sendTransport 已建立，复用既有惰性建连流程并 await 其完成）**，再：

   ```ts
   const settings = videoTrack.getSettings();
   const ceiling = screenShareBitrateCeiling(settings.width ?? null, settings.height ?? null);
   await mediaClient.produce({
     track: videoTrack,
     appData: { mediaType: "screen-video", streamId },
     encodings: [{
       maxBitrate: ceiling,
       ...(frameRate ? { maxFramerate: frameRate } : {}),
     }],
   });
   if (audioTrack) {
     await mediaClient.produce({
       track: audioTrack,
       appData: { mediaType: "screen-audio", streamId },
     });
   }
   ```

4. **码率天花板统一口径（H5）**：SFU 路径的码率上限**只**由 `screenShareBitrateCeiling()`（`useVoiceWebSocket.ts:2529`，阶梯保持不变）经 `encodings.maxBitrate` 表达；不再对该轨道调用 `RTCRtpSender.setParameters`（`applyScreenShareSenderParameters` 仅保留给原生 TS 观众 P2P 路径）。「保帧率」语义以 `videoTrack.contentHint = "motion"` 表达（`degradationPreference` 是 `RTCRtpSender` 概念，mediasoup-client 无对应入口）。
5. codec 偏好 `preferScreenShareCodecs` 对 SFU 路径无需调用——VP8 由 Router codec 列表与 `produce` 协商保证。

### 6.3 观众端：SFU 订阅、双轨组装、显式 resume（B2、H9、R4、R7）

`startScreenShareViewer(stream)` 对 `stream.source === "browser"` 改为：

1. 若 `stream.videoProducerId` 缺省 → 置「等待推流」态（UI 显示「等待对方开始推流…」），等 `screenShareProducers` 消息到达后补 ID 续走下列步骤；
2. **R7 就绪守卫**：`await mediaClient.ensureRecvReady()`（幂等；未开语音的观众在此惰性建立 recv 会话；`mediaClient` 本身未初始化时同样在此等待初始化完成，未就绪绝不调用 `consume`）；
3. consume 视频：

   ```ts
   const videoConsumer = await mediaClient.consume(stream.videoProducerId);
   await mediaClient.resumeConsumer(videoConsumer); // H9：解锁浏览器播放
   ```

4. 若 `stream.audioProducerId` 存在，同样 consume + resume 音频；
5. 组装与挂载（B2 验收点）：

   ```ts
   const tracks = [videoConsumer.track, ...(audioConsumer ? [audioConsumer.track] : [])];
   screenShareRemoteStream.value = new MediaStream(tracks);
   ```

   `<video>` 元素 `srcObject` 直接挂该流——音画同元素，**`<video>` 原生音量控制即屏幕声音控制**，无额外 AudioContext；
6. **R4 Consumer 清理（真实事件，替换 v2 不存在的 `producerclose`）**：
   - `consumer.on("trackended", ...)`：媒体轨结束 → 从 `MediaStream` 移除对应 track；视频轨结束则退出观看态并清理；
   - `consumer.on("@close", ...)`：Consumer 被关闭（含服务端级联关闭 PipeProducer 触发的连锁关闭）→ 同上清理，作为服务端信令丢失时的本地兜底；
   - 服务端定向 `screenShareVideoClosed`：主驱动，关闭并释放对应 Consumer、退出观看态（视频轨场景）；
   - 服务端 `screenShareStopped`：整流结束 → 关闭全部 Consumer、退出观看态（既有逻辑保留）。
7. 原生 TS 来源（`stream.source === "teamspeak"`）的 P2P 观看路径原样保留。

### 6.4 状态机与 P2P 下线（H1、H2）

- Web 观众相关 P2P 代码下线：
  - 删除/停用 `screenShareJoined` 分支中创建 `RTCPeerConnection` 的逻辑（`startScreenShareViewer` 的 browser 分支整体替换为 §6.3）；
  - 发起端删除对 Web 观众 offer 的应答（`handleScreenShareSignal` 中非 `ts-viewer-` 前缀的 offer 直接忽略并告警）；
  - `screenSharePeerStreams` / `screenSharePeers` 等 P2P 状态仅服务于 `ts-viewer-` 原生观众，加注释明确边界（最小改动：只加注释，不重命名）。
- 观看态状态机明确为：`idle → joining → waiting-producer? → consuming → playing → (stopped|failed) → idle`；`waiting-producer` 由 `screenShareProducers` 或 `screenShareStopped` 迁出，避免悬挂。

### 6.5 `ScreenShareStream` 接口扩充与 store 同步（R7）

`web/src/composables/useVoiceWebSocket.ts:137` 的 `ScreenShareStream` 接口显式扩充，与 §5.5 服务端描述对齐：

```ts
export interface ScreenShareStream {
  streamId: string;
  source: "browser" | "teamspeak";
  ownerPeerId: string;
  ownerClientId?: number;
  ownerNickname: string;
  name: string;
  audio: boolean;
  createdAt: number;
  viewerCount: number;
  viewers: ScreenShareViewer[];
  /** 对本端可见的 SFU 管道 Producer ID（仅 screenShareJoined / screenShareProducers 定向消息携带）。 */
  videoProducerId?: string;
  audioProducerId?: string;
}
```

- `upsertScreenShareStream`（:2838）同步透传两字段（与既有可选字段同风格的条件展开）。**注意** `screenShareList` / 广播消息不含该字段（R6），upsert 不得用缺省值覆盖已持有的定向 ID——对已有条目采用「仅在新值存在时更新」的合并语义，列表/广播刷新不丢已 pipe 的句柄。
- `screenShareProducers` 消息处理：按 `streamId` 定位条目后仅合并更新 `videoProducerId?` / `audioProducerId?` 两字段（不重建整条），若当前处于 `waiting-producer` 态则驱动状态机续走 §6.3。

---

## 7. 协议消息变更

| 消息 | 方向 | 变更 |
|---|---|---|
| `screenShareJoined` | S→C（定向） | `stream` 内新增 `videoProducerId?` / `audioProducerId?`（对请求者解析后的管道 Producer ID，新 UUID） |
| `screenShareList` | S→C（定向应答） | **R6 收敛**：不携带 producer 字段、不触发 pipe；其余字段不变 |
| `screenShareProducers`（新增） | S→C（定向） | `{ type, streamId, videoProducerId?, audioProducerId? }`：发起端开始推流（或补推音频）时，向已加入观众逐个定向推送其管道 Producer ID |
| `screenShareVideoClosed`（新增，R4） | S→C（定向） | `{ type, streamId }`：源屏幕视频 Producer 关闭（级联关闭该观众的 PipeProducer/Consumer 之后）定向通知，驱动前端清理视频轨 |
| `screenShareStarted`（广播） | S→C | 不带 producer 字段；其余不变；`excludeEntryId: ownerEntryId` 固化为规范 |
| `screenShareViewerJoined` | S→C | **Web 观众 join 不再下发**；仅原生 TS 观众（`ts-viewer-`）路径保留等价通知（`screenShareNativeViewerJoined`） |
| `screenShareSignal` | C↔S | browser 来源流仅转发 `owner <-> ts-viewer-*`；Web 观众 P2P 信令拒绝（`SCREEN_SHARE_SIGNAL_FORBIDDEN`） |
| `screenShareError` | S→C | 新增错误码：`SCREEN_SHARE_PIPE_FAILED`、`SCREEN_SHARE_VIEWER_LIMIT_REACHED` |
| `mediaProduce` | C→S | `appData` 约定新增 `mediaType: "screen-video" \| "screen-audio"` 与 `streamId`；服务端按 §5.3 分流 |
| `mediaConsume` / `mediaConsumerResume` | C→S | 无变更，直接复用 |

---

## 8. 测试规范与验收（B4、R1、R5、R6）

### 8.1 命令规范

- 仓库根目录 Node 脚本一律以 **`npx tsx scripts/xxx.mjs`** 运行，禁止 `node` 直跑（与 `package.json` 中 `dev: tsx` 的加载器口径一致）。
- **前端构建命令单列（R5）**：`npm --prefix web run build`——该脚本为 `vue-tsc --noEmit && vite build`（见 `web/package.json`），**包含**类型检查；不得用 `npm run web:build`（根 `package.json` 中该脚本仅 `cd web && npx vite build`，跳过 vue-tsc）作为验收依据。

本规格涉及的命令：

```bash
npx tsx scripts/media-worker-test.mjs        # codec 注册断言（已更新）
npx tsx scripts/screen-share-sfu-test.mjs    # 新增：SFU 分发验证
npx tsx scripts/upstream-pipeline-test.mjs   # 回归：TS3 上行管线不受屏幕流影响
npx tsx scripts/mediasoup-e2e.mjs            # 回归：语音 SFU 端到端
npm run build                                # 服务端 tsc
npm --prefix web run build                   # 前端：vue-tsc --noEmit && vite build（R5）
```

### 8.2 `scripts/media-worker-test.mjs` 断言更新

将 `MEDIA_CODECS.length === 1 && declared.kind === "audio" && …`（现 :77-91）平滑更新为按注册情况检查：

- 存在且仅存在一条 `kind === "audio"` 声明：`mimeType === "audio/opus"`、`clockRate === 48000`、`channels === 2`、`preferredPayloadType === 111`（原断言语义逐条保留）；
- 存在且仅存在一条 `kind === "video"` 声明：`mimeType === "video/VP8"`、`clockRate === 90000`；
- 不再对 `MEDIA_CODECS.length` 的具体数值下断言（允许后续合法扩展，但 audio/video 各一条是本规格的注册基线）。

### 8.3 新增 `scripts/screen-share-sfu-test.mjs`

脚本级验证（真实 mediasoup Worker，内存内完成，不经 WebSocket）：

1. 建 Worker + 两个 Router（模拟 owner / viewer）；
2. owner Router 上用 DirectTransport 造 video + audio 两个测试 Producer（`appData.mediaType` 分别为 `screen-video` / `screen-audio`）；
3. **R1 断言**：`pipeToRouter({ producerId, router: viewerRouter, keepId: false })` 成功；断言 `pipeProducer.id !== sourceProducer.id`（新 UUID）；补充对照断言：同 Worker 下省略 `keepId`（默认 `true`）对同一 (producer, router) 重复 pipe 抛错，固化「必须显式 `keepId: false`」的防回归；
4. viewer Router 上 consume 两个 PipeProducer，断言 `kind` 正确、rtpParameters 可解码；
5. **R2 断言**：视频 pipe 完成后单独补 pipe 音频（模拟「视频先推、音频后到」），断言两次调用各自生成独立 PipeProducer、互不阻塞（对应 `ensureScreenSharePipe` 的 merge 语义）；
6. **R6/B3 断言**：走与 `mediaProduce` 相同的分流判据函数（从 `voice-bridge.ts` 导出或复制最小实现并注释同步义务），对 `mediaType: "screen-video" | "screen-audio"` 与 `kind === "video"` 的输入断言分流结果为 screen（**不触达** `attachUpstreamPipeline` 路径，跳过上行管线挂载）；对麦克风音频输入断言分流结果为 voice（**触达**上行管线）——等价于断言 `session.upstreams.size === 0` 的服务端不变量；
7. 关闭源 Producer，断言 PipeProducer/Consumer 级联关闭（H4）。

### 8.4 构建与类型（R5）

- `npm run build`（服务端 tsc）零错误零新增告警。
- `npm --prefix web run build`（前端 `vue-tsc --noEmit && vite build`）零错误零新增告警——类型检查与产物构建同为验收门槛。

---

## 9. 红线约束（修订版）

1. 不改动 TS3 语音上行/下行数据面语义；麦克风流是唯一允许进入 `UpstreamAudioPipeline` 的流。
2. 不改动原生 TS6 屏幕共享协议路径（`requeststreaminfo` / `respondjoinstreamrequest` / `streamsignaling` 等）。
3. **（R7 澄清）** 严禁新增 mediasoup Worker、进程，**严禁新增任何对外/公网监听端口**，严禁引入外部 SFU 组件；**允许**在既有 Worker 内部创建 Router 间内存回环管道（`pipeToRouter` / PipeTransport，不经网络监听）与既有 Router 的 codec 声明扩展（新增 `video/VP8`）。
4. 信令协议向后兼容：旧客户端收到带 `videoProducerId` 的描述可安全忽略；但旧服务端 + 新前端组合不作保证（前后端同版本发布）。
5. 广播一律经 `broadcastScreenMessage()`（targetKey + channelId 作用域），按观众的 Producer/关闭通知只定向发送。

---

## 10. 验收清单（DoD）

- [ ] B1/R1：3 个模拟客户端（1 发起 2 观众）经 `pipeToRouter({ keepId: false })` 出画面；观众各自 Router 上的 PipeProducer ID 为新 UUID、与源及彼此均不同；同 Worker 下缺省 `keepId` 的重复 pipe 抛错（§8.3-3 防回归固化）。
- [ ] R2：视频先推、系统音频后到的场景，观众在音频到达后经 `screenShareProducers` 自动补出声，视频不中断、不重复 pipe（§8.3-5）。
- [ ] R3：同一观众并发触发 join + 推送 + 重试，仅产生一次/轨 pipe（in-flight 去重），无 `pipeToRouter` 重复调用异常。
- [ ] B2：带系统音频的共享，观众 `<video>` 同时出声出画，元素音量键控制屏幕声音；无音频共享时单轨正常。
- [ ] B3：屏幕推流期间 `session.upstreams` 无屏幕条目，TS3 侧听不到屏幕音/视频；`media-client.ts` 的 `encodings` 生效（抓包/statistics 验证 maxBitrate 天花板）。
- [ ] B4：§8.1 六条命令全绿；`media-worker-test.mjs` 按 §8.2 断言。
- [ ] H1/R6：共享开始后再加入的迟到观众，仅凭 `screenShareJoined` 直接出流；先于推流加入的早到观众，经 `screenShareProducers` 自动出流；`screenShareList` 应答不含 producer 字段且抓包验证未触发任何 pipe。
- [ ] H2：Web 观众加入时发起端不创建任何面向该观众的 `RTCPeerConnection`（无 `screenShareViewerJoined`、无 offer）；原生 TS 观众路径回归不变。
- [ ] H3：跨频道/跨服务器成员收不到任何屏幕共享广播；发起端不收到自身广播副本。
- [ ] H4/R4：停止共享、发起端关轨、发起端断线、观众断线/换频道场景下，观众端经 `screenShareVideoClosed` / `screenShareStopped` + 本地 `@close`/`trackended` 兜底完成清理，UI 与 mediasoup 资源均无悬挂（Consumer/PipeProducer 全部关闭）。
- [ ] H5：1080p 共享在丢包链路上帧率优先、码率不超过天花板。
- [ ] H8：第 33 位观众收到 `SCREEN_SHARE_VIEWER_LIMIT_REACHED`。
- [ ] H9：无额外用户手势时观众端能自动播放（resumeConsumer 已显式调用）。
- [ ] R7：未开语音的观众首次观看时 `ensureRecvReady()` 惰性建链成功；`ScreenShareStream` 两新字段经 `upsertScreenShareStream` 正确透传且不被列表/广播消息覆盖。
- [ ] 构建（R5）：`npm run build` + `npm --prefix web run build`（含 `vue-tsc --noEmit`）通过。
