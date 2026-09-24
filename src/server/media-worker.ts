/**
 * S2 媒体内核：mediasoup Worker 单例与生命周期托管。
 *
 * 设计要点（对应迁移规格 §4.2 / §6 / §11）：
 *
 * 1. **Worker 二进制来源可审计、可离线**：优先读取环境变量 `MEDIASOUP_WORKER_BIN`；
 *    缺省时按 `process.platform`/`process.arch` 在 `vendor/mediasoup-worker/` 下定位，
 *    两种来源都必须通过 `SHA256SUMS` 的 sha256 校验。缺失、无校验条目或哈希不符一律
 *    **硬失败抛出**，绝不静默回退到 mediasoup 官方的外网下载逻辑。
 * 2. **单例与崩溃可观测**：`getMediaWorker()` 返回进程内唯一 Worker；`worker.on('died')`
 *    记录告警并清空单例，使下一次 `getMediaWorker()` 能重新拉起，实现崩溃告警 + 按需重建。
 * 3. **Router codec 规范**：Opus 强制声明 `channels: 2`（RFC 7587，mediasoup `ortc.js`
 *    硬校验，填 1 直接抛 `UnsupportedError`）。TS3 语音的单声道语义由 Opus 帧内部 payload
 *    承载，与 SDP/ORTC 声道声明无关。
 * 4. **公网映射与 ICE 兜底**：WebRtcTransport 同时绑定 UDP 与 TCP 的 40000–40099 端口段；
 *    配置 `WEBSPEAK_MEDIA_PUBLIC_HOST` 时注入 `announcedAddress`，未配置则省略（纯内网/直挂
 *    公网场景）。
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as mediasoup from "mediasoup";
import type {
  Router,
  RouterRtpCodecCapability,
  TransportListenInfo,
  WebRtcTransport,
  WebRtcTransportOptions,
  Worker,
} from "mediasoup/types";
import type { Logger } from "../logger.js";
import { WEBRTC_UDP_PORT_RANGE } from "./webrtc-config.js";

/** 显式指定 worker 可执行文件路径的环境变量（生产镜像中固定指向 vendor 产物）。 */
export const MEDIA_WORKER_BIN_ENV = "MEDIASOUP_WORKER_BIN";
/** 公网媒体地址（announcedAddress）环境变量；代理机房/端口映射部署必须配置。 */
export const MEDIA_PUBLIC_HOST_ENV = "WEBSPEAK_MEDIA_PUBLIC_HOST";

/** 媒体端口段，与 Docker EXPOSE 及既有 `WEBRTC_UDP_PORT_RANGE` 对齐。 */
export const MEDIA_PORT_RANGE: readonly [number, number] = WEBRTC_UDP_PORT_RANGE;

/** 仓库内预编译 worker 目录（随源码/构建产物定位，src 与 dist 均在 `<root>/<layer>/server/`）。 */
export const MEDIASOUP_VENDOR_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "vendor",
  "mediasoup-worker",
);

/** 受支持的平台/架构 → vendor 二进制文件名。 */
export const WORKER_BINARY_BY_TARGET: Readonly<Record<string, string>> = {
  "win32-x64": "mediasoup-worker-win32-x64.exe",
  "linux-x64": "mediasoup-worker-linux-x64",
};

/**
 * Router 的 ORTC mediaCodecs。Opus 必须且只能声明 `channels: 2`：
 * RFC 7587 要求 SDP/ORTC 以 `opus/48000/2` 声明，mediasoup 在 `ortc.js` 对
 * `audio/opus` 且 `channels !== 2` 的 codec 直接抛 `UnsupportedError`。
 * TS3 语音的单声道语义由 Opus 帧内部 payload（TOC 字节）承载，与 SDP 声道声明无关。
 */
export const MEDIA_CODECS: readonly RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
    rtcpFeedback: [{ type: "transport-cc" }, { type: "nack", parameter: "" }],
  },
];

/** Worker 二进制定位/校验失败时抛出，属于不可恢复的启动期错误。 */
export class MediaWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaWorkerError";
  }
}

export interface MediaWorkerLifecycleOptions {
  /** 生命周期日志出口；缺省走 console。 */
  logger?: Logger;
  /** Worker 崩溃（`died`）后的回调，在日志记录之后调用。 */
  onDied?: (error: Error) => void;
}

export interface MediaWebRtcTransportOptions {
  enableUdp?: boolean;
  enableTcp?: boolean;
  preferUdp?: boolean;
  /** 显式覆盖公网广告地址；缺省读取 `WEBSPEAK_MEDIA_PUBLIC_HOST`。 */
  announcedAddress?: string;
  /** 显式覆盖端口段；缺省 `MEDIA_PORT_RANGE`。 */
  portRange?: readonly [number, number];
  appData?: Record<string, unknown>;
}

/** 解析 `SHA256SUMS`（`<64位hex>  <文件名>` 每行一条，支持 `#` 注释与 `*` 前缀）。 */
export function parseSha256Sums(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(trimmed);
    if (!match) continue;
    entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
}

/**
 * 校验一个 worker 二进制：必须存在、且其 sha256 与 `SHA256SUMS` 中同文件名条目一致。
 * 返回规范化后的绝对路径。
 */
export function verifyWorkerBinary(binPath: string, source: string): string {
  if (!existsSync(binPath)) {
    throw new MediaWorkerError(
      `mediasoup worker 二进制不存在（来源：${source}）：${binPath}\n` +
        `  请从与 lockfile 中 mediasoup 版本对应的官方 release 获取预编译产物，` +
        `放入 vendor/mediasoup-worker/ 并更新 SHA256SUMS（见 vendor/mediasoup-worker/README.md）。`,
    );
  }
  const sumsPath = join(MEDIASOUP_VENDOR_DIR, "SHA256SUMS");
  if (!existsSync(sumsPath)) {
    throw new MediaWorkerError(
      `缺少 worker 校验文件（来源：${source}）：${sumsPath}\n  请随二进制一并提交 SHA256SUMS。`,
    );
  }
  const expected = parseSha256Sums(readFileSync(sumsPath, "utf8")).get(basename(binPath));
  if (!expected) {
    throw new MediaWorkerError(
      `SHA256SUMS 中没有 "${basename(binPath)}" 的校验条目（来源：${source}）\n` +
        `  若使用自定义二进制，请将其 sha256 追加到 ${sumsPath} 后再启动。`,
    );
  }
  const actual = createHash("sha256").update(readFileSync(binPath)).digest("hex");
  if (actual !== expected) {
    throw new MediaWorkerError(
      `mediasoup worker 二进制 sha256 不符（来源：${source}）：${binPath}\n` +
        `  期望：${expected}\n  实际：${actual}\n` +
        `  二进制与 SHA256SUMS 不一致，拒绝启动（禁止静默回退到外网下载）。`,
    );
  }
  // git 在 Windows 检出时不保留可执行位；非 Windows 平台就地把 worker 置为 0755，
  // 保证 Docker 构建层与运行时 spawn 均可用。
  if (process.platform !== "win32") {
    chmodSync(binPath, 0o755);
  }
  return binPath;
}

/**
 * 定位并校验 worker 二进制路径。
 *
 * 1. `MEDIASOUP_WORKER_BIN` 已设置 → 校验存在 + sha256 → 使用；
 * 2. 未设置 → 按 platform/arch 定位 `vendor/mediasoup-worker/` 下对应二进制 → 校验 sha256；
 * 3. 两者均失败 → 抛出 `MediaWorkerError`，错误信息指出缺失文件与获取方式。
 */
export function resolveMediaWorkerBin(): string {
  const fromEnv = process.env[MEDIA_WORKER_BIN_ENV]?.trim();
  if (fromEnv) {
    return verifyWorkerBinary(fromEnv, `${MEDIA_WORKER_BIN_ENV} 环境变量`);
  }
  const target = `${process.platform}-${process.arch}`;
  const binaryName = WORKER_BINARY_BY_TARGET[target];
  if (!binaryName) {
    throw new MediaWorkerError(
      `不支持的平台/架构 "${target}"，可选：${Object.keys(WORKER_BINARY_BY_TARGET).join(", ")}。` +
        `请通过 ${MEDIA_WORKER_BIN_ENV} 显式指定 worker 二进制。`,
    );
  }
  return verifyWorkerBinary(join(MEDIASOUP_VENDOR_DIR, binaryName), `vendor/${binaryName}`);
}

/**
 * 解析公网媒体地址（announcedAddress 用）。
 *
 * 读取 `WEBSPEAK_MEDIA_PUBLIC_HOST`，容忍 `host` / `host:port` / 完整 URL 三种写法，
 * 返回其中的 hostname；未配置或不可解析时返回 undefined（此时不注入 announcedAddress）。
 */
export function resolveMediaPublicHost(raw: string | undefined = process.env[MEDIA_PUBLIC_HOST_ENV]): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.split(",", 1)[0]?.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

/** 克隆一份 mediaCodecs，避免调用方误改共享常量。 */
function cloneMediaCodecs(): RouterRtpCodecCapability[] {
  return MEDIA_CODECS.map((codec) => ({
    ...codec,
    ...(codec.rtcpFeedback ? { rtcpFeedback: codec.rtcpFeedback.map((feedback) => ({ ...feedback })) } : {}),
  }));
}

function logInfo(logger: Logger | undefined, fields: Record<string, unknown>, message: string): void {
  if (logger) logger.info(fields, message);
  else console.log(`[media-worker] ${message}`, fields);
}

function logError(logger: Logger | undefined, fields: Record<string, unknown>, message: string): void {
  if (logger) logger.error(fields, message);
  else console.error(`[media-worker] ${message}`, fields);
}

/**
 * 创建一个新的 mediasoup Worker 并挂载生命周期监听（非单例，供测试/多 worker 场景直接使用）。
 *
 * 启动失败（二进制缺失/哈希不符/worker 无法拉起）时抛出，不做任何静默降级。
 */
export async function createMediaWorker(options: MediaWorkerLifecycleOptions = {}): Promise<Worker> {
  const workerBin = resolveMediaWorkerBin();
  const worker = await mediasoup.createWorker({
    logLevel: "warn",
    // 显式指定 workerBin（优先于 mediasoup 默认定位与 MEDIASOUP_WORKER_BIN 读取时机）。
    workerBin,
    // 端口段以 listenInfos.portRange 为准（mediasoup 已废弃 rtcMin/MaxPort，这里对齐同段作双保险）。
    rtcMinPort: MEDIA_PORT_RANGE[0],
    rtcMaxPort: MEDIA_PORT_RANGE[1],
  });
  logInfo(options.logger, { pid: worker.pid, workerBin }, "mediasoup Worker 已启动");
  worker.on("died", (error: Error) => {
    logError(
      options.logger,
      { pid: worker.pid, err: error.message },
      "mediasoup Worker 异常退出（died），单例已失效，下次 getMediaWorker() 将重新拉起",
    );
    options.onDied?.(error);
  });
  return worker;
}

let singleton: Promise<Worker> | null = null;

/**
 * 返回进程内唯一的 Worker（惰性创建）。创建失败或 Worker 崩溃后清空缓存，
 * 使后续调用可重新拉起；并发调用共享同一次启动过程。
 */
export function getMediaWorker(options: MediaWorkerLifecycleOptions = {}): Promise<Worker> {
  if (singleton) return singleton;
  let pending: Promise<Worker>;
  pending = createMediaWorker({
    ...options,
    onDied: (error) => {
      if (singleton === pending) singleton = null;
      options.onDied?.(error);
    },
  });
  singleton = pending;
  // 启动失败时同样清空缓存，允许重试；同时避免未处理的 rejection。
  void pending.catch(() => {
    if (singleton === pending) singleton = null;
  });
  return pending;
}

/** 关闭并释放单例 Worker（进程优雅退出时调用）。 */
export async function closeMediaWorker(): Promise<void> {
  const pending = singleton;
  if (!pending) return;
  singleton = null;
  try {
    const worker = await pending;
    if (!worker.closed) worker.close();
  } catch {
    // 启动期就已失败：无需关闭。
  }
}

/** 在指定 Worker 上创建 Router，强制使用规范化的 Opus `channels: 2` mediaCodecs。 */
export async function createMediaRouter(worker: Worker): Promise<Router> {
  return worker.createRouter({ mediaCodecs: cloneMediaCodecs() });
}

/**
 * 在指定 Router 上创建浏览器侧 WebRtcTransport。
 *
 * - 同时绑定 UDP 与 TCP（`enableTcp: true` 提供 ICE-over-TCP 兜底），端口段默认 40000–40099；
 * - `WEBSPEAK_MEDIA_PUBLIC_HOST`（或显式 `announcedAddress`）配置时注入公网广告地址。
 */
export async function createMediaWebRtcTransport(
  router: Router,
  options: MediaWebRtcTransportOptions = {},
): Promise<WebRtcTransport> {
  const [min, max] = options.portRange ?? MEDIA_PORT_RANGE;
  const announcedAddress = options.announcedAddress ?? resolveMediaPublicHost();
  const listenBase: Omit<TransportListenInfo, "protocol"> = {
    ip: "0.0.0.0",
    portRange: { min, max },
    ...(announcedAddress ? { announcedAddress } : {}),
  };
  const transportOptions: WebRtcTransportOptions = {
    listenInfos: [
      { protocol: "udp", ...listenBase },
      { protocol: "tcp", ...listenBase },
    ],
    enableUdp: options.enableUdp ?? true,
    enableTcp: options.enableTcp ?? true,
    preferUdp: options.preferUdp ?? true,
    ...(options.appData ? { appData: options.appData } : {}),
  };
  return router.createWebRtcTransport(transportOptions);
}
