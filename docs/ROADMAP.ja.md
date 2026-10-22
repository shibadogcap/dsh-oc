*[English](ROADMAP.md) · 日本語 · [中文](ROADMAP.zh.md)*

# dsh-oc 次段階の要件（Roadmap）

> 本文書は、現在ユーザーが確認した次段階の作業一覧です。新しい agent が引き継ぐときは、まず本文書を読み、次に
> `docs/FEATURES.md`、`docs/PLAN.md`、`docs/PROTOCOL.md` を読んでください。
> `main` には `v0.2.0-rc.4`（dsh 0.1.5 の host ABI 対応）が入っています。`develop` は以降の変更の
> 集成交付ラインで、安定したら `main` にマージします。

## RC.4 完了（0.2.0-rc.4、2026-09-11）

dsh 0.1.5 の host ABI 破壊的変更への対応です。対象バージョンは `>=0.1.5-rc.2` に固定し、0.1.2 は互換対象から外しました。

- profile 起動：headless の `fileUploads` provider（`@chiro2001/dsh-oc/file-uploads`）で
  `session-controller` の pending を修正しました。`bindPrompt` は disposable なバインディングを返します。
- リアルタイムストリーム：削除された `assistant/chunk` セッションイベントの代わりに、`agent/assistant-stream` の購読を使います。
- 履歴：埋め込みの `assistant/message.stream` から packed run と、パートの所要時間・finish reason を復元します。
- ファイルツール：`write`/`edit` の diff を合成します。e2e の tools シナリオは `write` に切り替えました。
- 最初のターンのラベル：provisional カードはセッションの preset/model を統一して使い、
  `build`/`deepseek-chat` は表示しません。モデルが見つからない場合はデプロイ既定モデルにフォールバックします。
- ローカルゲート：ユニットテスト 440 件、probe 63/63、`check-all --e2e` 全体で 39/39 が初回 PASSED、
  retry は 0 回でした。リモートの `ci` と `e2e` の workflow はすべて green です。

## RC.3 完了（0.2.0-rc.3、2026-09-08）

reasoning effort の修正は候補の収束まで完了しました。公式 TUI のトップレベル `variant` で max/off を複数ターンにわたって選ぶ動作、
Default へのフォールバック、session/history/live/queued の model ref 同期のいずれにも回帰テストがあります。ユーザーが手動で行った TUI の
max/off 操作と、ローカル provider の request body oracle はどちらも通過しました。ローカルゲートの全体はユニットテスト 435 件、
probe 63/63、perf、artifact audit、e2e 39 件を対象とし、初回で全て green、retry なしでした。

## RC.2 完了（0.2.0-rc.2、2026-09-08）

Issue #4/#5 は自動ゲートとユーザーによる手動 TUI 検証を終え、`v0.2.0-rc.2` としてリリースしました。

| Issue | 内容 | 現在の状態 |
|---|---|---|
| #4 | 公式 TUI の `!` shell mode。Agent の idle maintenance を経由してユーザーの OS shell を起動します | ✅ RC.2 で完了 |
| #5 | `/preset` の完了結果が `QUEUED` を出し続けず、切り替え後の実際のモデルを表示します | ✅ RC.2 で完了 |

`!` shell はモデルのターンを発生させません。ユーザーが明示した `!` が権限付与の境界で、コマンドは OS ユーザーの権限と
session cwd を継承します。Agent の idle maintenance が管理し、許可されるのは正確な子プロセス／プロセスグループのキャンセルだけです。shell
カードはブリッジの短命な投影です。`/preset` は空のセッションで切り替えでき、以降に作る新しいセッションが引き継ぎます。
すでに返信のあるセッションは agent preset によるロックが続きます。ユーザー操作と回帰手順は [MANUAL-TEST.ja.md](MANUAL-TEST.ja.md) にあります。

## RC.1 の履歴ベースライン（0.2.0-rc.1、2026-09-07）

このバージョンは dsh `>=0.1.2-rc.1` を対象とした ABI breaking な minor リリースです。PR #1/#2/#3 は
そのままは取り込まず、モデル/preset、キュー、approval/question、subagent/history の
セマンティクスを dsh 0.1.2 の host-services 移行に合わせて統合し直しました。

現在までに実装済みで、対象を絞った回帰テストがある項目は次のとおりです。

- `sessionController`、`agentPresets`、`goals`、`sessionSkillCatalog`、
  `agents`、`sessions`、`sessionProjections` を直接接続しています。旧 apiProxy は履歴文書にのみ残しています。
- status のホットパスは `api-session/status/activity` のメモリ状態を消費し、コールドスタート時の `session.list` seed は最大 1 回です。
  SSE の `Last-Event-ID` はイベント数とバイト数の二重上限を持つ ring を使い、再接続してリプレイした後に
  現在の status/control snapshot を追加します。
- OpenTUI native の一時ファイルは dsh が所有する per-PID ディレクトリに隔離して削除します。安全な I/O
  monitor は既定で observe-only で、明示的な削除は owned process group のみ許可します。
- dsh-dcp rc.6 の `session.events` getter shim は一時的な互換境界です。上流の dcp が
  dsh 0.1.2 への移行を終えたら削除します。

リリースゲートは完了しています。artifact audit、full e2e、実 TUI、リモート full-SHA のコールドインストール／ロールバック、
実モデルの smoke はすべて通過しました。リリース手順の詳細とロールバック契約は [RELEASE.ja.md](RELEASE.ja.md) にあります。

## プロトコル補完の記録（2026-08-16）

次の SDK v2 エンドポイントは stub／未実装から実際の実装に変わり、すべてに単体テストと e2e があります。

- 権限の面：`GET /api/permission/request`、`GET /api/question/request`、
  `GET /api/session/{id}/permission/{rid}`、`DELETE /api/permission/saved/{id}`。
  saved リストは `PermissionSavedInfo` に合わせています。権限付与は session+tool 単位でメモリ上に分離しています。
- VCS の面：`GET /vcs`、`GET /vcs/status`、`GET /vcs/diff`、`GET /vcs/diff/raw`
  （実際の git を読み、untracked は status に入れません）。
- ファイルシステムの面：`GET /api/fs/read/{path}`（`*` ワイルドカード、範囲外は 400、上限 5 MiB）、
  `GET /api/fs/list`、`GET /api/fs/find`（依存／ビルドディレクトリは除外）。
- ライフサイクルの面：`GET /global/health`、`POST /global/dispose`、
  `POST /instance/dispose`（dispose は no-op の確認応答で、プロセスのライフサイクルは dsh が持ちます）。

実装済み：`/api/session/{id}/history`（`limit` と `after` のイベント seq カーソル。
`{ data: SessionMessage[], hasMore }` を返し、v2 のメッセージ変換を再利用してメッセージアンカーの
seq を付けます。`after` が非負整数でない場合は 400）。

> 2026-08-16 深夜：レスポンスに `next`（このページで最も古いアンカーの seq）を追加し、独立したクライアントが連続して
> ページングできるようにしました。`after` は**排他的な上限**（dsh ネイティブの `beforeSeq`、後ろ向きのページング）で、
> 全件を折りたたんでから絞り込む方式ではありません。20k メッセージの単一セッションを全件ページングして約 1.2s、1 ページあたりの遅延は有界です。ベンチマークは
> `docs/perf/results-2026-08-15.md` にあります。

まだ LATER の SDK ルート：`/api/pty/*`（dsh に PTY RPC がない）、`/api/integration/*`
（dsh に integration の面がない）、`/api/credential/*`（dsh は
`credentials.describe/set/unset` RPC をすでに公開していますが、opencode SDK 1.18.18 に対応する
消費ルートがないため、上流のプロトコルが出てから実装します）、`/global/upgrade`（自動更新は明示的に無効）。

## 優先度の概要

| 番号 | 要件 | 優先度 | 推奨ブランチ | 状態 |
|---|---|---|---|---|
| N1 | opencode 子プロセスの自動更新／ホット更新を止める | P0 | `feat-no-autoupdate` | ✅ 完了（2026-08-15） |
| N2 | ストリーミング toolcall / progress | P0 | `feat-stream-tool` | ✅ 完了（2026-08-15） |
| N3 | Goal 機能の完全対応 | P0 | `feat-goal` | ✅ 完了（2026-08-15） |
| N4 | セッション性能テスト（一時 DB と生成履歴） | P1 | `feat-perf` | ✅ 完了（2026-08-15） |
| N5 | プロトコル自測 UT / アップグレードプローブ | P1 | `feat-protocol-ut` | ✅ 完了（2026-08-15） |
| N6 | README と `/help` の能力マトリクス表示 | P1 | `feat-capability-help` | ✅ 完了（2026-08-15） |

推奨する実行順：`N1` を単独で先に行います（安定性と外部ネットワークに影響するため）。`N2`/`N3` は並行できます。`N4`/`N5`/`N6` は並行、またはその直後に行えます。

## 上位モデルのレビュー後に追加（2026-08-16、round-0001）

外部の上位モデルによるレビューの結論は、管理された RC/canary 配信に適しているというものでした。次段階は機能を凍結し、
安定性／一貫性に 60%、インストールとリリースおよび CI に 30%、ドキュメントに 10% を投じます。受け入れた項目と対応は
`expert-advice/round-0001/decision.md` にあります。実施順は次のとおりです。

- 実験 1：実イベントの差分リプレイ、復元の一貫性、既知の順序異常の裁定（live／再接続／再起動／
  `--continue`／`--session` の正規化メッセージグラフの exactly-once、10k イベントの単一セッション
  history のコールドリード／ページングのベンチマーク、公式 TUI の最小再現）。あわせて
  `/api/session/{id}/history` のページング性能のベースラインを定めます。
- 実験 2：`v0.1.0-rc.2` の不変候補に対するクリーンインストール／アップグレード／ロールバックの演習（GitHub spec
  からのコールドインストール、`lib` とソースの一致、旧セッションの復元、`dsh-oc` の PATH）。
- 実験 3：flake の統計監査（固定 commit × 50 回、シグネチャで分類し、初回失敗の証拠を残します。
  その後、無条件にスクリプト全体をリトライする運用を絞り込みます）。
- サポートマトリクス：少なくとも Linux x64 と macOS arm64 のリリース smoke。Windows/ARM は「宣言したらテストする」原則で縮小します。

## 上位モデルのレビュー後に追加（2026-08-17、round-0002）

round-0002 の結論は、rc.2 は現時点で条件付きの NO-GO というものでした。既存の復元一貫性テストは warm/cold の
history 投影の比較であり、live SSE の比較ではありません。また親チェーンのアサーションは常に空でした。受け入れた項目と対応は
`expert-advice/round-0002/decision.md` にあります。調整後の実行順は次のとおりです。

- 実験 1a（2026-08-17 に初回完了）：復元 oracle を修正しました。固定の sleep の代わりに権威ある idle
  （`/api/session/{id}/wait`）を待ちます。v1+v2 の二面シグネチャ（v1 は親チェーンの解決結果が
  非空、v2 はメッセージごとの part と tool name/status/output、ユーザーテキストを統合）を使い、
  全体を平坦に比較する方式はやめました。oracle は初回実行で、v1 の warm 履歴で `parentID` が surface
  id の remap に追随せず親チェーンが宙に浮く欠陥を見つけて修正しました。復元一貫性の e2e は 29s で PASSED し、安定スイートに入っています。
- 実験 1b（2026-08-17 に初回完了）：三つの故障ドメインのマトリクスです。
  `process-crash-recovery`（SIGKILL で途中停止したあと `--session` で再起動：永続化済みのプレフィックスが
  失われない／完了を偽装しない／会話を続けられる、20s で PASSED）、`client-sse-reconnect`（観測側の SSE
  が途切れて再接続したあとメッセージグラフが exactly-once、13s で PASSED）は安定スイートに入っています。
  `mux-resubscribe` は単体テストで覆っています（リプレイされた chunk を translator の再構築をまたいで重複排除します）。復元
  契約（durable な exactly-once、クラッシュ時のプレフィックスが失われない／完了を偽装しない／idle に戻る／会話を続けられる、純粋に
  メモリ上の面は transient として列挙）は、以降の実験のアサーションのベースラインのままです。
- 実験 1c（2026-08-17 に初回の実装とカバレッジ走査を完了）：決定的な合成リプレイコーパス
  `scripts/build-replay-corpus.mjs` → `tests/fixtures/replay/`（10 個の
  fixture。reasoning、単一／複数ツール、キュー、ツールエラー、compaction、中断、
  goal、plugin-context、session-title、unfinished-turn を覆います）。
  `tests/replay-corpus.spec.ts` は未処理／エラーがないこと、ツールの対応関係と終態、live
  の完了状態が durable と一致すること、durable の v1/v2 が一致することを検証し、実行時に 10k イベントの長いセッションの
  ケースを生成します。コーパスの監査は初回実行で**複数ツールのターン完了状態の欠陥**を見つけて修正しました（単一スロットの pending から
  メッセージ単位の複数スロットに変え、turn/end がすべて完了するようにしました）。実セッションの feature カバレッジ走査
  `scripts/replay-corpus-manifest.mjs` では、64 セッション／58,609 イベントの 12 個の
  特徴がコーパスで完全に覆われていることを示しました（結果は docs/perf/coverage-real-sessions-2026-08-17.md）。
  公式 1.18.18 のゴールデントラックのベースラインも実装済みです（`scripts/e2e-golden-trace.sh` と
  `scripts/normalize-golden-trace.mjs`）。実 TUI のツール＋後続テキストのシナリオについて、ブリッジ
  SSE の正規化トラック（id／時刻／パスを除去）を
  `tests/fixtures/golden/recovery-tool-followup-1.18.18.sse.jsonl` としてコミットし、構造は
  実行をまたいで再現でき、安定スイートに入っています。順序異常の再現記録は
  `scripts/e2e-queued-order-repro.sh` です。遅いストリームのツール＋後続テキストに、キーボードから 2 件目の
  prompt をキューした状況で、過渡的な順序をフレームごとに記録し、2 つ目のゴールデンベースライン
  `tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl`（116 イベント）を凍結しました。
  mock シナリオを連続実行しても過渡的な順序異常は再現しませんでした。実モデル版の
  `scripts/e2e-real-queued-order.sh`（manual）は wire の前提（後続テキストの delta がキューのユーザーイベントの後にも届き続ける）を 2 回連続で再現し、
  パネルのフレーム 45/50 で返信内容がキューカードの下に描画されていました。公式の最小サーバによる帰属も実装済みです
  （`scripts/minimal-oc-server.mjs` と `scripts/e2e-minimal-server-repro.sh`）。
  ブリッジの部品とスクリプト化したイベント列（queued-mid-followup fixture）を公式 TUI に与えると、
  TUI の描画順は正しくなります（後続テキストの全体がキューカードの上）。ブリッジには
  `src/bridge/router-entry.ts` のエクスポート（lib/bridge/router-entry.js）を追加し、外部の
  harness から使えるようにしました。実セッションの生 JSONL とブリッジ SSE トラック全体のリプレイも接続済みです（raw
  直送モード）。あわせて `SseHub.enqueue` の接続前バッファを追加しました。現在 raw 直送では公式
  TUI の `/global/event` 接続が短命なプローブになり（接続内のイベントは届きますが、外部へのブロードキャスト
  の窓が短すぎます）、重要な区間を切り出して 80ms の低速リプレイをしても描画されないため、raw 直送の路線は閉じました
  （ツールは実験用途として残します）。fixture のリプレイと実モデルの live 証拠は完了しており、順序異常の
  帰属は「公式 TUI の即時描画がイベントの交錯に影響され、ブリッジの永続データは正しい」という結論のままです。
- 実験 2（2026-08-17 にツールと初回の演習を実装）：`v0.1.0-rc.2` は full SHA
  を真実の源とします。`scripts/verify-release-artifacts.sh` を check-all のゲートに加えました。
  HEAD のソースから clean rebuild した後、コミット済みの `lib/` に差分がなく、npm pack にマシンの絶対
  パスがなく、package version／tarball sha256／package-tree hash を記録します。
  `scripts/e2e-install-rollback.sh`（manual）はリモートの full SHA から候補をコールドインストールし、
  実 TUI の smoke（28s）を実行してから前版の spec にロールバックして再実行し（23s）、同じ profile 内での re-add の挙動も調べます。バージョン番号を bump する前の in-place の結果はキャッシュ安全性の証明にはなりません。RC.2
  ではバージョン bump、リリース演習、保護 tag まで完了しています。
  リリース実行のチェックリストは `docs/RELEASE.md` にあります。
- vendor ABI の upgrade lane（2026-08-17 に実装）：`scripts/upgrade-lane.sh` は
  候補の opencode バイナリに対してゴールデンシナリオを実行し（バージョン検査は
  `DSH_OC_BYPASS_VERSION_CHECK=1` で迂回し、手動 lane のみで使います）、正規化したトラックを
  1.18.18 のベースラインとセマンティックに差分します。同一バージョンでは差分ゼロを確認済みです。候補のアップグレード手順は
  `bash scripts/upgrade-lane.sh --bin <candidate>` で、全て green になってから
  `opencode-version.json`／asset の一覧の更新を検討します。
- 実験 3：flake の層別統計（リスクの高い最小ケースを各 10 回、失敗ゼロなら 30〜60 回に広げます。
  release-lane の予算は 30〜45 分です。セマンティックな初回失敗は retry しません）。
- 実験 3 の初回（2026-08-17）：`scripts/flake-mini-scan.sh` を実装しました。復元の三つの
  故障ドメインはいずれも 10 回すべて green でした（consistency 29〜30s、crash 21〜24s、sse 15〜16s。
  `docs/perf/results-flake-recovery-2026-08-17.md` を参照）。走査の初回で crash
  oracle が厳しすぎる（クラッシュ境界の中でまだディスクに書かれていない chunk の正当な復元を失敗と判定する）ことが分かったため、
  「永続プレフィックスまたは末尾テキストのプレフィックス」という意味に変更しました。
- 実験 3 の第 2 ラウンド（2026-08-17）：queue-live と agent-tab はいずれも 10 回すべて green
  でした（19〜20s / 11〜12s。`docs/perf/results-flake-tui-2026-08-17.md` を参照）。permission の最小ケースは
  分割したうえで追加で実行しました。
- 実験 3 の第 3 ラウンド（2026-08-17）：permission の最小ケース
  `scripts/e2e-tui-permission-mini.sh`（Allow-once を 1 回、10〜11s）は初回で 10/10 green となり、
  stable スイートに加えました。permission の完全なマトリクスは引き続き毎回の回帰で覆います。
- 実験 3 の統合ベースライン（2026-08-17）：リスクの高い最小スクリプト 6 個 × 10 回 = 60 回が初回で
  すべて green でした（recovery の 3 本、permission-mini、queue-live、agent-tab）。
  `docs/perf/results-flake-consolidated-2026-08-17.md` を参照。
- `--continue` の完全なメッセージグラフの変種は優先しません。`e2e-tui-continue.sh` の選択
  契約は残し、低コストの `-c` 選択契約は後から追加できます。

### 復元契約（草案、実験 1b のアサーションのベースライン）

- 完了した durable なターン：ロール、順序、テキスト／reasoning、tool の
  input/output/error、part の帰属と参照関係が exactly-once。
- プロセスのクラッシュ時点で in-flight のターン：永続化済みのプレフィックスを復元します。成功を偽装せず、再起動後に
  明確な aborted/idle の終態になり、次の prompt を受け付けます。
- title/goal/todo などの永続 projection：コールドスタート後に復元します。
- queued message / pending permission/question：dsh に権威ある snapshot があれば
  再送し、なければ明示的に取り消し、操作できない TUI カードを残しません。
- `Allow always`、ブリッジが合成する command/error テキストなど純粋にメモリ上／一時的な面：復元しなくてもよい
  ものとしますが、ドキュメントに transient として明示する必要があります。

---

## N1. opencode 子プロセスの自動更新とホット更新を止める

### 背景
oc-tui は公式の `opencode --server` を子プロセスとして実行します。opencode 自身が新しいバージョンを確認し、自動ダウンロードやホット更新を行う可能性があるため、次の問題が起きます。
- 起動時に外部ネットワークへ接続し、タイムアウトすることがあります。
- バイナリのバージョンが `opencode-version.json` の固定から外れ、dsh-oc bridge のプロトコルと一致しなくなります。

### 要件
1. `src/tui/index.ts` の `buildChildEnv` で opencode の自動更新を明示的に止めます。
   - まず opencode 2.1.0 が対応する env／flag を調べます（`OPENCODE_DISABLE_AUTOUPDATE`、`OPENCODE_AUTOUPDATE=false`、`OPENCODE_DISABLE_AUTOUPDATE_CHECK` など）。ソースを根拠にします。
   - あわせて `OPENCODE_DISABLE_UPDATE=true` を設定します（そのスイッチが存在する場合）。
   - 不確かなスイッチは使いません。不確かなときは opencode のソースで確認します。
2. opencode が自身をホットリプレースしないようにします。
   - 公式の仕組みが「更新の案内」だけなら、ダウンロードしないことを確認します。ダウンロードする可能性があるなら必ず止めます。
   - opencode のデータディレクトリには読み取り専用／隔離したディレクトリを使い（現状は `$DSH_HOME/opencode` の下）、自動更新の状態もそのディレクトリに書かれるようにします。
3. バージョン固定の監査：
   - 実行時に解決した opencode バイナリの `--version` は、常に `OPENCODE_VERSION` と一致する必要があります。
   - `resolveOpenCodeBinary` の後にもう一度検証し、一致しない場合はエラーにして、キャッシュの削除か `DSH_OC_OPENCODE_BIN` の指定を促します。
4. ネットワークポリシー：
   - 子プロセスは `api.opencode.ai` や GitHub release に自発的にアクセスしないようにします（resolver が明示的にダウンロードする場合を除く）。
   - できれば `OPENCODE_DISABLE_NETWORK` または同等のパラメータを用意し、後からブリッジ層が外部ネットワークを完全に制御できるようにします。

### 受け入れ条件
- 単体テスト：`buildChildEnv` が、利用可能な更新停止の env をすべて含むこと。
- オフライン e2e：`HTTPS_PROXY/HTTP_PROXY` を到達不能なポートに向け、opencode のキャッシュを空にしても、TUI がタイムアウト内に起動すること。
- `opencode --version` と `OPENCODE_VERSION` が一致しないとき、dsh-oc が明示的にエラーを出すこと。

---

## N2. ストリーミング toolcall / progress

### 背景
テキストと reasoning はすでにストリーミングしていますが、ツール呼び出しは pending/final しか送らないため、途中の過程が見えません。ユーザーは bash などのツールコマンドの実際の実行状況と進捗を見たいと考えています。

### 要件
1. dsh のツールストリームイベントを変換します。
   - 少なくとも dsh の `tool/call`、`tool/call-chunks`（または `tool-call-chunks`）、`tool/result` を覆います。
   - opencode 1.18.18 の対応イベントを調べます。
     - `session.next.tool.input.started`
     - `session.next.tool.input.delta`
     - `session.next.tool.input.ended`
     - `session.next.tool.called`
     - `session.next.tool.progress`
     - `session.next.tool.success`
     - `session.next.tool.failed`
   - v1 の `message.part.updated` による ToolPart の差分更新にも対応します（opencode 1.18.18 の TUI が実際に消費する経路）。
2. ツール引数のストリーミング：
   - dsh のツール arguments が delta で現れるとき、TUI の入力エリア／ツールカードに段階的に表示します。
   - 大きな引数を一度に更新して固まることを避けます。
3. ツール実行の過程：
   - bash/pwsh の出力は最終的な output だけでなく、リアルタイムの progress を出します。
   - read/write/edit のファイルツールは段階の見出しを表示します。
4. 失敗とキャンセル：
   - ツールの失敗、abort、タイムアウトは、TUI にエラー状態と理由を表示します。
5. 性能の保護：
   - 高頻度の chunk イベントを throttle／バッチ処理し、SSE の洪水を避けます。

### 受け入れ条件
- 単体テスト：`tool-call-chunks` → ToolPart の input/state の差分。
- API e2e：mock LLM が bash を起こし、SSE に input.delta/progress/success が現れること。
- TUI e2e：`tmux capture-pane` で、ツール実行中にコマンド出力の一部が見えること。

---

## N3. Goal 機能の完全対応

### 背景
Goal は dsh で頻繁に使われる機能ですが、opencode TUI にはネイティブの goal UI がありません。dsh-oc は dsh の goal を、opencode が理解できる状態（todo／projection／セッションイベント／コマンド）にマッピングする必要があります。

### 要件
1. dsh の goal ライフサイクル：
   - `goal/start`、`goal/update`、`goal/end` などのイベントを opencode の todo またはセッションメッセージに変換します。
   - 少なくとも goal のタイトル、状態、ステップをユーザーに見せます。
2. `/goal` コマンド：
   - `GET /command` で `/goal` を公開します。
   - goal の作成／表示／切り替えをサポートします（dsh にコマンドレジストリがある場合）。
3. セッション履歴の goal：
   - `GET /session/:id/todo` は goal のステップを優先して返します。
   - `GET /session/:id/message` の goal イベントは、システムメッセージ／compaction の要約にマッピングします。
4. plan mode / todo との協調：
   - 現在の todo projection はそのまま動かし、goal が todo を上書きしないようにします。

### 実装状況（2026-08-15）

- `goal/change` と `goal` projection → `todo.updated` に統合します（goal はサイドバーの最初の todo になり、
  `active → in_progress`、`paused/blocked → pending`、`complete → completed`）。
- `GET /session/:id/todo` は goal（projection または履歴イベントの折りたたみ）を優先して返し、dsh の todo はその後ろに残します。
- `GET /command` / `GET /api/command` に `/goal` を登録します。`POST /session/:id/command` と
  prompt のルートが `/goal [objective|clear|edit ...|pause|resume]` を捕捉し、dsh の command
  registry で実行して busy/idle の結果をブロードキャストします。
- v1/v2 の履歴メッセージは `goal/change` を assistant のテキスト note に折りたたみます。
- 受け入れ：`tests/convert/goal.spec.ts`、`tests/bridge-events.spec.ts`、
  `tests/bridge-router.spec.ts`、`scripts/e2e-api-goal.sh`、
  `scripts/e2e-tui-goal.sh`（実 TUI のサイドバーに goal が見える）がすべて通過します。

### 受け入れ条件
- 単体テスト：goal イベント → todo／セッションメッセージ。
- API e2e：goal を作成し、goal のステップの変化が見えること。
- TUI e2e：ユーザーが goal の状態を見てタスクを続けられること。

---

## N4. セッション性能テスト

> 状態：完了（2026-08-15）。実装は `scripts/perf.mjs`、`scripts/perf-session-gen.mjs`、
> 単体テストは `tests/perf.spec.ts`、レポート例は `docs/perf/report-example.json` にあります。
> 実行：`pnpm run perf -- --sessions 1000 --messages-per-session 6 --tools --todos --children 10`。

### 背景
大量の dsh セッション履歴を模擬し、一覧／検索／SSE／history の体験性能を検証する必要があります。

### 要件
1. 生成器：
   - 一時的な DSH_HOME と SQLite/JSONL で dsh のセッション履歴を直接生成します。データの出所は次のとおりです。
     - `~/.codex/history.jsonl`
     - opencode の履歴 JSONL
     - 合成 fixture
   - `--sessions N`、`--messages-per-session M`、`--turns K`、`--tools` をサポートします。
2. 指標：
   - `GET /session` のコールド／ウォームスタートの遅延
   - `GET /session/:id/message` のページング遅延
   - SSE の最初のイベントの遅延
   - 1000/5000/10000 sessions でのメモリ使用量
3. シナリオ：
   - コールドスタート：profile キャッシュなし
   - ウォームスタート：profile 読み込み済み
   - 多数の subagent child
   - 多数の todos/produced-files
4. 出力：p50/p95/max を含む JSON／テキストのレポート。

### 受け入れ条件
- `pnpm run perf` を繰り返し実行できること。
- CI が任意で smoke 規模（例：1000 sessions）を実行すること。
- >500ms の明白な退行があれば、問題を記録して修正すること。

### 実測ベースライン（本機、30 セッション × 4 メッセージ、2026-08-15）
- boot（bridge URL が整うまで）：約 0.8s
- `GET /session` p50 ≈ 14ms / p95 ≈ 28ms（コールドスタートの初回リクエストを含む）
- `GET /session/:id/message?limit=50` p50 ≈ 15ms / p95 ≈ 40ms
- SSE の最初のイベント（トリガー後）：< 1ms
- dsh プロセスの RSS：約 250 MB
- その他の数値は `docs/perf/report-example.json` にあります。大規模なシナリオ（1000/5000/10000）は本機で全体を実行してください。

---

## N5. プロトコル自測 UT / opencode アップグレードプローブ

### 背景
opencode のバージョンを上げると API のルートや型が変わる可能性があるため、ユーザーが自分でプロトコルの自測を実行できる必要があります。

### 要件
1. 既存の `tests/bridge-router.spec.ts` は中核の UT として使い続けます。
2. プロトコルプローブのスクリプトを追加します。
   - `scripts/probe-opencode.sh` または `scripts/probe-opencode.mjs`
   - `OPENCODE_VERSION` と opencode バイナリのパスを指定できます。
   - 実／ローカルの opencode server、または mock bridge を起動し、起動時のリクエストを取得します。
3. 互換性レポートを出力します。
   - 欠けているルート
   - ルートの method/query の変化
   - SDK schema の変化
4. アップグレードの手順：
   - `opencode-version.json` を更新する
   - `node scripts/update-opencode-assets.mjs` を実行する
   - probe を実行する
   - `docs/PROTOCOL.md` の互換マトリクスを更新する
5. 任意：複数バージョンの SDK 型をキャッシュし、diff からレポートを生成します。

### 受け入れ条件
- 現在の 1.18.18 で probe を実行して全て green になること。
- ルートを 1 つ欠けさせた状態を模擬すると、probe がエラーを出し、修正案を示すこと。

---

## N6. README と `/help` での能力マトリクス表示

### 背景
ユーザーは、元の opencode の機能のうちどれが使えて、どれが stub／未対応なのかを明確に知る必要があります。

### 要件
1. README：
   - 「能力の状態」の表を追加し、`docs/FEATURES.md` を参照します。
   - ✅ / 🟡 / ❌ で、利用可／一部利用可／利用不可を記します。
   - ネットワーク、自動更新、バイナリ固定の方針を明記します。
2. `/help`：
   - `dsh --profile oc --help` の出力に次を表示します。
     - バージョン
     - 対応する attach パラメータ
     - 中核能力の要約
     - 既知の制限
     - ドキュメントの入口
   - `docs/FEATURES.md` から自動生成できます。
3. 動的更新：
   - `scripts/update-feature-matrix.mjs` が README と FEATURES.md を同時に更新します。
   - 新機能の実装時は必ずマトリクスを更新し、そうしないと UT が失敗します。

### 受け入れ条件
- README と FEATURES.md の内容が一致すること。
- `dsh --profile oc --help` で能力マトリクスが見えること。
- `pnpm run features:update` の後の git diff が最小であること。

---

## M シリーズ：保守とエンジニアリング（2026-08-15 以降）

機能の主線（N1〜N6）が完了したら保守の段階に入ります。持続的にイテレーションでき、参加しやすく検証しやすいリポジトリにすることを目指します。現在は `develop` ブランチの集成交付モードです。

### 優先度の概要

| 番号 | 方向 | 状態 |
|---|---|---|
| M1 | ドキュメントと既知の制限の同期 | ✅ README（ユーザー向け）と AGENTS.md（Agent／開発向け）を分離し、CHANGELOG/FEATURES を自動追跡 |
| M2 | 開発フローと CI | ✅ CI は `main`/`develop`/`feat-*`/`fix-*`/`docs-*`/`perf-*`/`test-*`/`chore-*` を対象にします。push で安定 e2e スイートを自動実行し、手動トリガーで全量 e2e と負荷テストを実行します |
| M3 | コミュニティの貢献フロー | ✅ `CONTRIBUTING.md`、PR テンプレート、Issue テンプレート（bug/feature） |
| M4 | ブランチ戦略と整理 | ✅ `scripts/cleanup-merged-branches.sh`（既定は dry-run）。履歴の `feat-*` はすべて main に統合済み |
| M5 | リファクタリング（router 分割／キャッシュ統一） | ✅ ルート登録をドメイン別に `src/bridge/routes/` へ分割。キャッシュ／in-flight の統合と無効化 generation を統一 |

### M1 ドキュメント

- README の既知の制限は `docs/FEATURES.md` と一致させます。新しい挙動（終了時の splash の説明など）は
  両方に同期する必要があります。
- 能力一覧に関わる変更では `pnpm run features:update` を実行し、自動追跡の結果をコミットします。

### M2 開発フロー

- 単体テスト／プローブ／性能 smoke は `scripts/check-all.sh` で一括実行します。完全な e2e は `--e2e` を使います。
- GitHub Actions：`ci.yml` が build/typecheck/test/probe を自動実行し、`e2e.yml` が push で
  安定 e2e スイートを自動実行、手動トリガーで全量 e2e と負荷テストを実行します。
- e2e のブランチ許可リスト：`main` / `develop` と `chore-*` / `fix-*` / `docs-*` /
  `perf-*` / `test-*` / `feat-*`。

### M3 コミュニティの貢献

- 開発環境、ブランチ戦略、コミット規約、自測のしきい値は `CONTRIBUTING.md` にあります。
- Issue/PR のテンプレートは `.github/` にあり、テンプレートに沿って記入します。

### M4 ブランチ戦略と整理

- `main` は安定リリース、`develop` は集成交付、機能ブランチは短命にします。
- `main` に統合済みの履歴の `feat-*` ブランチは安全に整理できます。
  `bash scripts/cleanup-merged-branches.sh`（まず dry-run で確認し、`--apply` でローカルを削除、
  `--remote` でリモートも削除します。ワークツリーでまだチェックアウトしているブランチはスキップします）。

### M5 リファクタリング（完了）

- ルート登録をドメイン別に `src/bridge/routes/{boot,session-v1,session-v2,permission}.ts` へ分割し、
  `router.ts` は約 2200 行から約 1600 行に減りました。プロトコルプローブはルートのディレクトリを自動で走査します。
- `InteractionState` のキャッシュ／in-flight の統合／無効化 generation を統一的に管理します。
- 今後の任意項目：`tests/e2e/common.sh` の tmux／待機のヘルパーを整理し、ヘルパーをさらに下層へ移します
  （現在はコマンドドメインのヘルパー同士が結合しており、効果が限られるため、今は分割しません）。

---

## 統一の受け入れゲート

1. `pnpm install && pnpm build && pnpm typecheck && pnpm test` がすべて通ること。
2. 関連する e2e スクリプトがすべて通り、新しいスクリプトが新機能を覆っていること。
3. `docs/FEATURES.md` の自動部分が更新され、README/ROADMAP が更新されていること。
4. `lib/` のビルド成果物をコミットすること。
5. ブランチごとに独立してコミットし、統合後に main へマージして push すること。
