# WebSpeak · 日本語

[プロジェクトトップ](../README.md) · [简体中文](./README.zh-CN.md) · [English](./README.en.md) · [Deutsch](./README.de.md) · [Русский](./README.ru.md)

## プロジェクト概要

| 観点 | 説明 |
| --- | --- |
| **WHAT** | WebSpeak は TeamSpeak 3 / TeamSpeak 6 向けのセルフホスト型ブラウザクライアント兼音声ゲートウェイです。 |
| **WHY** | デスクトップクライアントをインストールせず、ブラウザからチャンネルに参加できます。運用者はサーバーとデータを管理できます。 |
| **HOW** | 起動後、管理コンソールで TeamSpeak の接続先とアクセス方針を設定します。ブラウザが画面と音声を担当し、WebSpeak がゲートウェイとして接続します。 |

> **派生バージョン**：本リポジトリは [`EchoSixHIYA/WebSpeak-client-for-TeamSpeak`](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak)（上流ベース `v0.2.4`）に基づく派生版です。`v0.2.5` 以降のソース変更と日付は [CHANGELOG](../CHANGELOG.md)、全文は [NOTICE](../NOTICE) に記載しています。

## ✨ 機能

| 機能 | 説明 |
| --- | --- |
| TeamSpeak | TeamSpeak 3 / 6 に対応し、対象プロトコルを自動検出します。 |
| 画面共有 | Web 視聴者間ではゲートウェイが **mediasoup SFU** でメディアを転送します（共有者は 1 本のストリームを送信するため視聴者が増えても上り帯域は増えず、映像とシステム音声は別トラック）。TeamSpeak 6 ネイティブクライアントとの相互視聴は従来どおり WebRTC/ICE の直接接続です。 |
| IPv6 | IPv6 の接続先と DNS から解決された IPv6 アドレスに標準対応します。 |
| チャンネルとメンバー | チャンネルツリー、リアルタイムのメンバー状態、チャンネル移動。 |
| リアルタイム音声 | Opus 音声は内蔵 WebRTC（mediasoup 単一エンジン）による低遅延伝送で完結し、WebSocket は JSON ビジネスとメディア制御シグナリングのみを担います。 |
| 音声操作 | マイク、スピーカー、音量、VOX、ミュート、メンバーごとの音量調整。 |
| ブラウザ側ノイズ抑制 | マイクのノイズ抑制をブラウザの音声取得段階で任意に使用でき、サーバー側の追加処理は不要です。 |
| チャットと操作 | チャンネル/サーバーチャット、個人メッセージ、つつく、ウィスパー対象。 |
| BGM共有 | デスクトップブラウザで音声付きウィンドウやタブの音をチャンネルに共有。 |
| ID とアクセス | ID の保存、接続先の指定、期限・回数付き招待リンク。 |
| 管理コンソール | 接続先、アクセス、WebRTC、中継、招待、セッション、ログ、診断、バックアップ。 |
| インターフェース | 中文、English、Deutsch、Русский、日本語、ライト/ダークテーマ、レスポンシブ表示。 |

## 🖼️ インターフェースのスクリーンショット

日本語のホーム、音声ワークスペース、オーディオ設定、メンバー操作メニューを掲載しています。

### ホーム

<p align="center"><img src="./screenshots/webspeak-ja-home.png" alt="WebSpeak 日本語ホーム" width="100%" /></p>

### 音声ワークスペース

<p align="center"><img src="./screenshots/webspeak-ja.png" alt="WebSpeak 日本語音声ワークスペース" width="100%" /></p>

### オーディオ設定

<p align="center"><img src="./screenshots/webspeak-ja-audio.png" alt="WebSpeak 日本語オーディオ設定" width="100%" /></p>

### メンバーメニュー

<p align="center"><img src="./screenshots/webspeak-ja-menu.png" alt="WebSpeak 日本語メンバーメニュー" width="100%" /></p>

## 🧩 高度な機能

### WebRTC

**管理コンソール → サーバー → 詳細設定** で有効にします。無効の状態で UDP ポート範囲（初期値 `40000–40099`）を設定し、ファイアウォールで許可して保存してください。有効中は範囲がロックされ、新しい接続で WebRTC を使用します。ネットワークが WebRTC を確立できない場合（例：UDP/TCP がファイアウォールで遮断）、UI は明確なネットワーク診断と再試行案内を表示し、WebSocket 音声チャネルへ戻ることはありません。公開サイトでは HTTPS が必要です。

メディアは内蔵の **mediasoup** 単一エンジンで処理します。話者は `clientId ↔ producerId ↔ consumerId` で動的に publish/subscribe され、予約された audio m-line やスロット上限はありません。関連する環境変数はいずれも任意です。

- `MEDIASOUP_WORKER_BIN`：mediasoup worker の実行ファイルパス。既定では同梱のプリコンパイル済み `vendor/mediasoup-worker/` を使用し、SHA256 を検証します。Release パッケージと Docker イメージには同梱済みです。
- `WEBSPEAK_MAX_SPEAKERS`：1 セッションで同時に publish する話者数（1–64、既定 32）。
- `WEBSPEAK_MEDIA_PUBLIC_HOST`：プロキシ／ポートマッピング構成での公開メディアアドレス（ICE 候補の `announcedAddress` に書き込まれます）。メディアアドレスが待受アドレスと同じ場合は不要です。

ポート範囲 `40000–40099` は **UDP と TCP の両方** を許可してください（TCP は ICE-over-TCP のフォールバック）。

### 画面共有（SFU による中央転送）

Web 視聴者間の画面共有は、WebSpeak ゲートウェイの **mediasoup SFU による中央転送**で行われます。共有者は**1 本**のストリームをゲートウェイへ送るだけで、ゲートウェイが必要に応じて各視聴者へ配信します。したがって視聴者が増えても共有者の上り帯域は**増えず**、ブラウザ間の直接接続も不要です。双方が対称型 NAT、社内ネットワーク、モバイルホットスポットの背後にいても視聴できます。

- **2 トラック**: 画面映像とシステム音声（ブラウザの選択ダイアログで「音声を共有」を選んだ場合）は別トラックで、視聴側では同期します。
- **コーデック**: 優先は H.264（GPU ハードウェア符号化で CPU 負荷が低い）、非対応時は VP8 にフォールバック。
- **解像度とフレームレート**: 共有設定で最大 1080p / 60 FPS を選択できます。取得解像度が選択したソース自体を超えることはありません（タブの場合、上限はそのタブのビューポート）。帯域が逼迫したときの取舍はソースに従います——**タブ/ウィンドウ共有は解像度を維持**（ドキュメントやコードの可読性を優先）、**全画面共有かつ ≥30 FPS はフレームレートを維持**（動画やゲームの滑らかさを優先）。
- **視聴側**: 配信状態、視聴者数、音量、全画面、終了の操作を提供。1 つの共有につき Web 視聴者は最大 **32 人**。
- **パフォーマンスパネル**: 「取得」サイズと「視聴者への送信」実際の符号化出力サイズ、フレームレート、ビットレート、損失、制限理由を並べて表示し、ボトルネックが取得・符号化・ネットワークのどこかを判断できます。

**TeamSpeak 6 ネイティブクライアント**との相互視聴は引き続きピアツーピアです。双方は WebRTC/ICE で直接接続し（音声と同じ ICE 設定を再利用——自前の STUN と必要に応じた外部 TURN）、WebSpeak はセッション認証、共有状態、SDP/ICE シグナリングのみを担当し、このメディアを**転送しません**。TURN を設定した場合、メディアはその外部サービスを経由することがありますが、WebSpeak ゲートウェイを経由することはありません。

### STUN / TURN サーバー

ブラウザは ICE サーバーを使って自分のグローバルアドレスを検出し（STUN）、対称型 NAT や UDP 遮断時には中継（TURN）にフォールバックします。内蔵のパブリック STUN は設定なしで動作します。

- **管理コンソール（推奨）**：`/admin` →「サーバー」ページの **STUN / TURN サーバー** カード。STUN と TURN をいくつでも登録でき、**再起動は不要**です。空欄ならサーバーの環境変数（`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`）を使用するため、アップグレードしても既存のデプロイの挙動は変わりません。
- **2 種類の TURN 認証**：**固定のユーザー名とパスワード**（多くのサードパーティ TURN サービスが提供する形式）と **coturn REST 共有シークレット**（シークレットはサーバーに留め、ページ読み込みごとに短命な認証情報を発行）。パスワードとシークレットは AES-256-GCM の暗号文としてデータベースに保存され、API は保存済みかどうかのみを返し、平文がブラウザに届くことはありません。
- **並び順が優先順位**：リストの順序がそのままブラウザの試行順です。信頼性の高いサーバーを先頭にしてください。
- **注意**：固定の認証情報はすべての訪問者に配信され、再利用可能な中継アカウントを公開することになります。プロバイダー側で必ずクォータを設定してください。`turns:`（TURN over TLS）には**ブラウザが信頼する CA が発行した**証明書が必要で、ホスト名と証明書の SAN が一致していなければなりません。自己署名証明書は拒否されます（ブラウザは内蔵のルート証明書のみを信頼します）。ポート 53 はブラウザが遮断するため使用しないでください。

### 中継サーバー

中継は現在の WebSpeak セッションの TeamSpeak 通信だけを転送し、VPN ではありません。管理コンソールで複数のノードに名前、アドレス、トークンを設定すると、ユーザーは直接接続または中継を選択できます。中継モードは専用の転送サービスとして動作し、ゲスト画面や管理コンソールを提供しません。

中継サービスは WebSpeak に組み込まれており、Node.js の標準ライブラリを使用します。GOST や sing-box などのプロキシフレームワークは不要です。WebRTC メディアは [mediasoup](https://mediasoup.org/) `3.27.1`（ISC ライセンス）が処理します。従来の werift エンジンは廃止し、開発依存のテスト代替としてのみ残します。TeamSpeak 接続はプロジェクトが保守する [EchoSixHIYA/teamspeak-js](https://github.com/EchoSixHIYA/teamspeak-js) SDK を使用します。

## 🚀 デプロイ

| 方法 | 用途 |
| --- | --- |
| Docker Compose | 常時稼働サーバーと簡単な更新 |
| Release パッケージ | Node.js やビルドツールを使わない起動 |
| ソースから | 開発やカスタマイズ |

> Docker は必須ではありません。ビルド成果物を systemd ユニットで直接動かすこともできます（`ExecStart=node dist/index.js`、作業ディレクトリは配置先、データは `data/`）。Docker を導入できないホストに適します。更新は「ローカルでビルド → 成果物を差し替え → サービス再起動」です。

### Docker Compose

```bash
git clone --depth 1 https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak.git
cd WebSpeak-client-for-TeamSpeak
docker compose pull
docker compose up -d
```

起動後に `http://<your-host>:3040/admin` を開き、`admin` / `admin` でログインして直ちにパスワードを変更し、TeamSpeak を設定します。データは `webspeak-data` volume に保存されます。データベースを消さない場合は `docker compose down -v` を実行しないでください。

### Release パッケージ

[Releases](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/latest) から Windows x64 または Linux x64 のパッケージを取得し、専用フォルダーに展開して `start-webspeak.cmd` または `./start-webspeak.sh` を実行します。

### ソースから

```bash
npm ci --ignore-scripts     # mediasoup の postinstall をスキップ：worker バイナリは vendor/ に同梱
npm run verify:worker       # vendor/mediasoup-worker/ の SHA256 を検証
npm run prepare:sdk
npm --prefix web ci
npm --prefix web run build
npm run build
npm start
```

本番実行時に**ネイティブのトランスコード依存は不要**です（`@discordjs/opus` は `devDependencies` に移動し、オフラインテスト専用。テストを実行する場合は `npm rebuild @discordjs/opus`）。全リグレッションは `npm test` で実行できます——worker 検証に加え、コーデック、話者マップ、上りパイプライン、オーディオデバイス、画面共有 SFU、エンドツーエンド、TURN 資格情報、ICE 設定の計 9 スイート。

## ⚠️ 要件と注意

- ソースからのビルドには Node.js `>=22.5` が必要です。Docker と Release には必要な実行環境が含まれます。
- 対応ベースラインは **Chrome / Edge 94+ · Firefox 102+ · Safari 15.4+**（iOS Safari と Android Chrome を含む）です。マイクとウィンドウ音声には通常 HTTPS が必要です。ブラウザエンジンごとの差異とフォールバックは、リポジトリの README「Browser Compatibility」に記載しています。
- 出力デバイスの選択（スピーカー切り替え）が実際に機能するのは Chromium 系のみです（`AudioContext.setSinkId`）。Firefox 116+ には `HTMLMediaElement.setSinkId` がありますが `AudioContext.setSinkId` はなく、このアプリの可聴出力は WebAudio グラフ由来のため、Firefox もシステム既定の出力にフォールバックします。設定パネルにその旨を表示します。
- 伴奏共有は Chromium デスクトップのみで、WebRTC が必要です。Firefox/Safari の `getDisplayMedia` は表示音声トラックを返さないため、これらのエンジンでは利用できません。
- WebSpeak のホストから TeamSpeak に到達できる必要があります。標準音声ポートは `9987` です。
- Web サービスは `3040/TCP` を使用します。公開時は HTTPS と WebSocket をリバースプロキシ経由で公開してください。
- WebRTC のポート範囲は既定で `40000–40099`（UDP と TCP）。全体を許可し、変更前に WebRTC を無効化してください。
- IPv6 にはルーティング可能な IPv6、OS/コンテナで有効な IPv6、適切なファイアウォール設定が必要です。リテラルは `[2001:db8::1]#9987` の形式です。
- 保存したブラウザ ID は同じブラウザで同時に1接続だけ使用できます。
- BGM共有はデスクトップのみで、WebRTC が必要です。

## 🧾 更新履歴

| バージョン | 内容 |
| --- | --- |
| [v0.2.5](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.5) | 2026-09-26 | WebRTC エンジンを mediasoup に完全移行し、WebSocket バイナリ音声チャネルを廃止。画面共有は SFU 中央転送に変更（H.264 ハードウェア符号化を優先、映像とシステム音声は別トラック）し、解像度が 1/4 に落ちる問題、視聴者退出時に配信者パネルが消える問題、視聴者ゼロでのチャンネル移動で開始直後の共有が終了する問題を修正。オーディオデバイス切り替えの不具合も修正し、`npm test` を追加。 |
| [v0.2.4](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.4) | ブラウザと TeamSpeak 6 ネイティブクライアント間のクロスプラットフォーム P2P 画面共有を追加しました。STUN/外部 TURN 設定、プレーヤーと視聴者状態、1080p/60 FPS 取得設定、WebRTC 統計に対応し、共有操作と訪問者番号も改善しました。 |
| [v0.2.3](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.3) | チャンネルメンバーの移動操作と権限に応じた直接移動を追加し、アバター表示、ミュート状態の同期、保存 ID の復元に対応しました。5 言語のスクリーンショットとドキュメントも更新しました。 |
| [v0.2.2](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.2) | ブラウザ側マイクノイズ抑制、ロシア語・日本語 UI、言語別ウェルカム文を追加。音量操作と PR #2 を基にしたエラー表示・エラーコードを改善しました。 |
| [v0.2.1](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.1) | 接続エラー表示を改善し、IPv6 接続先を標準対応しました。 |
| [v0.2.0](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.2.0) | パスワード案内、正式な中継モード、複数中継選択、接続診断を追加しました。 |
| [v0.1.8](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/releases/tag/v0.1.8) | Docker 起動を簡略化し、15秒の接続タイムアウトと継続的なネットワーク監視を追加しました。 |

完全な履歴は [CHANGELOG.md](../CHANGELOG.md) を参照してください。

## ライセンス

WebSpeak は [GNU Affero General Public License v3.0 only](../LICENSE) の下で公開されています。
