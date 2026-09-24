# mediasoup-worker 预编译二进制（vendor）

本目录**纳入版本库**，为离线/断网构建与部署提供 `mediasoup` 的 worker 可执行文件，
规避 `mediasoup` npm `postinstall` 的外网下载逻辑（全程 `--ignore-scripts` 安装，不触网）。

- mediasoup 版本: `3.27.1`
- 上游仓库: https://github.com/versatica/mediasoup
- 获取日期: 2026-09-24

## 文件清单

| 文件 | 平台 / 架构 | 大小 (bytes) | sha256 |
|---|---|---|---|
| `mediasoup-worker-linux-x64` | linux / x64（生产：Docker 运行时） | 9593920 | `f18d7f4af2563322d830a69ea1b0843e653bb74fd5a803676879958aac9db749` |
| `mediasoup-worker-win32-x64.exe` | win32 / x64（本地开发） | 5383168 | `70c15a2919b21467e888887ce332f2f2ca26f9cc7da9c0572a6eb703a509b0c5` |

精确哈希以同目录 `SHA256SUMS` 为准（`scripts/verify-worker.mjs` 按当前平台读取比对）。

## 来源 URL

- **Linux x64**（官方 GitHub Release，kernel6 预编译包）:
  https://github.com/versatica/mediasoup/releases/download/3.27.1/mediasoup-worker-3.27.1-linux-x64-kernel6.tgz
  解包后 tar 内单文件 `mediasoup-worker`，就位重命名为 `mediasoup-worker-linux-x64`。
- **Windows x64**（同 3.27.1 发布批次，从 POC 工作区已就位产物复制）:
  源路径 `poc/node_modules/mediasoup/worker/out/Release/mediasoup-worker.exe`
  等价官方资产 https://github.com/versatica/mediasoup/releases/download/3.27.1/mediasoup-worker-3.27.1-win32-x64.tgz

## Linux 资产 kernel 后缀说明

mediasoup 官方 Linux 预编译资产按**构建主机的内核主版本**命名（`-kernel6` / `-kernel7`），
`downloadPrebuiltWorker()` 依据 `os.release()` 主版本号选择资产：

- `-kernel6`：于 Ubuntu 22.04（glibc 2.35）构建，适配内核 6.x 主机；
- `-kernel7`：于 Ubuntu 26.04 构建，适配内核 7.x 主机。

本项目 Docker 运行时基于 `node:22-bookworm-slim`（glibc 2.36），选用较旧 glibc 构建的
`-kernel6` 资产以保证兼容。若部署主机内核主版本为 7，需改用 `-kernel7` 资产并同步更新
本文件与 `SHA256SUMS`。

## 校验

```bash
node scripts/verify-worker.mjs    # 当前平台 worker sha256 + mediasoup 版本一致性
sha256sum -c SHA256SUMS           # 纯哈希校验（Linux；Windows 用 scripts/verify-worker.mjs）
```

脚本在非 Windows 平台会顺带将 linux worker 置为可执行（`0755`），以兼容 git 在
Windows 检出时不保留可执行位的情形。
