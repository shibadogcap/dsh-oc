*[English](AGENTS.md) · 日本語 · [中文](AGENTS.zh.md)*

# AGENTS.md — dsh-oc の開発/Agent ガイド

このファイルは、本リポジトリを引き継ぐ AI Agent と開発者に向けたものです。README の開発章の代わりに置きます。利用者向けのドキュメントは [README.ja.md](README.ja.md)、人間のコントリビューション手順は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください。

## プロジェクトの概要

dsh-oc は DeepSeek Harness（dsh）の OpenCode TUI フロントエンドです。

- **フロントエンド**: 公式 opencode CLI（`--server` モード）で、描画、キーボード、ターミナルのライフサイクルだけを担当します。
- **バックエンド**: dsh が Agent、セッション、ツール、モデル、権限、質問を担当します。
- **ブリッジ**: dsh-oc は dsh プロセス内で OpenCode 互換の HTTP/SSE サービス（`oc-bridge`）を提供し、公式 TUI の子プロセス（`oc-tui`）を起動します。

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (--server)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

リポジトリは `shibadogcap/dsh-oc`、npm パッケージ名は `@chiro2001/dsh-oc@0.2.0-rc.4` です（registry には未公開のため、インストールと更新は GitHub ソースの `#main` / `#develop` を使います）。

現在の prerelease は dsh `>=0.1.5-rc.2` を対象にしています（0.2.0-rc.3 以前は `>=0.1.2-rc.1` が対象で、イベントモデルが互換でないためサポートしません）。PR #1/#2/#3 はそのままでは取り込んでおらず、RC 版で有効な意味を dsh host-services への移行と統合し直しました。詳細は CHANGELOG を参照してください。

## コード構成

```text
src/
  bridge/            # OpenCode プロトコルのブリッジ
    router.ts        # 中核: SSE、キャッシュ/先読み、コマンド/権限ヘルパー、ブリッジサービスの配線
    routes/          # ルート登録（ドメイン別に分割し、routes.ts で集約）
      boot.ts        # 起動とディレクトリのルート（/api/info /api/location /api/agent /api/model ...）
      session-v2.ts  # セッションのルート（一覧、メッセージ、prompt、interrupt、command、fork）
      fs.ts          # ワークスペースのファイル読み取り/一覧/検索ルート
    routes.ts        # 集約役（登録順がそのままマッチ順なので並べ替えない）
    events.ts        # SSE イベント変換（assistant-stream、turn.*、message.*、session.*、ツールストリーム、権限）
    state.ts         # ブリッジのメモリ状態（キャッシュ、タイトル、agent preset、活動マーカー）
    file-uploads.ts  # dsh 0.1.5 の headless fileUploads provider（下記）
    convert/         # dsh イベント → opencode のメッセージ/セッション/モデル/権限への変換
    http.ts sse.ts rpc.ts errors.ts stubs.ts git.ts fs.ts
    web-ui.ts        # 公式 opencode Web UI: AppArchive の展開と静的ファイル配信
  rewind/            # revert プラグイン: セッション fork とターン単位でまとめたファイルスナップショット（copy-on-write）
  tui/               # opencode 子プロセスの解決/ダウンロード/spawn、シグナル転送、終了処理
  help.ts            # --help / /help の静的な機能サマリ
tui-branding/        # DSH OC ブランドロゴの TUI プラグイン
scripts/             # 自己テスト/負荷テスト/機能マトリクス/クリーンアップのツール
tests/               # vitest の単体テスト + e2e（scripts/e2e-*）
docs/                # FEATURES / PROTOCOL / ROADMAP / CHANGELOG / perf
lib/                 # ビルド成果物（コミットと一緒に push が必須、GitHub 直インストールがこれに依存する）
```

## よく使うコマンド

```bash
pnpm install
pnpm build                 # tsdown → lib/
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest
pnpm run probe             # opencode 2.1.0 のプロトコルルートプローブ（公式 client の全ルートを対象）
pnpm run e2e               # 全量 e2e（実際の opencode TUI、安定版のスイートで約 15–20 分）
pnpm run e2e:api           # API e2e のサブセット（高速なリグレッション）
pnpm run perf              # セッション性能の負荷テスト（--sessions N --scale ...）
pnpm run features:update   # docs/FEATURES.md の自動追跡を更新
bash scripts/check-all.sh --e2e          # 全量ゲートを一括実行
bash scripts/check-all.sh --e2e --scale 5000
bash scripts/verify-release-artifacts.sh # リリース成果物の監査（check-all に内蔵: lib の差分ゼロ、pack に絶対パスなし、成果物ハッシュの記録）
bash scripts/e2e-install-rollback.sh     # manual: リモートの full SHA で冷インストール + TUI smoke + ロールバック演習
bash scripts/cleanup-e2e-runs.sh --keep 20 --apply   # .e2e の古い run を削除（既定は dry-run）
bash scripts/replay-session-audit.sh <session.jsonl[.zstd]>
                                          # 実セッションのリプレイ監査: ブリッジの変換に未処理イベント/エラーがないこと
bash scripts/audit-local-sessions.sh [sessions-dir]
                                          # $DSH_HOME/sessions の全セッションを一括監査（メッセージ id/role の衝突検査を含む）
bash scripts/e2e-recovery-crash.sh        # 故障ドメイン: SIGKILL で途中終了した後の --session 再起動からの復旧
bash scripts/e2e-recovery-sse-reconnect.sh # 故障ドメイン: 監視側 SSE の切断と再接続後の exactly-once
node scripts/build-replay-corpus.mjs      # tests/fixtures/replay の合成コーパスを再生成（構造は保持、実コンテンツなし）
node scripts/replay-corpus-manifest.mjs   # 実セッションの feature 網羅を走査し、コーパスの網羅差を出力（内容は外部に出さない）
bash scripts/e2e-golden-trace.sh          # 1.18.18 のイベント形状のゴールデン SSE トラックを凍結/検証（DSH_OC_GOLDEN_OVERWRITE=1 で更新）
bash scripts/e2e-queued-order-repro.sh    # ツール + キュー + 後続テキストの公式 TUI 順序の再現記録
bash scripts/upgrade-lane.sh --bin <candidate>
                                          # 候補 opencode の upgrade lane: ゴールデントラックの意味差分
bash scripts/update-local-install.sh [ref]
                                          # ローカル dsh profile のインストールを更新し、解決された commit/version を検証
bash scripts/e2e-real-queued-order.sh     # manual: 実モデルのキュー順序異常について wire/パネルの証拠を取る
bash scripts/e2e-minimal-server-repro.sh  # 公式の最小 server での原因切り分け: スクリプト化したイベント → 公式 TUI の描画順
scripts/monitor-process-io.sh --pid <pid> --log <tsv> # 既定は observe-only、正常終了時は何も出力しない
scripts/e2e-tui-subagent.sh             # dsh subagent → OpenCode task + child のナビゲーション
scripts/e2e-tui-shell.sh                # 公式 TUI の `!` shell → OS shell のツールカード
tests/e2e/fake-opencode-idle.sh           # fake TUI がアイドルで EOF なしにビジーループする回帰
tests/e2e/monitor-process-io-attach.sh    # 正確な TUI PID/log/対象外を kill しない shell の回帰
```

dsh profile へローカルで直接つなぐ場合（リアルタイム検証）は `dsh plugin --profile oc add .` を実行します。コードを変更した後は `pnpm build` が即座に反映されます（link 方式）。GitHub のブランチからインストールして検証する場合は `dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#<branch>'` を使います。`#develop` は可変 ref のため pnpm が古い解決済み SHA を再利用することがあり、add を繰り返すとロックファイルが更新されます。実際に解決された commit は `rg 'codeload.github.com/shibadogcap/dsh-oc/tar.gz' pnpm-lock.yaml` で確認してください。

## インストール、更新、ローカル開発

利用者がインストールコマンドだけを知りたい場合は README を参照してください。Agent と開発者は次の方法で検証と更新を行います。

GitHub ソースからのインストールと更新（README と同じコマンドで、繰り返し実行するとそのブランチの最新に更新されます）。

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'                       # #main
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'      # ブランチを指定
dsh --profile oc --help                                            # バージョンを確認
```

- `bin/dsh-oc.mjs` が `dsh-oc` の短縮形を提供します（`dsh --profile oc` の引数と終了コードをそのまま渡します）。インストール後は profile の `node_modules/.bin` に置かれ、PATH の設定方法は README にあります。本機では `ln -sf ~/.dsh/profiles/oc/node_modules/.bin/dsh-oc ~/.local/bin/dsh-oc` を実行すると短縮形を PATH に常駐できます。
- npm パッケージ名 `@chiro2001/dsh-oc` は registry に未公開です。インストールと更新は必ず GitHub ソース経由で行います。
- ローカル開発では `dsh plugin --profile oc add .` がリポジトリを `link:` 方式でリンクするため、`src/` を変更した後の `pnpm build` が即座に反映されます。ただし `lib/` はコミットと一緒に push する必要があり、そうしないと GitHub からの直インストールに最新のビルド成果物が含まれません。

## opencode バイナリとネットワークポリシー

- 公式 opencode バイナリをそのまま使い、バージョンは `opencode-version.json` で固定します（現在は `2.1.0`）。起動時に `resolveOpenCodeBinary` + `verifyOpenCodeVersion` で二重に検証し、明示した `DSH_OC_OPENCODE_BIN` のバージョンが一致しない場合はエラーにして、PATH 上の別バージョンへは回退しません。
- OpenTUI 2.1.0/Bun の native 一時ファイルのリークは、dsh-oc が `$DSH_HOME/opencode/tmp/tui-<pid>` に隔離します。正常終了時に削除し、次回起動時に終了済み dsh プロセスのディレクトリを回収します。任意のユーザープラグインのキャッシュは探索せず、公式のバージョン/完全性の検証も無効にしません。
- 解決の優先順位は `DSH_OC_OPENCODE_BIN` → `$DSH_HOME/opencode/bin/<version>` → PATH 上のバージョンが一致する `opencode` → 公式 npm プラットフォームパッケージ `@opencode/cli-<platform>-<arch>`（遅延インストール、npm integrity 検証）→ profile 内の `opencode-ai` / `@opencode/cli` パッケージです。2.1.0 以降は `opencode-assets.json` を保守せず、バイナリは npm プラットフォームパッケージからのみ取得します。インストールはプロキシ（`HTTPS_PROXY`/`HTTP_PROXY`）と `DSH_OC_OPENCODE_MIRROR` のミラープレフィックスを使います。
- ネットワークポリシーとして、子プロセスには `OPENCODE_DISABLE_AUTOUPDATE=1` / `OPENCODE_DISABLE_MODELS_FETCH=1` / `OPENCODE_DISABLE_LSP_DOWNLOAD=1` を強制し、隔離した設定に `autoupdate: false` を書いてバックグラウンドの外部通信を止めます。
- キャッシュが壊れた場合は `$DSH_HOME/opencode/bin` を削除するか、一致するバージョンの `DSH_OC_OPENCODE_BIN` を設定します。`DSH_OC_TUI_TIMESTAMPS=1` を設定すると TUI が既定でタイムスタンプを表示します（`ctrl+shift+t` / `/timestamps` で実行中に切り替えられます）。
- **公式 Web UI も同じバイナリを使います**: `src/bridge/web-ui.ts` は opencode バイナリ内の AppArchive（`packages/cli/src/app-archive.ts` の形式で、リトルエンディアン u32 の JSON インデックス長、インデックス、`[offset, length]`、brotli 圧縮したアセット本体からなります）を `$DSH_HOME/opencode/web-ui/<version>/` に展開し、bridge がそのファイルを自身で配信します。`src/bridge/index.ts` の `resolveWebUi()` の探索順は `DSH_OC_WEB_UI` → 展開ディレクトリです。**バイナリは探索するだけで、bridge がインストールすることはありません**（`resolveOpenCodeBinary` には `installNpmPackage: async () => false` を渡します）。TUI プラグインは元々バイナリをインストールするため、Web UI は次回起動から現れます。バイナリが見つからない場合は Web UI なしとなり、API には影響しません。オフラインで展開するには `node scripts/extract-opencode-web-ui.mjs --bin <binary> --out <dir>` を使います。
- **opencode は vendor ABI として扱います**: 候補バージョンへの更新は「ゴールデン HTTP/SSE トラック + 実 TUI リプレイ」の意味差分をゲートにする必要があり、SDK の型やルート数だけでは判断できません。候補の新バージョンには独立した upgrade lane を作り、固定バージョンを直接置き換えません。
- **実モデルのリグレッションは smoke と位置づけます**: `scripts/e2e-real-llm.sh` は実際のテキスト、ツール、goal、variant、TUI 操作を対象にしますが、ランダムなモデル出力をブリッジの正しさの唯一の oracle にはしません。決定論的なリプレイコーパス（秘匿化した実セッション）のほうを優先するリグレッション手段とします。
- **復旧の故障ドメインは経路ごとに検証します**: `client-sse-reconnect` / `mux-resubscribe` / `process-crash-recovery` は同じ再接続経路ではありません。共有の oracle は `tests/e2e/recovery-lib.sh` にあり（v2 署名、authoritative idle、プレフィックス/全体グラフの比較）、bridge の SSE や履歴変換を変更するときは少なくとも `e2e-recovery-consistency.sh` + `e2e-recovery-crash.sh` + `e2e-recovery-sse-reconnect.sh` を実行します。

- **status のホットパス**: bridge は dsh の `api-session/status`/`api-session/activity` からメモリ上の authoritative map を維持し、SSE の `session.status` イベントで外部に公開します。`POST /api/session/:id/wait` は 2.x のアイドル待機の入口です。
- **SSE 切断の契約**: `SseHub` はイベント数とシリアライズ後のバイト数の二重の上限で制約した ring を保持し、`Last-Event-ID` を消費してその後のイベントを厳密にリプレイします。カーソルが淘汰されているか不明な場合は警告を記録し、現在の status/control snapshot をリプレイします。接続ごとに history/list の走査は発生しません。2.x のクライアントはイベントストリームが `server.connected` で始まることを要求するため、bridge は接続後にそのフレームを先に送ってからリプレイします。
- **e2e の TUI I/O 観測**: `DSH_OC_E2E_MONITOR_IO=1` を設定すると、`tests/e2e/common.sh` が `e2e_tui_wait_attach` の中で現在の run の `opencode --server` PID を正確に解決し、observe-only の monitor でその run のディレクトリに記録します。既定の `0.25s` / `32MiB` の読み取りウィンドウは `DSH_OC_E2E_MONITOR_INTERVAL` / `DSH_OC_E2E_MONITOR_READ_THRESHOLD` で上書きできます。監視は対象の終了とともに終わり、名前で対象を終了させることはしません。必要なクリーンアップで終了してよいのは monitor 自身の PID だけです。正常終了を stderr に書きたい場合は `--report-exit` を明示的に付けます。しきい値の警告はどの場合も stderr に書きます。
- **互換性の境界**: dsh-dcp rc.6 は削除済みの `session.events` をまだ読むため、bridge は一時的に `snapshotEvents()` の getter shim を入れています。dcp が dsh 0.1.5 互換へ更新されたら削除します。
- **dsh 0.1.5 の host ABI** は次のとおりです。
  - `dsh-api-session-controller` に `fileUploads` へのハード依存が加わりました。公式 provider（`dsh-client-file-upload`）はブラウザ転送用のプラグインで `connection` を inject するため、oc-bridge はこれを載せません。`@chiro2001/dsh-oc/file-uploads`（`src/bridge/file-uploads.ts`）が headless の実装を提供し、`cordis.patch.yml` で `session-controller` より前に挿入する必要があります。`bindPrompt` は `Symbol.dispose` を持つオブジェクトを返さなければなりません（0.1.5 は明示的なリソース管理でこれを包むため、普通のオブジェクトでは `TypeError: Object not disposable` になります）。
  - リアルタイムのストリーミング: `assistant/chunk` セッションイベントは削除されました。代わりにプロセス内の `agent/assistant-stream` を購読します（`start` が turn/step を、`chunk` が attemptId/revision/index と同じ `StreamChunk` のペイロードを持ちます）。`index.ts` が attempt→turn/step の対応を維持して `session/assistant-stream` フレームを流し、start を欠いた遅延フレームはそのまま捨てます。
  - 永続化された履歴: `SessionHistoryRecord` から `chunks` がなくなり、`assistant/message` / `assistant/attempt` が `stream: AssistantStreamRecord[]` を内蔵します。`expandRecord` は packed run を `text-chunks`/`reasoning-chunks`/`tool-call-chunks` の行に戻し、`assistantStreamTiming` は生の `block-start`/`block-end`/`finish` から部品の所要時間と finish reason を復元します。`assistant/attempt` は live でも history でも TUI の surface を持ちません。
  - `dsh-tool-fs` の `write`/`edit` が 0.1.5 のファイルツールです（`str_replace_editor` は 0.1.2 の base 行にだけあり、opt-in 化されました）。新規ファイルの `write` は result meta の diffs が空になるため、bridge が呼び出し引数から diff を合成し、opencode の edit カードに `metadata.diff` があることを保証します。
  - **最初のターンのラベル**: provisional なカード（live SSE、ストリーミング中の history 統合、shell の合成カード）はすべて、`state.sessionModelSelectionFor()` + `sessionAgentFor()` でセッションの実際の値を取らなければならず、`build`/`deepseek-chat` への回退は禁止です。prompt がモデルを持たない場合はデプロイの既定モデルに回退します。TUI の既定マッピング agent `build` は `applyAgentFromBody` がデプロイの既定 agent preset に解決するため、最初のターンには実際の agent preset が表示されます。

## 自己テストのゲート（コミット/マージ前にすべて通すこと）

1. `pnpm typecheck && pnpm test`
2. `pnpm run probe`（63/63）
3. プロトコル/ブリッジ/TUI に関わる変更では、関連する `scripts/e2e-*.sh` を少なくとも実行します。完全なリグレッションには `bash scripts/check-all.sh --e2e` を使います。
4. リリース成果物の監査: `check-all` に `verify-release-artifacts.sh` が内蔵されています（HEAD からクリーンに再ビルドした後、コミット済みの `lib/` に差分がないこと、npm pack にマシン固有の絶対パスがないこと、成果物のハッシュを記録すること）。単体で実行する場合は `bash scripts/verify-release-artifacts.sh` を使います。
5. `pnpm run features:update`（機能一覧に関わる場合）を実行し、結果をコミットします。
6. `pnpm run docs:check`（すべてのドキュメントに英語・日本語・中国語の版があり、切り替えヘッダーとリンクが揃っているか）
7. `lib/` のビルド成果物はコミットと一緒に含めます。マシン固有の絶対パスは `rg -n --hidden -g '!node_modules' -g '!.git' 'chiro' . | rg -v 'chiro2001|/home/chiro/'` で確認します。

e2e スクリプトを実行できるのは `main` / `develop` と `chore-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `feat-*` のブランチだけです（許可リストは `tests/e2e/common.sh` と `tests/e2e/env.mjs` にあり、CI のトリガーブランチと揃えています）。

## ブランチとリリース

- `main`: 安定版のリリース線で、README のインストールコマンドは既定で `#main` を使います。
- `develop`: 統合して届けるための線で、日常の開発と利用者によるリアルタイム検証に使います。安定したら main にマージします。
- リリース候補（rc.N）は `docs/RELEASE.ja.md` に従って進めます。バージョンの bump、全ゲート、full SHA でのリモートインストール/ロールバック演習、実モデルの smoke、保護タグまでを行い、npm は NO-GO のままです。
- 機能ブランチは `feat-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `chore-*` で、develop から切り、短い寿命で運用します。
- コミット規約は Conventional Commits（feat/fix/docs/perf/test/chore/refactor）です。
- 残っていた feat-* ブランチはすべて main にマージ済みです。整理用のツールは `scripts/cleanup-merged-branches.sh` で、既定は dry-run、`--apply` でローカル削除、`--remote` でリモートも同期します。

## 実装上の重要な約束と落とし穴

- **ルートの登録順がそのままマッチ順です**: `src/bridge/routes.ts` は boot → session-v2 → session-v2-extra → fs → stubs → client-compat → SSE の順に呼びます。新しいルートは対応するドメインのファイルに置きます。
- **セッション一覧のタイトル**: dsh の `session.list` は title の投影を返しません。bridge が `session.history` の tail を投影して補って読みます（非空セッションが 40 件以下なら同期で全件、大きな一覧では 24 件を低い並列度でバックグラウンド補充し、一覧リクエストを決してブロックしません）。タイトルの優先順位は投影タイトル → ディレクトリの basename → session id です。
- **進行中の統合とキャッシュ**: `session.list` / `session.history` の進行中 RPC は共有します（`InteractionState` 内の loading promise）。無効化には generation カウンタを使い競合を防ぎます。
- **revert の境界は排他です**: `POST /api/session/:id/revert/stage` で指定したメッセージとそれ以降のメッセージは、commit 時にまとめて捨てます。`POST /api/session/:id/fork` の `before` も同じく排他です。dsh の `sessionController.fork` がコピーするのは `atSeq` を**含む**手前のプレフィックスなので、切れ目は `R.atSeqBeforeMessage`（境界メッセージの1つ前のイベント）で計算します。切れ目が最初のメッセージより前になる場合、dsh は空の fork を表現できないため 400 `cannot cut before the first message` を返します。3つのルート（stage / `DELETE .../revert` / commit）と3つの `session.revert.*` イベントは `src/bridge/routes/session-v2.ts` にあり、ファイルロールバックは `src/rewind/` にあります（ターン単位でまとめた copy-on-write スナップショットで、stage は即時ロールバック、commit は保持、clear は取り消しです。境界がユーザーの prompt の場合はそのターンのファイルも含めます）。
- **revert 後の opencode セッション id は fork に追従します**: commit は切れ目で dsh セッションを fork し、`InteractionState.setSessionAlias` で opencode の id を fork に向けます。そのため `rpc()` の `resolveSessionPayload` はすべての dsh 呼び出しを fork に書き換えます。セッション一覧は元の id で fork を公開し、置き換えられたセッションは捨てます。`GET /api/session/:id` と `/message` は fork を読みます。fork の SSE イベントは `mapEventSessionId` が元の id に書き戻します。モデル/agent preset/タイトル/メッセージ id の対応は `inheritSessionState` が引き継ぎます。OpenCode と同じく、次の prompt が届くと `POST /api/session/:id/prompt` が先にステージ済みの revert を commit します。既知の制限として、ファイル diff は最初と最後の変更行の間をまとめた1つの粗い hunk で（bridge 自身のファイル変更 diff と同じ形です）、完全な LCS diff ではありません。
- **SSE の turn イベント**: `turn/start` は `session.status busy` + `turn.wait` をブロードキャストし、`turn/end` は `session.status idle` + `session.idle` + `turn.idle` をブロードキャストします。TUI の Esc による中断は `phase === "running"` に依存するため、`turn.wait` がないと中断しません。
- **SSE のハートビートは外せません**: `src/bridge/sse.ts` は 15 秒ごとに各接続へ `: heartbeat\n\n` のフレームを1つ書きます（公式 server の `packages/server/src/handlers/event.ts` と同じ形です）。ハートビートがないと、静かなセッションのストリームはクライアントに断流と判定されます。公式クライアントは "Event stream stalled" を報告して再接続し、OpenChamber の上流の読み取り側は 20 秒で諦めるため、どちらも再接続のループになります。コメントフレームは SSE パーサーには透過ですが「データを受信した」と数えられます。
- **status のスナップショットは有界に保つ必要があります**: `replaySessionStatusSnapshot()` の上限は `SESSION_STATUS_SNAPSHOT_LIMIT = 20` です（実行中のセッションを先に報告し、残りの枠は `sessionStatusUpdatedAt` が新しい順に割り当てます）。以前の実装は bridge が見たすべてのセッションを報告していたため、公式 Web UI は接続のたびに数百件のセッションレコードを読み、初期ロードが終わりませんでした。この上限を緩める場合は接続コストも併せて評価してください。
- **CORS は公式 server に揃えます**: `src/bridge/http.ts` の `isAllowedCorsOrigin()` / `corsHeaders()` は公式 `packages/server/src/cors.ts` の形を保つ必要があります。許可するのは `http://localhost:<port>`、`http://127.0.0.1:<port>`、`oc://renderer`、tauri のオリジン、`*.opencode.ai`、および `DSH_OC_CORS`（カンマ区切りで公式の `cors` オプションに相当）です。許可する場合は**リクエスト自身の origin をそのまま返し**、`Access-Control-Allow-Credentials: true` を付けます。以前の `Access-Control-Allow-Origin: *` は削除しました。認証情報付きのリクエストはブラウザに拒否されるため（"credentialed request requires Access-Control-Allow-Origin '<origin>'"）、ブラウザの UI がまったく接続できませんでした。`*` に戻さないでください。
- **Web UI のフォールバック規則**: `src/bridge/http.ts` でどのルートにもマッチしない `GET`/`HEAD` は `router.serveWebUi`（`src/bridge/web-ui.ts`）に渡します。シングルページアプリなので未知のパスも `index.html` を返します。`_assets/`、`icons/` 配下の欠けたファイルは 404 で、他のメソッドでマッチしないルートは 501 のままです。API のルートは Web UI より優先します。
- **`DSH_OC_HTTP_LOG=1`** を設定するとリクエストごとの stderr トレース（`[bridge/http] <METHOD> <path>`）を出します。ブラウザがないときに UI の呼び出しパターンを確認する手段です。
- **reasoning の所要時間**: reasoning part の `end` はそのブロックの最後の chunk の時刻を取ります。text ブロックの開始時と、turn/end（中断で最終メッセージがない場合）には、開いたままの reasoning part を閉じ、thinking が回り続けないようにします。0.1.5 では live の時刻は `agent/assistant-stream` フレームの `time` から、コールドリードは内蔵 stream の `block-start`/`block-end` から取ります（`assistantStreamTiming` を参照）。
- **agent preset のロック**: dsh はセッションが最初の返答を生成した後に agent preset をロックします（409 `agent-preset-locked`）。Tab/`/preset` は空のセッションにしか効きません。開始済みのセッションで prompt の本文が agent を持つ場合、bridge は切り替えを試み、失敗すると最初のメッセージの後に「Agent switch locked」の通知を1回ブロードキャストします（session+agent で重複を排除します）。
- **終了時の splash**: 公式 opencode バイナリは、セッションに内容があると自身のロゴと `opencode -s <id>` の再開コマンドを出力し、これは置き換えられません。dsh-oc はその下に dsh での再開方法を1行足します（`DSH_OC_DISABLE_EXIT_NOTE=1` で無効化できます）。
- **--mini**: `opencode mini --server <bridge-url>` で起動し、prompt は `POST /api/session/:id/prompt` を通ります。ストリーミング中のターンの中断は Esc を2回押します（公式 opencode 2.1.0 の handler と同じで、全量の TUI でも2回です）。
- **mini e2e の終了コード**: `scripts/e2e-tui-mini.sh` の3回の C-c は SIGINT で終わって 130 を返すことがあります。スクリプトは 0/130 を受け付けますが、dsh-oc の終了時の案内は必ず検査します。
- **プロトコルプローブ**: `scripts/probe-opencode.mjs` は `router.ts` + `routes.ts` + `src/bridge/routes/` + `stubs.ts` を自動で走査します。新しいルートファイルは走査対象に入る必要があります。
- **e2e の mock LLM**: `tests/e2e/mock-llm.mjs` は `@deepseek-ai/dsh-llm-mock-server` を包みます。長時間のストリームには `partial_disconnect` + `repeatLast`、遅い chunk には `chunkDelayMs/chunkSize` を使います（`success` の挙動は遅延 0 で固定である点に注意してください）。env.mjs が起動する mock は親プロセスの終了とともに終わるため、手動テストでは同じプロセス内で自前で用意します。
- **性能リグレッションへの警戒**: 一覧や history のリクエスト経路に同期処理を足す変更は、必ず `pnpm run perf -- --sessions 5000` で比較します。以前、タイトルの補充がコールドリードを 10s+ まで悪化させました。

## ドキュメントの入口

- [docs/FEATURES.ja.md](docs/FEATURES.ja.md): 機能マトリクス（自動追跡）。
- [docs/PROTOCOL.ja.md](docs/PROTOCOL.ja.md): プロトコルのルートと SSE の対応。
- [docs/ROADMAP.ja.md](docs/ROADMAP.ja.md): 次の段階の要件。
- [docs/CHANGELOG.ja.md](docs/CHANGELOG.ja.md): バージョンごとの変更。
- [docs/perf/results-2026-08-15.md](docs/perf/results-2026-08-15.md): 性能データ。

## デモの録画と公開（README のデモ）

まだ dsh-oc を使ったことのない利用者に向けたものです。実モデルと意味のあるタスクを使い、mock や無意味なタスクは使いません。GitHub の README は `<script>` を実行しないため asciinema のプレイヤーを直接埋め込めません。asciinema 公式の推奨に従い `agg` で GIF を生成して `<img>` で埋め込み、cast の元ファイルはリポジトリに残します。

依存は `asciinema`（`pip install asciinema`）と `agg`（`gh release download -R asciinema/agg -p 'agg-<platform>'` または `cargo install agg`）です。

1. フォークをインストールし（`dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'`）、先に `dsh --profile oc` を手動で1回起動して opencode バイナリとキャッシュを温めておきます。本番の録画に初回ダウンロード/解決の長い待ちが入らないようにするためです。
2. tmux / PTY の中で録画します。`-i 2` は再生時のアイドル区間を最大2秒に圧縮します。`asciinema rec --cols 110 --rows 30 -i 2 -t 'dsh-oc demo' -q docs/demo/dsh-oc-demo.cast` を実行してから `dsh --profile oc` を起動し、実モデルで意味のある短いタスク（例えば「`pnpm test` を実行して結果を報告する」）を完了させ、最後に Ctrl+C で終了して録画を止めます。実際の起動部分（shell のプロンプト → コマンド入力 → ロゴ）は残し、冒頭は切り取りません。アイドルは `-i` / `--idle-time-limit` で圧縮します。
3. GIF を生成します（README 用）。`agg --font-family 'Hack,Noto Sans Mono CJK SC' --idle-time-limit 1 --speed 1.2 --fps-cap 15 --font-size 14 docs/demo/dsh-oc-demo.cast docs/demo/dsh-oc-demo.gif`
   - `Hack` は等幅フォントで、`Noto Sans Mono CJK SC` は中国語のフォールバックです。SVG の方式は使わないでください。サイズ、フォント、エラー表示の描画で問題が出やすくなります。
   - 任意でアップロードできます。`asciinema upload docs/demo/dsh-oc-demo.cast` は匿名アップロードで7日後に期限が切れ、asciinema.org での引き取りが必要です。README の主な埋め込みは GIF のままです。
