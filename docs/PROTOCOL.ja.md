*[English](PROTOCOL.md) · 日本語 · [中文](PROTOCOL.zh.md)*

# OpenCode TUI プロトコルプローブと互換マトリクス

> 本ファイルは `PLAN.md` の補助ドキュメントです。P0 を実行する前に必ず本ファイルを読んでください。
> 機能状態の入口: まず [FEATURES.ja.md](FEATURES.md) を読み、その後で本ファイルに戻りルートとプロトコルの詳細を確認してください。
> プローブ基準: `@opencode/cli@2.1.0`（GitHub Release `v2.1.0`、commit `4643e65`）。

## 0.2.0-rc.4 実装ベースライン

現在の prerelease は dsh `>=0.1.5-rc.2` を対象にしています。以下の初期テーブルに残っている `apiProxy` の記述は歴史的な設計由来です。現在の実装は PR #1/#2/#3 の意味の再統合を完了しており、
`@deepseek-ai/dsh-host-apiproxy` には依存していません。

RC.2 は Issue #4 の `POST /api/session/:id/shell` を含みます。RC.3 は公式 TUI prompt のトップレベル
`variant` に対する reasoning effort の同期を補完しました。RC.4 は dsh 0.1.5 の host ABI と assistant
ストリーミングモデルに適応しています（§11 を参照）。

- Session/list/history/prompt/cancel/model/fork/rename は `sessionController` に直接接続します。
  agent/preset、goal、skill はそれぞれ対応する host services に直接接続します。
- SSE は `session/event`、`agent/assistant-stream`、
  `sessionController.control`、approval/question answerer のイベント変換で構成されます。旧
  `apiProxy.events.mux()` の envelope は消費しません。
- `POST /api/session/:id/wait` は dsh `api-session/status` のメモリ上の authoritative map を使い、
  コールドスタート時に最大 1 回だけ `session.list` を seed します。これにより TUI の待機ポーリングが DB 全体の I/O を引き起こしません。
- SSE クライアントは有界の `Last-Event-ID` ring リプレイに対応します。カーソルが破棄されたときは現在の
  status/control snapshot だけをリプレイし、history は走査しません。

---

## 1. プロトコルベースライン: OpenCode 2.1.0 単一代の実装

dsh-oc bridge は **OpenCode 2.1.0** の HTTP プロトコルだけを実装します。

- 公式 client（`@opencode/client@2.1.0`）が呼ぶものはすべて `/api/*` の下にあります。
- OpenCode 1.x の `/session`、`/config`、`/provider`、`/global/event` などの接頭辞ルートはすべて削除済みで、
  リポジトリは `@opencode-ai/sdk@1.18.18` の型に依存しません。`src/bridge/convert/wire.ts` はローカルの構造型で
  SSE チャネルが今も公開している 1.x 形状の投影を記述します。
- `node scripts/check-client-routes.mjs` は公式 client の chunk を基準にして、bridge が登録したルート集合が
  すべてのクライアントルートを覆っていること（`missing: 0`）を検証します。

---

## 2. プローブ方法（再現可能）

### 2.1 準備

```bash
# 公式バイナリをインストールする
npm pack @opencode/cli@2.1.0
# または node_modules/@opencode/cli/bin/opencode.exe を直接展開する

# 照合用に opencode のソースを clone する
git clone --depth 50 https://github.com/anomalyco/opencode.git ../opencode
git -C ../opencode checkout 4643e65
```

### 2.2 TUI の起動リクエストを記録する

```bash
# 1. 実際の opencode server を起動する（プロトコル記録専用で、dsh-oc のランタイムではない）
DEEPSEEK_API_KEY=test \
OPENCODE_CONFIG_CONTENT='{"provider":{"deepseek":{"options":{"baseURL":"http://127.0.0.1:19876","apiKey":"test-key"}}},"enabled_providers":["deepseek"],"model":"deepseek/deepseek-chat","autoupdate":false,"share":"disabled"}' \
opencode serve --port 4097

# 2. ログプロキシを起動する: 19877 -> 127.0.0.1:4097、method/url/headers/status を出力する
node tools/log-proxy.mjs

# 3. PTY で TUI を起動する（2.x はグローバルの --server で bridge を指す。--mini は mini サブコマンド経由）
script -qec "opencode --server http://127.0.0.1:19877" /dev/null
script -qec "opencode mini --server http://127.0.0.1:19877" /dev/null

# 4. /api/event の SSE と各レスポンス body を取得し、tests/fixtures/opencode/ に保存する
```

### 2.3 schema を取得する

権威ある schema の出所:

- `../opencode/packages/sdk/openapi.json`
- `../opencode/packages/sdk/js/src/v2/gen/types.gen.ts`（生成後）
- npm パッケージ `@opencode/client@2.1.0` の `dist/promise/generated/types.d.ts`

---

## 3. 実測した起動ルート一覧（P0 はすべてに応答する必要がある）

`opencode --server` の起動段階で実際に発生したリクエスト（2026-08-15 に TTY 環境で記録。1.x の接頭辞ルートは削除済み）:

```text
GET /experimental/capabilities
GET /experimental/console
GET /api/event                           # SSE 長接続
GET /api/location
GET /api/agent
GET /api/integration
GET /api/model
GET /api/provider
GET /api/reference
GET /api/command
GET /api/skill
GET /lsp
GET /mcp
GET /experimental/resource
GET /formatter
GET /experimental/workspace
GET /experimental/workspace/status
GET /api/model?location[directory]=...
GET /api/provider?location[directory]=...
GET /api/reference
GET /api/integration?location[directory]=...
```

> ディレクトリやワークスペースのモードが違うと、`/api/model` と `/api/provider` がさらに数回要求されます。実装は冪等でなければなりません。

---

## 4. ルート分類

凡例:

- **MAP**: dsh のサービスへ変換する必要がある。
- **STUB**: schema-valid な空データを返す。
- **LATER**: 初版では 501 または空でよいが、テストに記録する。

### 4.1 `/api` 以外のルート

OpenCode 1.x の接頭辞ルート（`/session`、`/config`、`/provider`、`/agent`、`/command`、
`/skill`、`/permission`、`/question`、`/vcs`、`/global/event` …）はすべて削除済みです。以下に残るのは
TUI 起動期の検出に使う stub とライフサイクルエンドポイントだけです。

| ルート | 分類 | dsh のデータソース / stub の形状 |
|---|---|---|
| `GET /lsp` | STUB | `[]` |
| `GET /mcp` | STUB | `{}` |
| `GET /formatter` | STUB | `[]` |
| `GET /experimental/resource` | STUB | `[]` |
| `GET /experimental/console` | STUB | `{ consoleManagedProviders: [], switchableOrgCount: 0 }` |
| `GET /experimental/capabilities` | MAP | `{ backgroundSubagents: true }`（dsh のバックグラウンド subagent は実際に利用できる） |
| `POST /experimental/session/{id}/background` | MAP | no-op で成功 `true`（dsh のセッションはサーバー側に常駐する） |
| `GET /experimental/workspace` | STUB | `[]` |
| `GET /experimental/workspace/status` | STUB | 空の状態 |
| 上記以外の未列挙ルート | LATER | 501 または schema-valid な空レスポンス |

> **Web UI フォールバック**: bridge が公式 Web UI を保持している場合（4.4 節を参照）、どのルートにも一致しない
> `GET` / `HEAD` リクエストは Web UI が受け持ちます。Web UI がない場合は従来どおり 501 です。

### ユーザーの `!` shell mode

公式 OpenCode は入力欄で `!` を押すと shell mode に入り、送信時に
`POST /api/session/{id}/shell` を送ります。リクエスト body には空でない `command` が必須です。`agent` は任意で、
省略時は session の現在の agent を使います。`agent` を指定する場合は現在の session の agent であり、利用可能な preset でなければなりません。
空値、不一致、利用不可の agent は 400 を返します。このルートは成功時に 204 を返し、表示されるカードは SSE で流れます。

作業ディレクトリは query の `directory` だけで渡します（`cwd` でも body の `workdir` でもありません）。
記録済みの session cwd が優先され、session cwd がまだ記録されていないコールドスタート時だけ query の値を使います。
相対的な query パスは bridge cwd を基準に解決し、絶対パスはそのまま使います。query がない場合は bridge
cwd にフォールバックします。`--dir` は bridge cwd を変えますが、記録済みの session cwd は上書きしません。

dsh-oc は dsh Agent の `runMaintenance` で実際の idle ownership を取得し、その後、現在の OS
ユーザーとして shell を起動します。ユーザーが明示的に `!` を入力したことがこの経路の認可境界だからです。POSIX では
`$SHELL` が絶対パスのときだけこれを使い、それ以外は `/bin/sh` にフォールバックします。Windows では `ComSpec` を使い、
存在しない場合は `cmd.exe` にフォールバックします。この経路は dsh model-tool approval や sandbox の保護を主張せず、
dsh turn/tool の永続イベントも捏造しません。SSE はまず running の tool part を公開し、完了後に completed/error の
tool part、authoritative な idle status、ちょうど 1 回の `session.idle` を公開します。
stdout/stderr はそれぞれ最大 1 MiB まで保持します。超過後も読み取りは続け、出力に切り詰めマーカーを書き込みます。出力量が閾値を超えたことで
子プロセスを能動的に kill することはありません。
この shell 経路は子プロセスの終了後に保持した出力を公開するだけで、リアルタイムの stdout/stderr ストリームは提供しません。

`POST /api/session/{id}/interrupt` は、まずその bridge/session に登録された正確な shell
子プロセスまたはプロセスグループを中止し、その後も dsh の `session.cancel` を呼びます。プロセス名で検索したり、他のプロセスを終了したりはしません。
POSIX では自分のプロセスグループを終了し、Windows では自分の PID の `taskkill /T` ツリーを終了します。Windows の shell を
dsh `pwsh` sandbox に見せかけることはしません。

ここで `ctx.tools.execute({ agent, name: 'bash' })` を意図的に呼んでいません。PTC
presentation では dsh-tools が model-direct root bash を `UNKNOWN_TOOL` と判定し、そのネストした
parent token は実際の `run_code` transport でしか作れず、bridge はそれを捏造できないためです。同時に
dsh-user-approval の `approval.request()` は open turn を要求し、shell maintenance
自体は model turn ではありません。したがって model-tool approval/sandbox の意味を同時に主張できる正当な
user-shell host seam は存在しません。bridge は上流と同等の明示的なユーザー認可と正確な子プロセス
所有権を採用し、`Agent.runMaintenance` ABI がない場合は明示的にエラーを報告します。

このリクエストはモデルの agent-loop の turn/step に属さないため、dsh の `tool/call` /
`tool/result` 永続イベントを捏造できません。完了カードは session ごとに有界な bridge メモリ上の command-result
store（直近 20 件）にだけ保持し、dsh の durable history には書き込みません。このカードは
`GET /api/session/{id}/message` の hydration には注入しますが、
`/api/session/{id}/history`、`/context`、単一の `/message/{messageID}` には注入しません。これらは
durable な dsh history だけを返します。コマンド完了後、bridge は dsh Agent の `inject()` で
Agent を起こさない plugin context（`plugin: dsh-oc`、`form: notice`）を追加します。内容には「ユーザーが手動で
実行したコマンド」であること、stdout/stderr、切り詰めマーカー、終了状態を明示します。モデル注入には独立した UTF-8 の予算があり、
コマンドは最大 16 KiB、stdout/stderr はそれぞれ最大 64 KiB、context テキスト全体は最大約 144 KiB です。TUI
のツールカードは従来どおり各ストリーム 1 MiB の表示予算を保ちます。shell の出力は現在設定されているモデルに送られるため、コマンドや出力に
token、パスワード、個人データなどの機密情報が含まれる可能性があります。利用者は `!` を実行する前に確認してください。注入に失敗した場合、
shell カードは completed になりますが、出力に `[dsh-oc] ... was not added to model context` が追記されます。
この context はまず正当な dsh `agent/inbox/spliced`（`next-step` pending）イベントとして永続化され、
後続の step が claim したときにだけその step の model request に入ります。注入自体は Agent を覚醒させず、
新しい turn も開かず、モデルの返信も自動では引き起こしません。同じ session では、次の実際の prompt がこの context を
確実に見ます（session が破棄された場合を除く）。再起動や復元では、まだ claim されていない inbox が再構築されます。claim 後に
compaction が起きた場合、dsh は逐語の原文を要約または破棄することがあるため、圧縮後に逐語で長期保持されることは保証されません。
Agent にすでに turn/maintenance がある場合は 409、session が存在しない場合は 404、`agent` の欠落または不正、
空の command は 400 を返します。

### 4.2 v2 `/api` ルート

| ルート | 分類 | dsh のデータソース / stub の形状 |
|---|---|---|
| `GET /api/location` | MAP | `{ directory: cwd }` |
| `GET /api/health` | MAP | `{ healthy: true }`（クライアントの生存確認） |
| `GET /api/project` | MAP | 裸の `Project[]`: bridge の作業ディレクトリ（`projectInfo`） |
| `GET /api/project/{projectID}` | MAP | 裸の `Project`。id が一致しない場合は 404 |
| `PATCH /api/project/{projectID}` | MAP | 裸の `Project`（現在はエコーバックのみで、永続化しない）。id が一致しない場合は 404 |
| `GET /api/agent` | STUB/LATER | `[]` |
| `GET /api/integration` | MAP | 資格情報のある provider ごとに 1 件（`methods: []` と env 接続）。無いときは profile を説明する案内 1 件 |
| `POST /api/integration/{id}/connect/*` | REJECT | 400 `integration/profile-configured`。資格情報は dsh の profile にあります |
| `GET /api/vcs` | MAP | `{ provider: "git", branch: { current, default } }`。worktree の外では `null` |
| `GET /api/vcs/base` | MAP | 既定ブランチとの merge base（`source: "default"`）。無ければ最初の commit |
| `GET /api/vcs/status` | MAP | `git status --porcelain` と `git diff --numstat HEAD` の行数 |
| `GET /api/vcs/branch` | MAP | ローカルブランチ（`git branch --format=%(refname:short)`） |
| `GET /api/vcs/diff` | MAP | `mode=working` は `git diff HEAD` と未追跡ファイルの追加パッチ、`branch`/`committed` は merge base との差分。200 ファイルまで |
| `GET /api/config` | MAP | 1 件のドキュメント。dsh のモデルと既定 agent、保存済みの `shell` |
| `GET /api/config/shell` | MAP | `/etc/shells` と `$SHELL` を `{ path, name, acceptable }` で返す |
| `PATCH /api/experimental/config` | MAP | `{ shell }` を `$DSH_HOME/opencode/config/opencode.json` に保存（204）。実行できない shell は 400 |
| `GET /api/model` | MAP | `sessionController.modelCatalog` |
| `GET /api/provider` | MAP | `sessionController.modelCatalog` の providers |
| `GET /api/provider/{id}` | MAP | 単一 provider `{ location, data: ProviderV2Info }`。見つからない場合は 404 |
| `GET /api/mcp` | MAP | 接続中の MCP サーバー。名前は dsh のツールレジストリにある `mcp__<server>__<tool>` から取り、`{ name, status: { status: "connected" } }` として返します |
| `POST /api/mcp`、`DELETE /api/mcp/{name}`、`POST /api/mcp/{name}/connect`、`POST /api/mcp/{name}/disconnect` | REJECT | 400 `mcp/profile-configured`。dsh は MCP サーバーを `mcp-client` プラグインとして設定するため、変更は profile が持ちます |
| `GET /api/reference` | STUB | `[]` |
| `GET /api/command` | MAP | `/preset`、`/goal`、`/help` を登録する |
| `GET /api/skill` | STUB/LATER | `[]` |
| `GET /api/session` | MAP | `sessionController.list`（ページング + `cursor`） |
| `GET /experimental/session` | MAP | GlobalSession の一覧（検索、ディレクトリ絞り込み、limit のサブセット。`convertSessionSummary` を再利用） |
| `GET /api/session/active` | MAP | 現在の活動セッション。実際に `running` のときだけ `{ data: { [sessionId]: { type: "running" } } }` を返し、それ以外は `{}` |
| `POST /api/session/{id}/wait` | MAP | agent ループがアイドルになるまで待つ。≤30s のあいだ `session.list` をポーリングし、アイドルなら 204、タイムアウトなら 503、セッションが存在しなければ 404 |
| `POST /api/session` | MAP | `sessionController.create` |
| `POST /api/session/{id}/fork` | MAP | `sessionController.fork`（client の `before` は**排他**境界で、そのメッセージより前のメッセージだけをコピーする）。v2 の envelope を返す |
| `POST /api/session/{id}/compact` | MAP | dsh の `/compact` command registry（SDK v2 ルート、204） |
| `POST /api/session/{id}/interrupt` | MAP | `sessionController.cancel` + その session に登録された shell 子プロセスの中止（SDK v2 の割り込み入口） |
| `GET /api/session/{id}` | MAP | history + summary。subagent の child は `parentID` と `metadata.origin` を保持する（SDK v2 の生成型がその拡張フィールドを宣言していなくても） |
| `GET /api/session/{id}/message` | MAP | `sessionController.follow/page` の history。`cursor.previous` が前ページのアンカーになる |
| `GET /api/session/{id}/history` | MAP | v2 の履歴ページング: `limit` + `after`（排他的上界で、dsh の `beforeSeq` に写像して後方へページングする）。`{ data, hasMore, next }` を返す |
| `GET /api/session/{id}/context` | MAP | `{ data: SessionMessage[] }`（v2 のメッセージ変換を再利用。カーソルなし） |
| `GET /api/session/{id}/message/{messageID}` | MAP | `{ data: SessionMessage }` の単一取得。見つからない場合は 404 |
| `POST /api/session/{id}/prompt` | MAP | `sessionController.prompt`（`id` は任意。slash コマンドは command registry 経由） |
| `POST /api/session/{id}/model` | MAP | v2 のモデル選択（`variant` を含み、`reconcileModelSelection` がフォールバック） |
| `POST /api/session/{id}/agent` | MAP | v2 の agent 切り替え（`switchAgentPreset` + `session.updated` のブロードキャスト） |
| `POST /api/session/{id}/revert/stage` | MAP | **排他**境界 `{ messageID }` を記録し、`{ data: { messageID, files? } }` を返す。同時に境界より後のターンが変更したファイルをその場でロールバックする |
| `DELETE /api/session/{id}/revert` | MAP | ステージ済みの境界を消去し、stage 時にロールバックしたファイルを元の状態に戻す（204） |
| `POST /api/session/{id}/revert/commit` | MAP | 境界メッセージの 1 つ前のイベントを切れ目として fork する（排他: 境界メッセージとそれ以降のメッセージはすべて破棄）。opencode のセッション id はその後その fork を指す。ロールバック済みのファイルは保持する（204） |
| `GET /api/session/{id}/event` | MAP | セッションで絞り込んだ SSE イベントストリーム（`/api/event` のサブセット） |
| `GET /api/session/{id}/permission` | MAP | セッションごとの pending approvals |
| `GET /api/session/{id}/permission/{rid}` | MAP | 単一の pending approval（セッションが一致しない場合は 404） |
| `POST /api/session/{id}/permission/{rid}/reply` | MAP | approval answerer |
| `GET /api/session/{id}/question` | MAP | セッションごとの pending questions |
| `POST /api/session/{id}/question/{rid}/reply` | MAP | question answerer |
| `POST /api/session/{id}/question/{rid}/reject` | MAP | question answerer cancelled |
| `GET /api/permission/request` | MAP | SDK v2 のグローバル pending approvals の別名。`{ location, data }` |
| `GET /api/question/request` | MAP | SDK v2 のグローバル pending questions の別名。`{ location, data }` |
| `GET /api/permission/saved` | MAP | メモリ上の always 認可リスト（`PermissionSavedInfo` + `sessionID/grantedAt`） |
| `DELETE /api/permission/saved/{id}` | MAP | `sessionID:toolName` のメモリ上の認可を削除する（存在しない場合は 404） |
| `GET /api/fs/read/{path}` | MAP | ワークスペース内のファイルの生バイトを読む（`*` ワイルドカードパス、範囲外は 400、上限 5 MiB） |
| `GET /api/fs/list` | MAP | ディレクトリを一覧する（`{ location, data: FileSystemEntry[] }`、ディレクトリを優先） |
| `GET /api/fs/find` | MAP | 再帰検索（query/type/limit。依存関係とビルドのディレクトリは飛ばす） |
| `GET /global/health` | MAP | `{ healthy: true, version }` |
| `POST /global/dispose` / `POST /instance/dispose` | MAP | no-op で `true` を確認（プロセスのライフサイクルは dsh が持つ） |
| 上記以外の未列挙ルート | LATER | 501 または schema-valid な空レスポンス |

> `after` は**排他的上界**です。イベント seq が `after` より厳密に小さいメッセージのページを返し、`next`
> はそのページで最も古いアンカーの seq です（独立したクライアントが連続して前方へページングできるようにするため）。`after` は
> 非負整数でなければならず、それ以外は 400 です。ページ境界がツールのターンを分割する場合も、ページをまたぐカーソルが
> 欠落や重複を防ぎます（復旧 e2e でカバーしています）。

### 4.3 セッションの revert

OpenCode 2.1.0 の revert は 3 段階です。まず stage で境界を記録し、ユーザーが確認し、最後に commit します。
境界は**排他**です。指定したメッセージとそれ以降のメッセージは、commit の適用時にまとめて消えます。

| ルート | リクエスト | レスポンス |
|---|---|---|
| `POST /api/session/{id}/revert/stage` | `{ messageID, files? }` | `200 { data: { messageID, files? } }` |
| `DELETE /api/session/{id}/revert` | — | `204` |
| `POST /api/session/{id}/revert/commit` | — | `204` |

- stage: 境界メッセージの dsh イベントログ上の位置（`R.locateMessage`）が、それが属する
  ターンも同時に決めます。レスポンスの `files` はこの revert が影響するファイルの diff で、各項目は `FileDiffInfo`
  （`file` / `patch` / `additions` / `deletions` / `status`）です。リクエスト body の `files`
  は無視し、diff は bridge 自身のファイルスナップショットから計算します。diff はロールバックの**前に**計算します。ロールバック後は
  ファイルがすでに旧内容になっているため、diff は空になります。stage は続けてこれらのファイルを変更前の内容へロールバックし
  （`restoreFilesAfter`）、ワークスペースは即座に revert 後の状態を表示します。ロールバック前の現在の内容は保持され、
  `clear` がファイルを元の状態に戻し（`undoRestore`）、`commit` がロールバック結果を保持します（`commitRestore`）。
- ファイル集合はターンごとにまとめます（`src/rewind/` の copy-on-write スナップショットで、`turn/start` ごとに分類）。
  ロールバックの範囲は、境界メッセージが属するターン**より後**のターンです。境界メッセージがユーザーの prompt の場合は、
  そのターン自身のファイルもロールバックします（`includeTurn: true`。assistant の返信が prompt の後に来るため）。境界メッセージが
  assistant の返信の場合は、そのターンはロールバックしません（`includeTurn: false`）。
- commit: dsh の `sessionController.fork` がコピーするのは `atSeq` を**含む**イベント接頭辞ですが、
  OpenCode の境界は排他なので、切れ目は境界メッセージの 1 つ前のイベントにします
  （`R.atSeqBeforeMessage`）。切れ目より後のメッセージ（境界メッセージ自身を含む）は新しい
  セッションに現れません。
- `POST /api/session/{id}/fork` の `before` も同じ排他の意味を持ち、同じ切れ目の計算を通ります
  （fork したセッションに `before` が指すメッセージは含まれません）。こちらは別名を作らず、fork が作るのは
  新しいセッション id です。
- commit 後も**セッション id は変わりません**。bridge が opencode のセッション id と fork した dsh id のあいだに
  別名を記録するためです（`InteractionState.setSessionAlias`）。その結果、
  - 以降の dsh 呼び出しはすべて fork に書き換えられます（`rpc()` の `resolveSessionPayload`）。
  - セッション一覧は fork を**元の opencode id** で公開し、置き換えられたセッションは一覧から
    消えます。
  - `GET /api/session/{id}` と `GET /api/session/{id}/message` は fork の
    サマリと履歴を読みます。
  - fork の SSE イベントは元の opencode id に書き戻されます（`mapEventSessionId`）。
  - セッション単位の状態（モデル、agent preset、タイトル、メッセージ id の対応）は fork にコピーされ
    （`inheritSessionState`）、クライアントが見るメッセージ id は変わりません。
- コミットのタイミング: OpenCode と同じく、次の prompt が届いたときにステージ済みの revert を先にコミットします
  （`POST /api/session/{id}/prompt` が先に `commitStagedRevert` を呼びます）。prompt はその後、書き換え後の
  セッションに入ります。`POST /api/session/{id}/revert/commit` は同じ経路の明示的な入口です。
- セッションの記録にはステージ済みの境界が付きます: `Session.Info.revert = { messageID, files? }`
  （`GET /api/session/{id}` で見え、commit または clear の後に消えます）。
- エラー: `messageID` の欠落 → 400、履歴にないメッセージ → 400
  `message not found for fork`、切れ目が最初のメッセージより前 → 400
  `cannot cut before the first message`（dsh の
  `atSeq` は非負整数でなければならず、空の fork を表現できません）。
- 既知の制限: ファイル diff は先頭と末尾の変更行のあいだの**1 つの粗い hunk** です（bridge 自身のファイル変更
  diff と同じ形）。完全な LCS diff ではありません。`files` の一覧は stage のレスポンスとセッションの
  記録に現れ、公式 TUI がこれを描画します。

### 4.4 公式 Web UI（API と同一オリジン）

公式 `opencode serve` は API と Web UI を同じオリジンで提供します。ブラウザの UI は
`location.origin` で API にアクセスするため、CORS もログインも要りません。dsh-oc の bridge は
この構成をそのまま採用しています（`src/bridge/web-ui.ts`）。

- 公式 opencode バイナリは Web UI を 1 つの `AppArchive` として埋め込みます（opencode ソースの
  `packages/cli/src/app-archive.ts`）。リトルエンディアン u32 の JSON インデックスのバイト長、インデックス本体
  （各アセットの `[offset, length]`）、brotli 圧縮したアセット本体という構成です。
- bridge はこのアーカイブを `$DSH_HOME/opencode/web-ui/<version>/` に一度展開します（`<version>`
  は固定した opencode のバージョンで、現在は `2.1.0`）。その後は bridge 自身がこれらのファイルを配信します。
- ディレクトリの検索順: `DSH_OC_WEB_UI` が指すディレクトリ → `$DSH_HOME/opencode/web-ui/<version>/`。
  指定されたディレクトリに `index.html` がない場合は未設定として扱います。
- バイナリは**検索するだけ**で、bridge がインストールすることはありません。TUI プラグインはもともと opencode バイナリを必要とするため、
  Web UI は次回の起動から現れます。バイナリが見つからない場合は Web UI を提供せず、API には影響しません。
- `scripts/extract-opencode-web-ui.mjs` を使うと、オフラインで任意のディレクトリにアセットを抽出できます
  （`node scripts/extract-opencode-web-ui.mjs --bin <opencode バイナリ> --out <ディレクトリ>`）。

ルートの挙動（`src/bridge/http.ts` のフォールバックと `src/bridge/web-ui.ts`）:

| リクエスト | レスポンス |
|---|---|
| API ルートに一致する | API のレスポンス（最優先） |
| どのルートにも一致しない `GET` / `HEAD` | Web UI の `index.html`（シングルページアプリ。未知のパスも shell になる） |
| `_assets/`、`icons/` 配下に存在しないファイル | 404 |
| その他のメソッドで一致しないルート | 501 `not implemented by oc-bridge` |

> 注意: フォールバックは `/api/` の接頭辞を区別しないため、未登録の `/api/*` パスは Web UI がある場合に
> JSON の 404 ではなく SPA の shell を返します。

静的ファイルのヘッダー: `content-type` は拡張子から決めます（公式サーバーと同じ型の表を使います）。
`index.html` / `sw.js` / `registerSW.js` は `cache-control: no-cache`、それ以外は
`public, max-age=31536000, immutable` で、`x-content-type-options: nosniff` を付けます。
Web UI のディレクトリの外に出るパスは配信しません。

> **実測状態**: Web UI は配信できており、公式 OpenCode 2.1.0 のクライアント（Node で、ブラウザではない）が
> bridge の `/api/event` を購読して約 40 ms で `server.connected` を受け取ります。本機には実際の
> ブラウザがないため、実際のブラウザでの対話検証は**行っていません**。

### 4.5 CORS ポリシー

`src/bridge/http.ts` の `isAllowedCorsOrigin()` / `corsHeaders()` は公式の
opencode サーバー（ソースは `packages/server/src/cors.ts`）と一致させています。

- `http://localhost:<port>` と `http://127.0.0.1:<port>` は常に許可します。
- `oc://renderer`、tauri のオリジン（`tauri://localhost`、
  `http://tauri.localhost`、`https://tauri.localhost`）、`*.opencode.ai` は常に許可します。
- さらに `DSH_OC_CORS`（カンマ区切り）に列挙したオリジンも許可します。公式サーバーの `cors` オプションに相当し、
   LAN 上のブラウザ UI に使います。

許可した場合はリクエスト自身の `Origin` をエコーし、次のヘッダーを付けます。

```text
Access-Control-Allow-Origin: <リクエストの origin>
Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Last-Event-ID
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

許可しないオリジンには CORS ヘッダーを一切付けません。`OPTIONS` のプリフライトは 204 を直接返します。`Origin` ヘッダーのない
リクエスト（ブラウザ以外のクライアント）は同一オリジンとして扱い、`*` を返します。

> 旧実装は常に `Access-Control-Allow-Origin: *` を返していたため、認証情報付きのリクエストがブラウザに拒否され
> （"credentialed request requires Access-Control-Allow-Origin '<origin>'"）、
> ブラウザ UI はまったく接続できませんでした。

### 4.6 リクエストの追跡

`DSH_OC_HTTP_LOG=1` を設定すると、bridge がすべての HTTP リクエストを stderr に出力します。

```text
[bridge/http] GET /api/info
[bridge/http] GET /api/event
```

行はリクエストの到着時に書かれるため、長接続（SSE）も現れます。ブラウザのない環境で
ブラウザ UI の呼び出しパターンを確認するためのデバッグ手段です。

---

## 5. SSE イベントの対応表

現在の dsh 0.1.2 は Cordis の `session/event`、`sessionController.control`、approval/question answerer から
host frames を生成し、oc-bridge がそれを opencode の
`GlobalEvent` に変換します。旧 `apiProxy.events.mux()` は歴史的なプロトコル由来としてのみ残っています。

| DSH mux frame | opencode GlobalEvent |
|---|---|
| `session/event: session/created` | `session.created`（properties.sessionID、info=Session） |
| `session/event: session/title` | `session.updated` |
| `session/event: turn/start` | `session.status`（busy） |
| `session/event: turn/end` | `session.status`（idle）+ `session.idle` |
| `session/event: user/message` | Session を再構築してから `message.updated` を送る |
| `session/event: assistant/message` | `message.updated` + `message.part.updated` |
| `session/event: assistant/chunk (tool-call-delta)` | `session.next.tool.input.started/delta/ended` + v1 ToolPart の増分（間引いてマージ） |
| `session/event: tool/call` | `session.next.tool.called` + `progress` + `message.part.updated`（ToolPart pending。dsh の `subagent*` は OpenCode の `task`） |
| `session/event: tool/result` | `session.next.tool.success/failed` + `message.part.updated`（ToolPart completed/error。Task child の `sessionId` は host の child lineage から関連付け、result meta には依存しない） |
| `session/event: todo/write` | `todo.updated` |
| `session/event: goal/change` | `todo.updated`（goal を先頭にマージ） |
| `session/event: approval/asked\|decided` | 永続化して記録し、bridge は何も発行しない（権限のやり取りは mux frame の `approval/requested\|resolved` が駆動する） |
| `approval/requested` | `permission.asked` |
| `approval/resolved` | `permission.replied` |
| `question/requested` | `question.asked` |
| `question/resolved` | `question.replied` / `question.rejected` |
| `session/projection: todos` | `todo.updated` |
| `session/projection: goal` | `todo.updated`（goal を先頭にマージ） |
| `session/projection: produced-files` | `session.diff` |
| `session/queue`（購読の初期化） | その session で初回のときに pending inbox を反映 → ユーザーメッセージごとに `message.updated` + `message.part.updated`（TUI は QUEUED を表示する） |
| `session/event: agent/inbox/spliced` | 増分: ユーザーメッセージの挿入 → `message.updated`、`outcome: canceled` の削除 → `message.removed`、claim（outcome なし）は削除せず、同じ id の `user/message` による upsert を待つ |
| `session/jobs` | 無視する |

> **Task subagent の関連付け**: 組み込みの OpenCode TUI は 1.18.18 形状の
> `ToolPart.state.input.description` / `subagent_type` を読んで Task を描画し、
> `ToolPart.state.metadata.sessionId` を読んで child へ移動します。
> dsh の `api-session/added`、`subagent/descriptor`、`subagent` projection は session をまたいで
> 届くことがあるため、bridge は parent の pending call で一時的に保持し、履歴については label/FIFO で
> parent-local に結び付けます。child の v1/v2 Session と `session.updated` の置き換えはすべて
> `parentID` と `metadata.origin` を保持します。

> **キュー済みメッセージの可視性**: 旧実装が `session/queue` を捨てていたため、キューに入った prompt が
> TUI で何のフィードバックもなく、ユーザーは送信に失敗したと考えて再送し、キューが滞留してモデルが古いメッセージに返信していました。現在は
> `session/queue` は初回の投影だけを行い（完全なフレームでは claim と cancel を区別できない）、以降の
> 増分は `agent/inbox/spliced` が維持します。未完了のツール呼び出しを含む assistant メッセージには
> `time.completed` を設定せず、`step/end`/`turn/end` で補完します。これにより公式 TUI の QUEUED 判定
> （最後の未完了 assistant メッセージより後のユーザーメッセージ）が機能します。

> **prompt の配送セマンティクス（steer）**: ユーザーの prompt はすべて dsh `session.prompt` の
> `mode: 'steer'` で投入します（公式 opencode の「セッションストリームに追記し、実行中の loop が次の step
> で処理する」という意味に相当）。実行中の turn は次の step 境界で挿入されたメッセージを見ます。
> `mode: 'queue'` のようにターン全体の終了を待つことはありません（かつて長い検索ターン中にユーザーが挿入した
> タイトルや訂正を、モデルが数分間アイドルし続けた後にようやく見るという問題がありました。session e0336d8b を参照）。
> キューに入った複数のメッセージは、次の step で順序どおり同じリクエストにマージされます。QUEUED バッジは従来どおり TUI
> がタイムラインから独自に判定します。

> **既知の挙動（テキスト delta が対で重複する）**: 旧 dsh/dcp rc.6 は同じストリーミングテキストを
> `assistant/chunk`（text-delta）と packed `text-chunks` の 2 つの符号化で同時に送り、さらに新しい mux の購読は
> 履歴をリプレイしてからリアルタイムに入るため、bridge の `message.part.delta` が同じ文字を
> 2 回送ることがあります（2 つの符号化でチャンクとオフセットが異なり、損失なくマージできません）。組み込み TUI は最終的な
> `message.updated` が持つ最終的な全文を基準にするため、実測では重複なく正常に描画されます。`e2e-tui-abort.sh` の
> v2 の区間は「新しい SSE ストリームに delta が現れる」ことで検出し、delta テキストの連続性には依存しません。

GlobalEvent の必須フィールド:

```ts
{
  directory: string,
  project?: string,
  workspace?: string,
  payload: { id: string, type: ..., properties: ... }
}
```

> **ストリーム先頭フレームの契約**: 2.x のクライアントは `server.connected` で始まらないイベントストリームを拒否するため、
> `GET /api/event`（およびセッションで絞り込んだ `GET /api/session/{id}/event`）は接続後に必ず
> 最初に `server.connected` フレームを送り、その後に `Last-Event-ID` のリプレイと status/control snapshot の
> リプレイを行います。`server.connected` は ring に入らず、リプレイのカーソルも消費しません。

### 5.1 OpenCode 2.x ネイティブのイベント語彙（OpenChamber 2.5 が読む）

組み込み TUI は `payload.type` + `payload.properties` を読みます。OpenChamber 2.5 が読むのは
OpenCode 2.x のネイティブな語彙（`session.text.delta`、`session.tool.called`…）で、
`message.updated` / `message.part.updated` は解釈しません。そのため同じ SSE 接続で 2 つの投影を同時に公開します。

* `payload.properties` は 1.18.18 の形状を保ちます（TUI の経路は変わりません）。
* `payload.data` は 2.x の形状です。SSE のトップレベルにはさらに `id`/`created`/`type`/`durable`/
  `location`/`data` を並べるため、2.x のクライアントは 1.18.18 の wrapper を理解せずに解析できます。
* 2 つの語彙で名前が同じイベント（`session.status`、`session.idle`、`permission.replied`）
  はイベントを 1 つで足ります。`data` 自体が 2.x の形状だからです。
* `permission.asked` は 2 つの形状が異なるため、同じイベントの `properties` を TUI に、
  `data` を 2.x のクライアントに渡します。

dsh → 2.x の対応:

| dsh の由来 | 2.x のイベント |
|---|---|
| `turn/start` | `session.execution.started` |
| `turn/end`（completed / max-tokens） | `session.execution.succeeded` |
| `turn/end`（error） | `session.execution.failed`（`error: {type, message}`） |
| `turn/end`（aborted / blocked） | `session.execution.interrupted`（`reason: user\|superseded\|shutdown`） |
| assistant step の開始 | `session.step.started`（`assistantMessageID`/`agent`/`model`） |
| assistant step の終了 | `session.step.ended`（`finish`/`cost`/`tokens`）。中断された step は `session.step.failed` を送る |
| テキストブロック | `session.text.started` / `.delta` / `.ended` |
| 推論ブロック | `session.reasoning.started` / `.delta` / `.ended` |
| ツールの入力 | `session.tool.input.started` / `.delta` / `.ended` + `session.tool.called` |
| ツールの結果 | `session.tool.success` / `session.tool.failed`（+ `session.tool.progress`） |
| ユーザーメッセージの受理 / 配送 | `session.inbox.enqueued` / `session.inbox.delivered` |
| セッションの認識 / 改名 | `session.created` / `session.renamed` |
| preset / モデルの切り替え | `session.agent.selected` / `session.model.selected` |
| 承認の要求 / 応答 | `permission.asked` / `permission.replied` |
| 質問 / 応答 / 取り消し | `form.created` / `form.replied` / `form.cancelled` |
| compaction | `session.compaction.started` / `.delta` / `.ended` |
| クライアント駆動の revert（stage / clear / commit） | `session.revert.staged` / `session.revert.cleared` / `session.revert.committed` |

`ordinal` はテキストブロックと推論ブロックがそれぞれ assistant message 内で持つ連番です（0 から始まり、
2 種類を別々に数えます）。`assistantMessageID` は bridge の provisional な assistant message id で、
1.18.18 の `message.updated` が使うのと同じ id です。

revert の 3 つのイベントには dsh の対応物がなく（revert はクライアントが駆動するため）、revert のルートが直接公開します。

| イベント | `data` |
|---|---|
| `session.revert.staged` | `{ sessionID, revert: { messageID, files? } }` |
| `session.revert.cleared` | `{ sessionID }` |
| `session.revert.committed` | `{ sessionID, to }`（`to` は境界メッセージの id） |

> revert の commit 後、セッションは fork に切り替わり、fork のイベントは新しい dsh のセッション id を持ちます。bridge は
> ブロードキャストの前にこれらの id をクライアントが知っている opencode のセッション id に書き戻すため
> （`mapEventSessionId`）、クライアント側から見たセッション id は最後まで変わりません。

### 5.2 ハートビートと status スナップショット

- **ハートビート**: `SseHub` は 15 秒ごとに、公式サーバーと同じコメントフレーム
  `: heartbeat\n\n` を各接続に書き込みます（公式の実装は `packages/server/src/handlers/event.ts`）。
  ハートビートがないと、静かなセッションのストリームは切れたように見えます。公式クライアントは "Event stream stalled"
  で切断して再接続し、OpenChamber の上流の読み取り側は 20 秒で諦めるため、どちらも再接続のループに入ります。
  コメントフレームはどの SSE パーサーにとっても透過的ですが、「データを受信した」と数えられます。ハートビートのタイマーは
  `unref` しているため、単独でプロセスを生かし続けることはありません。
- **status スナップショットは有界**: SSE の接続時に `replaySessionStatusSnapshot()` が
  `session.status` をリプレイし、再接続したクライアントにどのセッションが忙しいかを伝えます。上限は
  `SESSION_STATUS_SNAPSHOT_LIMIT = 20` で、実行中のセッションを先に、残りの枠は
  `sessionStatusUpdatedAt` の順に最近動いたセッションへ割り当てます。旧実装は bridge が見たことのあるすべてのセッションを
  報告していたため、公式 Web UI は接続のたびに数百件のセッション記録を読み、初期読み込みが永遠に終わりませんでした。

---

## 6. opencode の主要な型の所在

以下の型が `convert/*` を実装する際の権威ある根拠です。

```text
@opencode/client/dist/promise/generated/types.d.ts:
  SessionInfo, SessionMessageInfo, SessionMessageUser,
  SessionMessageAssistant, SessionMessageAssistantText,
  SessionMessageAssistantReasoning, SessionMessageAssistantTool,
  ModelInfo, ProviderInfo, ModelRef, AgentInfo, CommandInfo,
  PermissionRequest, FormInfo, SessionStatus, FileDiffInfo
```

SSE チャネルが今も公開している 1.x 形状の投影（`message.updated` / `message.part.updated` /
`session.updated`）には 2.1.0 の対応する型がなく、`src/bridge/convert/wire.ts` のローカルな構造型で
記述します。`WireMessageInfo`、`WirePart`、`WireToolPart`、`WireSessionInfo` です。

dsh の型の所在:

```text
deepseek-harness/packages/core/session/src/types.ts:
  SessionEvent, SessionEventMap, SurfaceOp, UserMessage, AssistantMessage
deepseek-harness/packages/host/apiproxy/src/api/:
  sessions.ts, events.ts, llm.ts, approvals.ts, questions.ts, rpc.ts
deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:
  createApiProxy / ApiProxyService
```

---

## 7. opencode バイナリの入手元

`opencode-assets.json` は 2.1.0 への移行で削除され、リポジトリは独自の asset manifest を維持していません。
2.x の公式配布は npm のプラットフォームパッケージ `@opencode/cli-<platform>-<arch>[-baseline][-musl]` だけで、
dsh-oc はプラットフォームごとにこれらのパッケージを遅延インストールしてバイナリを取得します。

```text
env DSH_OC_OPENCODE_BIN → バージョン付きキャッシュ → PATH → 公式 npm プラットフォームパッケージ
  → profile 内の opencode-ai / @opencode/cli パッケージ → ダウンロードのフォールバック
```

- 公式 npm プラットフォームパッケージは `$DSH_HOME/opencode/packages/<platform-key>` にインストールし、
  候補の順序は公式 `postinstall.mjs` の platform/arch/musl/AVX2 の選択と一致します。
- 明示的な `DSH_OC_OPENCODE_BIN` は固定バージョン `2.1.0` を報告しなければならず、そうでなければ直接エラーにします。PATH 上の
  別バージョンへ暗黙にフォールバックすることはありません。
- 次のプラットフォームキーを対象にします。
  - `linux-x64`、`linux-x64-baseline`、`linux-x64-musl`、`linux-x64-baseline-musl`
  - `linux-arm64`、`linux-arm64-musl`
  - `darwin-x64`、`darwin-x64-baseline`、`darwin-arm64`
  - `windows-x64`、`windows-x64-baseline`、`windows-arm64`
- manifest がない場合、ダウンロード経路は復旧の手引きだけを示します（`DSH_OC_OPENCODE_BIN` を設定する、
  `opencode-ai@2.1.0` / `@opencode/cli@2.1.0` をインストールする、実行ファイルを手動で置く）。暗黙に
  失敗することはありません。

### 7.1 複数 arch のバイナリ配布

`src/tui/binary.ts` の優先順位（詳細は README と FEATURES.md を参照）:

```text
env DSH_OC_OPENCODE_BIN → バージョン付きキャッシュ → PATH → 公式 npm プラットフォームパッケージ
  → profile 内の opencode-ai / @opencode/cli パッケージ → npm プラットフォームパッケージのインストールによるフォールバック
```

公式 npm プラットフォームパッケージは `$DSH_HOME/opencode/packages/<platform-key>` にインストールし、
候補の順序は公式 `postinstall.mjs` の platform/arch/musl/AVX2 の選択と一致します。各プラットフォームはそれぞれの
プラットフォームパッケージで独立に検証し、単一のグローバルハッシュでは検証しません。

---

## 8. 既知のプロトコル制限（初版）

1. **`always` 権限の降格**: opencode TUI は `Allow always` を提供しますが、dsh approval には `allowed-once / rejected` しかありません。初版は `always` を `allowed-once` に写像し、TUI の外のログで通知します。将来 dsh が永続的な権限 preset を追加したら、本来の `always` に戻します。
2. **TUI の起動方法**: 2.x CLI に `attach` サブコマンドはないため、dsh-oc は `opencode --server <bridge-url>` で TUI を起動します（`--mini` は `opencode mini --server <bridge-url>` 経由）。`--dir` は dsh-oc 自身が消費して bridge cwd を書き換え、CLI には転送しません。`dsh --profile oc --model X` などの引数は初版では警告を出して無視します。モデルの切り替えは TUI 内のモデルセレクターで行います。
3. **ファイル添付**: `file` part はテキスト（data URL または cwd 内のローカルファイル）と画像（data URL）に対応し、dsh の `text`/`image` part に写像します。PDF などのバイナリ添付は 400 を返します。
4. **session diff**: produced-files の投影がない場合は `[]` を返し、diff を捏造しません。
5. **opencode 2.1.0 単一プロトコル**: アップグレードする場合は必ず第 2 節のプローブを再実行し、本ファイルを更新します。

## 9. e2e の実測実装状態（2026-08-15）

以下の状態は `chore-release` ブランチの profile-fix 後の実際の e2e によるものです（mock LLM +
dsh 0.1.2-rc.1 + opencode 1.18.18 で、TUI と bridge の両方を実際に動かしています。2.1.0 のルート形状は
§4 のテーブルと一致します）。

| ルート/機能 | 状態 | 備考 |
|---|---|---|
| §3 の起動 GET マトリクス（query 付きの `/api/model?location[...]` などを含む） | 200 + JSON | すべて curl+jq でアサート |
| `GET /api/event` | 200 SSE | 先頭フレームは `retry: 3000`。各フレームに `directory` を含む |
| `GET /api/agent` | MAP | 単一の `build` メイン agent（`model` を含む）を返す。そうでないと TUI の prompt を投入できない |
| `POST /api/session/{id}/prompt` | MAP | opencode SDK v2 の公式ルートで、`{ data: SessionInputAdmitted }` を返す |
| `POST /api/session/{id}/fork` | MAP | dsh の fork。child session の `parentID` が正しい |
| `POST /api/session/{id}/compact` | MAP | TUI の `/compact` が dsh command registry 経由で `/compact` を実行する |
| `GET /api/session` | MAP | child session が `parentID` を出力する。subagent は `metadata.origin` とタイトルの識別子を伴う |
| `GET /api/model` | MAP | `{ location, data: ModelV2Info[] }` を返す（プロトコルのオブジェクトで、裸の配列ではない） |
| `GET /api/permission/request` + `POST /api/session/{id}/permission/{rid}/reply` | MAP | mux の approval frame を受け取るには、少なくとも 1 つの SSE 接続を保つ必要がある（実際の TUI と同じ） |
| `goal/change` | MAP | goal と todos をマージし（goal が先頭）、`todo.updated` イベントで公開する |
| `POST /api/session/{id}/command` `/goal` | MAP | goal の作成と参照を行う。実際の TUI の sidebar で見える（`scripts/e2e-tui-goal.sh`） |
| `DSH_PERMISSION_MODE=ask` | 非対応 | dsh は `read-only`/`workspace-write`/`danger-full-access` しか受け付けない。approval=ask は `workspace-write` を使う |
| oc profile のホスト行 | bundle patch に統合済み | `storage`/`storage-json`/`storage-domain`/`webserver` は `cordis.patch.yml` がすでにマウントしている。`dsh --profile oc` で直接起動できる（ホストの overlay は不要） |
| `--print-logs` | 透過 | oc-tui はすでに `--print-logs` を `opencode --server` に渡している（opencode のトップレベルなグローバルオプションで、`OPENCODE_PRINT_LOGS=1` を設定する） |
| タイムスタンプ | 既定で有効 | `DSH_OC_TUI_TIMESTAMPS=1` が `kv.json` に `timestamps: show` を書き込み、`ctrl+shift+t` / `/timestamps` を割り当てる。e2e は `scripts/e2e-tui-timestamps.sh` |
| tarball インストールの e2e | PASSED | `DSH_OC_E2E_ADD_SPEC=<tgz>` の下で `e2e-api.sh` / `e2e-tui-boot.sh` / `e2e-tui-turn.sh` / `e2e-tui-timestamps.sh` がすべて通過する。profile がインストールするのは npm tarball で、ローカルパスは使わない |

---

## 10. 自動化されたプロトコルプローブ

`scripts/probe-opencode.mjs` は `tests/fixtures/opencode/routes.json`
（公式 2.1.0 client の実際のリクエスト一覧）と照合して、oc-bridge がすべてのルートを登録しているかを確認し、
opencode バイナリと `@opencode/client` のバージョン固定も検証します。

```bash
pnpm run probe
node scripts/probe-opencode.mjs --version 2.1.0 --bin /path/to/opencode \
  --out .e2e/protocol-probe.json
```

出力は、欠落ルート（`FAIL missing-route` と修正の提案）とバイナリ/client のバージョン不一致です。
すべて通れば終了コード 0 で `PASSED` を出力します。opencode をアップグレードする手順は次のとおりです。

1. `opencode-version.json` を更新する。
2. `pnpm install`（client のバージョン）の後に `pnpm run probe` を実行する。
3. `node scripts/check-client-routes.mjs` を実行し、公式 client のルートが `missing: 0` であることを確認する。
4. プローブの結果に従ってルートや stub を補い、本ファイルの互換マトリクスを更新する。

`node scripts/check-client-routes.mjs` もあります。`@opencode/client` の chunk を直接解析し、
公式 client のルート集合と bridge が登録したルート集合を比較して、`missing: 0` を出力したときだけ
網羅が完了したとみなします。

---

## 11. dsh 0.1.5 への移行ポイント（0.2.0-rc.4）

dsh 0.1.5 には、dsh-oc が使う host ABI に対する破壊的変更が 2 つあります。opencode 側のプロトコルと
2.1.0 のプローブマトリクスは変わりません。

### 11.1 session-controller の fileUploads

`dsh-api-session-controller` の `static inject` に `fileUploads` が追加されました。公式の provider
`@deepseek-ai/dsh-client-file-upload` はブラウザ向けの転送プラグイン（`connection` を inject する）で、
oc-bridge は Web transport をマウントしないため、bundle patch は `session-controller` の前に headless の行を挿入します。

```yaml
- id: oc-file-uploads
  name: '@chiro2001/dsh-oc/file-uploads'
```

サービスの実装（`src/bridge/file-uploads.ts`）:
- `registerAgentResolver` / `retirePrompt` は no-op。
- `bindPrompt` は receipt のない prompt に対して `{ commit(), [Symbol.dispose]() }` を返します。
  0.1.5 はこの戻り値を明示的なリソース管理（`using`）で包むため、`Symbol.dispose` がないと
  prompt が `session/agent-busy` で失敗します。
- `resolve` / `uploadStream` は実際のファイルの receipt に対して明示的に失敗します（bridge にアップロードのルートはなく、
  opencode の添付は convert 層で prompt の content に写像され、dsh のアップロードを通りません）。

### 11.2 assistant のストリーミングと履歴

| 項目 | dsh 0.1.2 | dsh 0.1.5（現在） |
|---|---|---|
| リアルタイムの増分 | `assistant/chunk` セッションイベントを永続化 | プロセス内の `agent/assistant-stream` フレーム（`start`→`chunk`→`end`。`chunk.chunk` は同じ `StreamChunk` の共用体） |
| attempt の確定 | なし | `assistant/attempt`（surface なしで無視する） |
| 履歴の記録 | `SessionHistoryRecord = SessionEventEntry \| SessionChunkRun`（`chunkrow/*`） | `SessionEventEntry` のみ。`assistant/message.stream` / `assistant/attempt.stream` に packed run と raw chunk を埋め込む |
| part の所要時間 | block-start イベントの時刻 | live フレームの `time`。コールドリードでは `assistantStreamTiming` が raw の `block-start`/`block-end` を読む |
| finish reason | live の `finish` chunk | 上記と同じ |
| 重複排除のキー | `sessionId:seq` | live は `${sessionId}:${attemptId}:${revision}:${index}`。履歴の行は従来どおり seq |

`src/bridge/rpc.ts#expandRecord` は埋め込まれた run を、0.1.2 時代の変換層がもともと消費していた
`text-chunks`/`reasoning-chunks`/`tool-call-chunks` の行に戻し、確定イベント自体も追加します。
`src/bridge/convert/message.ts` は `assistantStreamTiming` で raw の部品境界をマージします。
これにより history v1/v2、SSE ring のリプレイ、golden trace が表す opencode のセマンティクスが安定します。

### 11.3 ファイルツール

dsh 0.1.5 の `str_replace_editor` は dsh-base がマウントしなくなりました（0.1.2 では base の行、0.1.5 では
明示的な opt-in が必要です）。既定の preset（`minimal`）は永続 shell だけを含み、host 層は従来どおり
`dsh-tool-fs` の `read`/`write`/`edit` を提供します。bridge のツール名の対応は
`write`/`edit` をすでに覆っており、新しいファイルの `write` で result meta の diffs が空のときは呼び出しの引数から
`metadata.diff` を合成します。e2e の untracked write のシナリオは `write` を使うようになりました（`str_replace_editor`
の対応と単体テストは、明示的に opt-in したデプロイのために残しています）。
