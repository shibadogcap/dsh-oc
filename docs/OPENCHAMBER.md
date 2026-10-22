# OpenChamber 2.5 互換性

## 接続

dsh-oc のブリッジは OpenCode v2 API（`/api/*`）を提供する。OpenChamber 2.5 は
`GET /api/info` の version が `2.0.20` 以上であれば接続を受け付ける。

```
# 1. ブリッジを起動する
dsh --profile oc

# 2. ブリッジのURLを確認する（起動ログの "bridge listening on ..."）
#    DSH_OC_PORT でポートを固定できる
DSH_OC_PORT=41800 dsh --profile oc

# 3. OpenChamber を外部ホスト接続モードで起動する
OPENCODE_HOST=http://127.0.0.1:41800 OPENCODE_SKIP_START=true openchamber
```

`DSH_OC_HOST` はバインド先、`DSH_OC_PORT` は待受ポートを変える。既定は
`127.0.0.1` とランダムポート。

公式 OpenCode の Web UI も bridge と同じ源で提供される。ブラウザで
`http://127.0.0.1:<port>/` を開くと公式 UI が立ち上がり、UI は
`location.origin` に対して API を呼ぶので CORS もログインも要らない。UI の
ファイルは opencode バイナリから `$DSH_HOME/opencode/web-ui/<version>/` に
展開される（`DSH_OC_WEB_UI` で別のディレクトリを指定できる）。

## 検証

### 起動時に UI が呼ぶルート

`packages/ui/src/sync/bootstrap.ts` が起動時に呼ぶ次のルートは、すべて
dsh-oc が応答する。

| 呼び出し | ルート | dsh-oc の応答 |
| --- | --- | --- |
| `server.info` | `GET /api/info` | version 2.1.0 |
| `location.get` | `GET /api/location` | directory と project |
| `project.list` | `GET /api/project` | bridge の作業ディレクトリ（`Project`） |
| `config.get` | `GET /api/config` | 空の設定 |
| `model.list` | `GET /api/model` | dsh のモデルカタログ |
| `provider.list` | `GET /api/provider` | dsh のプロバイダ |
| `agent.list` | `GET /api/agent` | dsh の agent preset |
| `session.list` | `GET /api/session` | dsh のセッション一覧 |
| `session.active` | `GET /api/session/active` | 実行中セッション |
| `permission.request.list` | `GET /api/permission/request` | 承認待ち |
| `form.list` | `GET /api/form` | 質問待ち |
| `vcs.get` | `GET /api/vcs` | 作業ツリーの状態 |
| `shell.list` | `GET /api/shell` | バックグラウンドシェル |
| `command.list` | `GET /api/command` | スラッシュコマンド |
| `skill.list` | `GET /api/skill` | dsh のスキル |
| イベント | `GET /api/event` | SSE ストリーム |

### 送信時のフロー

| 呼び出し | ルート | 備考 |
| --- | --- | --- |
| `session.create` | `POST /api/session` | `agent` を指定できる |
| `session.prompt` | `POST /api/session/:id/prompt` | v2 の本文は `{ id?, text, files?, agents?, skills? }` |
| `message.list` | `GET /api/session/:id/message` | `{ data, cursor }` |
| `session.get` | `GET /api/session/:id` | `{ data }` |
| `session.interrupt` | `POST /api/session/:id/interrupt` | `{ interrupted }` |

### 巻き戻し（revert）

OpenChamber の巻き戻し UI は 3 つのルートを呼ぶ。dsh-oc はいずれも実装済みで、
境界は OpenCode 2.1.0 と同じく排他（指定したメッセージ自身とその後のメッセージは
commit 時に落ちる）。

| 呼び出し | ルート | dsh-oc の応答 |
| --- | --- | --- |
| `session.revert.stage` | `POST /api/session/:id/revert/stage` | `{ data: { messageID, files? } }`。`files` は巻き戻すファイル（境界の後のターンが変えたもの）の diff |
| `session.revert.clear` | `DELETE /api/session/:id/revert` | 204。stage で巻き戻したファイルは元に戻す |
| `session.revert.commit` | `POST /api/session/:id/revert/commit` | 204。境界メッセージより前のメッセージだけが新しい会話に残る |

ファイルは stage の時点で既に巻き戻される。diff は巻き戻す前に計算するので空に
ならず、clear で元に戻せる（commit は巻き戻した内容を保持する）。

commit は dsh のセッションを fork して、**opencode のセッション id はそのまま**
（fork を指すエイリアスが付く）。そのためセッション一覧・履歴・SSE はすべて元の
id のまま参照できる（一覧は fork を元の id で公開し、置換されたセッションは消える）。
OpenCode と同じく、次のプロンプトを送ると stage 済みの巻き戻しは先に commit され、
そのプロンプトは fork 側のセッションに落ちる。

UI は `session.revert.staged` / `session.revert.cleared` /
`session.revert.committed` の 3 イベントで状態を更新する。この 3 つは dsh 側の
対応物を持たないため、revert ルートが直接発行する。SSE の 1.18.18 用の
`payload.*` ラッパも同じ `data` を入れて同時に流れる。

OpenChamber の reducer は `session.revert.staged` / `session.revert.cleared` を
`session.patched`（`patch.revert`）に写し、`session.revert.committed` はそのまま
sync イベントとして残す。UI は 3 つすべてを使うので、3 つとも出しつづけること。

### 検証コマンド

```
# 公式クライアントが呼べる 137 ルートをすべて登録できているか
pnpm run check:client-routes

# 起動時の呼び出しと送信フローを実ブリッジで流す
pnpm run e2e:openchamber -- --bridge http://127.0.0.1:41800

# OpenChamber 自身の reducer にブリッジのイベントを通す
pnpm run e2e:openchamber-events -- --bridge http://127.0.0.1:41800

# ブラウザで UI まで含めて確認する（Obscura 経由）
node scripts/e2e-openchamber.mjs --bridge http://127.0.0.1:41800 \
     --chamber http://127.0.0.1:3000 --password <ui-password>
```

ブラウザ E2E は `/api/event` のストリームで止まる（下の「既知の障害」を参照）。
検証は API 経路と reducer 経路の 2 本で行う。

`tests/contract/client.spec.ts` は `@opencode/client` 2.1.0 を実ブリッジに
当てて契約どおりに answered されるかを確認する。`tests/contract/routes.spec.ts`
は公式クライアントの 137 ルートとブリッジの登録済みルートを比較し、差分があると
失敗する。`tests/contract/events.spec.ts` は dsh のイベントが v2 の語彙に
変換されることを確認する。

## イベントの語彙

ブリッジは 1.18.18 用のイベント名と 2.x 用のイベント名の両方を流す。1.18.18
用のイベント名は同梱の TUI が読むため残しており、2.x 用のイベント名は
OpenChamber の reducer が読む。対応表は `docs/PROTOCOL.md` の 5.1 節にある。

SSE のフレームは 2.x の封筒（`id`、`created`、`type`、`durable`、`location`、
`data`）で Pune され、1.18.18 用のラッパ（`payload.*`）も同時に含まれる。

## 既知の障害

- 認証ガードが `app.use('/api', ...)` としてマウントされているため、未認証の
  `/api/*` 応答の `Content-Type` が `text/plain` になる。OpenCode v2 クライアントは
  応答の内容型を先に確認するため、`UnsupportedContentType` として見える。
  先に `POST /auth/session` で認証すると `/api/*` は `application/json` を返す。
- Obscura のブラウザは `fetch()` にストリーミング HTTP 応答を届けられない。chunked
  応答を約束するヘッダが解決しないまま止まる。OpenChamber 2.5 と公式 OpenCode
  Web アプリはいずれも `/api/event` で止まる。公式 opencode サーバと同じヘッダ
  （`text/event-stream`、content-length なし）を書く素の Node HTTP サーバでも同じ
  症状になり、完了する応答（`GET /api/info` など）は届く。
  公式 OpenCode 2.1.0 クライアント（Node、ブラウザではない）は bridge の
  `/api/event` に購読して約 40 ms で `server.connected` を受け取るので、bridge
  側のストリームは正しい。
  つまり、ブラウザレベルの E2E（ストリーミングを使う Web UI）は、この環境で使える
  Obscura では実施できない。dsh-oc の制約でも OpenChamber 側の制約でもなく、手元の
  ツールの制約である。

