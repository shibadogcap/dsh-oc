*[English](HANDOVER.md) · 日本語*
# HANDOVER — dsh-oc の dsh 0.2.1 / OpenCode 2.1.0 対応

このファイルは作業の引き継ぎ用。次に触れる人へ、状態・判断・残作業を渡す。

## 0. 何をするプロジェクトか

`/data/dsh-ocplus/dsh-oc` は DeepSeek Harness（dsh）の OpenCode TUI フロントエンド。

- 前端: 公式 opencode CLI（`--server` モード）。描画とキーボードのみ。
- バックエンド: dsh が Agent / Session / ツール / モデル / 承認 / 質問を担当。
- 橋接: dsh-oc の `oc-bridge` プラグインが dsh プロセス内で OpenCode 互換の
  HTTP/SSE を提供し、`oc-tui` が公式 TUI を子プロセスとして起動する。

## 1. 現在の目標と到達状態

目標: 「dsh-oc を最新 dsh と OpenCode v2 へ追従し、OpenChamber 2.5 から
操作できるようにする」。

到達状態（すべて実測で確認済み）:

| 項目 | 状態 |
| --- | --- |
| dsh 0.2.1-rc.2 追従 | 完了。`package.json` / `cordis.patch.yml` / ABI 差分対応済み |
| OpenCode 2.1.0 追従 | 完了。`@opencode/client@2.1.0`、公式 TUI バイナリ 2.1.0 |
| v1 HTTP 層の削除 | 完了。`@opencode-ai/sdk` 依存ごと削除 |
| 公式クライアント 138 ルートの網羅 | 完了。`scripts/check-client-routes.mjs` が `missing: 0` |
| プロトコルプローブ | 完了。`node scripts/probe-opencode.mjs` が `PASSED (138/138 routes, 0 issues)` |
| v2 イベント語彙 | 完了。`session.text.*` / `session.tool.*` / `session.step.*` / `session.execution.*` / `session.inbox.*` / `permission.*` / `form.*` / `session.compaction.*` を SSE で流す |
| `server.connected` 开流 | 完了。2.x クライアントはこれで開流しないと拒否する |
| 公式 TUI 接続 | 完了。`opencode --server <url>` で起動し `event stream connected` を確認 |
| 公式 TUI の実動 | 完了。`scripts/e2e-tui-boot.sh` が PASSED（起動 → 描画 → exit 0）。入力した prompt が dsh に届き、ツール実行と結果カードが描画されることも確認済み |
| OpenChamber 2.5 接続 | 完了。`isOpenCodeReady: true`、`lastOpenCodeError: null` |
| OpenChamber 起動時 22 呼び出し | 完了。`scripts/e2e-openchamber-bootstrap.mjs` が PASS |
| OpenChamber reducer 通過 | 完了。`scripts/e2e-openchamber-events.ts` が PASS |
| 巻き戻し | 完了。3 ルート（stage / clear / commit）と `session.revert.*` 3 イベントを実装。境界は排他（境界メッセージとその後のメッセージは commit で消える）、ファイルは stage で回合単位に即時巻き戻し、commit は dsh セッションを fork して opencode セッション id は fork を指す、次の prompt で自動 commit。実 bridge での通し検証は `scripts/e2e-revert-flow.mjs`（12 項目 PASS）、回帰は `tests/rewind/`（12 件）と `tests/contract/revert.spec.ts`（8 件） |
| 公式 Web UI の同源提供 | 完了。`src/bridge/web-ui.ts` が opencode バイナリから Web UI を `$DSH_HOME/opencode/web-ui/2.1.0/` に展開して自分で伺服する。API ルートに一致しない `GET`/`HEAD` は SPA の shell にフォールバックし、`_assets/` の欠落は 404。公式 2.1.0 クライアントの接続は確認済み、**実ブラウザでの操作確認はしていない**（この環境に実ブラウザがない） |
| CORS ポリシー | 完了。公式 opencode サーバと同じ許可リスト（`http://localhost:<port>`、`http://127.0.0.1:<port>`、`oc://renderer`、tauri の源、`*.opencode.ai`、および `DSH_OC_CORS`）。origin のエコーと `Access-Control-Allow-Credentials: true` 付き。旧実装の `*` は削除（資格情報付きリクエストをブラウザが拒否していた） |
| SSE ハートビート | 完了。15 秒ごとに `: heartbeat\n\n`（公式サーバと同じ）。無いと公式クライアントと OpenChamber の読み手が再接続ループを回す |
| status スナップショットの有界化 | 完了。`SESSION_STATUS_SNAPSHOT_LIMIT = 20`（実行中のセッション + 最近動いた順）。旧実装は bridge が見た全セッションを流していた |
| プロジェクト一覧 | 完了。`GET /api/project` は bridge の作業ディレクトリを返す（公式サーバは配信するディレクトリから導出する） |
| 型検査 / ビルド / テスト | すべて通過（461 passed, 1 skipped / 31 files） |

## 2. 今回行った主要な判断

### 2.1 v1 層を全部消した

`/session`、`/config`、`/provider`、`/global/event`、`/vcs*`、`/permission`、
`/question`、`/path`、`/project/*` を削除し、`@opencode-ai/sdk@1.18.18` 依存も
削除した。`src/bridge/convert/wire.ts` に、1.18.18 形状のイベント投影を
ローカル型として残してある（同梱 TUI が読むため）。

### 2.2 2 つの語彙を同時に流す

1.18.18 形状のイベント（`message.part.updated` 等）と 2.x ネイティブの語彙を
同じ SSE バッチに流す。OpenChamber の reducer は 2.x 語彙しか解釈しないが、
同梱 TUI は 1.18.18 形状を読む。

### 2.3 OpenChamber の reducer が仕様

`/data/dsh-ocplus/openchamber/packages/ui/src/lib/opencode/events.ts` の
`translateWireEvent` が解釈する語彙が、そのまま OpenChamber が必要とする契約。
このファイルを読むと「何が足りないか」が確定する。

### 2.4 TUI 起動は `opencode --server <url>`

2.x CLI は `attach` 子コマンドを削除した（`Help requested` で失敗する）。
`--mini` は `opencode mini --server <url>` の形。`--dir` は dsh-oc 自身が
消費して bridge の cwd を変えるだけで、CLI には渡さない。

### 2.5 公式クライアントのルート差分は自動で検出できる

`scripts/check-client-routes.mjs` が client 側の `path:` 定義を走査して
bridge 側と突き合わせる。client 側の chunk ファイル名にはハッシュが含まれる
ので、パターン数最大のファイルを探す実装にした。

## 3. 検証手順（再現方法）

### 3.1 静的ゲート

```bash
cd /data/dsh-ocplus/dsh-oc
pnpm typecheck
pnpm build
pnpm test                                   # 461 passed, 1 skipped
node scripts/check-client-routes.mjs         # missing: 0
DSH_OC_OPENCODE_BIN=~/.dsh/opencode/packages/linux-x64/node_modules/@opencode/cli-linux-x64/bin/opencode \
  node scripts/probe-opencode.mjs            # PASSED (138/138 routes, 0 issues)
```

### 3.2 実物 E2E

```bash
# 1) dsh の bridge を固定ポートで起動（TUI を skip する overlay を使う）
export PATH="/data/dsh-ocplus/.tools/node_modules/.bin:$PATH"
dsh plugin --profile oc add .               # ローカル実装を profile に link
DSH_OC_PORT=41800 dsh --profile oc --patch /tmp/overlay.yml &

# 2) OpenChamber 2.5.0（公式 npm ビルド）を bridge に向けて起動
#    /data/dsh-ocplus/.tools/oc に @openchamber/web@2.5.0 を入れてある
OPENCODE_HOST=http://127.0.0.1:41800 OPENCODE_SKIP_START=true \
OPENCHAMBER_HOST=127.0.0.1 OPENCHAMBER_UI_PASSWORD=test \
  node /data/dsh-ocplus/.tools/oc/node_modules/@openchamber/web/bin/cli.js \
  serve --foreground --port 39100 --host 127.0.0.1 &

# 3) E2E
node scripts/e2e-openchamber-bootstrap.mjs --bridge http://127.0.0.1:41800
bun   scripts/e2e-openchamber-events.ts   --bridge http://127.0.0.1:41800
node scripts/e2e-revert-flow.mjs         --bridge http://127.0.0.1:41800
```

`scripts/e2e-revert-flow.mjs` は巻き戻し（revert）の一巡を実ブリッジで確かめる。
stage → clear → stage+commit → 次の prompt、まで 12 項目を検証する
（境界は排他、前のメッセージの id は保持、セッション id は変わらない、
2 回目の巻き戻しも効く）。

`/tmp/overlay.yml` の中身:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- id: oc-tui
  disabled: true
```

### 3.3 公式 TUI の接続確認

```bash
grep "event stream" ~/.dsh/opencode/data/opencode/log/opencode.log | tail -3
# "event stream connected" が出ていれば成功
```

### 3.4 公式 TUI の実動（tmux）

```bash
bash scripts/e2e-tui-boot.sh     # 起動 → 描画 → exit 0。PASSED
```

`scripts/e2e-tui-boot.sh` が通ること（＝TUI が起動して描画して異常終了しない
こと）が、公式 TUI の実動確認の基準。Typing した prompt が dsh に届くこと、
ツール呼び出しが実行されて結果カードが描画されることは
`scripts/e2e-tui-permission.sh` の pane 出力（`$ echo ...` → 出力 →
`[Command finished with exit code 0]`）で確認できる。

e2e ハーネスは dsh 0.1.5 の正气から 0.2.1-rc.2 へずれていた。2026-10-20 に
直した点は次のとおり（すべて `tests/e2e/` と `scripts/` の中だけ）:

| 場所 | 症状 | 直し方 |
| --- | --- | --- |
| `tests/e2e/common.sh` | `pnpm` が `tunnel error: Connection refused` で落ちる | 既定の proxy `127.0.0.1:14514` は実際に応答するときだけ使う |
| `tests/e2e/common.sh` | TUI が出現判定に失敗 | dsh の起動は `node .../dsh/lib/bin.js --profile oc` なので、`dsh --profile` ではなく `--profile oc` で照合する |
| `tests/e2e/common.sh` | TUI の入力ボックスが pane に出ない | TUI は alternate screen に描くので、dsh の `--print-logs` を外す（ログが TUI の上に重なる） |
| `tests/e2e/env.mjs` | mock LLM サーバの install が拒否される | 0.1.0-rc.6 は `dsh-invariants@^0.1` を要求するので 0.2.1-rc.2 に上げる |
| `tests/e2e/env.mjs` | `dump-config: missing id agent-presets` | dsh 0.2 は `agent-preset-registry` と `agent-preset` に分かれた |
| `scripts/e2e-tui-boot.sh` | 終了後にプロンプトが見えない | プロンプト判定に powerline 形状（U+E0B0）と `user@host` を加える |

### 3.5 公式 Web UI の確認

bridge は公式 opencode Web UI も同じ源で伺服する。確認手順:

```bash
# 1) 固定ポートで起動する（TUI は overlay で skip してよい）
DSH_OC_PORT=41800 dsh --profile oc --patch /tmp/overlay.yml &

# 2) 起動ログの "web UI served from ... (open http://127.0.0.1:41800/)" を確認
#    出ていなければ opencode バイナリがまだ無い（bridge はバイナリをインストールしない）

# 3) シェル（とブラウザ）で応答を見る
curl -sS http://127.0.0.1:41800/ | head -3                      # SPA の shell
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:41800/_assets/nope.js  # 404
curl -sS http://127.0.0.1:41800/api/info | head -c 120          # API は通常どおり
```

実ブラウザで開くときは `http://127.0.0.1:41800/`（または `DSH_OC_HOST` /
`DSH_OC_PORT` で決めたアドレス）にアクセスする。UI は `location.origin` に対して
API を呼ぶので CORS もログインも要らない。

HTTP の呼び出しパターンをブラウザなしで確かめたいときは `DSH_OC_HTTP_LOG=1` を
付ける。リクエストが到達した時点で stderr に 1 行ずつ出る:

```bash
DSH_OC_HTTP_LOG=1 DSH_OC_PORT=41800 dsh --profile oc --patch /tmp/overlay.yml
# [bridge/http] GET /api/info
# [bridge/http] GET /api/event
```

### 3.6 ストリームの疎通確認

公式 OpenCode 2.1.0 クライアント（Node、ブラウザではない）は bridge の
`/api/event` に購読でき、`server.connected` を約 40 ms で受け取る。bridge 側の
ストリームが正しいことはこれで確認できる。ブラウザ側の確認は 4.2 の制約で
できない。

## 4. 未解決の既知の障害（dsh-oc 側では直せない）

### 4.1 OpenChamber の未認証 401 が text/plain

`packages/web/server/lib/ui-auth/ui-auth.js` の `respondUnauthorized` は
`req.path?.startsWith('/api')` で JSON 判定するが、認証ガードが
`app.use('/api', ...)` としてマウントされているためマウント内では `/api` が
剥がれ、判定が効かない。OpenCode v2 クライアントは内容型を先に見るため
`UnsupportedContentType` になる。

回避: 先に `POST /auth/session` で認証する（`scripts/e2e-openchamber.mjs` は
ページ内から `credentials: 'same-origin'` で叩いて回避している）。

### 4.2 Obscura のブラウザがストリーミング HTTP 応答を `fetch()` に届けられない

**2026-10-20 の再調査で結論が変わった。** 以前ここは「Obscura の V8 エンジンが
OpenChamber 2.5 の React をマウントしない」と書いていたが、その結論は誤りだった。
本当の原因は、Obscura のブラウザが `fetch()` に**ストリーミング HTTP 応答を
届けない**こと。chunked 応答を約束するヘッダが解決しないまま止まる。

確認した範囲:

- OpenChamber 2.5 のアプリも、公式 OpenCode Web アプリも、`/api/event` で止まる。
- 公式 opencode サーバと同じヘッダ（`text/event-stream`、content-length なし）を
  書く素の Node HTTP サーバでも同じ症状になる。完了する応答（`GET /api/info` など）
  は届く。
- 公式 OpenCode 2.1.0 クライアント（Node、ブラウザではない）は bridge の
  `/api/event` に購読して約 40 ms で `server.connected` を受け取る。bridge 側の
  ストリームは正しい。

つまり、ブラウザレベルの E2E（ストリーミングを使う Web UI）は、この環境で使える
Obscura では実施できない。dsh-oc の制約でも OpenChamber 側の制約でもなく、手元の
ツールの制約である。dsh-oc の API 経路
（`scripts/e2e-openchamber-bootstrap.mjs`）とイベント経路
（`scripts/e2e-openchamber-events.ts`）は実測で通っている。

参考: 以前の対照実験（実 OpenCode 2.1.0 サーバーに直接つないだ場合も同じ結果
だった）は次のとおり。

```bash
# OPENCODE_HOST を付けない版: OpenChamber が自分の OpenCode 2.1.0 を起動する
nohup /tmp/start-oc-250-own2.sh > /tmp/oc-250-own3.log 2>&1 &   # port 39300
node scripts/e2e-openchamber.mjs --chamber http://127.0.0.1:39300 \
     --out /tmp/dsh-oc-e2e-control.txt
```

結果は dsh-oc 接続時と完全に同じ:

```
login: 200 {"authenticated":true}
navigated
settled
ui state: {"evaluate":"timeout"}
api calls: 0
console errors: 0
error: page.screenshot: Timeout 30000ms exceeded.
```

実 OpenCode 2.1.0 サーバーでの対照:

```bash
nohup /tmp/start-oc-250-own.sh > /tmp/oc-250-own.log 2>&1 &   # OPENCODE_HOST を付けない版
node scripts/e2e-openchamber.mjs --chamber http://127.0.0.1:39200
# → 同じ "RENDERER-LIMITED"
```

## 5. 残作業

優先度順。

### 5.1 OpenCode 2.1.0 の新規イベント対応（低）

`session.archived` / `session.unarchived` が 2.1.0 で追加された。dsh には
アーカイブの概念がないため、bridge は発していない。OpenChamber 側が
「セッションをアーカイブ」操作を出すようになったら、その時点で必要になる。

### 5.2 巻き戻しのファイル巻き戻し（完了）

`src/rewind/index.ts` の `FileSnapshots` は turn 単位の copy-on-write
スナップショットを持ち、dsh の `session/event`（`turn/start`）で「どの turn が
どのファイルを変えたか」をまとめている。`revert/stage` は境界メッセージが属する
turn より後の turn のファイルについて diff を取り（`filesAfter`、巻き戻す前に
計算するので diff は空にならない）、そのまま巻き戻す（`restoreFilesAfter`）。
境界メッセージが user prompt ならその turn 自身也算入する
（`includeTurn: true`、assistant 返信が prompt より後ろにあるため）、
assistant 返信なら本 turn は巻き戻さない（`includeTurn: false`）。
`revert/commit` は戻した内容をそのまま保持し（`commitRestore`）、`revert/clear`
は元に戻す（`undoRestore`）。回帰は `tests/rewind/rewind.spec.ts`（12 件）と
`tests/contract/revert.spec.ts`（8 件）に固定してある。profile 起動中にファイルを
書き換えてから revert する実機 e2e はまだスクリプト化していないので、必要なら
`scripts/e2e-api.sh` に回帰を追加する。

### 5.3 `session.revert.*` の境界解決と commit（完了）

境界は OpenCode 2.1.0 のサーバと同じく**排他**にした。`revert/stage` で指定した
メッセージ自身とその後のメッセージは commit 時に落ちる。dsh の
`sessionController.fork` は `atSeq` を含む接頭辞をコピーする仕様なので、
`R.atSeqBeforeMessage(ctx, id, messageID)` で切点を境界メッセージの 1 イベント
前にずらす。`POST /api/session/:id/fork` の `before` も同じ切点計算を使う。

commit は `R.commitStagedRevert` が持つ。境界で dsh セッションを fork し、
`InteractionState.setSessionAlias` で **opencode セッション id を fork に紐づけ
直す**。このエイリアスがあるため、

- 以後の dsh 呼び出しは `rpc()` の `resolveSessionPayload` で fork に書き換わる
- セッション一覧は fork を元の opencode id で公開し、置換されたセッションは消える
- `GET /api/session/:id` と `GET /api/session/:id/message` は fork の要約と履歴を
  読む
- fork の SSE イベントは `mapEventSessionId` で元の opencode id に戻される
- モデル・agent preset・タイトル・メッセージ id 映射は `inheritSessionState` で
  fork に引き継がれる（クライアントから見えるメッセージ id は変わらない）

OpenCode と同じく、次の prompt が来た時点で stage 済みの巻き戻しは先に commit
される（`POST /api/session/:id/prompt` が `commitStagedRevert` を呼ぶ）。
検証は `tests/contract/revert.spec.ts`（8 件）にある。

### 5.4 巻き戻しの既知の制限（中）

- dsh は空の fork を表現できない（`atSeq` は非負整数）。第一条メッセージより前を
  切る境界は `400 cannot cut before the first message` になる。
- bridge のファイル diff は首尾の changed 行を覆う 1 個の粗い hunk で、bridge
  自身のファイル変更 diff と同じ形（LCS diff ではない）。
- 2 回目以降の巻き戻しでは、ファイルスナップショットが fork 側の dsh セッション id
  に紐づいたままで、bridge は opencode 側の id で引いているため、巻き戻すファイル
  集合が空になりうる。**2026-10-20 に修正済み**: `RewindServiceImpl.fork` が
  alias を解決してから fork し、bridge も `resolveSessionId` した id でファイル
  一覧を引く。実 bridge で 2 回目の巻き戻しが効くことを
  `scripts/e2e-revert-flow.mjs` が確認している。

### 5.5 ブラウザ E2E（手元のツールでは不可）

ブラウザレベルの E2E（ストリーミングを使う Web UI）は、この環境で使える Obscura
では実施できない。Obscura のブラウザが `fetch()` にストリーミング HTTP 応答を
届けられないため（4.2 節）、`/api/event` で止まる。実ブラウザのある環境か
別の自動化手段不能用を前提に、検証は次で行う。

- API 経路: `scripts/e2e-openchamber-bootstrap.mjs`
- イベント経路: `scripts/e2e-openchamber-events.ts`
- ストリームの疎通: 公式 OpenCode 2.1.0 クライアント（Node）が `/api/event` に
  購読して `server.connected` を受け取る（3.6 節）
- 呼び出しパターンの確認: `DSH_OC_HTTP_LOG=1`（3.5 節）

### 5.6 TUI から復元済みセッションで bash ツールを呼ぶと返らない（未解決・中）

**TUI 自体は実用できる**（3.4 節）。ただし次の組み合わせだけ、ツール呼び出し
が返らない:

- dsh プロセスをまたいで復元されたセッションに、公式 TUI をつないで
- そのセッションで **bash** ツールを呼ぶと、`tool/call` は durable log に
  残るのに `tool/result` が来ない（TUI 側はスピ见过的まま）。

切り分け済み（2026-10-20）:

| 条件 | 結果 |
| --- | --- |
| 復元セッション + TUI + bash | 返らない |
| 復元セッション + API だけ + bash | 動く |
| 復元セッション + TUI + write など bash 以外 | 動く |
| 新規セッション + TUI + bash | 動く |

承認待ちではない（`GET /api/permission/request` は空、ダイアログも出ない）。
dsh の bash ツールが持つ persistent shell の復元経路の疑いが強く、dsh 側の
問題か bridge 側の問題かはまだ切り分けていない。dsh の `dsh-bash-sandbox` と
復元時のセッション状態（シェル参照の復元）が切り分けの入口。

### 5.7 v1 層の痕跡掃除（低）

`docs/FEATURES.md` の自動追跡列と `tests/fixtures/golden/*.1.18.18.sse.jsonl`
の黄金軌跡は v1 形状のまま残してある。黄金軌跡は 1.18.18 形状の回帰基準
として意図的に保持しているので消さない。ただし `docs/FEATURES.md` は
`pnpm run features:update` で再生成してコミットすること。

### 5.8 `/openapi.json`（低）

OpenCode 2.x の `opencode api <op>` サブコマンドはサーバの
`/openapi.json` を読む。bridge は未実装（501）。このサブコマンドは
OpenChamber と TUI のどちらにも要らないので優先度は低い。実装するなら
公式サーバの operationId 体系（`session.list` 形式）を一致させる必要が
あるが、公式サーバは認証behind なので実測で録れない。

## 6. 今回増やした／変えた主要なファイル

### 新規

| ファイル | 役割 |
| --- | --- |
| `src/bridge/routes/v2-stubs.ts` | 公式クライアントが呼ぶ全ルートの schema-valid 空応答 |
| `src/bridge/routes/v2-client-compat.ts` | 2.x 固有の追加ルート（pty、integration、rpc など） |
| `src/bridge/routes/v2-shapes.ts` | 共有の placeholder ビルダー |
| `src/bridge/routes/session-v2-extra.ts` | セッション補助ルート（command/synthetic/shell/move/inbox/form/revert など） |
| `src/bridge/web-ui.ts` | 公式 opencode Web UI の AppArchive 展開と静的ファイル供給 |
| `src/bridge/convert/wire.ts` | 1.18.18 形状のローカル投影型 |
| `src/rewind/index.ts` | 巻き戻しプラグイン（fork + ファイル copy-on-write） |
| `scripts/check-client-routes.mjs` | client ルート表と bridge の突き合わせ |
| `scripts/extract-opencode-web-ui.mjs` | opencode バイナリから Web UI 資産をオフライン展開 |
| `scripts/e2e-openchamber-bootstrap.mjs` | OpenChamber 起動時 22 呼び出しの E2E |
| `scripts/e2e-openchamber-events.ts` | OpenChamber 自身の reducer にイベントを通す E2E |
| `scripts/e2e-revert-flow.mjs` | 巻き戻し（stage / clear / commit / 次の prompt）の通し E2E |
| `scripts/e2e-openchamber.mjs` | ブラウザ E2E（Obscura 経由） |
| `tests/contract/` | 契約テスト（client / events / routes） |
| `tests/e2e/` | E2E テスト（openchamber / events） |
| `tests/rewind/` | 巻き戻しテスト |
| `tests/contract/revert.spec.ts` | 巻き戻しの契約テスト（排他な境界・3 イベント・セッション id の維持） |
| `docs/COMPAT.md` | 互換性マトリクスと更新手順（**更新的手顺在这里**） |
| `docs/OPENCHAMBER.md` | OpenChamber 2.5 接続と検証手順 |
| `docs/ACCEPTANCE.md` | 完了条件 |

### 削除

| ファイル | 理由 |
| --- | --- |
| `src/bridge/routes/session-v1.ts` | v1 セッションルート全廃 |
| `src/bridge/routes/permission.ts` | 登録が v1 のみ |
| `src/bridge/routes/vcs.ts` | 登録が v1 のみ |
| `opencode-assets.json` | 2.x は npm プラットフォームパッケージから取得 |

### 変更

- `package.json`: `@opencode/client` 2.1.0、`@opencode-ai/sdk` 削除、`engines.dsh`
  追加、`e2e:openchamber` / `e2e:openchamber-events` / `check:client-routes` スクリプト追加
- `cordis.patch.yml`: `agent-preset-registry` + `agent-preset` へ、controller 群と
  `workspace-changes` を追加、`mcp-client` は 0.2.1 API 不一致で一時無効、
  `oc-rewind` を追加
- `src/tui/index.ts`: `opencode --server <url>` 起動へ、`--mini` は `mini`
  サブコマンドへ、`--dir` は消費して転送しない
- `src/bridge/router.ts`: `server.connected` を開流で発行、`/api/permission/saved/:id`
  の PATCH を追加、`webUiDir` オプションと `serveWebUi`、status スナップショットの
  上限（`SESSION_STATUS_SNAPSHOT_LIMIT`）、`projectInfo`
- `src/bridge/http.ts`: 公式サーバと同じ CORS ポリシー（origin のエコー + credentials）、
  未一致ルートの Web UI への回落、`DSH_OC_HTTP_LOG=1` のリクエストトレース
- `src/bridge/sse.ts`: 15 秒ごとの `: heartbeat\n\n` コメントフレーム
- `src/bridge/index.ts`: `resolveWebUi()`（`DSH_OC_WEB_UI` → 展開ディレクトリ）、
  `DSH_OC_CORS` の読み取り
- `src/bridge/routes/v2-stubs.ts`: `GET /api/project`、`GET`/`PATCH /api/project/:projectID`
- `src/bridge/events.ts` / `events-util.ts`: 2.x 語彙のイベントを追加、durable
  エンベロープを付与
- `src/bridge/state.ts`: revert 境界、保存済み権限の更新
- `.github/workflows/{ci,e2e}.yml`: 偽バイナリ 2.1.0、公式バイナリは npm
  プラットフォームパッケージから取得

## 7. 環境メモ

- dsh 本体は `/data/dsh-ocplus/.tools` に `@deepseek-ai/dsh@0.2.1-rc.2` を
  入れてある。`PATH` に入れて使う。
- 公式 opencode バイナリは `~/.dsh/opencode/packages/linux-x64/node_modules/@opencode/cli-linux-x64/bin/opencode`（2.1.0）。
  PATH 上の `~/.opencode/bin/opencode` は 2.0.32 のままで、resolver はバージョンが
  合わないので npm パッケージ側を拾う。
- OpenChamber 2.5.0 の公式 npm ビルドは `/data/dsh-ocplus/.tools/oc`。
- 作業ディレクトリは `/data/dsh-ocplus`（`/` ではなく NVMe 側）。
- dsh の profile は `~/.dsh/profiles/oc`。`dsh plugin --profile oc add .` で
  ローカル実装を link する。

## 8. 引き継ぎ時の注意

1. `lib/` はコミットに含めること（GitHub 直装が `lib/` を使う）。変更したら
   `pnpm build` して `lib/` を一并にコミット。
2. `AGENTS.md` の自测门槛に `pnpm run probe` がある。プローブの基準
   `tests/fixtures/opencode/routes.json` は client から再録する。
3. 公式 TUI は vendor ABI として扱う。バージョン更新は
   `docs/COMPAT.md` の手順で、「黄金 HTTP/SSE 軌跡 + 実 TUI 回放」の意味差分
   を確認してからロックする。
4. `docs/FEATURES.md` は自動追跡。`pnpm run features:update` 後にコミット。
5. OpenChamber の API 変更を追うときは
   `packages/ui/src/lib/opencode/client.ts`（呼び出し面）と
   `packages/ui/src/lib/opencode/events.ts`（reducer が読む語彙）の 2 ファイル。
6. 公式 Web UI は opencode バイナリに同梱されている資産で、bridge はバイナリを
   インストールしない（`resolveWebUi()` は `installNpmPackage: false` で解決する）。
   展開先は `$DSH_HOME/opencode/web-ui/<バージョン>/` なので、opencode のバージョンを
   上げると展開先のディレクトリも変わる。Web UI の実動確認は実ブラウザのある環境で
   行うこと（4.2 節）。
