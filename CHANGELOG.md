# Changelog

## [0.2.6] — 2026-09-26

### 中文

- 新增**管理后台可配置的 STUN / 外部 TURN**：在管理控制台的服务器设置里直接维护 ICE 服务器列表（STUN 与 TURN 可并存），不再需要改 systemd unit 或环境变量。支持两类 TURN 凭据：**静态用户名/密码**（第三方 TURN 服务常见形式）与 **coturn REST 共享密钥**（密钥留在服务端，每次页面加载签发一份短期临时凭据）。配置存在数据库里，密码与共享密钥以 AES-256-GCM 密文保存，接口只返回「是否已保存」，明文永不回传页面；每次变更写入 `ICE_SERVERS_CHANGED` 审计事件。
- 配置优先级：管理后台列表非空时以其为准；列表为空则回退到原有环境变量（`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`），因此**升级后既有部署行为完全不变**，无需改动任何服务器配置。语音与屏幕共享共用同一份解析结果，不会出现两条链路配置不一致。
- 保存时严格校验并**拒绝**而非静默丢弃：地址必须以 `stun:`/`stuns:`/`turn:`/`turns:` 开头、端口 1–65535 且禁用 53（浏览器会屏蔽）、`turns:` 不允许 `transport=udp`、TURN 条目必须选择凭据方式、展开后下发到浏览器的最多 8 条（与屏幕共享侧既有上限一致）。
- 数据库 schema 升级到 v8（新增 `ice_servers` 表），迁移前自动生成 `.schema-7.bak` 快照。
- 新增 `scripts/ice-config-test.mjs`（36 项断言）：静态与临时凭据派生、环境变量回退、加密存储与视图脱敏、全部校验拒绝路径、v7→v8 迁移；`npm test` 现为 9 个套件。

### English

- Added **admin-console-configurable STUN / external TURN**: maintain the ICE server list (STUN and TURN side by side) in the console's server settings, with no need to touch the systemd unit or environment variables. Two TURN credential schemes are supported: **static username/password** (what third-party TURN services hand out) and the **coturn REST shared secret** (the secret stays on the server and a fresh short-lived credential is issued on every page load). Entries live in the database; passwords and shared secrets are stored as AES-256-GCM ciphertext, the API returns only “stored or not”, and plaintext never travels back to the browser. Every change writes an `ICE_SERVERS_CHANGED` audit event.
- Precedence: a non-empty console list wins; an empty list falls back to the existing environment variables (`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`), so **an upgrade changes nothing for an existing deployment** and no server configuration has to be edited. Voice and screen sharing resolve to the same list, so the two paths cannot disagree.
- Saving validates strictly and **rejects** instead of silently dropping: addresses must start with `stun:`/`stuns:`/`turn:`/`turns:`, use port 1–65535 and not port 53 (browsers block it), `turns:` must not request `transport=udp`, a TURN entry must choose a credential scheme, and at most 8 entries may reach a browser (the ceiling the screen-share path already enforced).
- Database schema moves to v8 (new `ice_servers` table); a `.schema-7.bak` snapshot is written before the migration.
- Added `scripts/ice-config-test.mjs` (36 assertions): static vs. ephemeral credential derivation, the environment fallback, encrypted storage and redacted views, every rejection path and the v7→v8 migration. `npm test` now runs 9 suites.

### Deutsch

- **In der Admin-Konsole konfigurierbares STUN / externes TURN**: Die ICE-Serverliste (STUN und TURN nebeneinander) wird direkt in den Servereinstellungen der Konsole gepflegt – ohne systemd-Unit oder Umgebungsvariablen anzufassen. Zwei TURN-Anmeldeverfahren werden unterstützt: **statischer Benutzername/Passwort** (was Drittanbieter ausgeben) und das **coturn-REST-Shared-Secret** (das Secret bleibt auf dem Server, pro Seitenaufruf wird ein kurzlebiges Zugangsdatum ausgestellt). Die Einträge liegen in der Datenbank; Passwörter und Secrets werden als AES-256-GCM-Chiffrat gespeichert, die API liefert nur „gespeichert oder nicht“, Klartext gelangt nie zurück in den Browser. Jede Änderung schreibt ein `ICE_SERVERS_CHANGED`-Audit-Ereignis.
- Vorrang: Eine nicht leere Liste in der Konsole gewinnt; eine leere Liste fällt auf die bestehenden Umgebungsvariablen zurück (`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`) – **ein Upgrade ändert für ein bestehendes Deployment nichts**, es muss keine Serverkonfiguration angepasst werden. Sprache und Bildschirmfreigabe nutzen dieselbe Liste, ein Auseinanderlaufen ist ausgeschlossen.
- Beim Speichern wird streng geprüft und **abgelehnt** statt still verworfen: Adressen müssen mit `stun:`/`stuns:`/`turn:`/`turns:` beginnen, Port 1–65535 nutzen und nicht Port 53 (von Browsern blockiert), `turns:` darf kein `transport=udp` anfordern, ein TURN-Eintrag muss ein Anmeldeverfahren wählen, und höchstens 8 Einträge erreichen einen Browser (dieselbe Obergrenze wie beim Bildschirmfreigabe-Pfad).
- Das Datenbankschema steigt auf v8 (neue Tabelle `ice_servers`); vor der Migration wird ein `.schema-7.bak`-Schnappschuss geschrieben.
- `scripts/ice-config-test.mjs` hinzugefügt (36 Assertions): statische vs. kurzlebige Anmeldedaten, der Umgebungs-Fallback, verschlüsselte Speicherung und redigierte Ansichten, alle Ablehnungspfade und die Migration v7→v8. `npm test` führt jetzt 9 Suiten aus.

### Русский

- **Настраиваемые в админ-консоли STUN / внешний TURN**: список ICE-серверов (STUN и TURN вместе) ведётся прямо в настройках сервера в консоли — без правки systemd-юнита и переменных окружения. Поддерживаются две схемы аутентификации TURN: **статическое имя пользователя и пароль** (то, что выдают сторонние сервисы) и **общий секрет coturn REST** (секрет остаётся на сервере, а при каждой загрузке страницы выдаются свежие краткосрочные учётные данные). Записи хранятся в базе; пароли и секреты — в виде шифртекста AES-256-GCM, API возвращает только «сохранено или нет», открытый текст никогда не попадает обратно в браузер. Каждое изменение пишет событие аудита `ICE_SERVERS_CHANGED`.
- Приоритет: непустой список в консоли имеет приоритет; пустой список откатывается к существующим переменным окружения (`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`), поэтому **обновление ничего не меняет для существующего развёртывания** и не требует правки конфигурации сервера. Голос и демонстрация экрана используют один и тот же список — расхождение между ними исключено.
- При сохранении выполняется строгая проверка и **отказ** вместо тихого отбрасывания: адрес должен начинаться с `stun:`/`stuns:`/`turn:`/`turns:`, использовать порт 1–65535 и не порт 53 (браузеры его блокируют), `turns:` не должен запрашивать `transport=udp`, для записи TURN нужно выбрать схему аутентификации, а до браузера доходит не более 8 записей (тот же предел, что и в пути демонстрации экрана).
- Схема базы данных обновлена до v8 (новая таблица `ice_servers`); перед миграцией создаётся снимок `.schema-7.bak`.
- Добавлен `scripts/ice-config-test.mjs` (36 проверок): статические и краткосрочные учётные данные, откат к переменным окружения, шифрованное хранение и обезличенные представления, все пути отказа и миграция v7→v8. `npm test` теперь запускает 9 наборов.

### 日本語

- **管理コンソールで設定できる STUN / 外部 TURN**：ICE サーバー一覧（STUN と TURN を併記可）をコンソールのサーバー設定で直接管理でき、systemd ユニットや環境変数を触る必要がありません。TURN の認証方式は 2 種類に対応：**固定のユーザー名とパスワード**（サードパーティ製 TURN サービスが発行する形式）と **coturn REST 共有シークレット**（シークレットはサーバーに留め、ページ読み込みごとに短命な認証情報を発行）。設定はデータベースに保存され、パスワードとシークレットは AES-256-GCM の暗号文として保持、API は「保存済みかどうか」のみを返し、平文がブラウザに戻ることはありません。変更のたびに `ICE_SERVERS_CHANGED` の監査イベントを記録します。
- 優先順位：コンソールの一覧が空でなければそれを採用し、空なら既存の環境変数（`WEBSPEAK_STUN_URLS` / `WEBSPEAK_TURN_URLS` / `WEBSPEAK_TURN_SECRET` / `WEBSPEAK_TURN_TTL_SECONDS`）にフォールバックします。したがって**アップグレードしても既存のデプロイの挙動は変わらず**、サーバー設定の変更も不要です。音声と画面共有は同じ解決結果を使うため、両者が食い違うことはありません。
- 保存時は厳格に検証し、黙って捨てずに**拒否**します：アドレスは `stun:`/`stuns:`/`turn:`/`turns:` で始まり、ポートは 1〜65535（53 はブラウザが遮断するため不可）、`turns:` に `transport=udp` は指定不可、TURN の項目は認証方式の選択が必須、ブラウザに届くのは最大 8 件（画面共有側と同じ上限）。
- データベーススキーマを v8 に更新（`ice_servers` テーブルを追加）。移行前に `.schema-7.bak` スナップショットを作成します。
- `scripts/ice-config-test.mjs`（36 件のアサーション）を追加：固定／短命な認証情報の生成、環境変数へのフォールバック、暗号化保存とマスクされた表示、すべての拒否パス、v7→v8 移行をカバー。`npm test` は 9 スイートになりました。

## [0.2.5] — 2026-09-26

### 中文

- **BREAKING**：WebRTC 媒体引擎全量切换为 mediasoup 单引擎，旧 werift 引擎与「SFU 预分配槽位」模型彻底退役。说话人改为按 `clientId ↔ producerId ↔ consumerId` 动态发布/订阅，不再有预分配 audio m-line 与槽位上限。环境变量 `WEBSPEAK_SFU_SLOTS` 已移除；`werift` 移入 `devDependencies`（仅供无头测试替身使用）。运维发布注意：新版本不再使用 `scripts/patch-werift-ntp.mjs`，请同步删除生产 systemd unit 里的 `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` 拦截项，并确保随镜像分发 `vendor/mediasoup-worker/`。
- **BREAKING**：WebSocket 二进制音频兼容通道全面退役，实时语音全面收敛到纯 WebRTC（mediasoup）架构。服务端不再接收任何二进制音频帧（入站二进制帧返回 `UNSUPPORTED_BINARY_FRAME` 协议错误），移除服务端 Opus 软转码，`@discordjs/opus` 迁入 `devDependencies`（仅供无头测试套件使用），下行音频仅经 mediasoup DirectTransport 转发；前端移除 PCM 采集上行、二进制接收与兼容播放图。WebSocket 现仅承担 JSON 业务与媒体控制信令；WebRTC 协商重试（2s/5s）耗尽后不再回退到兼容通道，而是给出明确的网络诊断与重试指引。
- 新增「频道说明」标签：作为频道页面的默认视图排在标签栏最前，进入频道即展示当前频道的说明文本，支持 TeamSpeak 说明中的加粗、斜体、下划线、删除线、颜色与链接，正文里普通的方括号保持不变；频道未填写说明时给出引导空态。说明按需通过 `channelinfo` 读取，因此在没有频道列表权限的服务器上也能正常显示。
- 屏幕共享改为经网关 **mediasoup SFU 中央转发**：网页观众之间不再建立点对点连接，发起端只推 1 路画面（屏幕视频与系统音频各为一路），网关按需分发给每位观看者，观众增加不再放大发起端上行带宽；与 TeamSpeak 6 原生客户端互通仍走 P2P。
- 屏幕共享优先协商 **H.264**（可走显卡硬件编码、CPU 占用低，VP8 兜底）并放宽下行带宽上限，解决高动态画面因 CPU 过载掉帧的问题。
- 修复共享标签页/窗口时画面分辨率被压到约 1/4：发送端降级策略改为按共享来源选择——标签页/窗口共享保分辨率，整屏共享且帧率 ≥30 FPS 时保帧率。
- 修复三个屏幕共享交互缺陷：观众停止观看会清空直播端性能面板；无观众时发起者换频道会误杀刚开播的共享；全屏观看的画面稳定性加固。性能面板新增「发送给观看者」的实际编码输出分辨率。
- 修复切换音频输入/输出设备后听不到他人说话：麦克风切换改为原地换轨（不再重建传输层），扬声器切换追加 `AudioContext` 恢复与拉流节点 sink 同步。
- 新增 `npm test`：一条命令串联 worker 校验与编解码、说话人映射、上行管线、设备切换、屏幕共享 SFU、端到端、TURN 凭据共 8 个回归套件。

### English

- **BREAKING**: WebRTC media is now mediasoup-only; the werift engine and the pre-allocated “SFU slot” model are fully retired. Speakers are published and subscribed dynamically via `clientId ↔ producerId ↔ consumerId`, with no reserved audio m-lines and no slot ceiling. The `WEBSPEAK_SFU_SLOTS` environment variable is removed, and `werift` moved to `devDependencies` (headless test double only). Operators: the new build no longer uses `scripts/patch-werift-ntp.mjs`, so remove the `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` guard from the production systemd unit and make sure `vendor/mediasoup-worker/` ships with the image.
- **BREAKING**: The WebSocket binary audio compatibility channel is fully retired and realtime voice now runs entirely on the pure WebRTC (mediasoup) architecture. The server no longer accepts binary audio frames (inbound binary frames receive the `UNSUPPORTED_BINARY_FRAME` protocol error) and server-side Opus transcoding is gone — `@discordjs/opus` moved to `devDependencies` (used only by the headless test suite) — and downlink audio flows solely through the mediasoup DirectTransport; the frontend drops PCM capture/uplink, binary reception, and the compatibility playback graph. WebSocket now carries JSON business and media-control signaling only, and exhausting the WebRTC retries (2s/5s) no longer falls back to a compatibility channel but surfaces a clear network diagnosis and retry guidance.
- Added a “Channel description” tab: it leads the tab strip as the channel page's default view and shows the current channel's description as soon as you enter, rendering TeamSpeak's bold, italic, underline, strike-through, color, and link markup while leaving ordinary bracketed text untouched; a guiding empty state appears when the channel has no description. Descriptions are fetched on demand through `channelinfo`, so servers without channel-list permission keep working.
- Screen sharing now goes through **mediasoup SFU central forwarding** in the gateway: web viewers no longer connect peer-to-peer, the sharer pushes a single stream (screen video and system audio as separate tracks), and the gateway fans it out to each viewer — adding viewers no longer multiplies the sharer's upstream bandwidth. Interop with native TeamSpeak 6 clients stays peer-to-peer.
- Screen sharing now negotiates **H.264** first (GPU hardware encoding, low CPU, with VP8 as fallback) and allows a higher downlink bitrate ceiling, fixing frame drops caused by CPU overuse on high-motion content.
- Fixed the share resolution collapsing to roughly a quarter when sharing a tab or window: the sender's degradation policy now follows the source — tab/window shares keep resolution, whole-screen shares at ≥30 FPS keep frame rate.
- Fixed three screen-share interaction defects: a viewer stopping playback cleared the broadcaster's performance panel; an owner changing channel with no viewers killed a just-started share; and fullscreen playback stability was hardened. The performance panel now also reports the actual encoded output resolution sent to viewers.
- Fixed losing other participants' audio after switching the input or output device: microphone switching now replaces the track in place (no transport teardown), and speaker switching re-asserts `AudioContext` resume plus sink synchronization.
- Added `npm test`: one command runs all eight regression suites — worker verification plus codec, speaker map, upstream pipeline, audio device, screen-share SFU, end-to-end and TURN credentials.

### Deutsch

- **BREAKING**: WebRTC-Medien laufen jetzt ausschließlich über mediasoup; die werift-Engine und das Modell der vorab reservierten „SFU-Slots“ sind vollständig entfernt. Sprecher werden dynamisch über `clientId ↔ producerId ↔ consumerId` publiziert und abonniert – ohne reservierte Audio-m-Lines und ohne Slot-Obergrenze. Die Umgebungsvariable `WEBSPEAK_SFU_SLOTS` entfällt, `werift` wandert nach `devDependencies` (nur noch als Headless-Testdouble). Betriebshinweis: Der neue Build nutzt `scripts/patch-werift-ntp.mjs` nicht mehr – entfernen Sie den `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify`-Eintrag aus der produktiven systemd-Unit und liefern Sie `vendor/mediasoup-worker/` mit dem Image aus.
- **BREAKING**: Der binäre WebSocket-Audio-Kompatibilitätskanal ist vollständig entfernt; Echtzeit-Sprache läuft jetzt ausschließlich über die reine WebRTC-Architektur (mediasoup). Der Server nimmt keine binären Audioframes mehr an (eingehende Binärframes erhalten den Protokollfehler `UNSUPPORTED_BINARY_FRAME`), die serverseitige Opus-Transkodierung entfällt – `@discordjs/opus` wandert nach `devDependencies` (nur noch für die Headless-Testsuite) – und die Downlink-Audioübertragung erfolgt ausschließlich über den mediasoup-DirectTransport; das Frontend entfernt PCM-Aufnahme/Uplink, Binärempfang und den Kompatibilitäts-Wiedergabegraphen. WebSocket transportiert jetzt nur noch JSON-Business- und Mediensteuerungs-Signalisierung, und erschöpfte WebRTC-Wiederholungen (2s/5s) führen zu keiner Fallback-Verbindung mehr, sondern zu einer klaren Netzwerkdiagnose und einem Wiederholungshinweis.
- Neuer Tab „Kanalbeschreibung“: Er steht als Standardansicht am Anfang der Tab-Leiste und zeigt die Beschreibung des aktuellen Kanals direkt beim Betreten; dargestellt werden Fett, Kursiv, Unterstrichen, Durchgestrichen, Farben und Links aus TeamSpeak, gewöhnliche Klammertexte bleiben unverändert, und ohne Beschreibung erscheint ein Hinweis. Die Beschreibung wird bedarfsweise über `channelinfo` geladen, sodass Server ohne Kanal-Listen-Berechtigung weiter funktionieren.
- Bildschirmfreigabe läuft jetzt über die **zentrale mediasoup-SFU-Weiterleitung** des Gateways: Web-Zuschauer verbinden sich nicht mehr direkt, der Teilende sendet einen einzigen Stream (Bildschirmvideo und Systemaudio als getrennte Spuren), und das Gateway verteilt ihn an jeden Zuschauer – zusätzliche Zuschauer vervielfachen die Upload-Bandbreite nicht mehr. Die Interoperabilität mit nativen TeamSpeak-6-Clients bleibt Peer-to-Peer.
- Die Bildschirmfreigabe verhandelt jetzt zuerst **H.264** (Hardware-Encoding über die GPU, geringe CPU-Last, VP8 als Fallback) und erlaubt eine höhere Downlink-Bitratengrenze – das behebt Bildverluste durch CPU-Überlast bei stark bewegten Inhalten.
- Behoben: Beim Teilen eines Tabs oder Fensters fiel die Auflösung auf etwa ein Viertel. Die Degradierungsstrategie des Senders richtet sich jetzt nach der Quelle – Tab-/Fensterfreigaben behalten die Auflösung, Ganzbildschirm-Freigaben mit ≥30 FPS die Bildrate.
- Drei Interaktionsfehler der Bildschirmfreigabe behoben: Beendete ein Zuschauer die Wiedergabe, wurde die Leistungsanzeige des Teilenden geleert; ein Kanalwechsel des Teilenden ohne Zuschauer beendete eine gerade gestartete Freigabe; die Stabilität der Vollbildwiedergabe wurde verbessert. Die Leistungsanzeige zeigt jetzt zusätzlich die tatsächlich kodierte Ausgabeauflösung.
- Behoben: Nach dem Wechsel von Eingabe- oder Ausgabegerät war kein anderer Teilnehmer mehr zu hören. Der Mikrofonwechsel ersetzt die Spur jetzt an Ort und Stelle (kein Transportabbau mehr), der Lautsprecherwechsel stellt `AudioContext`-Resume und Sink-Synchronisierung sicher.
- `npm test` hinzugefügt: ein Befehl führt alle acht Regressionssuiten aus – Worker-Prüfung sowie Codec, Sprecher-Mapping, Upstream-Pipeline, Audiogeräte, Bildschirmfreigabe-SFU, End-to-End und TURN-Anmeldedaten.

### Русский

- **BREAKING**: Медиа WebRTC теперь работает только на mediasoup; движок werift и модель предварительно выделенных «SFU-слотов» полностью выведены из эксплуатации. Говорящие публикуются и подписываются динамически по `clientId ↔ producerId ↔ consumerId`, без резервирования audio m-line и без ограничения на число слотов. Переменная окружения `WEBSPEAK_SFU_SLOTS` удалена, а `werift` перенесён в `devDependencies` (только для безголового тестового двойника). Внимание при выпуске: новая сборка больше не использует `scripts/patch-werift-ntp.mjs` — удалите строку `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` из рабочего systemd-юнита и поставляйте `vendor/mediasoup-worker/` вместе с образом.
- **BREAKING**: Бинарный аудиоканал совместимости через WebSocket полностью выведен из эксплуатации; голос в реальном времени теперь работает исключительно на чистой архитектуре WebRTC (mediasoup). Сервер больше не принимает бинарные аудиокадры (входящие бинарные кадры получают ошибку протокола `UNSUPPORTED_BINARY_FRAME`), серверное транскодирование Opus удалено — `@discordjs/opus` перенесён в `devDependencies` (используется только безголовым набором тестов) — а нисходящее аудио идёт исключительно через mediasoup DirectTransport; фронтенд убирает захват/восходящий поток PCM, приём бинарных кадров и граф совместимого воспроизведения. WebSocket теперь передаёт только JSON-бизнес и сигнализацию управления медиа, а исчерпание повторных попыток WebRTC (2s/5s) больше не приводит к откату на канал совместимости — выводится понятная диагностика сети и рекомендация повторить.
- Добавлен раздел «Описание канала»: он открывается по умолчанию и стоит первым в панели разделов, показывая описание текущего канала сразу при входе; поддерживаются полужирный, курсив, подчёркивание, зачёркивание, цвет и ссылки TeamSpeak, при этом обычный текст в квадратных скобках не изменяется; если описания нет, выводится подсказка. Описание запрашивается по требованию через `channelinfo`, поэтому серверы без права на список каналов продолжают работать.
- Демонстрация экрана теперь идёт через **центральную пересылку mediasoup SFU** в шлюзе: веб-зрители больше не соединяются напрямую, демонстрирующий отправляет один поток (видео экрана и системный звук отдельными дорожками), а шлюз раздаёт его каждому зрителю — рост числа зрителей больше не умножает исходящую полосу. Совместимость с нативными клиентами TeamSpeak 6 остаётся одноранговой.
- Демонстрация экрана теперь в первую очередь согласует **H.264** (аппаратное кодирование на GPU, низкая нагрузка на CPU, VP8 как запасной вариант) и допускает более высокий предел битрейта — это устраняет потерю кадров из-за перегрузки CPU на динамичных сценах.
- Исправлено: при демонстрации вкладки или окна разрешение падало примерно до четверти. Стратегия деградации отправителя теперь зависит от источника — демонстрация вкладки/окна сохраняет разрешение, демонстрация всего экрана при ≥30 FPS сохраняет частоту кадров.
- Исправлены три дефекта взаимодействия: остановка просмотра зрителем очищала панель производительности вещателя; смена канала вещателем без зрителей завершала только что начатую трансляцию; повышена стабильность полноэкранного воспроизведения. Панель производительности теперь также показывает фактическое разрешение кодированного вывода.
- Исправлено: после переключения устройства ввода или вывода перестали быть слышны другие участники. Переключение микрофона теперь заменяет дорожку на месте (без пересоздания транспорта), а переключение динамика восстанавливает `AudioContext` и синхронизацию sink.
- Добавлена команда `npm test`: одна команда запускает все восемь наборов регрессионных тестов — проверка worker, кодеки, карта говорящих, восходящий конвейер, аудиоустройства, SFU демонстрации экрана, сквозной тест и учётные данные TURN.

### 日本語

- **BREAKING**: WebRTC メディアは mediasoup 単一エンジンに完全移行し、werift エンジンと「SFU スロット事前割り当て」モデルは廃止しました。話者は `clientId ↔ producerId ↔ consumerId` で動的に publish/subscribe され、audio m-line の予約やスロット上限はありません。環境変数 `WEBSPEAK_SFU_SLOTS` は削除し、`werift` は `devDependencies` へ移動（ヘッドレステスト代替のみ）。運用注意：新ビルドは `scripts/patch-werift-ntp.mjs` を使用しないため、本番 systemd unit の `ExecStartPre=node scripts/patch-werift-ntp.mjs --verify` を削除し、`vendor/mediasoup-worker/` をイメージに同梱してください。
- **BREAKING**: WebSocket のバイナリ音声互換チャネルを完全廃止し、リアルタイム音声は純粋な WebRTC（mediasoup）アーキテクチャに完全移行しました。サーバーはバイナリ音声フレームを受け付けなくなり（受信バイナリフレームには `UNSUPPORTED_BINARY_FRAME` プロトコルエラーを返します）、サーバー側の Opus 変換を撤去、`@discordjs/opus` は `devDependencies` へ移動（ヘッドレステスト専用）し、下り音声は mediasoup DirectTransport 経由のみで転送します。フロントエンドは PCM 取得・上り送信、バイナリ受信、互換再生グラフを撤去しました。WebSocket は JSON ビジネスとメディア制御シグナリングのみを担い、WebRTC ネゴシエーションの再試行（2s/5s）を使い切っても互換チャネルへは戻らず、明確なネットワーク診断と再試行案内を表示します。
- 「チャンネル説明」タブを追加：タブ列の先頭に既定の表示として配置し、入室時に現在のチャンネルの説明を表示します。TeamSpeak の太字・斜体・下線・取り消し線・色・リンクを描画し、本文中の通常の角括弧はそのまま。説明がない場合は案内の空状態を表示。説明は `channelinfo` で必要なときだけ取得するため、チャンネル一覧の権限がないサーバーでも動作します。
- 画面共有はゲートウェイの **mediasoup SFU による中央転送**に変更しました。Web 視聴者は直接接続せず、共有者は 1 本のストリーム（画面映像とシステム音声は別トラック）を送るだけで、ゲートウェイが各視聴者へ配信します。視聴者が増えても共有者の上り帯域は増えません。TeamSpeak 6 ネイティブクライアントとの相互視聴は従来どおりピアツーピアです。
- 画面共有は **H.264** を優先してネゴシエーションするようにし（GPU ハードウェア符号化で CPU 負荷が低く、VP8 はフォールバック）、下りビットレート上限も緩和しました。動きの激しい画面で CPU 過負荷によりフレームが落ちる問題を解消します。
- タブ/ウィンドウ共有時に解像度が約 1/4 に落ちる問題を修正。送信側の降格戦略をソースに応じて選択するようにしました——タブ/ウィンドウ共有は解像度を維持、全画面共有かつ ≥30 FPS はフレームレートを維持。
- 画面共有の 3 つの操作不具合を修正：視聴者が視聴を終了すると配信者のパフォーマンスパネルが消える、視聴者ゼロで配信者がチャンネルを移動すると開始直後の共有が終了する、全画面視聴の安定性を強化。パネルに実際の符号化出力解像度も表示します。
- 入出力デバイスを切り替えると他の参加者の声が聞こえなくなる問題を修正。マイク切り替えはトラックをその場で差し替え（トランスポートを再構築しない）、スピーカー切り替えは `AudioContext` の再開と sink 同期を保証します。
- `npm test` を追加：worker 検証とコーデック、話者マップ、上りパイプライン、オーディオデバイス、画面共有 SFU、エンドツーエンド、TURN 資格情報の計 8 スイートを 1 コマンドで実行します。

## [0.2.4] — 2026-09-22

### 中文

- 新增跨端 P2P 屏幕共享：浏览器用户可以与 TeamSpeak 6 原生客户端互相发现、发起和观看屏幕共享；浏览器之间以及浏览器与原生客户端之间的媒体流优先通过 WebRTC/ICE 直连，WebSpeak 仅负责会话鉴权、共享状态和 SDP/ICE 信令转发，不承载屏幕媒体流量。
- 默认使用 TeamSpeak 官方 STUN 服务发现直连候选，并支持管理员显式配置外部 TURN；即使使用 TURN，媒体也经过外部服务而不是 WebSpeak 网关。
- 新增屏幕共享直播状态、观众人数、播放器音量、全屏和退出控制，并提供发送端/接收端 WebRTC 实时统计。
- 提供浏览器屏幕采集分辨率和帧率设置，最高支持 1080p、60 FPS；设置改为独立弹窗，避免成员卡片被撑高。
- 新增首页访客编号，并优化屏幕共享成员卡片和观看交互。

### English

- Added cross-platform P2P screen sharing: browser users can discover, start, and watch screen shares with native TeamSpeak 6 clients. Media between browsers, and between a browser and a native client, prefers a direct WebRTC/ICE path; WebSpeak handles session authorization, share state, and SDP/ICE signaling only and does not carry screen media.
- Added TeamSpeak's public STUN services for direct-candidate discovery by default, with optional administrator-configured external TURN. Even with TURN, media uses the external service rather than the WebSpeak gateway.
- Added live screen-share status, viewer counts, player volume, fullscreen, and exit controls, plus live sender/receiver WebRTC statistics.
- Added browser capture-resolution and frame-rate controls up to 1080p and 60 FPS; moved the controls into a standalone modal so member cards no longer stretch.
- Added homepage visitor numbering and refined screen-share member-card and viewing interactions.

### Deutsch

- Plattformübergreifendes P2P-Bildschirmteilen ergänzt: Browsernutzer können Bildschirmfreigaben mit nativen TeamSpeak-6-Clients erkennen, starten und ansehen. Die Medienübertragung zwischen Browsern sowie zwischen Browser und nativem Client nutzt möglichst direkte WebRTC-/ICE-Verbindungen; WebSpeak übernimmt nur Sitzungsberechtigung, Freigabestatus und SDP-/ICE-Signalisierung und transportiert keine Bildschirmmedien.
- Öffentliche TeamSpeak-STUN-Dienste werden standardmäßig zur Ermittlung direkter Kandidaten verwendet; ein externes TURN kann ausdrücklich durch den Administrator konfiguriert werden. Auch mit TURN läuft die Medienübertragung über den externen Dienst und nicht über das WebSpeak-Gateway.
- Live-Status, Zuschauerzahl, Lautstärke, Vollbild- und Beenden-Steuerung für Bildschirmfreigaben sowie laufende WebRTC-Statistiken für Sender und Empfänger ergänzt.
- Aufnahmeauflösung und Bildrate im Browser bis 1080p und 60 FPS konfigurierbar; die Einstellungen wurden in ein eigenes Modal verschoben, damit Mitgliederkarten nicht mehr in die Höhe wachsen.
- Besucherzählung auf der Startseite ergänzt und die Interaktion von Bildschirmfreigabe-Karten und Player verbessert.

### Русский

- Добавлена кроссплатформенная P2P-трансляция экрана: пользователи браузера могут обнаруживать, запускать и смотреть трансляции вместе с нативными клиентами TeamSpeak 6. Медиа между браузерами, а также между браузером и нативным клиентом по возможности передаётся напрямую через WebRTC/ICE; WebSpeak отвечает только за авторизацию сессии, состояние трансляции и SDP/ICE-сигналы и не переносит медиаданные экрана.
- По умолчанию добавлено обнаружение прямых кандидатов через публичные STUN-сервисы TeamSpeak; администратор может явно настроить внешний TURN. Даже при использовании TURN медиа идёт через внешний сервис, а не через шлюз WebSpeak.
- Добавлены статус трансляции, число зрителей, громкость проигрывателя, полноэкранный режим и выход, а также текущая статистика WebRTC для отправителя и получателя.
- Добавлены настройки разрешения и частоты кадров захвата в браузере до 1080p и 60 FPS; настройки вынесены в отдельное окно, чтобы карточки участников не растягивались.
- Добавлен номер посетителя на главной странице и улучшено управление карточками и просмотром трансляций.

### 日本語

- クロスプラットフォーム P2P 画面共有を追加しました。ブラウザユーザーは TeamSpeak 6 ネイティブクライアントと互いに画面共有を検出・開始・視聴できます。ブラウザ間、およびブラウザとネイティブクライアント間のメディアは可能な限り WebRTC/ICE で直接送信され、WebSpeak はセッション認証、共有状態、SDP/ICE シグナリングだけを担当し、画面メディアは運びません。
- 初期設定で TeamSpeak 公開 STUN サービスによる直接候補の検出に対応し、管理者が外部 TURN を明示的に設定できるようにしました。TURN 使用時もメディアは外部サービスを経由し、WebSpeak ゲートウェイは経由しません。
- 配信状態、視聴者数、プレーヤー音量、全画面、終了操作と、送信側・受信側の WebRTC 統計を追加しました。
- ブラウザの画面取得設定で最大 1080p / 60 FPS を選択できます。設定を独立したモーダルに移し、メンバーカードが縦に伸びないようにしました。
- ホームページの訪問者番号を追加し、画面共有カードと視聴操作を改善しました。

## [0.2.3] — 2026-09-19

### 中文

- 新增频道成员调度入口：保留拖放移动，并在右键菜单提供“调度到”二级菜单和“我所在的频道”快捷项。
- 支持按 TeamSpeak 权限直接移动成员；具备权限时无需重复输入频道密码，无权限时不提供该操作。
- 支持成员头像显示、麦克风静音状态同步和保存身份恢复，并增强指针拖动兼容性。
- 更新中文、English、Deutsch、Русский、日本語五种语言的功能截图和文档页面。
- 修复高分辨率桌面端管理员设置页面底部内容被裁切的问题，并收紧中继卡片的宽度约束。

### English

- Added member-management entry points: drag-and-drop remains available, while the context menu now provides a “Move to” submenu with a “My channel” shortcut.
- Added permission-aware direct member moves: authorized users can move clients without redundant channel-password prompts, while the action is unavailable without the required TeamSpeak permission.
- Added client-avatar display, microphone mute-state synchronization, and remembered-identity recovery, with improved pointer-drag compatibility.
- Refreshed feature screenshots and documentation pages for all five supported languages.
- Fixed clipped lower content in the high-resolution desktop admin settings page and tightened relay-card width constraints.

### Deutsch

- Neue Einstiege für die Mitgliederverwaltung: Ziehen und Ablegen bleibt verfügbar, zusätzlich bietet das Kontextmenü ein Untermenü „Verschieben nach“ mit dem Eintrag „Mein Kanal“.
- Direkte, berechtigungsabhängige Mitgliederverschiebung ergänzt: Benutzer mit den erforderlichen TeamSpeak-Rechten benötigen keine erneute Kanalpasswortabfrage; ohne diese Rechte steht die Aktion nicht zur Verfügung.
- Anzeige von Client-Avataren, Synchronisierung des Mikrofon-Stummschaltstatus und Wiederherstellung gespeicherter Identitäten ergänzt; Zeigerbedienung verbessert.
- Funktionsscreenshots und Dokumentationsseiten für alle fünf unterstützten Sprachen aktualisiert.
- Das Abschneiden unterer Inhalte in den Admin-Einstellungen bei hoher Desktop-Auflösung behoben und die Breitenbegrenzung der Relay-Karten verbessert.

### Русский

- Добавлены способы управления участниками: перетаскивание сохранено, а в контекстном меню появился пункт «Переместить в» с быстрым вариантом «Мой канал».
- Добавлено прямое перемещение с учётом прав TeamSpeak: пользователям с нужными правами не нужно повторно вводить пароль канала, а без этих прав действие недоступно.
- Добавлены отображение аватаров клиентов, синхронизация состояния микрофона и восстановление сохранённой идентичности; улучшено перетаскивание указателем.
- Обновлены функциональные скриншоты и страницы документации для всех пяти поддерживаемых языков.
- Исправлено обрезание нижнего содержимого настроек администратора на десктопах с высоким разрешением и ограничена ширина карточек ретрансляторов.

### 日本語

- メンバー操作を追加しました。ドラッグ＆ドロップに加えて、コンテキストメニューに「移動先」サブメニューと「自分のチャンネル」ショートカットを用意しました。
- TeamSpeak 権限に応じた直接移動を追加しました。必要な権限があればチャンネルパスワードを再入力せずに移動でき、権限がなければ操作は表示されません。
- クライアントアバターの表示、マイクミュート状態の同期、保存した ID の復元に対応し、ポインター操作も改善しました。
- 対応する 5 言語すべての機能スクリーンショットとドキュメントページを更新しました。
- 高解像度デスクトップで管理設定の下部が切れる問題を修正し、中継カードの幅制約を改善しました。

## [0.2.2] — 2026-09-17

### 中文

- 提供可开关的浏览器端麦克风降噪功能。
- 优化前端音量交互逻辑：桌面端悬停麦克风和整体音量按钮即可调整，降噪开关收纳在麦克风菜单中。
- 在 PR #2 基础上优化错误提示和错误代码显示。
- 提供俄语和日语界面支持，并支持按语言单独调整欢迎文字。

### English

- Added optional browser-side microphone noise suppression.
- Refined volume interaction: desktop microphone and master-volume controls open on hover, with noise suppression in the microphone menu.
- Improved error messages and error-code display on top of PR #2.
- Added Russian and Japanese UI support and per-language welcome text configuration.

### Deutsch

- Optionale browserseitige Mikrofon-Geräuschunterdrückung hinzugefügt.
- Lautstärkeinteraktion verbessert: Desktop-Mikrofon- und Gesamtlautstärkeregler öffnen sich beim Überfahren; die Geräuschunterdrückung befindet sich im Mikrofonmenü.
- Fehlertexte und Fehlercodes auf Basis von PR #2 verbessert.
- Russische und japanische Oberfläche sowie sprachabhängige Begrüßungstexte ergänzt.

### Русский

- Добавлено опциональное шумоподавление микрофона в браузере.
- Улучшено управление громкостью: на компьютере регуляторы открываются при наведении, а шумоподавление находится в меню микрофона.
- Улучшены сообщения и коды ошибок на основе PR #2.
- Добавлены русский и японский интерфейсы и отдельная настройка приветствия для каждого языка.

### 日本語

- ブラウザ側で任意に使えるマイクノイズ抑制を追加しました。
- 音量操作を改善し、デスクトップではマイクと全体音量のボタンにカーソルを合わせると調整画面を表示し、ノイズ抑制をマイクメニューにまとめました。
- PR #2 を基にエラー表示とエラーコードを改善しました。
- ロシア語・日本語 UI と言語別ウェルカム文の設定を追加しました。

## [0.2.1] — 2026-09-13

### 中文

- 统一首页连接错误显示：保留错误代码，未知错误安全截断，并显示可追溯的服务端原因。
- 默认支持 IPv6 TeamSpeak 目标，并补充主机、运行时和网络条件说明。

### English

- Unified connection-error display on the welcome page: preserve error codes, safely truncate unknown codes, and show traceable server reasons.
- Added default IPv6 TeamSpeak target support and documented the required host, runtime, and network conditions.

### Deutsch

- Verbindungsfehler auf der Willkommensseite vereinheitlicht: Fehlercodes bleiben erhalten, unbekannte Codes werden sicher gekürzt und nachvollziehbare Serverursachen angezeigt.
- IPv6-Ziele für TeamSpeak standardmäßig unterstützt und erforderliche Host-, Laufzeit- und Netzwerkbedingungen dokumentiert.

## [0.2.0] — 2026-09-10

### 中文

- 新增 README“高级功能”章节，补充 WebRTC 与中继服务器的配置和使用步骤。
- 明确 WebRTC 的 UDP 端口、安全组与防火墙要求，以及中继令牌和管理员控制台配置方式。
- 标注中继服务为 WebSpeak 自带实现；同时注明 WebRTC 使用 MIT 许可的 `werift` 依赖，TeamSpeak 连接使用项目维护的 SDK fork。
- 细分 TeamSpeak 连接失败原因，服务器需要密码时提示用户输入密码并重试。
- 优化管理员历史连接日志：能够追溯时显示具体原因，无法追溯时使用通用失败提示，不猜测历史原因。
- 新增正式中继部署模式：中继实例不提供前台和管理员后台，只接受带令牌的网关转发会话。
- 管理员可配置多个中继节点，访客可在欢迎页为当前连接选择直连或指定中继。
- 修复用户正常断开后被管理员运维日志误显示为“请求失败”的问题。

### English

- Added an “Advanced features” section to the README with WebRTC and relay configuration and usage steps.
- Documented WebRTC UDP, security-group, and firewall requirements, plus relay-token and administration-console setup.
- Clarified that the relay is built into WebSpeak, while WebRTC uses the MIT-licensed `werift` dependency and TeamSpeak connectivity uses the project-maintained SDK fork.
- Classified TeamSpeak connection failures and prompt users for a server password with a retry when authentication requires one.
- Improved administrator connection history: show a specific reason when available and use a generic failure message when older records cannot be traced, without guessing.
- Added a formal relay deployment mode: relay instances expose no visitor or admin UI and accept only token-authenticated gateway sessions.
- Administrators can configure multiple relay nodes, and visitors can choose direct access or a specific relay for each connection.
- Fixed normal user disconnects being shown as “request failed” in administrator connection history.

### Deutsch

- Einen Abschnitt „Erweiterte Funktionen“ mit Anleitungen für WebRTC und Relay-Server zur README hinzugefügt.
- UDP-, Sicherheitsgruppen- und Firewall-Anforderungen für WebRTC sowie Relay-Token und Administrationskonfiguration dokumentiert.
- Klargestellt, dass das Relay Bestandteil von WebSpeak ist; WebRTC verwendet die MIT-lizenzierte Abhängigkeit `werift`, die TeamSpeak-Verbindung den projektgepflegten SDK-Fork.
- TeamSpeak-Verbindungsfehler genauer klassifiziert und bei erforderlichem Serverpasswort eine Eingabe mit Wiederholung angeboten.
- Den Verlauf der Administrator-Verbindungen verbessert: verfügbare Ursachen werden angezeigt, ältere nicht nachvollziehbare Einträge erhalten eine allgemeine Fehlermeldung statt einer Vermutung.
- Einen dedizierten Relay-Bereitstellungsmodus ergänzt: Relay-Instanzen stellen keine Besucher- oder Admin-Oberfläche bereit und akzeptieren nur Gateway-Sitzungen mit Token.
- Administratoren können mehrere Relay-Knoten konfigurieren; Besucher wählen pro Verbindung Direktzugriff oder ein bestimmtes Relay.
- Behoben, dass normale Benutzertrennungen im Administrationsverlauf als „Anfrage fehlgeschlagen“ erschienen.

## [0.1.8] — 2026-09-08

### 中文

- Docker 默认使用 host 网络，支持网关访问同机 TeamSpeak 并直接暴露 WebRTC UDP 端口。
- 开放模式统一校验用户提交的目标地址，包括管理员默认目标，修复本机与内网目标绕过限制的问题。
- TeamSpeak SDK 连接握手增加 15 秒超时，失败连接会及时清理。
- 网络性能面板改为持续监测，打开后每 3 秒更新一次延迟与丢包率。

### English

- Docker now uses host networking by default, allowing the gateway to reach a local TeamSpeak server and expose the WebRTC UDP range directly.
- Open access now validates every submitted target, including the administrator default, closing loopback and private-network bypasses.
- Added a 15-second TeamSpeak SDK handshake timeout with prompt cleanup after failed connections.
- The network performance panel now measures continuously and refreshes latency and packet loss every 3 seconds while open.

### Deutsch

- Docker verwendet standardmäßig das Host-Netzwerk, damit das Gateway einen lokalen TeamSpeak-Server erreicht und den WebRTC-UDP-Bereich direkt bereitstellt.
- Der offene Zugriffsmodus prüft nun jedes Ziel einschließlich des Administrator-Standards und schließt Umgehungen für Loopback- und private Netze.
- Für den TeamSpeak-SDK-Handshake gilt jetzt ein Timeout von 15 Sekunden; fehlgeschlagene Verbindungen werden zeitnah bereinigt.
- Das Netzwerkleistungsfeld misst bei geöffneter Ansicht fortlaufend und aktualisiert Latenz und Paketverlust alle 3 Sekunden.

## [0.1.7] — 2026-09-06

### 中文

- 增加 Deutsch 界面支持和 Telegram 群组入口。
- 增加桌面端整体音量滑块，默认收起并在悬停时展开。
- 修复伴奏音量忽大忽小的问题。
- 增加可展开的网络性能面板，显示浏览器、WebSpeak 与 TeamSpeak 之间的延迟和丢包率。
- 管理员连接测试改用服务端多次主机 Ping 并显示丢包率，不再创建临时 TeamSpeak 客户端。
- 统一中文、English、Deutsch 的旗帜代码语言菜单。
- 修复 TeamSpeak 使用 TCP 探测导致的误报丢包，并修正语言菜单异常留白。
- 移除 WebRTC 桥接中的 RMS 静音帧过滤，安静帧仅用于发言状态指示，不再丢弃。
- 修复 Docker 运行环境缺少 ICMP Ping 工具导致管理员测试误报 100% 丢包。

### English

- Added German UI support and a Telegram community link.
- Added a compact desktop master-volume slider that expands on hover.
- Fixed accompaniment volume fluctuations.
- Added an expandable network performance panel with latency and packet loss across the browser, WebSpeak, and TeamSpeak path.
- Updated the administrator connection test to use repeated host pings, report packet loss, and avoid creating temporary TeamSpeak clients.
- Unified the Chinese, English, and German flag/code language menu.
- Fixed false packet-loss reports caused by probing the TeamSpeak UDP service with TCP, and corrected excess space in the language menu.
- Removed RMS-based silence filtering from the WebRTC bridge; quiet frames are now retained for the codec timeline.
- Fixed Docker admin diagnostics falsely reporting 100% packet loss when the runtime lacked the ICMP ping tool.

### Deutsch

- Deutsche Benutzeroberfläche und Telegram-Community-Link hinzugefügt.
- Kompakten Gesamtlautstärkeregler für den Desktop ergänzt, der sich beim Überfahren öffnet.
- Schwankende Lautstärke bei der Begleittonfreigabe behoben.
- Aufklappbares Netzwerkleistungsfeld mit Latenz und Paketverlust zwischen Browser, WebSpeak und TeamSpeak ergänzt.
- Verbindungstest in der Administration auf wiederholte Host-Pings mit Paketverlustanzeige umgestellt, ohne temporäre TeamSpeak-Clients zu erzeugen.
- Einheitliches Sprachmenü mit Flaggen und Sprachcodes für Chinesisch, Englisch und Deutsch ergänzt.
- Falsche Paketverlustmeldungen durch TCP-Prüfung des UDP-Dienstes behoben und übermäßigen Leerraum im Sprachmenü korrigiert.
- RMS-basierte Stillefilterung aus der WebRTC-Brücke entfernt; leise Frames bleiben nun im Codec-Zeitverlauf erhalten.
- Falsche 100-%-Paketverlustmeldungen behoben, wenn dem Docker-Laufzeitimage das ICMP-Ping-Tool fehlte.

## [0.1.6] — 2026-09-04

### 中文

- 新增保持身份并发连接提醒，避免同一浏览器复用身份造成连接卡住。
- 新增桌面端伴奏共享功能。
- 新增网站 favicon，并更新仓库 README 主视觉。

### English

- Added a warning for concurrent remembered-identity connections in the same browser.
- Added desktop accompaniment sharing.
- Added a site favicon and refreshed the repository README branding.

## [0.1.5] — 2026-09-04

### 中文

- 修复并优化主题切换按钮，首次点击即可切换，并使用太阳/月亮图标。
- 修复浏览器身份保存与退出后的保持逻辑。

### English

- Fixed and refined the theme toggle so the first click switches themes, with sun/moon icons.
- Fixed browser identity persistence across exit and return.

All notable changes to WebSpeak are documented here. Versions follow SemVer.

## [0.1.4] — 2026-09-03

### 中文

- 修复 WebRTC 语音收发与发言状态同步。
- 修复频道文字消息在 WebSpeak 客户端之间无法互收。
- 优化管理员页面、运行日志换行和移动端顶部布局。
- 首页新增 Bilibili 入口，管理员登录页新增返回首页。

### English

- Fixed WebRTC voice transport and speaking-state synchronization.
- Fixed channel text messages between WebSpeak clients.
- Refined admin pages, log wrapping, and narrow-screen header layout.
- Added the Bilibili profile link and the admin-login home link.

## [0.1.3] — 2026-09-03

### Added

- Optional WebRTC audio transport for deployments that need lower and more stable realtime voice latency.
- A self-contained WebRTC media service controlled by one administrator switch; the gateway derives the media host from the current WebSpeak address and owns a fixed UDP range.
- Migrated the TeamSpeak integration to the maintained `EchoSixHIYA/teamspeak-js` fork, including live directory snapshots and member/channel synchronization.

### Changed

- WebRTC audio uses negotiated Opus parameters and a bounded newest-frame mixer instead of allowing stale audio to accumulate.
- The browser keeps the WebSocket path available for signaling, control, and compatibility fallback; Docker Compose publishes the built-in `40000–40099/UDP` media range alongside the web port.

### Fixed

- Prevented duplicate playback when WebRTC and the WebSocket audio path overlap during negotiation or fallback.
- Made WebRTC teardown and fallback explicit so a failed negotiation does not leave a server-side media session behind.
- Corrected native Opus decoder usage and cleaned up negotiated payload handling for TeamSpeak-to-browser audio.

### Verification

- After allowing inbound `40000–40099/UDP` on the public WebSpeak host, two browser sessions were tested against the same TeamSpeak target with WebRTC enabled: audio frames flowed in both directions, packet drops remained at `0`, ingress frame gaps peaked at about `27 ms`, and egress gaps peaked at about `81–83 ms`.
- The measured WebRTC path stayed below the previous WebSocket jitter peaks of about `268–376 ms` in the same browser test setup; these figures describe the observed test path, not a universal latency guarantee.

## [0.1.2] — 2026-09-02

### Added

- Current-version badge and a direct changelog link on the welcome page, next to the prominent GitHub repository button.
- Mobile member actions through a three-dot menu, while desktop member actions remain available through the context menu.

### Changed

- Mobile and narrow-screen header controls now collapse longer labels into icons to preserve usable spacing.
- The welcome page and connected workspace now present the GitHub, version, changelog, admin, theme, language, exit, and microphone controls as a consistent responsive control group.
- The version shown on the welcome page is read from the gateway's public configuration so it stays aligned with the running backend.
- Consolidated the post-0.1.1 mobile voice controls, microphone mute replacement for focus-dependent PTT, automatic protocol detection, simplified Docker Compose startup, and live-demo documentation.

### Fixed

- Replaced the visually off-center settings glyph and normalized icon alignment for settings-related controls across the client.
- Fixed narrow-screen exit and microphone controls so their text-collapse rules apply correctly.
- Bounded browser and gateway voice buffering, reset stale browser playback queues, and exposed low-overhead in-memory audio counters for diagnosing jitter without per-frame log writes.
- Moved microphone frame assembly to an `AudioWorklet` with a compatibility fallback to `ScriptProcessorNode`; both paths emit fixed 960-sample frames.

## [0.1.1] — 2026-09-02

### Added

- M009 admin operations dashboard for managed invites, active-session inspection, per-session termination, diagnostics, logs, audit access, diagnostic report download, and SQLite backup export.
- Persistent managed invites with expiry, optional maximum uses, revocation, hashed opaque tokens, and encrypted TeamSpeak credentials at rest.
- Mobile-aware invite joining through the `invite` URL parameter without placing a TeamSpeak password in the URL.
- M010 hardening for per-peer join-ticket rate limiting and bounded rotating runtime logs.
- Bilingual README documentation with parallel Chinese and English feature, deployment, security, and operations sections.

### Changed

- Database schema is now version 2 and migrates existing version 1 installations transactionally with a migration copy.
- Admin overview and diagnostics use the application package version instead of a hard-coded display value.
- The README architecture section now uses GitHub-native Markdown instead of a Mermaid rich-display block.
- The README badge set now uses stable static Shields badges without a repository-metadata 404 dependency.
- Version tags publish Windows/Linux deployment packages to GitHub Releases and publish the matching Docker image.
- Removed the focus-dependent normal browser Space-key PTT mode and replaced it with a one-click microphone mute/unmute control on desktop and mobile.
- Persisted the microphone mute state in browser preferences and suppresses upstream audio before it is sent to TeamSpeak while muted.

### Fixed

- Late WebSpeak browser sessions now reconcile and merge the complete TeamSpeak directory, so members who joined earlier remain visible.
- Private-message delivery no longer disconnects the browser session.
- Member actions are presented through the right-click context menu with hover feedback.
- Docker release builds copy the root `postinstall` patch script before running `npm ci`.
- Release builds skip `npm version` when the project version already matches the requested version, preventing false `Version not changed` failures.

### Verification

- `npm test` — 51 tests passed.
- `npm run build` — backend TypeScript build passed.
- `npm run web:build` — frontend production build passed.
- `npm audit --omit=dev --audit-level=high` — no high or critical vulnerabilities reported.
- Local `/demo` browser checks passed at the documented narrow and desktop widths; `/demo` does not connect to TeamSpeak.

Real TS3/TS6 interoperability, Android microphone behavior, multi-client smoke, and the 24-hour long-run gate require their respective test environments and are not claimed by this local release check.

## [0.1.0] — 2026-08-31

- First normalized release with the browser client, TeamSpeak 3 / 6 gateway, browser audio controls, access modes, administrator operations, and AGPL-3.0-only licensing.
