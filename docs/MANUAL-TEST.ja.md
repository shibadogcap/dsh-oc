*[English](MANUAL-TEST.md) · 日本語 · [中文](MANUAL-TEST.zh.md)*

# dsh-oc 手動テストガイド

この文書は、dsh-oc を手作業で検証するときの推奨手順と期待動作をまとめたものです。
リリース前やアップグレード後に短時間で回帰テストを行うために使います。自動テストの
範囲は [FEATURES.md](FEATURES.md) と `scripts/e2e-*.sh` にあります。

前提: リリース線では `dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'` を使います。
ローカルの作業ツリーをテストするときは `dsh plugin --profile oc add .` を実行し、
`pnpm build` を走らせます。クリーンなターミナルで `dsh --profile oc` を実行して
ください。profile 名は常に `oc` です。

## 1. 起動とブランド

- 期待: 起動画面に **DSH OC** のアスキーアートが表示され（OPENCODE ではありません）、
  そのまま opencode TUI に入ります。画面下部には opencode `2.1.0` が表示されます。
- 確認: `dsh --profile oc` を実行します。`dsh --profile oc --help` で能力の要約が
  表示されます。

## 2. 基本の会話

- 新しいセッションで、普通の文を 1 つ入力します（例:「OK とだけ返答して」）。
- 期待: モデルの返答が正常に表示されます。入力中はストリーミング表示になり、
  ステータスバーにモデルと所要時間が出ます。
- 確認: セッション一覧（`ctrl+x l` で Sessions 一覧を開きます）にそのセッションが
  表示され、実際のタイトル（タイトル → ディレクトリ名 → id の順にフォールバック）
  が出ます。`--continue` / `--session <id>` で復元したとき、履歴が欠けずに残ります。
- キュー: 長いタスク（例:「300 字の短文を書いて 1 文ずつ出力して」）を与え、
  モデルの実行中に短いメッセージを入力します。期待: 2 通目がすぐに QUEUED マーカー
  付きで表示され、1 通目が終わると自動で処理が始まります（実モデルで確認済み。
  コマンドラインや API から送った場合も同じです）。

## 3. ツールと権限

権限昇格が必要なコマンドをモデルに実行させます（例: `ls` の前に「コマンドを実行して」
と付けます）。`Permission required` ダイアログが出ます。

- `Allow once`: 今回の 1 回だけ許可します。同じセッションで再度実行すると、また
  確認が出ます。
- `Allow always`: 確認が出ます。同じセッションの同じツールは以後自動で許可されます。
  新しいセッションでは再度確認が出て、再起動すると記憶は消えます。
- `Reject`: コマンドは実行されず、TUI に拒否のマークかエラーが表示され、ファイルは
  書き換わりません。
- `Esc`: standard モードでは Reject と同じです。`--mini` では先に「Reject permission」
  の確認層が出るので、Enter で確定します。
- 質問ダイアログ（`ask_user_question`）: `Down`/`Up` で選択肢を移動し、Enter で
  確定します。Esc で取り消し、`/question` で内容を消してターンを終了します。

## 4. 中断とキャンセル

- モデルが長いテキストを出力している間に、完全な TUI と `--mini` の両方で Esc を
  2 回続けて押します。進行中のストリームが止まり、入力できる状態に戻ります。
  thinking のインジケータが回り続けてはいけません。
- ストリーミングのエラー（例: SSE に `[DONE]` が無い、認証に失敗する）では、
  サイドバーに読める形のエラーテキスト（例:「SSE stream ended without [DONE]」）が
  出ます。`[object Object]` にはなりません。

## 5. 終了時の案内

- 内容のあるセッションを終了すると（`exit`）、公式 opencode のスプラッシュ
  （logo + session id）が通常どおり表示され、その下に dsh-oc が 1 行追加します。
  session id は dsh のセッション id で、復元には
  `dsh --profile oc --session <id>` を使います。
- `DSH_OC_DISABLE_EXIT_NOTE=1` でこの案内を止められます。空のセッションを終了した
  ときはスプラッシュを表示しません。

## 6. agent / preset

- 空のセッション: `/preset` で利用できる preset の一覧が出ます。`/preset minimal`
  または Tab で agent を切り替えると反映され、以後に作るセッションは直近の選択を
  引き継ぎます。
- `/preset minimal` が終わると、`preset switched to minimal` のカードはすぐに
  終了します。`QUEUED` のまま残ってはいけませんし、消すために次のメッセージを
  送る必要もありません。
- 返答が始まったセッション: 切り替えは dsh にロックされます。切り替えたあとの
  最初のメッセージで「Agent switch locked」の案内が 1 回出ます。黙って失敗しては
  いけません。

## 7. `!` shell mode

- 公式 OpenCode TUI の入力欄で `!` を押すと Shell mode に入ります。
  `printf DSH_OC_SHELL_OK` を入力して Enter を押します。
- 期待: `bash` のツールカードが 1 枚表示され、状態が running から completed に
  変わります。出力は 1 回だけ表示され、モデルの返答は発生しません。API の履歴では、
  対応する tool part の `state.output` に `DSH_OC_SHELL_OK` が含まれます。続けて
  普通の質問として、いま実行したコマンドを尋ねます。モデルには「ユーザーが手動で
  実行した」と明確に示されたコマンドと出力のコンテキストが見えます。shell の完了
  処理そのものが余分なモデルのターンを生んではいけません。注意: コマンドと出力は
  現在設定されているモデルに送られます。token、パスワード、個人データが漏れる
  コマンドを `!` で実行しないでください。長すぎるコマンドや出力には明確な切り詰め
  マーカーが付きます。
- 検証スクリプト: `scripts/e2e-tui-shell.sh`。このスクリプトは専用の tmux session を
  使うため、普通の shell コマンドが他のプロセスを終了させることはありません。
  shell の実行は現在の OS ユーザーの権限を引き継ぎ、idle ownership は Agent
  maintenance が管理します。キャンセルはその session 自身の正確な子プロセスまたは
  プロセスグループにだけ働きます。

## 8. mini モード

- `dsh --profile oc --mini`: 返答は 1 回だけ描画されます（重複しません）。
  ストリーミング中のターンは Esc を 2 回続けて押すと中断します。権限の Esc は確認層が
  1 段増えます。終了時の動作は第 5 節と同じです。
- `scripts/e2e-tui-mini.sh` で C-c を 3 回押すと `DSH_EXIT=130`（SIGINT）に
  なることがあります。これは許容される終了コードです。0 でも 130 でも、dsh-oc の
  終了案内が見える必要があります。

## 9. subagent / Task パネル

- モデルに `subagent` または `subagent_fork` を呼ばせます。親セッションには
  ネイティブの `Spawn Task` / `Fork Task` カードと delegation description が
  表示されます。未知のツールカードにはなりません。
- Task カードから実際の child session へ移動できます。child のページにも正しい
  親セッションの関係が表示され、一度きりの child が終わったあとも履歴を参照
  できます。
- 自動回帰: `scripts/e2e-tui-subagent.sh`（隔離した dsh profile + 公式
  `opencode --server` + 正確な PID を observe-only で監視）。

## 10. その他の入口

- `--dir <path>` は作業ディレクトリを変えます（パスと添付ファイル検証の基準に
  なります）。`--fork` は現在のセッションから派生します。`--log-level` は opencode
  にそのまま渡します。
- 添付: テキストと画像は送信できます。PDF などのバイナリは拒否されます（400）。
- `/goal` は goal の作成・参照・一時停止・再開・完了を行い、sidebar にも同じ状態が
  表示されます。TUI で `/goal <完全な目標>` を直接入力すると、完全な目標が作成
  されます（回帰: 以前は入力が `/goal` と直前のメッセージに分割されていました）。
  自動で開始された goal のターンは Esc で中断できます。
- `/help` は能力の要約を表示します。`/preset` は agent preset の一覧を表示します。

## 11. プロトコルエンドポイントのスモークテスト（任意、開発者向け）

起動後、TUI プロセスの引数から bridge の URL を取得します
（`opencode --server http://127.0.0.1:<port>`）。

```bash
B=http://127.0.0.1:<port>
curl -s $B/api/health                       # {"healthy":true}
curl -s $B/api/vcs                          # 現在の git ブランチ/既定ブランチ
curl -s $B/api/fs/read/README.md            # ワークスペースのファイル内容
curl -s $B/api/fs/list                      # ワークスペースのディレクトリ
curl -s "$B/api/fs/find?query=README"       # ファイル検索
curl -s $B/api/permission/request           # pending が無いとき {"data":[]}
```

## 12. 既知の制限の再確認

- `Allow always` は再起動で消えます。MCP/LSP/formatter/integration/reference は
  schema-valid stub です。opencode の終了スプラッシュは置き換えられません（下の
  案内だけを追加します）。`ask_user_question` の `multiple` オプションには、公式
  TUI で視覚的な複数選択の操作がありません。

## 13. 公式 opencode との表示比較（2.1.0 + ローカル mock）

同じ mock provider の下で、公式 `opencode --server` と dsh-oc を項目ごとに比較
します。

- 起動画面: 公式は OPENCODE のアスキーアート、dsh-oc は DSH OC のアスキーアートを
  表示します。
- 基本の会話: ユーザーメッセージとアシスタントの返答はどちらも 1 回だけ描画
  されます。思考中は `+ Thought` が表示され、完了するとモデルと所要時間が表示
  されます。
- ツール呼び出し: 実行中はツールカードを 1 枚だけ表示し（`$ <command>`）、完了すると
  出力を追記します。「同じ呼び出しが 2 回表示される」ことや「コマンドカードと結果
  カードが並ぶ」重複は起きません。
- キュー入力: モデルが実行中のときに新しいメッセージを送ると、すぐに QUEUED カードが
  表示され、1 通目が終わるとそのメッセージの処理が自動で始まります。同じメッセージが
  2 枚のカードになることはありません。
- 終了: 公式のスプラッシュ（logo + session id）と dsh-oc の案内行がどちらも正常に
  表示されます。
- 通常のテキスト返答（reasoning を含む）とユーザーメッセージはどちらも 1 回だけ
  描画されます。ツール呼び出しは実行中にツールカードを 1 枚だけ表示し、完了すると
  出力とターンの所要時間を表示します。

再現手順: `scripts/e2e-tui-queue.sh`、`scripts/e2e-tui-abort.sh`、
`scripts/e2e-tui-permission.sh` が上記のほとんどのシナリオを覆います。実モデルでの
回帰は `scripts/e2e-real-llm.sh` です。

既知の残差（公式 TUI 2.1.0 で観察された即時表示の制限）: ツール呼び出しのターンで、
モデルが実行中に 2 通目のメッセージをキューしたときの**即時ビュー**では、後続テキストが
キューカードより後に描画されることがあります。ブリッジが正規化したデータは
exactly-once と親子関係の正しさをすでに示しており（v1/v2 の履歴ではツールと後続
テキストが同じメッセージに統合されます）、`--session` でセッションに入り直すと順序は
完全に正しくなります。公式 opencode は同じシナリオでその後続テキストすら保持しません。
具体的な帰属（renderer か bridge のイベント妥当性か）は、公式 2.1.0 での最小再現実験が
閉じるまで確定しません。再現記録として `scripts/e2e-queued-order-repro.sh` を追加
しました。遅いツールと後続テキストのストリームの途中でキーボードから 2 通目の prompt
をキューし、ストリーミング中のパネル順序をフレームごとに撮影して、正規化した SSE の
ベースライン（`tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl`）を固定します。
mock 駆動のシナリオを連続実行しても、瞬間的な順序の乱れは観察されませんでした
（1 ラウンド 61 フレーム）。実モデル版の `scripts/e2e-real-queued-order.sh`（manual、
実際の DeepSeek API）は、2 回連続で wire 側の前提を再現しました。後続テキストの
`message.part.delta` がキューのユーザーイベント（seq 107/65）より後に届き続け
（`wire_follow_after_queued=1`）、ストリーミング中は 50 フレーム中 45 フレームで返答
内容がキューカードの下に描画されました。証拠を合わせると、公式 TUI の即時描画順序が
キュー後に届く後続テキストの影響を受けるという方向を支持します。公式の最小 server で
の帰属（`scripts/minimal-oc-server.mjs` + `scripts/e2e-minimal-server-repro.sh`）:
dsh も実モデルも使わず、ブリッジのコンポーネントだけでスクリプト化したイベント列を
公式 2.1.0 TUI に流すと（queued-mid-followup fixture: 後続テキスト part2 がキューの
ユーザーイベントの後に届きます）、TUI は完全な後続テキストをキューカードの上に描画
しました（順序は正しく、95 フレームで瞬間的な乱れは観察されませんでした）。この結果
は、乱れが実セッションで覆われていないイベントの交互配置やメッセージ同一性の形に
依存することを示します。最終的な帰属には、実セッションの元のイベント列を最小 server
上で再現する必要があります。ターンメッセージの完了時刻はターンの終了まで遅らせる
ようにしたので、QUEUED マーカーはターン全体が終わるまで正しく残ります。

## 14. プロセス I/O の観察（安全な既定）

`scripts/monitor-process-io.sh` は既定で、明示的に指定した PID だけを観察し、外部
プロセスを終了させません。正常終了は既定で何も出力せず、しきい値に達したときは
stderr に警告を出すだけで記録を続けます。正常終了を報告させたいときは `--report-exit`
を明示的に付けます。ログは TSV で、`read_bytes/write_bytes/rchar/wchar/RSS/CPU` と
CPU の増分を含みます。ログには現在の累計値とこのウィンドウの delta の両方が残ります。
外部 PID の最初のサンプルは baseline を作るだけで、`--start` で起動した自前の
プロセスは最初のサンプルにある既存のカウントも計上します。また PID/starttime により、
子プロセスの終了や PID の再利用で負の delta が出るのを防ぎます。

```bash
scripts/monitor-process-io.sh \
  --pid <pid> --include-descendants --interval 1 \
  --read-threshold 1073741824 --log /tmp/dsh-oc-io.tsv
```

監視スクリプト自身が起動し、終了時に片付ける必要があるテストプロセスには、`--start`
を明示的に使います。`--terminate-owned` を許すのはこのモードだけで、しかも
スクリプトが作成して検証したプロセスグループに限ります。

```bash
scripts/monitor-process-io.sh --start --terminate-owned --samples 10 \
  --interval 1 --log /tmp/dsh-oc-owned.tsv -- sleep 30
```

fake TUI binary のアイドル回帰: `tests/e2e/fake-opencode-idle.sh`。修正後の fake
binary が EOF でビジーループを回して CPU/I/O を消費しないことを示します。

監視の安全自測: `tests/e2e/monitor-process-io-read.sh` は 16 MiB の `rchar` 増分と
しきい値の警告を検証します。`tests/e2e/monitor-process-io-owned.sh` は TERM を無視
する owned child、root が先に終了しても生き残る child、外部 PID の終了保護を検証
します。

実 TUI の e2e では任意で `DSH_OC_E2E_MONITOR_IO=1` を設定できます。このとき
`e2e_tui_wait_attach` が現在の run の `opencode --server` PID を正確に取得し、
observe-only モードでそのプロセスツリーをサンプリングします。ログと警告はそれぞれ
現在の `E2E_RUN_DIR/opencode-attach-<pid>*.io.tsv` / `.io.warn` に書き、警告は
stderr にも同期します。既定のサンプリング間隔は `0.25s`、read ウィンドウのしきい値は
`32MiB` で、`DSH_OC_E2E_MONITOR_INTERVAL` と
`DSH_OC_E2E_MONITOR_READ_THRESHOLD` で上書きできます。この接続は
`--terminate-owned` を渡さず、名前で TUI を終了させることもありません。対象が終了
すると監視も自然に終わります。対応する TUI 無しの shell 回帰は
`tests/e2e/monitor-process-io-attach.sh` です。

## 15. Profile の隔離と dsh-tui のトラブルシューティング

- dsh-oc は `dsh --profile oc` からのみ起動してください。bridge の互換 shim はその
  dsh プロセスにだけ存在し、`tui` や `dsh-tui` の profile を汚しません。
- dsh-tui launcher は常に `dsh --profile dsh-tui` を使います。`dsh --profile tui` は
  別の profile で、空か dsh-base だけの可能性があります。まず次の読み取り専用
  コマンドで実際の構成ツリーを確認します。

  ```bash
  dsh --profile oc --dump-config
  dsh --profile tui --dump-config
  dsh --profile dsh-tui --dump-config
  ```

- `tui` という名前の profile を明確に使いたい場合は、次の推奨コマンドを検討して
  ください。今回の作業ではユーザーの profile に対して実行しておらず、古い dsh-dcp を
  追加してもいけません。

  ```bash
  dsh plugin --profile tui add '@deepseek-harness-tui/dsh-tui@0.10.0-beta.5'
  dsh --profile tui
  ```

  グローバルの `dsh-tui` コマンドは今も `dsh-tui` profile を探し、`tui` に自動で
  切り替わることはありません。

- dsh-tui が `turn error · events is not iterable` を表示する場合は、dsh-dcp が
  まだ `session.events` を読んでいないか確認します。dsh 0.1.2 のインターフェースは
  `session.snapshotEvents()` です。dsh-dcp をアップグレードするか、dsh-tui の
  profile patch または一時的な診断 overlay で `dcp` を無効にしてください。dsh-oc を
  dsh-tui profile にインストールしてはいけません。ABI の非互換は直らず、profile の
  隔離も分かりにくくなります。
