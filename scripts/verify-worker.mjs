// 校验 vendor/mediasoup-worker/ 下的预编译 worker 二进制：
//   1) 按当前平台/架构定位对应二进制，比对 vendor/mediasoup-worker/SHA256SUMS 中的 sha256；
//   2) 交叉核对 vendor README 记录的 mediasoup 版本与 node_modules/mediasoup 实际版本一致。
// 通过时打印 [WORKER_VERIFY_OK] 并以退出码 0 结束；缺失、哈希不符或版本漂移时退出码非 0。
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "vendor", "mediasoup-worker");
const sumsPath = join(vendorDir, "SHA256SUMS");
const readmePath = join(vendorDir, "README.md");
const mediasoupPackageJson = join(root, "node_modules", "mediasoup", "package.json");

// 与 package.json 中锁定的 mediasoup 版本保持一致；vendor 二进制与 README 均须匹配。
const expectedMediasoupVersion = "3.27.1";

const binaryByTarget = {
  "win32-x64": "mediasoup-worker-win32-x64.exe",
  "linux-x64": "mediasoup-worker-linux-x64",
};

const fail = (message) => {
  console.error(`[WORKER_VERIFY_FAIL] ${message}`);
  process.exit(1);
};

const target = `${process.platform}-${process.arch}`;
const binaryName = binaryByTarget[target];
if (!binaryName) {
  fail(`unsupported platform/arch "${target}", expected one of ${Object.keys(binaryByTarget).join(", ")}`);
}

if (!existsSync(sumsPath)) {
  fail(`missing checksum file: ${sumsPath}`);
}
if (!existsSync(readmePath)) {
  fail(`missing vendor README: ${readmePath}`);
}

const parseSums = (content) => {
  const entries = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(trimmed);
    if (!match) continue;
    entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
};

const sums = parseSums(readFileSync(sumsPath, "utf8"));
const expectedHash = sums.get(binaryName);
if (!expectedHash) {
  fail(`SHA256SUMS has no entry for "${binaryName}"`);
}

const binaryPath = join(vendorDir, binaryName);
if (!existsSync(binaryPath)) {
  fail(`missing worker binary: ${binaryPath}`);
}

const actualHash = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
if (actualHash !== expectedHash) {
  fail(
    `sha256 mismatch for ${binaryName}\n  expected: ${expectedHash}\n  actual:   ${actualHash}\n` +
      `  vendor 二进制与 SHA256SUMS 不一致，请重新获取 3.27.1 官方构建产物并更新校验文件。`,
  );
}

// git 在 Windows 检出时不保留可执行位；非 Windows 平台就地把 linux worker 置为 0755，
// 保证 Docker 构建层与运行时 spawn 均可用。
if (process.platform !== "win32") {
  chmodSync(binaryPath, 0o755);
}

const readmeVersion = /mediasoup\s*版本[:：]\s*`?([0-9]+\.[0-9]+\.[0-9]+)`?/i.exec(readFileSync(readmePath, "utf8"));
if (!readmeVersion) {
  fail(`cannot parse mediasoup version from ${readmePath}`);
}
if (readmeVersion[1] !== expectedMediasoupVersion) {
  fail(`vendor README records mediasoup ${readmeVersion[1]}, expected ${expectedMediasoupVersion}`);
}

if (existsSync(mediasoupPackageJson)) {
  const installedVersion = JSON.parse(readFileSync(mediasoupPackageJson, "utf8")).version;
  if (installedVersion !== expectedMediasoupVersion) {
    fail(`node_modules/mediasoup is ${installedVersion}, vendor worker is ${expectedMediasoupVersion}`);
  }
} else {
  console.warn("[WORKER_VERIFY_WARN] node_modules/mediasoup not installed; skipped version cross-check");
}

console.log(`[WORKER_VERIFY_OK] ${binaryName} sha256=${actualHash} mediasoup=${expectedMediasoupVersion}`);
