*[English](CHANGELOG.md) · 日本語 · [中文](CHANGELOG.zh.md)*

# 変更履歴

書式は [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) に準拠し、バージョン番号は
semver に従います。現在の npm パッケージ名は `@chiro2001/dsh-oc` で、まだ registry には
公開していません。インストールと更新は GitHub のソース（`#main` / `#develop`）から行います。

## [Unreleased]

- 「モデルは設定済みなのにクライアントから選択できない」問題を修正しました。dsh は provider に
  利用可能な資格情報がある場合だけモデルを列挙します。資格情報がないと `/api/model` が空に
  なり、カタログからモデル選択を解決するクライアント（TUI）は「No provider selected」で止まり、
  dsh が使わない OpenCode の provider 接続フローに入ります。bridge はカタログが空のとき、
  dsh の設定にある既定モデルを公開するようになりました（`/api/model`、`/api/provider`、
  `/api/model/default`）。`/api/config` は `model` と `default_agent` を持つ設定ドキュメントを
  返し、モデル付きの `POST /api/session` はモデルをルーティングできないという理由で全体が
  失敗することはなくなりました。モデルの切り替えに失敗したときは不足している資格情報を
  名指しし、カタログが空である理由は起動時に 1 回だけ記録します。設定方法は
  [COMPAT.ja.md](COMPAT.ja.md) の「モデル（provider）の設定」を参照してください。
- TUI ブランドプラグインを 2.1.0 の実際のプラグイン API に合わせました。旧プラグインは 1.x の
  書き方で関数をエクスポートしていたため、読み込み時に `Invalid V2 TUI plugin module` で
  失敗しました。2.1.0 は slot ツリーを `context.ui.slot` に置き、ホーム画面の logo 用 slot を
  持ちません（ホームの logo は TUI 自身が描画します）。そのため `DSH ⨯ OC` とサブタイトルは
  `home.footer` に配置します。プラグインの `package.json` は `"."` と `"./tui"` の両方の
  エントリを提供します。
- 公式 OpenCode Web UI を bridge 自身が API と同じオリジンで配信するようになりました。公式
  opencode バイナリは Web UI を 1 つの `AppArchive`（リトルエンディアン u32 の JSON インデックス
  長 + インデックス + brotli 圧縮したアセット本体）として埋め込んでいます。bridge は起動時に
  1 回だけ `$DSH_HOME/opencode/web-ui/<version>/` へ展開し、その後は自分でこれらのファイルを
  配信します（`src/bridge/web-ui.ts`）。検索順は `DSH_OC_WEB_UI` で指定したディレクトリが先で、
  次に展開先のディレクトリです。公式 Web UI は常に `location.origin` で API にアクセスするため、
  同一オリジンにすれば CORS もログインも不要になり、公式 `opencode serve` の設定と同じに
  なります。バイナリは検索するだけで bridge がインストールすることはないため（TUI プラグインが
  もともと必要とします）、Web UI は次回の起動から現れます。バイナリが見つからないときは
  Web UI を配信せず、API には影響しません。どのルートにも一致しない `GET`/`HEAD` は Web UI の
  shell（シングルページアプリ）へフォールバックし、`_assets/` 配下で見つからないファイルは
  404 です。`scripts/extract-opencode-web-ui.mjs` を使うと、オフラインで任意のディレクトリへ
  アセットを抽出できます。
- CORS ポリシーを公式 opencode サーバー（ソース `packages/server/src/cors.ts`）に合わせました。
  常に `http://localhost:<port>`、`http://127.0.0.1:<port>`、`oc://renderer`、tauri のオリジン、
  `*.opencode.ai` を許可し、さらに `DSH_OC_CORS`（カンマ区切り、公式サーバーの `cors` オプションに
  相当、LAN 上のブラウザ UI 用）を許可します。許可した場合はリクエスト自身のオリジンをエコーし、
  `Access-Control-Allow-Credentials: true` を付けます。旧実装は常に
  `Access-Control-Allow-Origin: *` を返していたため、資格情報付きのリクエストはブラウザに拒否され
  （"credentialed request requires Access-Control-Allow-Origin '<origin>'"）、ブラウザ UI は
  まったく接続できませんでした。
- SSE にハートビートを追加しました。`SseHub` は 15 秒ごとに、公式サーバーと同じコメントフレーム
  `: heartbeat\n\n` を各接続へ書き込みます（公式の実装は
  `packages/server/src/handlers/event.ts`）。以前は静かなセッションのストリームが切断されたように
  見えました。公式クライアントは "Event stream stalled" で切断して再接続し、OpenChamber の上流
  リーダーは 20 秒で諦めるため、どちらも再接続ループに陥っていました。
- SSE の status スナップショットを有界にしました（`SESSION_STATUS_SNAPSHOT_LIMIT = 20`）。
  実行中のセッションを先に報告し、残りの枠は最後に動いた順で埋めます。旧実装は bridge が見た
  すべてのセッションを報告していたため、公式 Web UI は接続のたびに数百件のセッションレコードを
  読み、初期読み込みが終わりませんでした。
- プロジェクト一覧が bridge の作業ディレクトリを報告するようになりました。`GET /api/project` は
  素の `Project[]` を返し、`GET /api/project/:projectID` と `PATCH /api/project/:projectID` は
  素の `Project` を返します（PATCH は現時点ではエコーするだけで永続化しません）。公式サーバーは
  配信するディレクトリからプロジェクト一覧を導出するため、ブラウザ UI でワークスペースを
  選択できるようになりました。
- `DSH_OC_HTTP_LOG=1` で HTTP リクエストのトレースを有効にしました。リクエストが届くたびに
  `[bridge/http] <METHOD> <path>` を 1 行 stderr へ出力します。ブラウザがないときにブラウザ UI の
  API 呼び出しパターンを確認するためのデバッグ手段です。
- セッションの revert（回退）を OpenCode 2.1.0 のセマンティクスで実装しました。ルートは
  `POST /api/session/:id/revert/stage`、`DELETE /api/session/:id/revert`、
  `POST /api/session/:id/revert/commit` の 3 つ、SSE イベントは `session.revert.staged` /
  `session.revert.cleared` / `session.revert.committed` の 3 つです。境界は排他です。指定した
  メッセージとそれ以降のメッセージは commit 時にまとめて破棄し、`POST /api/session/:id/fork` の
  `before` も同様に排他です（dsh の fork は `atSeq` を含むイベントの前方部分をコピーするため、
  切れ目は境界メッセージの 1 つ前のイベントになります）。commit はその切れ目で dsh セッションを
  fork し、opencode のセッション id はその fork に追随します（エイリアス）。以降の dsh 呼び出しは
  fork へ書き換えられ、セッション一覧は元の id で fork を公開して置き換えられたセッションを捨て、
  `GET /api/session/:id` と `/message` は fork の要約と履歴を読み、fork の SSE イベントは元の id へ
  書き戻し、セッションレベルの状態（モデル、agent preset、タイトル、メッセージ id の対応）は fork が
  継承します。ファイルは dsh のターン単位でグループ化してロールバックします。stage の時点で境界
  より後のターンが変更したファイルをその場でロールバックして diff を報告し（clear は元に戻し、
  commit はロールバック結果を残します）、境界がユーザーの prompt のときはそのターンも含めて
  ロールバックします。OpenCode と同じく、次の prompt が届くとまずステージ済みの回退を commit し、
  prompt はその後に書き換え後のセッションへ届きます。
- セッションの revert（回退）の既知の制限です。dsh は空の fork を表現できないため、切れ目が
  最初のメッセージより前にある場合は 400 `cannot cut before the first message` を返します。
  ファイル diff は最初と最後の変更行の間をまとめた粗い hunk（bridge 自身のファイル変更 diff と
  同じ形）で、完全な LCS diff ではありません。
- `scripts/e2e-revert-flow.mjs`（`pnpm run e2e:revert`）と `tests/e2e/revert.spec.ts` を追加しました。
  実 bridge に対して stage → clear → stage+commit → 次の prompt の 1 巡を実行し、境界が排他で
  あること、メッセージ id が保たれること、セッション id が変わらないこと、同じセッションで
  2 回目の巻き戻しも効くことを検証します。
- e2e ドライバの dsh 0.2.1-rc.2 に対するずれを修正し、公式 TUI の実機 e2e が実際に動くように
  しました。既定のプロキシは `127.0.0.1:14514` が実際に応答するときだけ有効にします（そうでないと
  pnpm が tunnel error を出します）。dsh プロセスは `--profile oc` で照合します（dsh は現在
  `node .../dsh/lib/bin.js --profile oc` です）。TUI の起動時に dsh の `--print-logs` を渡さなく
  なりました（ログが TUI の alternate screen を覆い、pane の取得で入力欄が見えなくなります）。
  mock LLM サーバーを `0.1.0-rc.6` から `0.2.1-rc.2` へ上げました（前者は
  `dsh-invariants@^0.1` を要求し、プラグインマネージャーに拒否されます）。設定ダンプの検査は
  `agent-preset-registry` + `agent-preset` を認識するようにしました（dsh 0.2 が `agent-presets` を
  分割したため）。終了後のシェルプロンプトの判定には powerline の形も加えました。
- 2 回目以降の巻き戻しを修正しました。rewind プラグインの fork が先にエイリアスを解決し、bridge も
  解決後の dsh セッション id でファイルスナップショットを取得するため、ファイル集合が空に
  ならなくなりました。
- 公式 OpenCode 2.1.0 へアップグレードしました。固定バージョンは `2.1.0`、`@opencode/client` も
  `2.1.0` に揃え、プロトコルプローブの基準は 138 ルートで録り直しました。2.0.32 と比べた 2.1.0 の
  契約差分は 1 件の追加（`PATCH /api/permission/saved/:id`、記憶済みの許可を狭める用途）だけで、
  bridge はこのルートを実装済みです。残りは型の改名（`SessionMessageProviderState` を
  `SessionMessageNative` へ）と新しいイベント型（`session.archived` / `session.unarchived`。dsh に
  アーカイブの概念がないため現時点では送りません）です。
- 公式 OpenCode 2.0.32 へ移行しました。TUI の起動は `opencode attach <url>` から
  `opencode --server <url>` へ変わります（`--mini` は `opencode mini --server <url>`）。2.x の CLI は
  `attach` サブコマンドを削除したため、旧記法は "Help requested" で失敗します。
- v1 HTTP レイヤーを削除しました。`/session`、`/config`、`/provider`、`/global/event`、`/vcs*`、
  `/permission`、`/question`、`/path`、`/project/*` はすべて廃止し、`/api/*` だけを残しました。
  OpenCode 2.x クライアントが呼ぶ 137 ルートには bridge がすべて応答します
  （`scripts/check-client-routes.mjs` が `missing: 0` を検証します）。
- SSE の契約です。イベントストリームは `server.connected` で開く必要があり（2.x クライアントは
  これで始まらないストリームを拒否します）、その後に `Last-Event-ID` のリプレイと status/control
  スナップショットの再生を行います。このフレームはリプレイ ring に入れません。
- イベントの語彙です。bridge は 1.18.18 の形のイベントを出し続けながら、2.x のネイティブ語彙
  （`session.text.*`、`session.tool.*`、`session.step.*`、`session.execution.*`、`session.inbox.*`、
  `permission.*`、`form.*`、`session.compaction.*`）を追加します。組み込み TUI と OpenChamber UI は
  同じストリームを読みます。
- e2e とドキュメントを同期しました。スクリプト内の TUI 起動コマンドを `--server` 形式に変え、
  v1 ルートは `/api/*` の等価ルートへ置き換え、バージョンの検証は `2.0.32` にしました。
  `docs/PROTOCOL.md`、`docs/FEATURES.md`、README も 2.x の記述に更新しました。
- リリース後のローカルインストール resolver を修正しました。dsh-oc の codeload SHA だけを解決し、
  dsh-dcp などの他のパッケージと区別します。`rg` がないときは隔離環境で検証した grep の
  fallback を使い、走査の失敗や SHA の欠落・曖昧さでは fail-closed にします。

## [0.2.0-rc.4] - 2026-09-11

この候補は dsh `>=0.1.5-rc.2` を対象とし、host ABI の破壊的な適応を含みます。dsh 0.1.5 は
session-controller の依存と assistant のストリーミングイベントモデルを変えたため、dsh 0.1.2 以前とは
互換性がありません。リリースとリモートの不変識別子は最終的な GitHub の notes に従います。

- profile が起動できない問題を修正しました。dsh 0.1.5 の `dsh-api-session-controller` は
  `fileUploads` を必須依存として追加したため、oc-bridge は headless provider
  `@chiro2001/dsh-oc/file-uploads` を順序どおりに挿入するようになりました。`bindPrompt` は
  `Symbol.dispose` を持つバインディングを返し、0.1.5 の明示的なリソース管理を満たします
  （満たさないと prompt は `session/agent-busy` + `TypeError: Object not disposable` で失敗します）。
- ライブストリーミングを移植しました。削除された `assistant/chunk` セッションイベントは、
  グローバル購読の `agent/assistant-stream` フレームに置き換えました（attempt の `start` で
  turn/step を記録し、`chunk` は元の chunk 変換を再利用し、`end` で attempt を回収します）。
  start を持たない遅延フレームは安全に破棄します。
- ストリーミング中の history 読み取りに対応しました。0.1.5 は in-flight の chunk を永続ログに
  書かなくなりました。そこで bridge は translator の live provisional assistant（id/created/
  テキストブロック、`time.completed` は未設定）を v1/v2 history のレスポンスにマージし、TUI と
  queue-live oracle の in-flight 契約を保ちます（`scripts/e2e-tui-queue-live.sh`）。
- 最初のターンの agent/model ラベルを修正しました。live provisional の SSE カード、prompt
  レスポンスの placeholder、ストリーミング中の v1/v2 history は `build`/`deepseek-chat` を
  ハードコードせず、セッションに記録済みの preset とモデル選択を使います。prompt がモデルを
  持たない場合は配備の既定モデルへフォールバックします（`placeholderSessionOptionsForPrompt`）。
  shell が合成するカードも同様にセッションのモデルを優先します。TUI が既定 agent `build` を
  マップする部分は `applyAgentFromBody` が配備の既定 preset に解決するため、最初のターンから
  実際の preset が表示されます。
- 履歴を移植しました。`SessionHistoryRecord` の `chunks` レコードは、埋め込みの
  `assistant/message.stream` / `assistant/attempt.stream` に置き換わりました。`expandRecord` は
  packed run を `text-chunks`/`reasoning-chunks`/`tool-call-chunks` の行へ戻し、raw の
  `block-start`/`block-end`/`finish` からパートの所要時間と finish reason を復元します。
  `assistant/attempt` は live でも履歴でも TUI の surface を生成しません。
- ファイルツールを dsh 0.1.5 に適応させました。`write`/`edit`（`dsh-tool-fs`）は新規ファイルや
  presentation を再生できない場合に呼び出し引数から diff を合成し、opencode の edit カードは
  引き続き `metadata.diff` を持ちます。`tests/e2e-tui-tools.sh` の untracked write シナリオは
  `write` ツールを使うように変えました。
- 依存とゲートを更新しました。devDeps を dsh 0.1.5-rc.2 / cordis 4.0.2 へ上げ、peer の範囲を
  `>=0.1.5-rc.2` に絞りました。CI は dsh 0.1.5-rc.2 に固定し、`pnpm install` の prerelease 例外は
  pnpm が `pnpm-workspace.yaml` で管理します。replay コーパスと perf セッションの生成器は
  0.1.5 のイベント形状（session format v3）へ更新しました。
- 復元のセマンティクスです。0.1.5 は未決済のストリーミング内容を永続化しないため、クラッシュ
  復元後にそのターンに assistant メッセージがないことがあります。`e2e-recovery-crash.sh` の
  oracle は「再起動後のグラフは永続化済みの前方部分 + クラッシュした attempt を捏造しない +
  新しいターンは exactly-once」に変え、idle であることと残留プロセスがないことも引き続き
  検証します。
- ローカルのゲートはすべて通りました。`pnpm typecheck`、438 個の単体テスト（23 ファイル）、
  probe 63/63、`perf smoke (200)`、リリース成果物の監査（クリーン再ビルドで差分ゼロ、pack に
  絶対パスなし）、`scripts/check-all.sh --e2e` の e2e 39/39 が初回で PASSED、retry は 0 回でした。
  5000 セッションの負荷試験は
  [docs/perf/results-2026-09-11-rc4.md](perf/results-2026-09-11-rc4.md) にあります。

## [0.2.0-rc.3] - 2026-09-08

この候補は dsh `>=0.1.2-rc.1` を対象とします。リリースとリモートの不変識別子は最終的な
GitHub の notes に従います。

- 公式 OpenCode 1.18.18 の prompt にあるトップレベルの `variant` の解釈を修正しました。
  `max`/`off` は複数ターンにわたって引き継がれ、variant を省略した Default は dsh バックエンドの
  既定へ正しく戻ります。セッション、ユーザーカード、live/queued の SSE、v1/v2 history における
  実際の model effort は同期したままです。
- max/max、off/off、max→Default の bridge optimistic-card 回帰を追加し、実 host API の e2e で
  session/history/live の model ref を決定的に検証するようにしました。
- TUI での手動による max/off の複数ターン検証は通りました。ローカルの決定的な host oracle は
  さらに provider のリクエスト body を検証します。max は
  `thinking.enabled + reasoning_effort=max`、off は `thinking.disabled` で `reasoning_effort` を
  持ちません。
- ローカルのフルゲートは 435 個の単体テスト、63/63 のプロトコルプローブ、perf smoke、成果物の
  監査、39 個の e2e（実 TUI、recovery、golden trace を含む）を対象とし、すべて初回で通り
  retry はありませんでした。
- リモート CI のフィードバックから 2 件のゲート問題を修正しました。permission の TUI 選択状態は
  テーマに依存しない ANSI 前景のシグネチャで同期するようにし、成果物のパススキャナは `rg` が
  ない環境で fail-closed にして回帰テストを追加しました。

## [0.2.0-rc.2] - 2026-09-08

このバージョンは dsh `>=0.1.2-rc.1` を対象とし、Issue #4/#5 とリリース前の安定化を含みます。

- 公式 OpenCode の `!` shell モードを追加しました。`POST /session/:id/shell` は dsh Agent の
  `runMaintenance` で idle の所有権を確保し、そのうえで現在の OS ユーザーとして正確な shell
  サブプロセス/プロセスグループを起動します。dsh の approval/sandbox を迂回せず、迂回したふりも
  しません。running/completed/error、abort、busy/idle、`session.idle` の exactly-once、bridge の
  history 投影にはいずれも回帰テストがあります。完了後は `Agent.inject()` により、
  `plugin: dsh-oc` の印を付けたユーザーの手動コマンドと stdout/stderr を次のモデル prompt へ
  注入しますが、モデルのターンを自動で開始はしません。モデルへの注入には独立した UTF-8 の
  予算があり、注入に失敗したときは可視の警告を shell カードへ書きます。コマンドと出力には
  機密情報が含まれうるため、現在設定されているモデルへ送られます。ルートプローブ、実 TUI +
  mock モデルの e2e、プロトコルの説明を追加し、フル e2e と手動の TUI で検証しました。
- `/preset` の切り替え後の synthetic command result に完了時刻がなく、公式 TUI が
  `preset switched to ...` カードを次のターンまで `QUEUED` と表示し続ける問題を修正しました。
  切り替えカードは切り替え後の実際のモデル/variant も返すようになりました。bridge の単体
  テスト、v1/v2 history、実 TUI の回帰検証を追加しました。

## [0.2.0-rc.1] - 2026-09-07

> この候補は dsh `>=0.1.2-rc.1` を対象とします。PR #1/#2/#3 はそのまま取り込んでいません。
> 有効な修正と dsh 0.1.2 への移行は意味レベルで再統合し、現在のブランチは独立した RC 候補です。

### 変更

- bridge は旧 `apiProxy` envelope から、dsh 0.1.2 の `sessionController`、`agentPresets`、`goals`、
  `sessionSkillCatalog`、`agents`、`sessions`、`sessionProjections` という host services へ
  移行しました。
- モデル選択、既定モデル/preset、キューの可視性、approval/question、subagent の lineage、history の
  ページネーション、dsh 0.1.2 の error ABI を再統合しました。安定した v1/v2 の OpenCode
  プロトコル surface は維持しています。
- `Last-Event-ID` に対応する有界の SSE ring（イベント数とシリアライズ後のバイト数の両方に上限）を
  追加しました。切断前のカーソルが ring に残っていれば不足分のイベントだけを再生し、追い出された
  カーソルや未知のカーソルは status/control スナップショットへフォールバックします。
- `/session/status` は dsh の `api-session/status` で駆動するメモリ上のホットパスに変えました。
  コールドスタート時の `session.list` seed は有界で最大 1 回にし、公式 TUI の 250ms 待ちポーリングが
  全量の永続 I/O を引き起こすのを避けます。
- OpenTUI native の一時ファイルは `$DSH_HOME/opencode/tmp/tui-<pid>` へ隔離しました。正常終了時に
  削除し、次の起動時に終了済みインスタンスを回収します。任意のプラグインキャッシュを探索せず、
  公式バイナリの検証も無効にしません。
- dsh-dcp rc.6 の `session.events` 互換 getter は当面残し、dcp が dsh 0.1.2 の peer/API 移行を
  終えた時点で削除します。
- 安全な既定値を持つ `scripts/monitor-process-io.sh`（observe-only。スクリプト自身が `setsid` で
  起動し検証したプロセスグループだけを後始末できます）と、fake attach の idle 回帰を追加しました。

### 検証

- typecheck、418 個の単体テスト、プロトコル probe fixture の全件、5000 セッションの性能試験、
  リリース成果物の監査、実 TUI のフル e2e が通りました。probe の基準は rc.1 のリリース時が 62/62、
  shell ルートを追加した rc.2 のリリース時が 63/63 です。高リスクの flake スキャンは初回 30/30 で
  retry はありませんでした。
- GitHub CI、full-SHA のコールドインストール、実 TUI smoke、同一 ABI でのロールバック演習、
  実際の DeepSeek による quick smoke が通りました。リリースの四つ組とハッシュは GitHub の
  prerelease の説明にあります。

### リリース前の収束

- dsh の `subagent` / `subagent_fork` をネイティブの OpenCode `task` カードへ変換し、delegation と
  child session の lineage を保つようにしました。実 TUI の Task ナビゲーション回帰を追加しました。
- optimistic user / provisional assistant のメッセージ時刻の同一性を固定し、最初の返信や
  reasoning/tool カードが二重に描画される問題を修正しました。実 TUI ではツールカードに
  exactly-once を検証します。
- crash recovery では tmux の親子 PID の厳密な照合、run 単位の残留物チェック、observe-only の
  flake スキャンを強化し、名前で外部の orphan プロセスを操作しないようにしました。
- GitHub の e2e workflow は dsh `0.1.2-rc.1` に固定し、perf の起動失敗は即座に報告します。
  full-SHA のインストール/ロールバックは lockfile の実際の commit を検証し、旧 dsh ABI との
  同時ロールバックが必要であることも記録します。
- v2 のセッション要約/履歴は child の label か parent-local の FIFO で紐づけ、`metadata.origin` を
  保つようにしました。同じ親と同じ説明を持つ複数の child を取り違えて再利用しません。

### 修正

- ユーザーの prompt を dsh の `mode: 'steer'` で送るようにしました。実行中のターンは次の step の
  境界で挿入されたメッセージを見られるため、公式 opencode の「セッションの流れに追記し、loop が
  次の step で処理する」セマンティクスと一致します。以前はすべて `mode: 'queue'`（next-turn）
  だったため、挿入したメッセージはターン全体が終わる（または abort される）までモデルに
  見えませんでした。実際のセッション e0336d8b では、ユーザーが論文の正確なタイトルを示した後も
  モデルが約 4 分間検索を続けました。busy のときに prompt が steer で届くことを新しい回帰単体
  テストで固定し、キュー関連の e2e（QUEUED バッジ、FIFO、golden trace）はすべて通りました。
- モデル選択が最初のターンの後に既定モデルへ戻らなくなりました。TUI はセッションを切り替える
  とき「最後のユーザーメッセージ」から prompt のモデルを復元しますが、bridge はユーザー
  メッセージ（履歴とキューのエコーカード）をすべてモデルカタログの先頭項目
  （deepseek-v4-flash）として扱っていたため、2 回目の質問が黙って flash に戻っていました。
  履歴とエコーはセッションの現在のモデル（`session.models`）か prompt body が持つモデルを使う
  ようになりました。「Pro が最初のターン後に flash へ戻らない」ことを 2 本の回帰単体テストで
  固定しています。

## [0.1.0] - 2026-08-18

### 追加

- `CONTRIBUTING.md` の自己テスト基準に、リリース/ビルド成果物の監査項目を追加しました。
- `.github` のテンプレートを更新しました。bug 報告は `dsh-oc --version` を使い、PR の自己テスト
  チェックリストには成果物の監査とフル e2e の選択肢を加えました。
- `bridge-router.spec.ts` に「ページ間でメッセージを追記する」カーソル契約テストを追加しました。
  1 ページ目の後に新しいターンを追記しても、旧ページのカーソルは変わらず、重複もなく、全量の
  読み取りでは追記した内容がちょうど 1 回だけ含まれます。
- `bridge-router.spec.ts` にページ境界の不変条件テストを追加しました。`limit` がツールのターンを
  またぐとき、`after`/`next` は変換済みメッセージの最も古い seq を基準にし、ツールイベント
  （tool/call、tool/result は独立したメッセージになりません）はまとめて同じ側のページに入ります。
  ページをまたいでマージした後、ツール part はちょうど 1 回だけ現れ、状態は completed です。
- `AGENTS.md` の e2e 所要時間の記述を更新しました（安定版のスイートは約 15–20 分に広がっています）。
- `docs/ROADMAP.md` の LATER の説明を修正しました。`/api/credential/*` に対応する dsh の
  `credentials.describe/set/unset` RPC は実際に存在しますが、opencode SDK 1.18.18 に消費する
  ルートがないため、上流のプロトコルが現れるまで LATER のままにします。
- `docs/RELEASE.md` に「現在の候補の準備状況（12ca493）」のまとめを追加しました。ローカル/CI の
  ゲート、flake/性能/実モデル/インストール経路/帰属実験の根拠を一覧できます。
- `dsh-oc --version` は dsh がないときも他の経路と同じ挙動になりました。終了コード 127 で
  インストールの案内を出力します（以前は 1 で終了し、案内もありませんでした）。bin の単体
  テストを追加しました。
- `docs/PROTOCOL.md` に v2 のルート表を補完しました。`/api/session/{id}/history`（`after` は
  排他的な上界 + `next` カーソルのセマンティクス）、`prompt`/`model`/`agent` エンドポイントを記載し、
  ページをまたぐページネーションの不変条件も注記しました。
- `e2e-tui-turn.sh` にツール part の exactly-once 検証を追加しました。履歴の中で bash の
  ツールカードは 1 回しか現れてはいけません（「動的なツール呼び出しが 2 回表示される」回帰項目）。
- `e2e-tui-preset-inherit.sh` を追加しました。会話の前に `/preset minimal`（選択肢の確定で Enter を
  含む）を実行してから新しいセッションを作り、新しい dsh セッションが minimal preset を継承する
  ことを検証します（「会話前の /preset で preset を変えられない」回帰項目）。安定版スイートに
  入り、ローカルで 3/3 通りました。
- `scripts/update-local-install.sh` を追加しました。ローカルの dsh profile を指定した GitHub ref へ
  1 コマンドで更新し、解決された commit と `dsh-oc --version` の 2 つのバージョン出力を検証します。
- 成果物の監査に pack 内容の検証を追加しました。tarball に `src/` を含めてはいけず、
  `bin/dsh-oc.mjs`、`lib/index.js`、`lib/bridge/router-entry.js`、`opencode-version.json`、
  `cordis.patch.yml` がパッケージ内に必要です。
- `e2e-queued-order-repro.sh` の安定性を修正しました。2 つ目の prompt はツール part が完了した後
  ではなく現れた時点で送るようにし、busy の窓の中に確実に入れて QUEUED バッジが必ず出るように
  しました。後続のテキストは 15 セグメントに増やしています。ローカルの flake スキャンは 10/10 通り
  （1 回 48 秒）、CI の slow runner で起きていた "queued prompt not shown" の失敗を解消しました。
  queued-followup のゴールデン基準は新しいシナリオ（180 イベント）へ更新しました。
- 5000 セッションの性能基準を記録しました（commit `609ccd6`）。一覧/メッセージ/履歴/
  ページネーション/タイトル補温/RSS のデータは docs/perf/results-5000-2026-08-17.md にあり、
  8 月 15 日の基準と同じ桁です。
- `e2e-real-llm.sh` の検証を強化しました（round-0002 で実回帰が弱いと指摘されたため）。queue probe
  は user の総数を数えるのではなく、FIFO の内容順を検証します（2 つ目の prompt が最後の user
  メッセージで、最後の返信が要求した 2 文字の答え「完成」を含む）。TUI のキーボード入力は配送と
  返信の idle を待ち、user メッセージがちょうど 1 件増えることとパネルに記録が残ることを
  検証します。あわせて TUI の段階で bridge の URL が更新されない潜在バグを修正し、
  `wait_idle`/カウント関数が一時的な API 失敗に耐えるようにしました。
- flake の統合基準です。最小の高リスクスクリプト 6 本を各 10 回、合計 60 回の初回実行がすべて
  通りました（現在の HEAD）。結果は docs/perf/results-flake-consolidated-2026-08-17.md にあります。
- `e2e-cli-bin.sh` に `dsh-oc --version` の検証を追加しました。出力は
  `dsh-oc <semver> (dsh <version>)` の 2 バージョン形式でなければなりません。
- `SseHub.enqueue` を変更しました。クライアントが接続していないときはイベントをバッファし、
  最初の SSE クライアントが接続した時点で即座に流します（raw リプレイ/復元のシナリオで遅れて
  接続してもイベントを失いません）。バッファと即時ブロードキャストの挙動を単体テストで
  固定しました。
- 最小サーバーが raw SSE の直接再生モード（`minimal-oc-server.mjs --sse <trace.raw>`）に
  対応しました。録画した bridge の SSE イベントを元の順序で公式 TUI へブロードキャストします。
  再現ドライバはカスタム marker、イベント遅延、CJK ヒューリスティック、キャプチャ時間
  （`DSH_OC_MINIMAL_*`）に対応します。実際のセッションの生 JSONL と bridge の SSE トレース全体の
  再生はどちらも接続済みです。fixture の再生は描画順が正しく、raw の直接再生では公式 TUI の
  `/global/event` 接続が短命のプローブだと分かりました（fixture モードは接続内のストリーミング
  イベントが窓の中で届くことを前提にし、外部からのブロードキャストでは窓が短すぎます）。そのため
  現時点では会話を描画せず、今後の実験項目としています。キー区間を切り出して 80ms で低速再生して
  も描画されないため、raw 直接再生の路線は閉じました（ツールは残します）。raw モードでは mux を
  保留したままにし、bridge 側から能動的に切断しないようにしています。`e2e-real-queued-order.sh` は
  最初の prompt の前から `/global/event` のトレース全体を録るように変え、実モデルで wire の前提を
  3 回連続で再現しました。
- 公式の最小サーバーによる帰属 harness を追加しました。`scripts/minimal-oc-server.mjs` は bridge の
  コンポーネントとスクリプト化したイベント列（dsh なし、実モデルなし）で OpenCode 互換の surface
  全体を提供し、`scripts/e2e-minimal-server-repro.sh` が公式 1.18.18 TUI の attach を駆動して
  キュー/後続テキストの順序をフレーム単位で分析します。初回実行では公式 TUI の描画順は正しく、
  後続テキストがキューカードの上に来ました。bridge には harness 用のビルドエントリ
  `src/bridge/router-entry.ts` を追加し、`createBridgeRouter`/`startBridgeServer` をエクスポートします。
- 実モデルでのキュー順序の再現 `scripts/e2e-real-queued-order.sh`（manual、実際の DeepSeek API）を
  追加しました。ツールの完了直後に 2 つ目の prompt をキーボードからキューし、bridge の SSE の
  時系列の根拠（後続テキストの delta がキューのユーザーイベントの後に届くか）とストリーミング
  パネルのフレームを記録します。2 回連続で `wire_follow_after_queued=1` となり、パネルの 45/50
  フレームで返信内容がキューカードの下に描画されました。あわせて
  e2e-real-llm/e2e-real-queued-order の `DSH_OC_REAL_KEEP_RUN=1` の後始末ロジックを修正しました
  （以前は逆で、keep のときに削除していました）。
- 候補 opencode の upgrade lane `scripts/upgrade-lane.sh` を追加しました。候補バイナリでゴールデン
  シナリオを実行し、正規化した SSE トレースを 1.18.18 の基準と意味差分します（`--bin`/`--out`）。
  同一バージョンでは差分ゼロを確認します。バージョン検査のバイパス
  `DSH_OC_BYPASS_VERSION_CHECK=1` は lane のシナリオにだけ作用し、本番の経路では引き続き
  バージョン一致を強制します。
- 順序の再現記録 `scripts/e2e-queued-order-repro.sh` を追加しました。ツールと低速ストリームの
  後続テキストの間に 2 つ目の prompt をキーボードからキューし、公式 TUI のパネル順をフレーム
  単位で取得して（一過性の順序ずれを検出）、2 つ目の 1.18.18 ゴールデン SSE 基準
  `tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl` を凍結します。mock 駆動の連続実行では
  一過性の順序ずれは観測されず、renderer/bridge の帰属の根拠として記録しました。
- 1.18.18 のゴールデン SSE トレース基準を追加しました。`scripts/e2e-golden-trace.sh` が実 TUI で
  「ツール + 後続テキスト」のシナリオを実行し、観測用の SSE でトレースを録ります。
  `scripts/normalize-golden-trace.mjs` が正規化し（ランダムな id、絶対時刻、マシンのパスを除去）、
  基準を `tests/fixtures/golden/` へコミットします。繰り返し実行しても構造は一致し、安定版
  スイートに入っていて、今後の vendor 更新の意味差分に使います。
- 最小の permission e2e `scripts/e2e-tui-permission-mini.sh` を追加しました。実 TUI で Allow-once を
  1 巡（ダイアログ → 承認 → ツールの完了 → 返信はちょうど 1 回 → 権限の残留なし）行い、10–11 秒
  です。安定版スイートに入り、flake スキャンは 10/10 通りました。
- flake スキャンの 2 巡目です。`e2e-tui-queue-live.sh` と `e2e-tui-agent-tab.sh` を各 10 回
  初回実行し、すべて通りました（CI でたまに flake していた 2 本です）。結果は
  docs/perf/results-flake-tui-2026-08-17.md にあります。
- 実セッションの feature カバレッジ走査 `scripts/replay-corpus-manifest.mjs` を追加しました。
  イベント型と特徴の件数だけを出力し、実際の内容には触れません。64 個の実セッションにある
  12 の特徴はすべて合成コーパスでカバーされています（long-session は spec が実行時に生成して
  カバーします）。レポートは docs/perf/coverage-real-sessions-2026-08-17.md にあります。
- 決定的な replay コーパス（実験 1c）を追加しました。`scripts/build-replay-corpus.mjs` が構造を
  保った合成 fixture 10 個（reasoning、単一/複数ツール、キュー、ツールエラー、compaction、中断、
  goal、plugin-context、session-title、unfinished-turn）を `tests/fixtures/replay/` へ生成し、
  `tests/replay-corpus.spec.ts` が replay を監査します。未処理や変換エラーがないこと、ツール
  呼び出しが対になり終端状態であること、live の完了状態が durable と一致すること、durable の
  v1/v2 メッセージ面が一致すること、実行時に 10k イベントの長いセッションを扱えることを
  確認します。
- 予算付きの flake スキャン `scripts/flake-mini-scan.sh` を追加しました。最小の高リスク e2e
  スクリプトを N 回（既定 10）繰り返し、最初の失敗と所要時間を記録します。意味のある失敗では
  即座に停止し、retry はしません。復元の 3 つの故障ドメインは初回の各 10 回がすべて通りました
  （結果は docs/perf にあります）。
- 復元 oracle にクラッシュのセマンティクスを追加しました。`recovery_assert_crash_prefix` は、
  再起動後のグラフが観測グラフの完全なメッセージ前方部分であるか、同じ長さのときに最後の
  テキスト part が観測テキストの前方部分であることを許容します（SIGKILL が最後の chunk の
  書き込み境界の内側に落ちるのは正常なクラッシュ整合性で、データ損失ではありません）。
- リリース成果物の監査 `scripts/verify-release-artifacts.sh`（`check-all` のゲートに含まれます）を
  追加しました。HEAD のソースからクリーンに再ビルドし、コミット済みの `lib/` との差分がゼロで
  あることを検証します。npm pack を走査してマシンの絶対パスを探し、パッケージのバージョン、
  tarball の sha256、package-tree のハッシュを出力します。
- インストール/アップグレード/ロールバックの演習 `scripts/e2e-install-rollback.sh`（manual）を
  追加しました。リモートの GitHub full SHA から候補をコールドインストールして実 TUI の smoke を
  実行し、前の版の spec へロールバックして再実行し、同じ profile 内で re-add の挙動を調べます。
  バージョンを上げる前の in-place の結果はコマンド経路の検証にとどまります。
- 復元の故障ドメイン e2e マトリクスを追加しました。
  - `scripts/e2e-recovery-crash.sh` は低速ストリームの途中で dsh を SIGKILL し、`--session` で
    再起動した後に、永続化済みの前方部分が exactly-once であること（失わない、完了を捏造しない）、
    セッションが idle に戻ること（必要なら実行中のターンを明示的にキャンセルします）、新しい
    prompt で続行できること（20 秒）を検証します。
  - `scripts/e2e-recovery-sse-reconnect.sh` は観測用の SSE を切断して再接続し、再接続後も
    イベントを受け取り続けることと、最終的な v1/v2 のメッセージグラフが exactly-once であること
    （13 秒）を検証します。
  - mux 再購読の単体テストです。translator を作り直しても、再生される text-chunks は接続
    レベルの replay guard で重複排除され、delta を 2 回送りません。
- 復元の検証 helper を `tests/e2e/recovery-lib.sh` に集約しました（v1/v2 のシグネチャ、権威ある
  idle、前方部分/完全一致の比較）。`e2e-recovery-consistency.sh` も同じ oracle を使います。
- `GET /api/session/{id}/history` を追加しました。SDK v2 の履歴エンドポイントで（`limit` +
  `after` のイベント seq カーソル）、`{ data: SessionMessage[], hasMore, next }` を返します。
  `after` は排他的な上界で（dsh ネイティブの `beforeSeq`、後方へページを送ります）、1 ページの
  遅延は有界です。v2 のメッセージ変換にはメッセージのアンカー seq を記録し、`after` が負の値なら
  400 を返します。
- バックグラウンド subagent の能力を有効にしました。`GET /experimental/capabilities` が
  `{ backgroundSubagents: true }` を返し、`POST /experimental/session/{id}/background` を no-op の
  成功ルートとして追加しました（dsh のセッションはサーバーに常駐し、`subagent` ツールは既定で
  バックグラウンドで動きます）。
- `GET /session/{id}/children` を追加しました。`parentSessionId` で subagent の子セッションを
  一覧し、バックグラウンド subagent の能力と組み合わせて TUI の subagent ツリーの問い合わせに
  使います。
- `GET /experimental/session` を追加しました。GlobalSession の一覧で（search/ディレクトリでの
  絞り込み/limit による部分取得に対応）、experimental のセッション一覧面を補完します。
- `POST /session/{id}/init` を追加しました。no-op で `true` を返します（dsh のセッションは作成時に
  初期化されます）。
- `GET /session/{id}/message/{messageID}` を追加しました。単一メッセージの問い合わせで（v1 の変換を
  再利用し、見つからない場合は 404 を返します）。
- `POST /session/{id}/permissions/{permissionID}` を追加しました。SDK v2 の権限返信の別名で
  （body は `response` フィールドを使います）、同じ `permissionReply` にマップします。
- `GET /api/health` を追加しました。`{ healthy: true }` を返し、クライアントの死活確認に使います。
- `GET /api/session/active` を追加しました。現在のアクティブセッションを返します
  （`{ data: { [sessionId]: { type: "running" } } }`）。
- `POST /api/session/{id}/wait` を追加しました。セッションが idle になるまで有界にポーリングして
  待ちます（30 秒以下、idle なら 204）。
- `GET /api/session/{id}/context` を追加しました。`{ data: SessionMessage[] }` を返します（v2 の
  メッセージ変換を再利用します）。
- `GET /api/session/{id}/event` を追加しました。セッションで絞り込んだ SSE イベントストリームです
  （`/global/event` の部分集合）。
- `GET /api/session/{id}/message/{messageID}` を追加しました。v2 の単一メッセージの問い合わせです
  （`{ data: SessionMessage }`）。
- `GET /api/provider/{id}` を追加しました。単一 provider の問い合わせです
  （`{ location, data: ProviderV2Info }`）。
- SDK v2 の権限面を補完しました。`GET /api/permission/request`、`GET /api/question/request`
  （グローバルの pending 一覧、`{ location, data }`）、`GET /api/session/{id}/permission/{rid}`
  （単一の問い合わせ、セッションが一致しない場合は 404）、`DELETE /api/permission/saved/{id}`
  （`sessionID:toolName` のメモリ上の許可を削除）を追加しました。`GET /api/permission/saved` の
  出力は SDK の `PermissionSavedInfo`（`projectID/action/resource`、`sessionID/grantedAt` は保持）に
  揃えました。
- 実際の VCS 面を追加しました。`GET /vcs`、`GET /vcs/status`、`GET /vcs/diff`、`GET /vcs/diff/raw` を
  stub から実際の git 読み取りへ上げました（現在のブランチ、origin の既定ブランチ、staged+unstaged
  のファイル状態と行数、ファイル単位/生の unified diff。untracked は status に入りません）。
- ワークスペースのファイルシステム面を追加しました。`GET /api/fs/read/{path}`（生バイト、範囲外の
  パスは 400、1 ファイル 5 MiB の上限）、`GET /api/fs/list`、`GET /api/fs/find`（再帰検索、
  依存/ビルドのディレクトリを飛ばして結果数を制限）です。ルートの照合には末尾 `*` のワイルドカード
  対応を追加しました。
- ライフサイクル面を追加しました。`GET /global/health`（`{ healthy: true, version }`）、
  `POST /global/dispose`、`POST /instance/dispose`（no-op で確認を返し、プロセスは dsh が管理します）。
- セッション一覧の実際のタイトルの補読を追加しました。dsh の `session.list` は title の投影を
  返さないため、bridge はセッションごとに history tail の投影から補読してキャッシュします
  （40 件以下は全量を同期、それより多い一覧はブロックせず、バックグラウンドで低並列に直近 24 件を
  並列度 2 で補います）。復元した古いセッションも終了時の案内で正しく識別されます。
- Esc による中断/キャンセルを追加しました。`turn.wait` / `turn.idle` イベントが TUI の実行状態を
  駆動します。フル TUI で Esc を 2 回続けて押すと、`--mini` で 1 回押すと `session.cancel` を呼び、
  実行中のストリームを止めます。
- `/preset` の新規セッションへの継承を追加しました。最後に選んだ agent preset が、以降の `/new` で
  作るセッションに適用されます。切り替え後は新しい agent を持つ `session.updated` を
  ブロードキャストします。
- 終了時の案内を追加しました。opencode 公式の終了 splash（フル/`--mini`）は置き換えられないため、
  dsh-oc はセッションに内容があるときその下に 1 行の説明を出力します（セッション id は dsh の
  もので、復元は `dsh --profile oc --session <id>` で行います）。`DSH_OC_DISABLE_EXIT_NOTE=1` で
  無効にできます。

### エンジニアリング

- CI の e2e は各スクリプトを `timeout -k` 付きで実行します（既定 300 秒、`E2E_TIMEOUT` で上書き）。
  ハングしたスイートは早く失敗して 1 回だけ retry し、job 全体を止めません。
- CI の失敗成果物はまとめてアップロードします（`node_modules` と `work/.git` を除外）。
  アップロードの手順には 5 分の制限を付け、`.e2e` のアップロードが何時間もハングしないように
  しました。
- `scripts/cleanup-merged-branches.sh` はローカルとリモートのマージ済みブランチを同時に列挙する
  ようになりました（dry-run で `origin/feat-*`、`origin/chore-*` などの残骸を一覧できます）。
  `--apply --remote` でまとめて削除できます。
- `CONTRIBUTING.md`、PR/Issue のテンプレート、ブランチ戦略（main はリリース、develop は統合、
  機能ブランチは短命）を追加しました。
- CI を追加しました。`main`/`develop`/`feat-*`/`fix-*`/`docs-*`/`perf-*`/`test-*`/`chore-*` への
  push で安定版の e2e スイートを自動実行し（`CI_E2E_SUBSET=1`）、手動実行ではフル e2e と負荷試験を
  行います。
- M5 のリファクタリングです。ルート登録を `router.ts` から取り出し、ドメインごとに
  `src/bridge/routes/{boot,session-v1,session-v2,permission}.ts` へ分割しました。プロトコル
  プローブはルートのディレクトリを自動で走査します。
- `scripts/cleanup-merged-branches.sh` を追加しました。main にマージ済みの残骸ブランチを
  一覧/削除します（既定は dry-run、`--apply` でローカルを削除、`--remote` でリモートも削除）。
- `scripts/cleanup-e2e-runs.sh` を追加しました。`.e2e` 配下の古い e2e run ディレクトリを掃除します
  （既定は dry-run、`--keep N` で直近 N 個を残し、`--apply` で削除。テスト成果物は再生成できます）。
- `pnpm run e2e` / `pnpm run e2e:api` を追加しました。全量または API サブセットの e2e を 1 コマンドで
  実行します。
- `scripts/e2e-tui-permission.sh` を追加しました。実 TUI の権限/質問 e2e で（workspace-write +
  mock LLM がツール呼び出しを昇格）、Allow once、Allow always + セッション内の自動許可、Reject
  （エラーを返し永続化しない）、`ask_user_question` の選択肢ダイアログ、`--mini` モードでの
  once/always+自動許可/reject/question と単一返信の描画を対象にします。
- `scripts/e2e-api-permission.sh` を追加しました。API の権限 e2e を補完します（v1 の once は許可を
  永続化しない、v2 の always/別名 reject、保存した許可がセッションをまたいで漏れない、削除後の
  再質問、question の 2 番目の選択肢への返信と v2 の reject、400/404 のエラー分岐）。
- `scripts/e2e-tui-permission-ext.sh` を追加しました。TUI のキーボード面を拡張します（question の
  選択肢のハイライトが Down で移動、question は Esc で取り消し、permission は Esc=reject で
  standard は直接拒否、`--mini` は確認層を先に出します）。
- `scripts/e2e-tui-mini.sh` を追加しました。`--mini` を正常終了（Ctrl+C を 3 回）した後に、
  dsh-oc の終了時の案内が見えることを検証します。
- `scripts/e2e-tui-continue.sh` を追加しました。seed したセッションに明示的なタイトルを付け、
  `--continue` で復元した後にセッション一覧が実際のタイトルを返すことを検証します（過去の
  「復元したセッションにタイトルがない」回帰項目）。
- `scripts/perf.mjs` に `measurements.titleCoverage` を追加しました。一覧の実際のタイトルの
  カバレッジを数値化します。
- `e2e-tui-abort.sh` を変更しました。mini の分岐は SSE に実際のストリーミング増分が現れてから
  Esc を押し、実行中のストリームを確かに中断することを検証します（長い mock で `repeatLast` を
  有効にし、以前 2 回目のリクエストが 500 で拒否されて偽の成功になっていた問題を修正しました）。
- `e2e-tui-queue.sh` を追加しました。権限ダイアログが最初のターンを止めている間に 2 つ目の prompt を
  送り、TUI が QUEUED を表示し、承認後に 2 つ目が順序どおり処理されることを検証します。
- `e2e-tui-queue-live.sh` を追加しました。低速ストリームの進行中に TUI のキーボードから 2 つ目の
  prompt を送り、QUEUED が表示された後に中断してきれいに終了することを検証します（「モデルの
  実行中は新しいメッセージを送れない」回帰項目）。
- `e2e-tui-agent-tab.sh` を追加しました。Tab で agent を切り替えると prompt とともに有効になり、
  dsh セッションの preset が実際に切り替わること（build → standard）を検証します。
- `e2e-tui-abort.sh` に spinner の停止検証を追加しました。中断後の 2 回の取得で、変化する spinner の
  フレームが現れてはいけません（「中断後も thinking が回り続ける」回帰項目）。
- `scripts/e2e-real-llm.sh` を追加しました。ローカルでの実 LLM の全フロー回帰です（headless の
  テキスト+ツール、FIFO のキュー順、`/goal` の作成、variant の保持、TUI の sidebar と送信、
  きれいな終了。ローカルの手動実行のみで、実際のトークンを消費します）。
- README をレビューに沿って簡潔にしました。能力の状態を先頭に置き、cast の録画手順は削除し
  （AGENTS.md に残しています）、バイナリの説明は「公式バイナリ」だけにし、更新コマンドと npm
  パッケージ名の説明を補いました。
- README のデモを実モデルで録画した GIF に変えました。asciinema の cast（`docs/demo/`）を公式の
  `agg` で GIF にし、README に埋め込みます（GitHub は `<script>` を実行しないためプレイヤーの
  スクリプトは使えません）。cast は `asciinema play` での対話的な再生用に残します。録画は mock
  ではなく実際の DeepSeek モデルで実際のタスクをこなしています。
- エラー表示を変更しました。dsh の `host/agent-error` は `session.error` に加えて、エラーの接頭辞を
  付けた assistant のテキストメッセージ（`[错误] …`）もブロードキャストするようになり、TUI の
  会話領域でエラーを直接確認できます。黙って何も出ない状態や異常な描画はなくなりました。
- キューのメッセージを見えるようにしました。dsh の pending inbox（`session/queue` の初期化 +
  `agent/inbox/spliced` の増分）を opencode のユーザーメッセージにマップし、TUI に QUEUED を
  表示します。あわせて同じテキストの 300ms デバウンスを削除しました（「キューの反応がない →
  ユーザーが再送する」という根本原因を隠していました）。
- `tool-call-chunks` の履歴再生を変更しました。dsh が永続化するメインストリームのエンコード（実際のセッションで
  701 対 39 の live delta）から、共有 feed のパイプラインでストリーミング中のツール引数を
  復元します。
- slash コマンドのキュー案内を追加しました。`/goal`、`/preset`、`/help` の実行時に未処理の
  ユーザーメッセージがキューに残っている場合、結果の末尾に未処理のメッセージが N 件残っている旨を
  追記します。
- ログとして知られているセッションイベント（`step/start`、`request/header|context`、
  `session/title-llm-request`、`permission/preset`、`sandbox/mode`、`approval/policy`、
  `command/run|done`）は明示的に黙らせ、本当に未知の型だけログに出します。
- トップレベルモデルによる round-0002 のレビュー（gpt-5.6-sol / max）を反映しました。rc.2 は
  条件付きの NO-GO と確認され、復元整合性の主要な根拠は warm/cold の history 投影から v1+v2 の
  両面 oracle へ上げる必要があります。`--continue` のメッセージグラフの変種は後回しにし、3 つの
  故障ドメイン（SSE の切断、mux の再購読、プロセスのクラッシュ）と full SHA の不変な
  インストール/アップグレード/ロールバック演習を優先します。順序ずれの帰属に関する表現は中立的な
  既知の制限に下げ、公式 1.18.18 の最小再現を待ちます。

### 修正

- 1 つのターンに tool-call を含む assistant メッセージが複数あるとき、turn/end がすべての
  ツールメッセージに completed を送るようにしました（以前は pending の完了状態が 1 枠だけで、
  最後のツールメッセージしか completed を受け取らず、それより前のツールカードは live 表示で
  完了状態を欠いていました。コーパス監査の初回で見つけて修正し、複数ツールの完了状態の単体
  テストを追加しました）。
- v1 履歴メッセージの `parentID` を bridge の surface id と一緒に remap するようにしました。以前は
  warm のプロセス内で親チェーンが元の dsh id を指したままメッセージ id だけが bridge の id に
  変わっていたため、クライアントは返された一覧の中で親チェーンを解決できませんでした
  （マッピングのない cold の `--session` では解決できていました）。修正後は warm/cold の v1
  グラフが正規化した索引で一致します。
- `e2e-recovery-consistency.sh` を復元整合性の両面 oracle へ上げました。固定の sleep の代わりに
  権威ある idle（`POST /api/session/:id/wait`）を待ち、v1（親チェーン/part の帰属）と v2
  （メッセージごとの parts、ユーザーテキストは統合）の両方を比較します。ツール part は
  `name/status/output` を含めて比較し、completed のツール出力が少なくとも 1 件あることと、親
  チェーンがすべて解決できることを検証します（親チェーンなしの空の検証ではなくなりました）。
- 最初の返信が二重に描画されなくなりました。dsh が注入するプラグインコンテキストのメッセージ
  （`Current runtime context`）が「親のアンカー」を上書きせず、assistant メッセージは常にその
  prompt に登録した bridge の id を使うため、履歴インターフェースの id と一致し、TUI は 1 回だけ
  描画します。
- 会話の前に Tab / `/preset` で preset を切り替えても、TUI の sidebar の agent ラベルが戻らなく
  なりました。bridge はセッションごとに実際の agent を追跡し、ユーザーメッセージ、assistant
  メッセージ、`session.updated`、v1/v2 の履歴に通します。prompt のエコーは agent を適用した後に
  ブロードキャストし、assistant メッセージには公式ランタイムの `agent` フィールドを補います。
- ストリーミングのエラーを sidebar に読めるテキストで表示するようにしました。`session.error` は
  公式の判別共用体（`UnknownError` / `MessageAbortedError` / `ProviderAuthError`）に従って送出し、
  `[object Object]` として描画されません。
- v1/v2 の履歴で、同じターンのツール呼び出しと後続テキストを bridge の id で 1 つのメッセージに
  マージし、live の SSE と一致させました（以前は履歴が同じ id のメッセージを 2 件返し、TUI が
  マージした後にツールカード/テキストを二重に描画していました）。「ツール + キュー」の即時表示の
  順序ずれは、公式 TUI 1.18.18 で観測された表示上の制限です（bridge の永続データは正しく、
  `--session` で入り直すと順序も正しくなります。正確な帰属は公式の最小再現実験の完了を待ちます）。
- `turn/end` が確定済みメッセージの pending 完了を飛ばすとき、記録も同時に削除するようにしました。
  次のターンまで残って重複した `message.updated` を送ることがありません。
- `/api/session/active` はセッションが実際に `running` のときだけそのセッションを返し、idle や
  存在しない場合は `{ data: {} }` を返すようにしました（以前は無条件に running としていました）。
- SSE のテキスト delta が対で重複する既知の挙動を文書化しました（dsh の二重エンコード + mux の
  再生。TUI は `message.updated` の全量テキストで描画するため、実測では影響ありません）。
- Thought（reasoning）の所要時間を修正しました。`end` は最後の reasoning chunk の時刻を使い、
  返信全体の完了時刻と同じになる誤りをなくしました（履歴の読み取りと live のストリームの両方に
  効きます）。
- 中断/ストリーミングの spinner を修正しました。text ブロックが始まった時点で reasoning part を
  閉じ（end 時刻を付けます）、中断時（最終の assistant/message がない場合）も turn/end が開いた
  ままの reasoning part を閉じるため、TUI の thinking 表示が回り続けません。
- Tab/agent の選択が prompt とともに有効になるようにしました。v1/v2 のすべての prompt ルートが
  リクエスト body の `agent` を適用します。dsh は返信が発生したセッションの agent preset を
  固定するため（409）、その場合は最初のメッセージの後に TUI へ「Agent switch locked」の案内を
  1 回表示し、黙って失敗しないようにしました。
- 未完了のツール呼び出しを含む assistant メッセージを早期に `completed` としないようにしました。
  `step/end` / `turn/end` で完了を送るため、公式 TUI の QUEUED 判定（最後の未完了 assistant より
  後のユーザーメッセージ）が正しく働きます。

## [0.1.0-rc.1] - 2026-08-15

### 追加

- OpenCode 1.18.18 を基にした HTTP/SSE bridge と実 TUI の attach を追加しました。
- DSH OC ブランドの起動 logo を追加しました（OpenCode の ASCII アートを置き換えます）。
- 自動更新を無効にし、バイナリのバージョンを 1.18.18 に固定しました。
- ストリーミングの toolcall/progress、Goal の全ライフサイクル、dsh のモデルカタログ/preset の
  切り替えに対応しました。
- テキスト/画像の添付、`Always` 権限のセッション内メモリ、skills ディレクトリ、スラッシュ
  コマンドに対応しました。
- v2 のセッション検索/ページネーション/並べ替え、`--dir` によるディレクトリの絞り込みに
  対応しました。
- SSE の mux/host 再接続と再生の重複排除、todo/goal の状態の再接続間の保持に対応しました。
- セッション性能の負荷試験（200/1000/5000/10000）とプロトコル更新のプローブを追加しました。
- ワンコマンドの自己テスト `scripts/check-all.sh` と GitHub Actions の CI を追加しました。

### 修正

- `--mini` で返信がない問題を修正しました（`POST /session/:id/prompt_async` を追加）。
- `--mini` の返信が 2 回描画される問題を修正しました（ストリーミング/最終の part id を再利用）。
- セッション履歴の一覧にタイトルがない問題を修正しました（永続タイトル → プロジェクト
  ディレクトリの basename → セッション id の順にフォールバック）。
- 旧パッケージ名からの移行で `duplicate loader entry id: storage` が発生していました
  （profile に残った `@deepseek-ai/dsh-oc` の依存と bundle の項目を消せば復旧します）。

### リファクタリング

- パッケージ名を `@deepseek-ai/dsh-oc` から `@chiro2001/dsh-oc` へ移行しました。
- ルート登録を `router.ts` から `src/bridge/routes.ts` へ取り出しました。
