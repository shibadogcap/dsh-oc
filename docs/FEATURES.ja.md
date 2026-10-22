*[English](FEATURES.md) · 日本語 · [中文](FEATURES.zh.md)*

# dsh-oc の機能サポートマトリクス

> 状態の凡例: ✅ 対応済み、🟡 一部対応または制限あり、❌ 未実装または stub のみ。
> 本ファイルは機能状態の入口です。ルートとプロトコルの詳細は [PROTOCOL.ja.md](PROTOCOL.ja.md) を参照してください。
> `pnpm run features:update` を実行すると文末の「自動追跡」の部分を更新できます。手動の状態マトリクスはそのまま残ります。

## 現在の状態と次の段階

> 本表はユーザーから見える機能の事実上の入口です。対応済みの機能は下のマトリクスにあり、未リリースの作業は
> [CHANGELOG.ja.md](CHANGELOG.ja.md) の `Unreleased` に記録しています。今後の計画は [ROADMAP.md](ROADMAP.md) にあります。

## 1. モデル

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| Provider / モデルカタログの表示 | ✅ | `GET /api/provider`、`GET /api/model`、`src/bridge/convert/model.ts` | `tests/convert/model.spec.ts`、`scripts/e2e-api.sh` | `f30b156` |
| デフォルトの build agent が利用可能なモデルを持つ | ✅ | `GET /api/agent`、`src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| モデルセレクタから dsh への書き戻し（`/api/session/:id/model`） | ✅ | `POST /api/session/:sessionID/model`（body に model を載せる） | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本コミット |
| Reasoning effort / variant の表示と切り替え | ✅ | `Model.variants`、`ModelV2Info.variants`、session model の `variant` | `tests/convert/model.spec.ts`、`tests/bridge-router.spec.ts`、`scripts/e2e-api.sh`、TUI `ctrl+t` | 本コミット |
| dsh agent preset の表示と切り替え（minimal など） | ✅ | `GET /api/agent`、`POST /api/session/:sessionID/agent`、`POST /api/session/:id/command` `/preset` | `tests/bridge-router.spec.ts`。隔離プロファイルに minimal が無い場合は build のみ | 本コミット |
| Tab/`/preset` による agent 切り替えが prompt とともに反映される | ✅ | prompt の body の `agent` をセッションに適用します。すでに返信を生成したセッションを dsh がロックしている場合（409）は、最初の送信後にロックの通知を1回だけ表示します。最終的な切り替えカードには完了時刻と実際のモデル/variant が付き、QUEUED のままにはなりません | `tests/bridge-router.spec.ts`、実際の TUI とユーザーの手動検証 | `v0.2.0-rc.2` |
| モデル / Provider のエラー変換 | ✅ | `src/bridge/errors.ts`、`src/bridge/rpc.ts` | `tests/bridge-router.spec.ts`（404/409/400/501） | `f30b156` |

## 2. セッション

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| セッション一覧 / 状態 | ✅ | `GET /api/session`、`POST /api/session/:id/wait` | `tests/bridge-router.spec.ts`、`e2e-api.sh` | `f30b156` |
| セッション一覧のタイトルフォールバック | ✅ | 永続タイトル → プロジェクトディレクトリの basename → session id（dsh クライアントの表示ロジックに合わせる） | `tests/convert/session.spec.ts` | 本コミット |
| セッション一覧での実タイトルの補読 | ✅ | dsh の `session.list` は title の投影を持ちません。bridge がセッションごとに history tail の投影を補読してキャッシュし、一覧に実タイトルを表示します（≤40 は全量を同期取得し、大きな一覧では 24 件をバックグラウンドで補読します。一覧はブロックしません） | `tests/bridge-router.spec.ts`、`scripts/e2e-tui-turn.sh` | 本コミット |
| セッション検索（v2 `?search=`）と limit/ディレクトリの絞り込み | ✅ | `src/bridge/router.ts` の `/api/session` が `session.search` を経由 | `tests/bridge-router.spec.ts` | 本コミット |
| セッション一覧のページング（v2 `cursor` next/previous + order） | ✅ | `src/bridge/router.ts` の `/api/session` offset カーソル | `tests/bridge-router.spec.ts` | 本コミット |
| 新規作成 / リネーム / 履歴 / メッセージ | ✅ | `POST /api/session`、`PATCH /api/session/:id`、`GET /api/session/:id/message` など | `tests/bridge-router.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| Prompt | ✅ | `POST /api/session/:sessionID/prompt`（body の `text` または `parts`） | `e2e-api.sh`、`e2e-tui-turn.sh` | `f30b156` |
| `!` Shell mode（ユーザーコマンド） | ✅ | 公式 TUI の `!` → `POST /api/session/:id/shell`。Agent の `runMaintenance` で idle を排他的に取得してから OS shell を起動し、user/assistant/tool のカードに変換します。ユーザーが手で実行したコマンドと出力は、起床を伴わない `Agent.inject()` で次のモデル prompt に注入します | `tests/bridge-router.spec.ts`、`scripts/e2e-tui-shell.sh`、ユーザーによる TUI の手動確認 | `v0.2.0-rc.2` |
| `--mini` での prompt 送信 | ✅ | `POST /api/session/:sessionID/prompt`（slash/モデル/agent の処理） | `tests/bridge-router.spec.ts`、`e2e-tui-mini.sh` | 本コミット |
| Abort / cancel | ✅ | `POST /api/session/:id/interrupt` | `e2e-api.sh` | `f30b156` |
| Fork（`parentID`） | ✅ | `POST /api/session/:id/fork`、messageID→atSeq | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本コミット |
| セッションの revert（回退） | ✅ | `POST /api/session/:sessionID/revert/stage`、`DELETE /api/session/:sessionID/revert`、`POST /api/session/:sessionID/revert/commit`。境界は排他で、境界のメッセージとそれ以降をまとめて破棄します。stage ではターン単位でファイルをロールバックして diff を返し、commit では切れ目で dsh セッションを fork して opencode のセッション id をその fork に追従させます（エイリアス）。次の prompt で自動的にコミットします。セッション記録には `revert` フィールドが付きます。SSE は `session.revert.staged` / `.cleared` / `.committed` | `tests/contract/revert.spec.ts`、`tests/rewind/rewind.spec.ts` | 本コミット |
| セッション revert の既知の制限 | 🟡 | dsh は空の fork を表現できません（切れ目が最初のメッセージより前にある場合は 400 `cannot cut before the first message` を返します）。ファイル diff は変更行の先頭と末尾の間をまとめた粗い hunk で（bridge 自身のファイル変更 diff と同じ形）、完全な LCS diff ではありません | `docs/PROTOCOL.ja.md` の 4.3 節 | 本コミット |
| Todo の投影 | ✅ | SSE `todo.updated`（2.x に独立した todo の GET ルートはありません） | `tests/convert/todo.spec.ts`、`tests/bridge-router.spec.ts` | `f30b156` |
| Diff / produced-files / Modified Files | ✅ | `GET /api/session/:id/diff`、`session.diff` + Snapshot/Patch part | `tests/bridge-router.spec.ts`、`e2e-tui-tools.sh` | 本コミット |
| SSE のセッション / メッセージイベント | ✅ | `GET /api/event`（先頭フレームは `server.connected`）、`src/bridge/events.ts` | `tests/bridge-events.spec.ts`、`e2e-api.sh`、`e2e-tui-stream.sh` | `f30b156` |
| SSE のテキスト delta が対で重複する | 🟡 | 既知の挙動です。dsh は同じテキストに対して `assistant/chunk` と packed な `text-chunks` を同時に送り、新しい mux の購読では再生も行われます。そのため bridge の delta は対で重複することがありますが、TUI は `message.updated` の全量テキストで描画するため、実測では重複表示はありません | `docs/PROTOCOL.ja.md` | 本コミット |
| Agent / ストリームのエラー → `session.error` | ✅ | `stream/error` と `host/agent-error` の変換 | `tests/bridge-events.spec.ts` | 本コミット |
| SSE mux/host の一時エラーからの自動再接続（指数バックオフ） | ✅ | `src/bridge/router.ts` の `startSse` で再購読します（既定は 250ms から、最大 3 回） | `tests/bridge-events.spec.ts` | 本コミット |
| 再接続時の approval/question 再生の重複排除 | ✅ | `MuxEventTranslator` の `replayGuard`（SSE 接続単位） | `tests/bridge-events.spec.ts` | 本コミット |
| 再接続後の todo/goal 投影状態の保持 | ✅ | `sharedState` を translator の再構築をまたいで共有 | `tests/bridge-events.spec.ts` | 本コミット |

## 3. ツール

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| Tool call / result の四状態の変換 | ✅ | `src/bridge/convert/tool.ts`、`src/bridge/events.ts` | `tests/convert/tool.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| ツール引数のストリーミング（`tool-call-delta` → input.started/delta/ended + v1 ToolPart の増分） | ✅ | `src/bridge/events.ts` の `startToolInput`/`queueToolDelta`/`flushToolDelta` | `tests/bridge-events.spec.ts`、`scripts/e2e-api.sh` | 本コミット |
| キューに入った prompt の可視化（`session/queue` の初期化 + `agent/inbox/spliced` の増分 → QUEUED メッセージ） | ✅ | `src/bridge/events.ts` の `queuedMessageEvents`、`src/bridge/state.ts` の inbox 投影 | `tests/bridge-events.spec.ts`、`scripts/e2e-tui-queue.sh` | 本コミット |
| v2 tool のライフサイクル（called/progress/success/failed） | ✅ | `src/bridge/events.ts` の `endToolInput`/`completeToolInputImmediately` | `tests/bridge-events.spec.ts`、`scripts/e2e-api.sh` | 本コミット |
| 高頻度 chunk の間引き / バッチ処理 | ✅ | `MuxEventTranslator` の `toolFlushMs` と pending delta のマージ | `tests/bridge-events.spec.ts`（fake timer） | 本コミット |
| `!` shell のリアルタイム出力 progress | 🟡 | shell の経路は子プロセスが終了してから保持した stdout/stderr を公開します。1 ストリームあたり 1MiB が上限で、超えた分は drain を続けながら切り詰め済みの印を付けます | `docs/PROTOCOL.ja.md`、`tests/bridge-router.spec.ts` | `v0.2.0-rc.2` |
| ツール実行は dsh のバックエンドが行う | ✅ | モデルのツールは dsh の tool レジストリを通ります。`!` shell はユーザーが許可した OS の子プロセスを実行し、Agent maintenance が管理します | `e2e-api.sh`（bash ツール）、`tests/bridge-router.spec.ts` | `v0.2.0-rc.2` |
| read/write/edit のファイル変更表示 | ✅ | tool result → ToolPart metadata/diff + `session.diff` + Modified Files | `tests/convert/tool.spec.ts`、`e2e-tui-tools.sh` | 本コミット |
| dsh の複数の編集モードの変換（view/create/str_replace/insert/undo_edit） | ✅ | `src/bridge/convert/tool.ts` が read/edit のカードに変換し、mode を保持します | `tests/convert/tool.spec.ts`、`e2e-tui-tools.sh` | 本コミット |
| テキスト添付 / ファイル part | ✅ | `src/bridge/router.ts` の `filePartToContent`。data URL のテキスト/画像、cwd 内のローカルファイルを扱い、cwd 外とバイナリは 400 を返します | `tests/bridge-router.spec.ts`、`scripts/e2e-api.sh` | 本コミット |
| dsh の profile で `mcp-client` として設定した MCP サーバー | ✅ | `/api/mcp` が、ツールを `mcp__<server>__<tool>` として登録済みのサーバーを返します | `tests/bridge-mcp.spec.ts` | — |
| LSP / formatter などの周辺ツール | ❌ | `src/bridge/stubs.ts` が schema-valid な空データを返します | `e2e-api.sh` のルートマトリクス | `f30b156` |

## 4. 権限

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| Permission の ask / once / reject | ✅ | `GET /api/permission/request`、`POST /api/session/{id}/permission/{rid}/reply`、`POST /api/permission/{rid}/reply` | `tests/convert/permission.spec.ts`、`e2e-api.sh` | `f30b156` |
| "Always" をセッション内で記憶（同じセッションと同じツールは自動で許可） | ✅ | `src/bridge/state.ts` の `savedPermissions` + SSE による自動 approve | `tests/bridge-events.spec.ts`、`e2e-api.sh` | 本コミット |
| 保存済み permission の照会 / 削除 | ✅ | `GET /api/permission/saved` + `DELETE /api/permission/saved/{id}`（`sessionID:toolName`）。許可はセッションをまたいで漏れません | `tests/bridge-events.spec.ts`、`scripts/e2e-api-permission.sh` | 本コミット |
| SDK v2 の permission/question request エイリアス | ✅ | `GET /api/permission/request`、`GET /api/question/request`、`GET /api/session/{id}/permission/{rid}` | `tests/bridge-router.spec.ts`、`scripts/e2e-api-permission.sh` | 本コミット |
| TUI の権限 / 質問のキーボード操作 | ✅ | Down で選択肢のハイライトを移動、question は Esc で取り消し、permission は Esc=reject（standard はそのまま拒否し、mini は確認レイヤーを先に出します） | `scripts/e2e-tui-permission.sh`、`scripts/e2e-tui-permission-ext.sh` | 本コミット |

## 5. サブエージェント

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| メイン agent（build）の表示 | ✅ | `GET /api/agent`、`src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| Background subagents | ✅ | `GET /experimental/capabilities` が `{ backgroundSubagents: true }` を返します。`POST /experimental/session/{id}/background` は no-op で成功します（dsh のセッションはサーバー側に常駐し、`subagent` は既定でバックグラウンドです） | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本コミット |
| サブエージェントのセッションツリー / parent-child の描画 | ✅ | `Session.parentID`、child の cwd/parent の継承、child の履歴の再利用 | `tests/convert/session.spec.ts`、`e2e-api.sh` の fork lineage | 本コミット |
| ネイティブな OpenCode Task サブエージェントカード | ✅ | dsh の `subagent*` → `tool: task`。child の `sessionId` metadata と parent の lineage を保持します | `tests/bridge-events.spec.ts`、`tests/bridge-router.spec.ts`、`scripts/e2e-tui-subagent.sh` | `v0.2.0-rc.1` |

## 6. コマンド

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| コマンド一覧 | ✅ | `GET /api/command` が `/preset` `/goal` `/help` を登録します | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本コミット |
| `/goal` の作成 / 参照 / 切り替え | ✅ | `src/bridge/router.ts` の `runGoalCommand` + dsh の command registry | `tests/bridge-router.spec.ts`、`scripts/e2e-api-goal.sh` | 本コミット |
| `/goal` のライフサイクル（complete/pause/resume/clear） | ✅ | `complete` は `goal.complete` RPC、それ以外は registry を経由します | `tests/bridge-router.spec.ts`、`scripts/e2e-api-goal.sh` | 本コミット |
| TUI の `/help` 機能サマリ | ✅ | `src/help.ts` の `ocHelp` + `runHelpCommand`（モデルのターンは発生しません） | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本コミット |
| TUI の `/help` pane の e2e | ✅ | `scripts/e2e-tui-command.sh` が `/help` を入力し、サマリが見えることを検証します | `bash scripts/e2e-tui-command.sh` | 本コミット |
| `/compact` / summarize | ✅ | `POST /api/session/:id/compact` | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本コミット |
| Skills カタログ | ✅ | `GET /api/skill` が dsh の `skill.list` を経由します（ディレクトリでセッションを照合し、セッションが無い場合は `[]` を返します） | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本コミット |
| Skills のスラッシュコマンド | ✅ | `/command` がスキル名を公開し、コマンドのルートは `session.prompt` の `/name` の経路に転送します | `tests/bridge-router.spec.ts` | 本コミット |
| スキルのスラッシュコマンドの TUI e2e | ✅ | `scripts/e2e-tui-skill.sh`（`DSH_OC_E2E_FAKE_SKILLS` の注入 + 実際のキーボード入力） | `bash scripts/e2e-tui-skill.sh` | 本コミット |
| References / integrations | ❌ | `GET /api/reference`、`GET /api/integration` などが schema-valid な `[]` を返します | `e2e-api.sh` | `f30b156` |

## 7. TUI

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| `opencode --server` の起動 / 終了 / シグナル転送 | ✅ | `src/tui/index.ts` の `startOpenCodeTui`（`--mini` → `opencode mini --server`） | `tests/tui/index.spec.ts`、`e2e-tui-boot.sh` | `f30b156` |
| TUI の引数フィルタ（`--session/--dir/--mini/--print-logs/...`） | ✅ | `src/tui/index.ts` の `filterSupportedArgs`。`--dir` は bridge の cwd にも書き込みます | `tests/tui/index.spec.ts`、`scripts/e2e-tui-dir.sh` | 本コミット |
| `--dir` のパス検証 | ✅ | `resolveTuiDir`: 存在しない場合やディレクトリでない場合は明示的にエラーにします | `tests/tui/index.spec.ts` | 本コミット |
| データの隔離（config/data/state/cache は `$DSH_HOME/opencode` の下） | ✅ | `src/tui/index.ts` の `buildChildEnv` | `tests/tui/index.spec.ts` | `f30b156` |
| メッセージのタイムスタンプを既定で有効化 | ✅ | `DSH_OC_TUI_TIMESTAMPS=1` → `kv.json` の `timestamps: show` + `tui.json` のキーバインド | `tests/tui/index.spec.ts`、`scripts/e2e-tui-timestamps.sh` | 本コミット |
| タイムスタンプの実行時切り替え | ✅ | `tui.json` が `session_toggle_timestamps` / `messages_toggle_timestamps` を `ctrl+shift+t` に割り当て、`/timestamps` でも切り替えられます | TUI での手動確認 | 本コミット |
| バイナリのバージョン検証（`--version` の完全一致 + 明示的な上書き時はエラー） | ✅ | `src/tui/binary.ts` の `parseOpenCodeVersion`/`verifyOpenCodeVersion` | `tests/tui/binary.spec.ts`、`scripts/e2e-tui-version-lock.sh` | 本コミット |
| 自動更新 / ホット更新の無効化 | ✅ | `OPENCODE_DISABLE_AUTOUPDATE=1` + 隔離した設定の `autoupdate: false` | `tests/tui/index.spec.ts`、`scripts/e2e-tui-offline.sh` | 本コミット |
| バックグラウンドの外部通信の無効化（models fetch / LSP download） | ✅ | `OPENCODE_DISABLE_MODELS_FETCH=1`、`OPENCODE_DISABLE_LSP_DOWNLOAD=1` | `tests/tui/index.spec.ts` | 本コミット |
| `dsh --profile oc --help` の機能サマリ | ✅ | `src/tui/index.ts` の `ocHelp`/`helpRequested` | `tests/tui/index.spec.ts`、`scripts/e2e-tui-help.sh` | 本コミット |
| DSH OC ブランドの起動ロゴ（OpenCode の文字アートを置き換え） | ✅ | `tui-branding/` の TUI プラグイン（figlet で生成、`scripts/generate-tui-branding-art.mjs`）+ `prepareOpenCodeTuiState` による `tui.json` の注入 | `tests/tui/branding-art.spec.ts`、`tests/tui/index.spec.ts`、`scripts/e2e-tui-brand.sh` | 本コミット |

## 8. 配布

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| 複数 arch のプラットフォームマトリクス（linux/darwin/windows × x64/arm64 + musl/baseline） | ✅ | `src/tui/platform.ts` | `tests/tui/platform.spec.ts`、`tests/scaffold.spec.ts` | 本コミット |
| 公式 npm プラットフォームパッケージを優先（`@opencode/cli-<platform>-<arch>[-baseline][-musl]@2.1.0`） | ✅ | `src/tui/binary.ts` の `npmPackage*`、`$DSH_HOME/opencode/packages/<key>` | `tests/tui/binary.spec.ts`（候補の順序 / フォールバック） | 本コミット |
| GitHub Release フォールバックのプラットフォーム別 `sha256` 検証 | ❌ | 2.1.0 への移行で `opencode-assets.json` とこのフォールバックを削除し、バイナリは npm のプラットフォームパッケージからのみ取得するようになりました | `tests/tui/download.spec.ts`、`tests/scaffold.spec.ts` | 本コミット |
| プロキシ / ミラー | ✅ | `src/tui/download.ts` の `resolveAssetUrl` | `tests/tui/download.spec.ts` | `f30b156` |

## 9. テスト

| 機能 | 状態 | 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| ユニット / 変換 / ブリッジ / 配布のテスト | ✅ | `tests/**/*.spec.ts` | `pnpm test` | `f30b156` |
| API e2e のルートマトリクス + 権限フロー | ✅ | `scripts/e2e-api.sh` | `bash scripts/e2e-api.sh` | `f30b156` |
| TUI の boot / turn / stream e2e | ✅ | `scripts/e2e-tui-boot.sh`、`scripts/e2e-tui-turn.sh`、`scripts/e2e-tui-stream.sh` | 対応するスクリプトが `PASSED` を出力します | `f30b156` |
| TUI タイムスタンプ e2e | ✅ | `scripts/e2e-tui-timestamps.sh` | `bash scripts/e2e-tui-timestamps.sh` | 本コミット |
| オフライン起動 / バージョン固定 e2e | ✅ | `scripts/e2e-tui-offline.sh`、`scripts/e2e-tui-version-lock.sh` | 対応するスクリプトが `PASSED` を出力します | 本コミット |
| Help e2e | ✅ | `scripts/e2e-tui-help.sh` | `bash scripts/e2e-tui-help.sh` | 本コミット |
| ブランドロゴ e2e | ✅ | `scripts/e2e-tui-brand.sh` | `bash scripts/e2e-tui-brand.sh` | 本コミット |
| `--dir` TUI e2e | ✅ | `scripts/e2e-tui-dir.sh` | `bash scripts/e2e-tui-dir.sh` | 本コミット |
| `--dir` の相対パス e2e | ✅ | `scripts/e2e-tui-dir.sh` が相対パス `sub-project` を使います | `bash scripts/e2e-tui-dir.sh` | 本コミット |
| `--dir` のディレクトリ絞り込み e2e | ✅ | `scripts/e2e-tui-dir-filter.sh`: 新しいセッションはサブディレクトリに置かれ、ルートのセッションは絞り込まれます | `bash scripts/e2e-tui-dir-filter.sh` | 本コミット |
| `--fork --session` TUI e2e | ✅ | `scripts/e2e-tui-fork.sh` | `bash scripts/e2e-tui-fork.sh` | 本コミット |
| `--continue` TUI e2e | ✅ | `scripts/e2e-tui-continue.sh`（最新のセッションを復元） | `bash scripts/e2e-tui-continue.sh` | 本コミット |
| `--mini` TUI + 返信 e2e | ✅ | `scripts/e2e-tui-mini.sh`: prompt を入力し、返信が1回だけ描画されることを検証します | `bash scripts/e2e-tui-mini.sh` | 本コミット |
| 終了時の splash の説明（フル / `--mini`） | 🟡 | 公式バイナリが描画するため置き換えられません。セッションに内容がある場合（新しい入力または履歴の復元）、dsh-oc がその下に1行の案内を追加します（id は dsh のセッション id で、復元には `dsh --profile oc --session` を使います） | `tests/bridge-router.spec.ts`、`scripts/e2e-tui-mini.sh` | 本コミット |
| Esc による中断 / 取り消し（フル / `--mini`） | ✅ | `turn.wait`/`turn.idle` イベントが TUI の実行状態を駆動します。`POST /api/session/:id/interrupt` → `session.cancel` が進行中のストリームを停止します（フルと mini のどちらも Esc 2 回） | `tests/bridge-events.spec.ts`、`scripts/e2e-tui-abort.sh` | 本コミット |
| 新しいセッションが直近の preset を継承 | ✅ | `/preset X` の選択を bridge の状態に記録し、`/new` で作成したセッションはその preset を引き継ぎます（ツールセットもそれに応じて変わります） | `tests/bridge-router.spec.ts` | 本コミット |
| `--print-logs` の透過 e2e | ✅ | `scripts/e2e-tui-print-logs.sh`（fake バイナリの argv を検証） | `bash scripts/e2e-tui-print-logs.sh` | 本コミット |
| プロトコルプローブ（ルート一覧 + バイナリ/SDK のバージョン検証） | ✅ | `scripts/probe-opencode.mjs`、`tests/fixtures/opencode/routes.json` | `pnpm run probe`、`tests/protocol-probe.spec.ts` | 本コミット |
| 一括セルフテストの入口 | ✅ | `scripts/check-all.sh`（typecheck + 単体テスト + プローブ + 性能スモーク。`--e2e` で全量の e2e、`--scale N` で負荷試験） | `bash scripts/check-all.sh` | 本コミット |
| GitHub Actions CI | ✅ | `.github/workflows/ci.yml`（自動）+ `.github/workflows/e2e.yml`（手動の全量 e2e / 負荷試験） | push/PR で自動 + workflow_dispatch | 本コミット |
| ストリーミングツールイベントの API e2e | ✅ | `scripts/e2e-api.sh` の承認フローが started/delta/called/success を検証します | `bash scripts/e2e-api.sh` | 本コミット |
| 機能マトリクスの自動追跡 | ✅ | `scripts/update-feature-matrix.mjs` | `pnpm run features:update` | 本コミット |
| セッション性能テスト（生成器 + 指標 + レポート） | ✅ | `scripts/perf.mjs` + `scripts/perf-session-gen.mjs`（dsh Session API での合成ログ、zstd のフレーム分割書き込み） | `pnpm run perf`、`tests/perf.spec.ts` | 本コミット |
| 大規模セッションの性能検証（200/1000/5000/10000） | ✅ | `docs/perf/results-2026-08-15.md`: SSE のデバウンス + list/history の短い TTL キャッシュ + 上流のボトルネックの記録 | `pnpm run perf -- --sessions 10000` | 本コミット |
| 履歴読み取りの in-flight マージと派生ページのキャッシュ | ✅ | 並行呼び出しと起動時のプリフェッチが同じ `session.list`/`session.history` RPC を共有します。full tail と 100 件のページは互いに派生し、TUI はセッションを開くときに1回だけ走査します | `tests/bridge-router.spec.ts` | 本コミット |
| perf 生成器の単体テスト（エンコード / round-trip / サブエージェントのシナリオ） | ✅ | `tests/perf.spec.ts` | `pnpm test` | 本コミット |

## 10. ブラウザと Web UI

| 機能 | 状態 | ルート / 実装 | 検証方法 | 最終更新 |
|---|---|---|---|---|
| 公式 OpenCode Web UI を API と同じオリジンで提供 | ✅ | `src/bridge/web-ui.ts`: opencode バイナリ内の AppArchive を `$DSH_HOME/opencode/web-ui/<version>/` に展開します（`DSH_OC_WEB_UI` が優先）。ルートに一致しない `GET`/`HEAD` は SPA の shell にフォールバックし、`_assets/`、`icons/` の欠落は 404 になります | `tests/bridge-web-ui.spec.ts` | 本コミット |
| 公式 Web UI のブラウザでの実測 | 🟡 | サービスは用意できており、公式 2.1.0 のクライアントは `/api/event` を購読できます。本機には実際のブラウザが無いため、操作の検証は行っていません | ブラウザのある環境で手動で検証する必要があります | 本コミット |
| CORS ポリシー（公式 server に合わせる） | ✅ | `src/bridge/http.ts` の `isAllowedCorsOrigin`/`corsHeaders`: localhost、127.0.0.1、`oc://renderer`、tauri のオリジン、`*.opencode.ai` に `DSH_OC_CORS` を加えたもの。リクエストの origin をそのまま返し、`Access-Control-Allow-Credentials: true` を付けます | `tests/bridge-cors.spec.ts` | 本コミット |
| プロジェクト一覧（bridge の作業ディレクトリ） | ✅ | `GET /api/project`、`GET /api/project/:projectID`、`PATCH /api/project/:projectID`（`projectInfo`。PATCH は返すだけで保存しません） | `tests/bridge-web-ui.spec.ts` | 本コミット |
| SSE のハートビート（クライアントがストリームの停止と判定するのを防ぐ） | ✅ | `src/bridge/sse.ts` が 15 秒ごとに `: heartbeat\n\n` のフレームを1つ書きます（公式 server と同じ形式） | 単体テストの対象外です | 本コミット |
| SSE の status スナップショットの上限 | ✅ | `src/bridge/router.ts` の `SESSION_STATUS_SNAPSHOT_LIMIT = 20`（実行中のセッション + 直近に触れたセッション） | 単体テストの対象外です | 本コミット |
| HTTP リクエストのトレース | ✅ | `DSH_OC_HTTP_LOG=1` → stderr に `[bridge/http] <METHOD> <path>` を1行ずつ出力します | 手動で検証 | 本コミット |

<!-- FEATURES:AUTO:START -->
## 自動追跡（スクリプト生成）

> `pnpm run features:update` で再生成します。生成時の HEAD: `9b4dd18`（2026-10-22）。

### ルート登録表

`src/bridge/router.ts` と `src/bridge/stubs.ts` が登録するルートです。`/command`、`/skill`、`/reference`、`/integration` とその `/api/*` 対のルートはルート定義側の `for` ループで動的に登録されるため、この表には解決済みのリテラルと stub ルートを載せています。

| Method | Route | Kind | ソース |
|---|---|---|---|
| `GET` | `/experimental/capabilities` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/console` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/resource` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace/status` | json | `src/bridge/stubs.ts` |
| `GET` | `/formatter` | json | `src/bridge/stubs.ts` |
| `GET` | `/lsp` | json | `src/bridge/stubs.ts` |
| `GET` | `/mcp` | json | `src/bridge/stubs.ts` |

### テストカバレッジ

| テストファイル | ケース数 | 最終更新 |
|---|---|---|
| `tests/bin.spec.ts` | 5 | 050803b chore(release): bump version to 0.1.0 for first release |
| `tests/bridge-cors.spec.ts` | 6 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-errors.spec.ts` | 1 | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `tests/bridge-events.spec.ts` | 89 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-fs.spec.ts` | 5 | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `tests/bridge-git.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-mcp.spec.ts` | 3 | — |
| `tests/bridge-model.spec.ts` | 5 | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `tests/bridge-router.spec.ts` | 138 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-web-ui.spec.ts` | 9 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/client.spec.ts` | 12 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/events.spec.ts` | 19 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/revert.spec.ts` | 8 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/routes.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/goal.spec.ts` | 5 | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `tests/convert/message.spec.ts` | 9 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/model.spec.ts` | 6 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/permission.spec.ts` | 4 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/question.spec.ts` | 5 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/session.spec.ts` | 8 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/todo.spec.ts` | 3 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/tool.spec.ts` | 19 | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `tests/e2e/events.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/e2e/openchamber.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/e2e/revert.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/perf.spec.ts` | 5 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/protocol-probe.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/replay-corpus.spec.ts` | 2 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/rewind/rewind.spec.ts` | 12 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/scaffold.spec.ts` | 10 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/binary.spec.ts` | 18 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/branding-art.spec.ts` | 3 | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `tests/tui/download.spec.ts` | 5 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/index.spec.ts` | 39 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/platform.spec.ts` | 7 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |

### 主要実装の最終更新

| ファイル | 最終更新 |
|---|---|
| `src/bridge/convert/common.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/goal.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/message.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/model.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/convert/permission.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/question.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/session.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/todo.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/tool.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/wire.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/dsh-types.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/errors.ts` | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `src/bridge/events-util.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/events.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/file-uploads.ts` | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `src/bridge/fs.ts` | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `src/bridge/git.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/http.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/router-entry.ts` | 6928f8a feat(bridge): expose router entry and add minimal-server renderer attribution |
| `src/bridge/router.ts` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `src/bridge/routes.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/boot.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/routes/fs.ts` | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `src/bridge/routes/session-v2-extra.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/session-v2.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/routes/v2-client-compat.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/v2-shapes.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/v2-stubs.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/rpc.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/shell.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/sse.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/state.ts` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `src/bridge/stubs.ts` | c281121 feat(bridge): serve real git info, status and diffs over /vcs |
| `src/bridge/web-ui.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/help.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/rewind/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/binary.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/brand.ts` | eba383f feat(tui): print DSH OC brand before --mini launches |
| `src/tui/download.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/node-undici.d.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/platform.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/temp.ts` | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `src/types.ts` | 153f781 feat(tui): show exit hint for resumed sessions with history, not only new input |
| `scripts/audit-local-sessions.sh` | fb50dbe fix(perf): write v3 session generation filenames |
| `scripts/build-replay-corpus.mjs` | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `scripts/check-all.sh` | db87e31 fix(release): verify local dsh-oc resolution |
| `scripts/check-client-routes.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/check-docs-i18n.mjs` | — |
| `scripts/cleanup-e2e-runs.sh` | ec31177 chore: add e2e run directory cleanup script |
| `scripts/cleanup-merged-branches.sh` | 2f1ab51 chore(scripts): enumerate remote merged branches for cleanup |
| `scripts/e2e-api-attachment.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api-goal.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api-permission.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-cli-bin.sh` | e1817df test(e2e): assert dsh-oc --version dual output in cli-bin suite |
| `scripts/e2e-golden-trace.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-install-rollback.sh` | dacd2a2 chore(release): prepare v0.2.0-rc.3 |
| `scripts/e2e-minimal-server-repro.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-openchamber-bootstrap.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-openchamber.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-queued-order-repro.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-real-llm.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-real-queued-order.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-consistency.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-crash.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-sse-reconnect.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-revert-flow.mjs` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `scripts/e2e-tui-abort.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-agent-lock.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-agent-tab.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-boot.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-brand.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-command.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-continue.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-dir-filter.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-dir.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-fork.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-goal-command.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-goal.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-help.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-mini.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-offline.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission-ext.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission-mini.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-preset-inherit.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-print-logs.sh` | 7561559 test(e2e): assert --log-level value passthrough to opencode child |
| `scripts/e2e-tui-queue-live.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-queue.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-shell.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-skill.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-stream.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-subagent.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-timestamps.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-tools.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-turn.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-version-lock.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/extract-opencode-web-ui.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/flake-mini-scan.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/generate-tui-branding-art.mjs` | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `scripts/minimal-oc-server.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/monitor-process-io.sh` | d94f52e fix(e2e): harden permission waits and monitor output |
| `scripts/normalize-golden-trace.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/perf-session-gen.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/perf.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/probe-opencode.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/replay-corpus-manifest.mjs` | fb50dbe fix(perf): write v3 session generation filenames |
| `scripts/replay-session-audit.sh` | 54c9c31 test(bridge): add reusable real-session replay audit script |
| `scripts/scan-release-artifact-paths.sh` | f5f016f test(release): harden CI verification |
| `scripts/update-feature-matrix.mjs` | 8d95367 fix(docs): keep feature matrix generation idempotent |
| `scripts/update-local-install.sh` | db87e31 fix(release): verify local dsh-oc resolution |
| `scripts/update-opencode-assets.mjs` | 6ecf354 feat(tui): timestamps, feature matrix and multi-arch binary resolution |
| `scripts/upgrade-lane.sh` | 81effdd feat(tui): add candidate opencode upgrade lane with golden trace diff |
| `scripts/verify-release-artifacts.sh` | 3ed10a7 fix(release): invoke tsdown directly in artifact rebuild |
<!-- FEATURES:AUTO:END -->
