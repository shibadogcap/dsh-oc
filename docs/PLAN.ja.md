*[English](PLAN.md) · 日本語 · [中文](PLAN.zh.md)*

# dsh-oc 実装計画

> ⚠️ 歴史的アーカイブです。本文はプロジェクト初期の実装計画であり、機能はほぼ実装済みです。現在の機能は
> [FEATURES.ja.md](FEATURES.md)、プロトコルは [PROTOCOL.ja.md](PROTOCOL.ja.md)、次の段階は
> [ROADMAP.ja.md](ROADMAP.md)、開発ガイドは [../AGENTS.ja.md](../AGENTS.ja.md) を参照してください。
>
> 状態は、方針が確定済みで主要部分が実行済みです。
> `0.2.0-rc.1` は dsh `>=0.1.2-rc.1` の host services へ移行し、`0.2.0-rc.4` 以降は
> dsh `>=0.1.5-rc.2` を対象にしています。本文に残る
> `apiProxy` 構造は歴史的な背景としてのみ扱い、実行時の仕様は AGENTS/PROTOCOL に従います。
> リポジトリは `chiro2001/dsh-oc` です（後に `chiro/dsh-oc` へ移る可能性があります）。
> 想定読者は、この計画に沿って dsh-oc を実装するモデルとエンジニアです。

---

## 1. 目標と境界

### 1.1 目標

OpenCode の TUI を DeepSeek Harness（dsh）のターミナルフロントエンドとして使います。

- **フロントエンド**: opencode 公式 CLI を `attach` モードで実行し、描画、キーボード、ターミナルのライフサイクルだけを担当します。
- **バックエンド**: dsh が Agent ロジック、セッション、ツール、モデル呼び出し、権限、ユーザーへの質問をすべて担当します。
- **接続**: dsh-oc は dsh プロセス内に OpenCode 互換の HTTP/SSE サービスを実装し、opencode TUI のプロトコル要求を dsh のサービス呼び出しへ変換します。

### 1.2 非目標（初版では扱わない）

- opencode TUI のソースを fork せず、コピーもしません。TUI は公式配布バイナリを使います。
- opencode 自身の server / agent / session / tool ランタイムを起動させません。
- opencode の 162 本の HTTP ルートすべてを対象にしません。未実装の周辺機能は schema-valid な空データか明示的な 501 を返します。
- dsh 本体のリポジトリは変更しません。dsh-oc は外部の profile bundle です。
- dsh の実行時に Bun を使いません。

---

## 2. アーキテクチャ

```text
┌───────────────────────────── dsh (Node) ─────────────────────────────────┐
│                                                                          │
│ profile "oc" = dsh-base + dsh-oc                                         │
│                                                                          │
│ dsh-base:                                                                │
│   agents, sessions, tools, llm, approval, userQuestions,                 │
│   sessionProjections, attachments, settings, credentials                 │
│                                                                          │
│ dsh-oc bundle が追加でマウントするもの:                                  │
│   - workspace registry (@deepseek-ai/dsh-workspace)                      │
│   - directory picker  (@deepseek-ai/dsh-host-directory-picker-auto)      │
│   - api proxy        (@deepseek-ai/dsh-host-apiproxy)                    │
│   - oc-bridge        本リポジトリの /bridge サブパス                     │
│   - oc-tui           本リポジトリの /tui サブパス                        │
│                                                                          │
│ oc-bridge:                                                               │
│   node:http の loopback サーバー                                         │
│   OpenCode v1 + v2 互換ルートを実装する                                  │
│   ctx.apiProxy.* を呼び出す                                              │
│   ctx.apiProxy.events.mux() を購読して SSE へ転送する                    │
│                                                                          │
│ oc-tui:                                                                  │
│   opencode バイナリを解決してキャッシュする                              │
│   `opencode attach http://127.0.0.1:<port>` を spawn する                │
│   stdio: inherit                                                         │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTP + SSE、loopback のみ
                                   ▼
                  opencode 公式バイナリ（attach モード）
                  · TUI/client のコードだけを実行する
                  · opencode バックエンドのインスタンスを作らない
                  · すべての状態を oc-bridge から読む
```

---

## 3. 主要な決定

| 決定 | 結論 | 理由 |
|---|---|---|
| TUI の入手元 | 公式 `opencode-ai` バイナリ + `opencode attach` | 公式の配布物を継続して再利用し、UI の fork を保守しない |
| バックエンドの帰属 | dsh を唯一のバックエンドとする | opencode をフロントエンド専用にするというユーザーの目標による |
| プロトコル範囲 | TUI が実際に使う v1 + v2 ルートのサブセットを実装する | プローブにより、TUI が2世代の API を同時に呼ぶことを確認済み |
| モデル設定 | opencode に DeepSeek の API キーを注入しない | dsh バックエンドが自分で DeepSeek を呼び、opencode TUI は dsh のモデルカタログだけを表示する |
| opencode データディレクトリ | `$DSH_HOME/opencode` へ隔離する | グローバルの opencode 設定、資格情報、セッションを読まない |
| バイナリ配布 | キャッシュ済み・インストール済みを優先し、無い場合だけ GitHub Release から遅延ダウンロードする | 350MB の npm 二重バイナリ依存と postinstall の自己修復を避ける |
| プロセス境界 | dsh=Node、opencode 子プロセス=公式 Bun 自己完結バイナリ | 互いに侵入しない |
| 互換戦略 | 未実装ルートには正当な空レスポンスか 501 を返し、UI を壊さない | 初版の範囲を制御する |

---

## 4. バージョンと依存の基準

### 4.1 opencode

- npm パッケージ: `opencode-ai@1.18.18`
- ソース commit: `4643e65`（リポジトリ `anomalyco/opencode`、dev ブランチ）
- GitHub Release: `v1.18.18`
- Release asset の命名: `opencode-<linux|darwin|windows>-<x64|arm64>[-baseline][-musl].tar.gz`（Windows は `.zip`）
- バージョン更新の方法: dsh-oc リポジトリに `opencode-version.json` を保持します。アップグレードでは、このファイルを更新し、asset の sha256 manifest を再生成し、プロトコル回帰を実行します。

### 4.2 dsh

- 実行時は、インストール済みの `@deepseek-ai/dsh` CLI が提供します（`dsh plugin --profile oc add ...`）。
- 開発時は同じ `deepseek-harness` の checkout を使います（dsh-oc の兄弟ディレクトリへ clone することを推奨します）。
- 本リポジトリは dsh のパッケージを `peerDependencies` + `devDependencies` で参照し、実行時は profile の module fallback で解決します。
- 直接使う dsh のサービスと型:
  - `@deepseek-ai/cordis`
  - `@deepseek-ai/dsh-cmdline`（`ctx.cmdlineArgs`、`ctx.appExit`）
  - `@deepseek-ai/dsh-home-paths`（`resolveDshHome`）
  - `@deepseek-ai/dsh-host-apiproxy`（`ctx.apiProxy` の型。プラグインは patch 行でマウントします）
  - `@deepseek-ai/dsh-settings` / `dsh-credentials`（型と brand helper）
  - `@deepseek-ai/dsh-session`（SessionEvent 型）
  - `@deepseek-ai/dsh-llm`（ContentBlock / ModelSelection 型）

---

## 5. 目標とするリポジトリ構造

```text
dsh-oc/
├─ package.json
├─ tsconfig.json
├─ tsdown.config.ts
├─ cordis.patch.yml
├─ opencode-version.json            # 固定した opencode のバージョン + commit
├─ opencode-assets.json             # 生成物: プラットフォーム asset -> url/sha256/size
├─ src/
│  ├─ index.ts                      # bundle エントリ（型と定数のみを公開し、副作用なし）
│  ├─ bridge/
│  │  ├─ index.ts                   # oc-bridge プラグイン: server のライフサイクル + ctx.apiProxy の組み立て
│  │  ├─ router.ts                  # OpenCode v1/v2 のルート表
│  │  ├─ http.ts                    # node:http のラッパー、CORS とエラー封筒
│  │  ├─ sse.ts                     # SSE encoder / client registry
│  │  ├─ events.ts                  # DSH mux frame -> OpenCode GlobalEvent
│  │  ├─ convert/
│  │  │  ├─ session.ts              # DSH SessionSummary -> OpenCode Session
│  │  │  ├─ message.ts              # DSH SessionEvent[] -> OpenCode Message/Part
│  │  │  ├─ tool.ts                 # tool/call + tool/result -> ToolPart
│  │  │  ├─ model.ts                # DSH ModelProviderGroup -> OpenCode Provider/Model
│  │  │  ├─ permission.ts           # DSH approval frame -> PermissionRequest
│  │  │  ├─ question.ts             # DSH question frame -> QuestionRequest
│  │  │  └─ todo.ts                 # DSH todos projection -> Todo[]
│  │  ├─ stubs.ts                   # 周辺ルート向けの schema-valid な空実装
│  │  └─ errors.ts                  # DSH RPC error -> OpenCode HTTP error
│  └─ tui/
│     ├─ index.ts                   # oc-tui プラグイン: spawn/シグナル/終了
│     ├─ binary.ts                  # バイナリの特定と遅延ダウンロード
│     ├─ download.ts                # GitHub Release のダウンロード + sha256 + 原子的な書き込み
│     └─ platform.ts                # platform/arch/musl/AVX2 の選択
├─ tests/
│  ├─ convert/*.spec.ts
│  ├─ bridge-router.spec.ts
│  ├─ binary.spec.ts
│  ├─ fixtures/
│  │  ├─ opencode/                  # プロトコルプローブが記録したリクエスト/レスポンスの fixture
│  │  └─ dsh/                       # DSH の session-event fixture
│  └─ e2e/
│     ├─ mock-llm.ts                # dsh-llm-mock-server かローカル mock を再利用する
│     ├─ attach-boot.e2e.ts         # 公式 attach が起動して oc-bridge へ要求する
│     └─ session-turn.e2e.ts        # TUI が prompt を送る -> DSH Agent -> メッセージが戻る
└─ docs/
   ├─ PLAN.md                       # 本文
   └─ PROTOCOL.md                   # プロトコルプローブの結果とルート一覧
```

---

## 6. package.json と cordis.patch.yml の仕様

### 6.1 package.json の要点

```json
{
  "name": "@chiro2001/dsh-oc",
  "version": "0.1.0-rc.1",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./bridge": "./lib/bridge/index.js",
    "./tui": "./lib/tui/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "opencode-version.json", "opencode-assets.json"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.0",
    "@deepseek-ai/dsh-cmdline": ">=0.0.1-rc.1",
    "@deepseek-ai/dsh-home-paths": ">=0.0.1-rc.1"
  }
}
```

> 型レベルの devDependencies（公開時には不要）: `@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-credentials`。
> ビルドには `tsdown` か `tsc` を推奨します。エントリは `lib/bridge/index.js` と `lib/tui/index.js` を生成します。

### 6.2 cordis.patch.yml

```yaml
# dsh-base の上に重ねる。挿入順が依存の有効化順を決める。
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'

    - id: directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-auto'

    - id: api-proxy
      name: '@deepseek-ai/dsh-host-apiproxy'

    - id: oc-bridge
      name: '@chiro2001/dsh-oc/bridge'
      inject: [apiProxy]

    - id: oc-tui
      name: '@chiro2001/dsh-oc/tui'
      inject: [ocBridge]
```

- `workspace` と `directory-picker` は `@deepseek-ai/dsh-host-apiproxy` の静的な inject 依存なので、dsh-oc が補う必要があります。
- `oc-bridge` は `ocBridge` サービスを公開します。形は `{ url: string, port: number }` です。
- `oc-tui` は `ocBridge` の準備ができてから起動します。`--help` のときに launcher が `appExit` を付けずに終了するのかは未確定で、実際の実装は dsh app の規約に従います。

### 6.3 インストール方法

```bash
# ローカル開発
cd dsh-oc
pnpm install && pnpm build
dsh plugin --profile oc add .
dsh --profile oc

# 公開後
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc
```

`dsh plugin` は `$DSH_HOME/profiles/oc` を初期化し、まず `["@deepseek-ai/dsh-base"]` を書きます。本パッケージが `dsh.bundle` を宣言していることを検出すると、`["@deepseek-ai/dsh-base", "@chiro2001/dsh-oc"]` になるよう追記します。

---

## 7. oc-bridge の設計

### 7.1 HTTP サービス

- `node:http` を使い、`127.0.0.1` のランダムポートで待ち受けます（`port: 0`、起動後に `server.address()` から読み取ります）。
- loopback 接続だけを受け付けます。すべてのレスポンスで CORS `*` を許可します（attach モードでは認証が不要で、後から dsh/openCode と同じ basic auth を足せます）。
- JSON エラーは opencode の `EffectHttpApiError*` / `NotFoundError` の形に統一し、TUI が正当な stub を致命的エラーとして扱わないようにします。
- 起動後、Cordis サービス `ocBridge` で `{ url }` を公開します。

### 7.2 DSH 呼び出しのラッパー

`ctx.apiProxy` のメソッドは RPC envelope 形式なので、oc-bridge が統一的に包みます。

```ts
async function call<K extends keyof DshApiProxy>(
  method: K,
  payload: RequestPayload<K>,
  signal?: AbortSignal,
): Promise<ResponseValue<K>> {
  const rpcId = randomUUID()
  const response = await api[method]({ rpcId, payload }, signal)
  return response.payload
}
```

DSH の RPC エラーはすべて opencode の HTTP エラーへマッピングし、`code` を保持します。

### 7.3 ルート一覧（中核のサブセット）

以下のルートは **P1/P2 で必ず実装する** ものです。残りは `PROTOCOL.md` の表に従って stub を返します。

#### v1（TUI の sync と主な対話で使う）

| メソッド/パス | 実装 |
|---|---|
| `GET /path` | `{ path, worktree, directory }` を返します。値は `ctx.apiProxy.host` / `process.cwd()` から取ります |
| `GET /project/current` | 単一プロジェクトの stub です。`id/worktree` は dsh プロセスの cwd から安定した値として生成します |
| `GET /project/global/directories` | `[{ id, worktree: cwd, path: cwd }]` か空配列を返します |
| `GET /config` | `{}` を返します（opencode TUI のローカル設定は attach プロセス自身の `OPENCODE_CONFIG_DIR` が管理します） |
| `GET /config/providers` | 空の設定ビューか、dsh `llm.providers` からの変換結果を返します |
| `GET /provider` | dsh の provider 一覧（モデルを含む）を返します |
| `GET /provider/auth` | `{}` を返します。dsh の資格情報は opencode が管理しません |
| `GET /agent` | primary agent のビュー1件か空配列を返します |
| `GET /command` | dsh の command registry から変換します。初版では空配列でも構いません |
| `GET /session?start=…&path=…` | `apiProxy.sessions.list` → `Session[]` |
| `GET /session/status` | `apiProxy.sessions.list` の running フラグから `Record<id, SessionStatus>` を返します |
| `POST /session` | `apiProxy.sessions.create` を呼び、opencode の `Session` を返します |
| `GET /session/{id}` | `apiProxy.sessions.history` と `list` の該当項目から `Session` を作ります |
| `PATCH /session/{id}` | `apiProxy.sessions.rename` |
| `GET /session/{id}/message` | `apiProxy.sessions.history` → `Message[]` |
| `POST /session/{id}/prompt` | `apiProxy.sessions.prompt` を呼びます。content は opencode の `PromptInput` から `PromptContentPart[]` へ変換します |
| `POST /session/{id}/abort` | `apiProxy.sessions.cancel` |
| `GET /session/{id}/todo` | dsh の `todos` projection → `Todo[]` |
| `GET /session/{id}/diff` | produced-files の投影があれば変換し、無ければ `[]` を返します |
| `GET /global/event` | SSE です。`apiProxy.events.mux` を購読し、変換してから送ります |
| `GET /permission` | 現在 pending の approval → `PermissionRequest[]` |
| `POST /permission/{id}/reply` | dsh `apiProxy.respond` の approval response へマッピングします |
| `GET /question` | 現在 pending の question → `QuestionRequest[]` |
| `POST /question/{id}/reply` | dsh `apiProxy.respond` の question response へマッピングします |
| `POST /question/{id}/reject` | cancelled の client-response で `apiProxy.respond` を呼びます |

#### v2（`/api/...`、TUI の data layer が使う）

| メソッド/パス | 実装 |
|---|---|
| `GET /api/location` | `{ directory: cwd, workspaceID? }` を返します |
| `GET /api/agent` | dsh の subagent/preset 情報です。初版では空配列か primary agent を返します |
| `GET /api/model` | `apiProxy.llm.models` → opencode `Model[]` |
| `GET /api/provider` | `apiProxy.llm.models/providers` → opencode `Provider[]` |
| `GET /api/command` | 空配列か、dsh の commands を変換したもの |
| `GET /api/skill` | 空配列か、dsh の skills を変換したもの |
| `GET /api/reference` | `[]` |
| `GET /api/integration` | `[]` |
| `GET /api/permission/saved` | `[]`（初版は always-save に対応しません） |
| `GET /api/session` | v1 の list と同じ |
| `POST /api/session` | v1 の create と同じ |
| `GET /api/session/{id}` | v1 の get と同じ |
| `GET /api/session/{id}/message` | v1 の messages と同じ |
| `GET /api/session/{id}/permission` | セッションの pending approvals |
| `POST /api/session/{id}/permission/{rid}/reply` | v1 の permission reply と同じ |
| `GET /api/session/{id}/question` | セッションの pending questions |
| `POST /api/session/{id}/question/{rid}/reply` | v1 の question reply と同じ |
| `POST /api/session/{id}/question/{rid}/reject` | v1 の question reject と同じ |

> 注意: プローブでは、TUI が `/session*` と `/api/session*` の両方を呼び出します。2系統は共存させる必要があり、同じ service 実装を共有して URL プレフィックスだけを変えます。

### 7.4 SSE イベントブリッジ

`GET /global/event` は長い接続を維持します。

1. SSE クライアントごとに dsh mux consumer を1つ作ります。
   ```ts
   for await (const frame of apiProxy.events.mux({ rpcId, payload: {} }, signal)) {
     const event = convertMuxFrameToOpencodeEvent(frame)
     if (event) sse.write(`data: ${JSON.stringify(event)}\n\n`)
   }
   ```
2. 少なくとも次の mux frame を変換します。
   - `session/event`:
     - `session/created`、`session/title` → `session.updated`
     - `turn/start` → `session.status`（busy）
     - `turn/end` → `session.idle`
     - `user/message`、`assistant/message`、`tool/result` → 対応する `message.updated` / `message.part.updated` を再構築します
     - `approval/asked|decided` → `permission.asked/replied`
     - `todo/write` → `todo.updated`
   - `approval/requested|resolved` → `permission.asked/replied`
   - `question/requested|resolved` → `question.asked/replied/rejected`
   - `session/queue` は購読の初期化時に pending inbox をミラーします（キューに入ったメッセージは TUI で QUEUED と表示されます）。以降は `agent/inbox/spliced` で差分を維持します。`session/jobs` は引き続き無視します。
3. イベントには `directory`（セッションの cwd）と、任意の `project`/`workspace` フィールドを付けます。opencode TUI は directory でイベントを絞り込みます。
4. SSE が切断されたら dsh mux consumer をキャンセルします（`AbortController` を使います）。

### 7.5 主要なオブジェクトの変換

#### Session

OpenCode の `Session` と dsh の `SessionSummary` の対応です。

```text
id            = dsh sessionId
slug          = id
directory     = summary.cwd ?? process.cwd()
projectID     = 安定した dsh-project-id（cwd のハッシュ）
title         = summary.projections?.sessionTitle ?? ''
time.created  = dsh header.createdAt
time.updated  = summary.updatedAt
model         = セッションの現在の model（無ければ既定値）
agent         = agentPreset ?? 'build'
```

#### Message / Part

`apiProxy.sessions.history` の `events` を畳み込んで生成します。

- `user/message` ごとに:
  - `UserMessage` とテキストの `TextPart` を生成します。画像は `FilePart` にします（URL は `GET /file/content` か data URL を使い、初版はテキストのみの対応でも構いません）。
- `assistant/message` ごとに:
  - `AssistantMessage` を生成します。
  - `message.content` の text block → `TextPart`。
  - reasoning block → `ReasoningPart`。
  - `tool/result` は対応する `tool/call` と組にして `ToolPart` を生成します。
  - 初版では、assistant メッセージ全体を `message.updated` イベントとして再構築し、part 単位の増分イベントを減らしても構いません。
- `assistant/chunk`:
  - SSE の間は delta へ変換せず、`assistant/message` か `turn/end` の時点で完全なメッセージを送ります。正確さを優先します。

#### ToolPart

dsh の `tool/call` と `tool/result` の対応です。

```text
callId      = dsh callId
tool        = dsh の tool 名
state:
  call のみ        -> pending（raw input）
  result 成功      -> completed（input + output）
  result エラー    -> error
title        = tool presentation の `title`、無ければ tool 名
metadata     = dsh meta（JSON-safe）
```

#### Model / Provider

`apiProxy.llm.models` の `ModelProviderGroup` の対応です。

- dsh の provider `deepseek-official` → opencode の provider id `deepseek`（表示名は `DeepSeek`）。
- model の id、name、description はそのまま通します。`limit.context/output` は dsh の能力値を使い、無い場合は安全な既定値（context 128000、output 8192）を使います。
- `capabilities` には既定値を入れます。`toolcall: true`、`reasoning: true`、`temperature: false`、input/output は text です。
- モデル選択の書き戻し: `POST /api/session/{id}/model` か TUI の対応する呼び出し → `apiProxy.sessions.selectModel`。

#### Permission

- `opencodePermissionId -> dshRpcId` の対応表をメモリ上に作ります。
- mux の `approval/requested` が届いたら:
  - opencode の `PermissionRequest` を生成します。
    - `permission` には `toolName` に対応する分類を入れます（bash → `bash`、fs → `edit`/`read`、それ以外 → `unknown`）。
    - `patterns` と `metadata` は toolName/callId/reason で埋めます。
  - `/permission` の一覧と SSE の `permission.asked` の両方へ書きます。
- TUI からの応答:
  - `once` → dsh の `allowed-once`
  - `reject` → dsh の `rejected`
  - `always` → 初版では `allowed-once` として扱い、制限を `docs/PROTOCOL.md` に記録します。

#### Question

- `opencodeQuestionId -> dshRpcId` の対応表を作ります。
- dsh `question/requested` の `questions[]`（`id` を含む）を opencode の `QuestionRequest` へ変換します。
  - opencode の `QuestionInfo[]` は dsh の順に並べます。opencode の answer は配列の順で返します。
  - 書き戻すときは index で dsh の `{ id, selected[], custom? }` へ戻します。
- `multiSelect`、`header`、`detail` は dsh のフィールドをそのまま通します。

#### Todo

- dsh の `todos` projection は `TodoItem[]` で、フィールドは opencode の `Todo` に近い形です。
  - `status`: dsh の `pending|in_progress|completed` → opencode の同名の値。priority が無い場合は `medium` を入れます。
- projection が無い場合は `[]` を返します。

### 7.6 周辺 stub の規則

`GET /lsp`、`/mcp`、`/formatter`、`/experimental/resource`、`/experimental/console`、`/experimental/capabilities`、`/vcs`、`/experimental/workspace*`:

- **正当な空配列・空オブジェクト** を返します。HTML や裸の 500 は返しません。
- `experimental.capabilities` は `{ backgroundSubagents: true }` を返します。dsh のセッションは
  サーバー側に常駐し、`subagent` ツールは既定でバックグラウンド実行になります。`POST /experimental/session/{id}/background`
  は no-op の成功です（`true` を返します）。
- `vcs` は `{ branch: '', status: [] }` のような最小の形を返します。
- すべての stub は、公式 opencode server の同じルートの実レスポンスを fixture にして schema を検証します。

---

## 8. oc-tui の設計

### 8.1 バイナリ取得の優先順位

```text
1. 環境変数 DSH_OC_OPENCODE_BIN（絶対パス）
2. $DSH_HOME/opencode/bin/<version>/opencode(.exe) のキャッシュで、--version が一致するもの
3. PATH 上の opencode で、--version が一致するもの
4. 公式 npm プラットフォームパッケージ（opencode-<platform>-<arch>[-baseline][-musl]@1.18.18）。
   $DSH_HOME/opencode/packages/<platform-key> へ遅延インストールし、npm integrity で検証する
5. profile にインストール済みの opencode-ai パッケージ（存在すれば公式 postinstall を自動実行してから使う）
6. GitHub Release から公式の単一プラットフォーム asset を遅延ダウンロードする（プラットフォーム別 sha256 manifest）
```

- バージョンは `opencode-version.json` から取得し、現在は `1.18.18` に固定しています。
- キャッシュパス: `$DSH_HOME/opencode/bin/1.18.18/opencode`（Windows は `.exe`）。
- npm プラットフォームパッケージの候補順は公式 `postinstall.mjs` と同じです。ダウンロード URL とプラットフォーム別 sha256 は
  `opencode-assets.json` から取得し、このファイルはスクリプトが生成します（`PROTOCOL.md` の付録を参照）。

### 8.2 プラットフォームの選択

公式 opencode postinstall の選択ロジックをそのまま実装します。

- `process.platform` → darwin/linux/win32
- `process.arch` → x64/arm64
- Linux:
  - musl の検出: `/etc/alpine-release` か `ldd --version`
  - x64 かつ AVX2 が無い場合: `-baseline` を選びます（`/proc/cpuinfo` を読みます）
- asset の拡張子:
  - Linux/macOS: `.tar.gz`
  - Windows: `.zip`

### 8.3 ダウンロード、検証、書き込み

1. Node の `fetch` で `$DSH_HOME/opencode/tmp/<uuid>` へダウンロードします。
2. `crypto.createHash('sha256')` で `opencode-assets.json` の digest を検証します。失敗したら削除して1回だけ再試行します。
3. 展開します。
   - POSIX: `tar -xzf`
   - Windows: PowerShell の `Expand-Archive`
4. `chmod 0755` の後、原子的に rename してキャッシュディレクトリへ置きます。もう一度 `--version` を実行して検証します。
5. プロキシ: `HTTPS_PROXY`/`HTTP_PROXY` を尊重します。Node の fetch が自動でプロキシを使わない場合は、`undici` の `ProxyAgent` を足すか、`DSH_OC_OPENCODE_MIRROR` のミラー URL を文書化します。
6. ダウンロードに失敗したら、明確な案内を出力します。
   - `DSH_OC_OPENCODE_BIN` を設定する
   - または `dsh plugin --profile oc add opencode-ai@1.18.18`
   - または asset を手動でダウンロードしてキャッシュパスへ置く

### 8.4 起動

```text
spawn(opencodeBin, ['attach', bridgeUrl, ...tuiArgs], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: childEnv,
})
```

- `tuiArgs` には `attach` が対応する引数だけを渡します。`--continue`、`--session`、`--fork`、`--dir`、`--mini` です（P0 ではまず `--continue/--session/--dir` のみの対応でも構いません）。
- `attach` が対応しない引数（`--model`、`--prompt` など）は警告を出して無視します。黙って捨ててはいけません。
- `childEnv`:
  - `process.env` を継承します
  - `OPENCODE_CONFIG_DIR=$DSH_HOME/opencode/config`
  - `XDG_DATA_HOME=$DSH_HOME/opencode/data`
  - `XDG_STATE_HOME=$DSH_HOME/opencode/state`
  - `XDG_CACHE_HOME=$DSH_HOME/opencode/cache`
  - DeepSeek の provider/key を設定するために `OPENCODE_CONFIG_CONTENT` を **設定しません**。モデルと資格情報は dsh バックエンドが扱います。
  - `DSH_OC_TUI_TIMESTAMPS=1` のときは、追加で `$DSH_HOME/opencode/state/opencode/kv.json` に
    `timestamps: show` を書き、`ctrl+shift+t` を含む `tui.json` を生成します。

### 8.5 シグナルと終了

- プラグインは `ctx.cmdlineArgs` で引数を読み、`ctx.appExit(code)` で終了します。
- spawn に成功した後:
  - 子プロセスがターミナルの raw mode を保持します。
  - 親プロセスが SIGINT/SIGTERM を受け取ったら子プロセスへ転送し、子プロセスの終了前に強制終了しません。
  - 子プロセスが終了したら `ctx.appExit(childExitCode)` を呼びます。
- プラグインの dispose 時に子プロセスが生きている場合: SIGTERM → 5s → SIGKILL。
- ターミナルの復元（alternate screen、カーソル、raw mode の復帰）は PTY の e2e で検証する必要があります。

---

## 9. テスト方針

### 9.1 ユニットテスト

| モジュール | 対象 |
|---|---|
| `convert/session.ts` | SessionSummary → Session の全フィールド |
| `convert/message.ts` | user/assistant/tool イベントの畳み込み、compaction replace、空の履歴 |
| `convert/tool.ts` | pending/running/completed/error の4状態 |
| `convert/model.ts` | provider/model の対応、欠けたフィールドの既定値 |
| `convert/permission.ts` | id の対応、once/reject/always の意味 |
| `convert/question.ts` | 複数質問の順序、multiSelect、custom |
| `bridge/router.ts` | 中核ルートごとの 200/エラー/空データ |
| `bridge/events.ts` | mux frame → SSE イベントの全パターン |
| `tui/platform.ts` | linux の musl/AVX2、darwin、windows の選択 |
| `tui/binary.ts` | 優先順位、キャッシュヒット、自己修復、ダウンロード失敗 |

### 9.2 プロトコル回帰

- `docs/PROTOCOL.md` の手順で fixture を録り直します。
- mock の oc-bridge を起動し、公式の `opencode attach` を動かして次を検証します。
  - TUI が全画面に入る。
  - すべての `GET` が 200 を返し、schema が正当である。
  - TUI 側に unhandled エラーのログが出ない。

### 9.3 DSH バックエンドの e2e

- dsh のテスト基盤を再利用し、mock LLM（`@deepseek-ai/dsh-llm-mock-server` かローカルの HTTP mock）をマウントします。
- oc-bridge の HTTP API を直接叩いて検証します。
  - create session → prompt → history の読み取り → メッセージとツールカードが正しい
  - cancel/steer
  - approval/question の一連の流れ
- PTY で `dsh --profile oc` を動かし、キー入力を模擬します。
  - セッションを新規作成する
  - prompt を入力する
  - DSH Agent の返答を待つ
  - 終了してターミナルが復元されたことを確認する

---

## 10. 実装フェーズと受け入れゲート

### P0: プロトコルプローブと最小 mock（目標: 公式 attach が安定して起動する）

成果物は次のとおりです。
- `docs/PROTOCOL.md` の更新（fixture 生成スクリプトを含む）
- `src/bridge/stubs.ts` で、プローブが検出した起動ルートをすべて覆う
- `tests/e2e/attach-boot.e2e.ts`

受け入れ条件は次のとおりです。
- `opencode attach http://127.0.0.1:<mock>` で TUI に入る
- 起動時の全リクエストが 200 で、schema が正当
- 未捕捉の例外が無い

### P1: 中核のセッション経路（目標: TUI から dsh のセッションを操作できる）

成果物は次のとおりです。
- dsh-oc bundle patch で workspace/directory-picker/api-proxy をマウントする
- oc-bridge の中核 `/session*`、`/api/session*`、`/global/event`
- session/message/tool の変換
- oc-tui の binary resolver + spawn + signal

受け入れ条件は次のとおりです。
- `dsh --profile oc` が起動する
- TUI でセッションを新規作成できる
- prompt を送ると DSH Agent が実行する（mock LLM を使う）
- テキスト、reasoning、ツールカードが TUI にリアルタイムで表示される
- セッション一覧と履歴の resume が正しく動く

### P2: 対話とモデル（目標: 人とマシンのループを完成させる）

成果物は次のとおりです。
- permission/question の双方向マッピングと SSE
- model/provider の一覧と model 選択の書き戻し
- todo/diff のマッピング
- エラーマッピング

受け入れ条件は次のとおりです。
- bash ツールが approval を起こし、TUI に権限ダイアログが出て、allow once/reject が効く
- `ask_user_question` が TUI のダイアログに出て、回答が DSH へ戻る
- モデル選択に DSH のカタログが表示され、切り替え後に DSH が新しいモデルを使う

### P3: 周辺ルートと堅牢化（目標: 目に見える UI の破綻を無くす）

成果物は次のとおりです。
- command/skill/file-search/vcs などの map か正当な stub
- ダウンロードキャッシュ、ミラー、プロキシ
- Windows/macOS の基本検証（少なくとも binary resolver + attach boot）

受け入れ条件は次のとおりです。
- プローブ対象の全ルートが 200/501 を返し、schema が正当
- TUI の主要メニューが落ちない
- ネットワーク断でもキャッシュヒットで起動できる
- プロトコル回帰が通る

### P4: リリース

成果物は次のとおりです。
- README のインストール、使い方、制限
- `opencode-assets.json` の生成スクリプト
- npm publish dry-run / CI

受け入れ条件は次のとおりです。
- 新しい環境で README の3ステップにより動く
- `dsh plugin --profile oc add .` が bundle リストを正しく書き込む

---

## 11. リスクと緩和

| リスク | 緩和 |
|---|---|
| opencode TUI が v1/v2 の両方に依存し、プロトコルの細部が多い | P0 で実バイナリを使って fixture を録る。中核ルートは実装を共有する。バージョンごとに回帰を回す |
| DSH と opencode のメッセージモデルの差で描画が欠ける | DSH `history` の event+view を正とし、SSE では細かい delta ではなく完全なメッセージを送る |
| `always` 権限に DSH の等価物が無い | 初版では `once` へ降格し、その旨を明示する。DSH の権限プリセット拡張は後で評価する |
| opencode バイナリのアップグレードで attach のルートが壊れる | バージョンを厳密に固定し、アップグレードには必ずプロトコル回帰を通す |
| ダウンロード元へ到達できない | キャッシュを優先する。mirror に対応する。ユーザーが事前にインストールした `opencode-ai` にも対応する |
| dsh の RPC エラーを正しく変換できず TUI が落ちる | エラー封筒を統一し、schema の fixture テストを置く |
| ターミナルの raw mode が復元できない | PTY の e2e で、正常終了、シグナル終了、タイムアウトによる強制終了を必ず覆う |

---

## 12. Definition of Done

初版の完了条件は次のとおりです。

1. `dsh plugin --profile oc add chiro2001/dsh-oc` の後、`dsh --profile oc` で公式 opencode TUI が起動する。
2. TUI は dsh-oc のブリッジにだけ接続する。opencode のローカル server/agent の経路は現れない。
3. セッションの作成、一覧、履歴、prompt、cancel はすべて dsh が実行し、TUI が正しく描画する。
4. approval、ask_user_question、モデル選択は TUI から操作でき、dsh へ書き戻される。
5. opencode バイナリは公式の配布物に由来し、バージョンと sha256 を検証する。
6. 中核の PTY e2e とプロトコル回帰が通る。
7. 未実装ルートの挙動は `docs/PROTOCOL.md` に明記する。
8. README でインストール、引数の受け渡しの制限、セッションとデータの隔離、dsh-web との違いを説明する。

---

## 13. 参考資料

- `docs/PROTOCOL.md`: プローブの結果、ルートの分類、fixture の方法
- opencode のソース（開発時に `../opencode` へ clone します）:
  - `packages/tui/src/context/{sdk,sync,data}.tsx`
  - `packages/tui/src/component/prompt/index.tsx`
  - `packages/opencode/src/cli/cmd/attach.ts`
  - `packages/opencode/src/server/routes/instance/httpapi/`
  - `packages/sdk/openapi.json`
  - `packages/opencode/script/postinstall.mjs`
- dsh のソース（開発時に `../deepseek-harness` へ clone します）:
  - `packages/host/apiproxy/src/api-proxy.ts`
  - `packages/host/apiproxy/src/api/{sessions,events,llm,approvals,questions}.ts`
  - `packages/core/session/src/types.ts`
  - `packages/core/agent/src/index.ts`
  - `packages/bundle/{base,web-app}/cordis.patch.yml`
  - `apps/cli/src/{args,profile-boot,plugin}.ts`

---

## 14. 実装状況のスナップショット（2026-08-15）

> 本章は後から追記した現在の実装状況です。第1〜13節の歴史的な計画はそのまま残しています。

### 実装済み

| フェーズ | 状態 | 説明 |
|---|---|---|
| scaffold | ✅ 実装済み | `src/`、`tests/`、`tsdown.config.ts`、`cordis.patch.yml`、`opencode-version.json`/`opencode-assets.json` が揃っています |
| bridge | ✅ 実装済み | oc-bridge: OpenCode v1/v2 のルート、SSE、セッション/モデル/権限/質問の変換 |
| tui | ✅ 実装済み | oc-tui: バイナリの解決/ダウンロード/検証、`attach` 引数の絞り込み、シグナル転送、データ隔離 |
| e2e | ✅ 実装済み | `scripts/e2e-api.sh`、`e2e-tui-boot.sh`、`e2e-tui-turn.sh`、`e2e-tui-stream.sh`、`e2e-tui-timestamps.sh` を `tests/e2e/{env.mjs,common.sh}` が駆動します |
| profile-fix | ✅ 実装済み | ホスト行（`storage`/`storage-json`/`storage-domain`/`webserver`）を bundle patch に統合し、`dsh --profile oc` で直接起動します |
| release | ✅ 実装済み | README/PROTOCOL/PLAN を仕上げました。`DSH_OC_E2E_ADD_SPEC=<tgz>` による npm tarball の e2e に対応します |

### 主要コミット

```text
68d8be5 fix(profile): bundle storage and webserver host rows so dsh --profile oc boots directly
042b5d3 test(e2e): api route matrix, sse turn, dsh profile boot and real opencode tui attach
beca54d merge: integrate oc-bridge and oc-tui
0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy
81920ee feat(tui): opencode binary resolution, download, spawn and signal handling
```

後続のリリースコミットは `chore(release): documentation and npm tarball end-to-end verification` です（本スナップショットのコミットと同時に記録しています）。

### 検証結果

- `pnpm install` / `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm pack:dry` はすべて通り、`pack:dry` に warning/error はありません。
- ローカルパスインストールの e2e（`dsh plugin --profile oc add .`）: 5本のスクリプトがすべて `PASSED` です。
- npm tarball インストールの e2e（`DSH_OC_E2E_ADD_SPEC=<tgz>`）: 5本のスクリプトがすべて `PASSED` で、profile に入っているのは tarball です。
- tarball には `lib/index.js`、`lib/bridge/**`、`lib/tui/**`、`cordis.patch.yml`、`opencode-version.json`、`opencode-assets.json`、`package.json`、`README.md` が含まれます。
