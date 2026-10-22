*[English](README.md) · 日本語 · [中文](README.zh.md)*

# dsh-oc

DeepSeek Harness（dsh）の OpenCode TUI フロントエンドです。公式の OpenCode ターミナルインターフェースを使い、Agent、セッション、ツール、モデル、権限、質問の機能は dsh が提供します。

[![CI](https://github.com/shibadogcap/dsh-oc/actions/workflows/ci.yml/badge.svg)](https://github.com/shibadogcap/dsh-oc/actions/workflows/ci.yml)
[![e2e](https://github.com/shibadogcap/dsh-oc/actions/workflows/e2e.yml/badge.svg)](https://github.com/shibadogcap/dsh-oc/actions/workflows/e2e.yml)

## 動作の仕組み

- **インターフェース**: 公式の `opencode --server` TUI です。ターミナル描画、キーボード操作、ライフサイクルだけを担当します。
- **バックエンド**: Agent、セッション、ツール、モデル、権限、ユーザーへの質問は dsh が担当します。
- **ブリッジ**: dsh-oc は dsh プロセス内で OpenCode 互換の HTTP/SSE ブリッジを提供し、公式 TUI を起動します。

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (--server)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

現在の互換ベースラインは dsh `0.2.1-rc.2`、公式 opencode `2.1.0` です。このフォークは
`feat-opencode-2-1` ブランチを追従しており、dsh 0.2.1 と OpenCode 2.1.0 への対応はここに
あります。上流の `main` は今も `v0.2.0-rc.4` の prerelease を指しています。パッケージ名は
上流の `@chiro2001/dsh-oc` のままで、npm registry には未公開のため、インストールと更新は
GitHub ソース経由で行います。

## インストールと起動

### フォークからインストールする

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'
dsh --profile oc
```

ここでの profile 名は `oc` であり、`dsh-oc` ではありません。同じソースから更新するときは、上のインストールコマンドをもう一度実行します。

### commit の固定と開発ライン

ブランチは動く参照なので、再現性が要るときは完全な commit SHA を固定します。

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#<full-sha>'
```

ブランチに戻すときは、上の節のインストールコマンドを再実行します。npm パッケージ名は `@chiro2001/dsh-oc` ですが、現在 npm registry には公開されていません。

ローカル開発では `dsh plugin --profile oc add .` で作業ツリーをリンクできます。TypeScript を変更したあと `pnpm build` を実行すると、profile は新しいビルドを使います。

インストール後は `dsh-oc` の短縮コマンドも使えます。profile の bin ディレクトリを PATH に追加します。

```bash
export PATH="$HOME/.dsh/profiles/oc/node_modules/.bin:$PATH"
dsh-oc                        # dsh --profile oc と同じ
dsh-oc --mini                 # dsh --profile oc --mini と同じ
dsh-oc --version              # dsh-oc と dsh のバージョンを両方出力します
```

pnpm が `@deepseek-ai/cordis` などの peer 不足を警告しますが、これは想定どおりです。これらの依存は dsh ホストが実行時に提供します。

## 5分でわかる使い方

起動後は普通のタスクをそのまま入力できます。たとえば「OK とだけ返信」などです。よく使う制御コマンドは次のとおりです。

| 入力 | 動作 |
|---|---|
| `!` のあとに shell コマンドを入力 | 完全な OpenCode TUI で、ユーザーが指定した shell コマンドを実行します |
| `/preset` | 利用できる dsh agent preset を一覧します |
| `/preset minimal` | `minimal` preset に切り替えます。モデルのターンは発生しません |
| `/goal <目標>` | goal を作成または表示します。状態はサイドバーに同期されます |
| `/help` | TUI に機能の概要を表示します |

### `!` shell モード

完全な TUI の入力欄で `!` を入力し、続けて `printf DSH_OC_SHELL_OK` などを入力して Enter を押します。コマンドは dsh-oc 経由で、現在の OS ユーザーとして正確な shell 子プロセスを起動します（POSIX では絶対パスの `$SHELL -c` のみを使い、なければ `/bin/sh` にフォールバックします。Windows では `ComSpec` を使い、存在しない場合は `cmd.exe` にフォールバックします）。`!` 自体がユーザーの認可境界であり、dsh のモデルツール、approval、sandbox waterfall は経由しません。TUI は shell ツールカード、出力、終了結果を表示しますが、モデルの返信は発生しません。コマンドが終わると、明確に「ユーザーが手動で実行」と示した非ウェイク context として次の実際の prompt に注入され、モデルはコマンドと出力を参照できます。注入自体は新しい turn を開始せず、セッションが破棄されたときに遅れて注入されることもありません。
stdout/stderr はそれぞれ最大 1 MiB まで保持します。超えた場合も子プロセスの drain は続けますが、カードに切り詰めマーカーを追加し、出力がしきい値を超えたことを理由にコマンドを kill しません。モデルに送る context には独立した予算があり、コマンドは最大 16 KiB、stdout/stderr はそれぞれ最大 64 KiB、全文は最大約 144 KiB で、明確な切り詰めマーカーが付きます。
コマンドと出力は現在設定されているモデルに送信されるため、token、パスワード、個人データが含まれる可能性があります。`!` を使う前に、機密情報が漏れないことを確認してください。

`--dir <path>` は bridge cwd を設定します。記録済みの session cwd が優先され、この値はコールドスタート時の shell cwd fallback としてのみ使われます。shell カードは bridge の短命な投影であり、dsh agent-loop のイベントを偽装しません。完了した出力は、現在の bridge のライフサイクル内であれば履歴から再読み込みできます。

### `/preset`

空のセッションで `/preset <name>` を実行するか Tab で agent を選ぶと、現在のセッションとその後作成するセッションがその preset を使います。`/preset` の結果カードはコマンド完了と同時に終わるため、`QUEUED` 状態を消すために追加のメッセージを送る必要はありません。

セッションが返信を生成したあと、dsh は agent preset をロックします。この状態で切り替えると `Agent switch locked` が一度表示されるので、新しいセッションを作成してから切り替えてください。

## ブラウザからのアクセス（公式 Web UI）

bridge は API に加えて公式 OpenCode の Web UI も同じオリジンで配信するため、ブラウザで bridge のアドレスを直接開くだけで使えます。

```bash
dsh --profile oc
```

起動ログの `bridge listening on http://127.0.0.1:<port>` がブラウザで開くアドレスです。公式 Web UI は `location.origin` 経由で API にアクセスするため、同一オリジンであれば CORS もログインも不要です。

Web UI のファイルは opencode バイナリに埋め込まれたリソースです。bridge は初回実行時にそれを `$DSH_HOME/opencode/web-ui/<バージョン>/`（現在は `2.1.0`）へ展開します。bridge は opencode バイナリを探すだけで、インストールは行いません。TUI プラグインはもともとこのバイナリを必要とするため、Web UI は次回起動から現れます。バイナリが見つからない場合は Web UI がないだけで、API には影響しません。

注意点として、dsh-oc の検証環境には実ブラウザがないため、Web UI の画面操作はここでは実測していません。UI アセットを配信できること、公式 OpenCode 2.1.0 クライアントが bridge のイベントストリームを購読できること、この 2 点は確認済みです。

### 関連する環境変数

| 変数 | 動作 |
|---|---|
| `DSH_OC_HOST` | bridge のバインドアドレスです。既定は `127.0.0.1` です |
| `DSH_OC_PORT` | bridge の待ち受けポートです。既定はランダムポートです |
| `DSH_OC_CORS` | クロスオリジンアクセスを許可する origin の一覧（カンマ区切り）です。LAN 上のブラウザ UI で使います。既定では `localhost`、`127.0.0.1`、`oc://renderer`、tauri の origin、`*.opencode.ai` を許可しています |
| `DSH_OC_WEB_UI` | 公式 Web UI のディレクトリを指定します（展開済みで `index.html` を含むディレクトリが必要です）。指定しない場合は `$DSH_HOME/opencode/web-ui/<バージョン>/` を使います |
| `DSH_OC_HTTP_LOG` | `1` にすると、すべての HTTP リクエストを stderr に出力します（`[bridge/http] GET /api/info`）。ブラウザがないときに UI の呼び出しパターンを確認するために使います |

## 機能の状態

> 完全なマトリクスは [docs/FEATURES.ja.md](docs/FEATURES.md)、プロトコルの詳細は
> [docs/PROTOCOL.ja.md](docs/PROTOCOL.ja.md) を参照してください。`dsh --profile oc --help`
> はオフラインの機能概要を表示します。

| 機能 | 状態 |
|---|---|
| セッションの一覧/新規作成/継続/fork/compact、SSE ストリーミングメッセージ | ✅ |
| 公式 OpenCode Web UI（API と同一オリジン。ブラウザで bridge のアドレスを直接開きます） | ✅ |
| セッションの revert（回退）: stage/clear/commit、ターン単位のファイルロールバック、セッション id は不変、次の prompt で自動コミット | ✅ |
| セッションタイトル、履歴の復元、ディレクトリによる絞り込み | ✅ |
| モデルカタログ、reasoning effort、agent preset の切り替え | ✅ |
| `!` shell モード（ユーザーが認可した OS shell、固定の bash ツールカード） | ✅ |
| ツールカード（bash/read/write/edit）、引数のストリーミング、diff と Modified Files | ✅ |
| 権限/質問のフロー、サブエージェントのセッションツリーとバックグラウンドサブエージェント | ✅ |
| Goal の作成/表示/一時停止/再開/完了 | ✅ |
| テキスト/画像の添付 | ✅（PDF などのバイナリは未対応） |
| `Allow always` 権限 | 🟡（現在のセッションのメモリ内だけ記憶します） |
| dsh の profile で設定した MCP サーバー（ツールは `mcp__<server>__<tool>`） | ✅ |
| LSP / formatter / integration / reference などの周辺ルート | ❌（schema-valid stub） |

## MCP サーバー

MCP サーバーは dsh のプラグインであり、ブリッジの状態ではありません。ブリッジは
そのツールをそのまま通し、ツールが登録されたサーバーを一覧に出します。dsh は
これを接続中の印として扱います。クライアントを一度入れ、サーバーごとに 1 エントリを
profile の `cordis.patch.yml` に追加します。

```bash
dsh plugin --profile oc add @deepseek-ai/dsh-mcp-client@0.2.1-rc.2
```

```yaml
- insert:
    - id: mcp-github
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
```

リモートのサーバーでは `command`/`args`/`env` の代わりに
`transport: streamable-http` と `url`、`headers` を書きます。dsh を再起動すると、
サーバーのツールはモデルから `mcp__<serverName>__<tool>` として見え、TUI では
通常のツールカードとして表示されます。MCP パネルには接続中のサーバーが並びます。
実行中の追加・削除・切り替えは 400 を返します。設定は profile が持つためです。

## デモ

<img src="docs/demo/dsh-oc-demo.gif" alt="dsh-oc の主要機能のデモ（実際の DeepSeek モデル）" width="900">

実際の録画です。ブランドの起動画面 → 実際のモデルが `pnpm test` を実行 → すべての単体テストが成功 → 終了メッセージ、という流れです。再現するには、上の節のとおりフォークからインストールして `dsh --profile oc` を実行します。

## 起動引数

公式 opencode TUI にそのまま渡せる引数をサポートします（dsh-oc は `opencode --server <bridge-url>` として TUI を起動し、`--mini` は `opencode mini --server <bridge-url>` を使います）。

- `--continue` / `-c`、`--session` / `-s`、`--fork`、`--dir`、`--mini`、
  `--print-logs`、`--log-level`

実行例は次のとおりです。

```bash
dsh --profile oc --session <session-id>
dsh --profile oc --dir ~/project --mini
```

その他の引数は `ignored unsupported arg` 警告を明示的に出力するため、通知せずに破棄されることはありません。

## データ、セキュリティ、制限

- OpenCode の設定、データ、状態、キャッシュは `$DSH_HOME/opencode` に分離されています。モデルと資格情報は dsh バックエンドが管理し、dsh-oc は OpenCode に provider/key を注入しません。
- 公式 Web UI と API は同じポートを共有します。bridge は既定で `127.0.0.1` にのみバインドするため、Web UI もローカルマシンからしかアクセスできません。`DSH_OC_HOST` や `DSH_OC_CORS` を変更してサービスを LAN に公開する前に、この露出面をよく検討してください。
- 公式バイナリは `2.1.0` に固定されています。自動更新、リモートのモデルカタログ取得、LSP のダウンロードはすべて無効です。
- shell モードはユーザーが明示的に `!` を入力して認可するもので、現在の OS ユーザーの権限と session cwd を継承します。dsh の approval/sandbox による保護は主張しません。キャンセルは現在の bridge/session が登録した正確な子プロセス/プロセスグループだけを対象とし、プロセス名で他のプロセスを終了させることはありません。POSIX では独自の process group を、Windows では独自の PID に対する `taskkill /T` のツリーを使います。Windows では `ComSpec` を使うため（dsh の pwsh sandbox ではありません）、このプラットフォーム差は Windows ホストで別途受け入れる必要があります。
- shell の経路は子プロセス終了後に保持済みの stdout/stderr を公開するだけで、リアルタイムの出力ストリームは提供しません。各ストリームは最大 1 MiB まで保持し、超えた分は drain を続けながら切り詰めマーカーを追加します。shell 専用カードは bridge のメモリ内投影です。また、次の prompt 用に dsh の `agent/inbox/spliced` pending context が 1 本あり、claim 後に compaction が起きても逐語的に長期保持されることは保証されません。
- `Allow always` は現在のセッション内だけで記憶し、再起動すると消えます。
- 公式の終了 splash は置き換えられません。dsh-oc はその下に dsh の復元手順を 1 行追加し、`DSH_OC_DISABLE_EXIT_NOTE=1` で無効にできます。
- `--mini` は TUI branding プラグインを読み込まないため、入口には公式 OpenCode のアスキーアートが残ることがあります。dsh-oc は起動前に DSH OC のブランドを表示します。
- ストリーミング中のターンでは、完全な TUI も `--mini` も Esc を 2 回続けて押して中断します。dsh-oc はそれを `session.cancel` に変換します。
- ツールのターンがビジー状態のときは 2 通目のメッセージがキューに入り、公式 TUI の即時トランスクリプトでは順序が一時的にずれることがあります。内容は失われず重複もしません。セッションに入り直すと順序は正しくなります。
- LSP/formatter/integration/reference などの周辺ルートは現在 schema-valid stub のみを提供し、結果を偽装しません。
- セッション revert（回退）の境界は排他的です。指定したメッセージとそれ以降のメッセージはコミット時にまとめて破棄され、セッション id は変わりません（コミット後、会話は dsh の fork 上に移ります）。dsh は空の fork を表現できないため、切れ目が最初のメッセージより前にある場合は 400 を返します。ファイル diff は最初と最後の変更行の間の粗い hunk 1 つであり、完全な LCS diff ではありません。

## トラブルシューティング: profile の分離と dsh-tui

`dsh-oc` は `dsh --profile oc` の dsh プロセスでのみ読み込まれます。bridge、OpenCode の設定、互換 shim はいずれもそのプロセスのローカル状態であり、プロセスをまたいで他の profile を変更しません。dsh-tui を直すために dsh-oc を dsh-tui の profile にインストールしないでください。

dsh-tui のランチャーは現在 `dsh --profile dsh-tui` に固定されており、総称の `tui` ではありません。両方は同時に存在できます。実際の構成ツリーを読み取り専用で確認するには次のようにします。

```bash
dsh --profile oc --dump-config
dsh --profile tui --dump-config
dsh --profile dsh-tui --dump-config
```

profile 名を明示的に `tui` にしたい場合は、dsh-tui バンドルをインストールしてその profile を直接使えます（以下は提案コマンドであり、今回はユーザーの profile に対して実行していません）。

```bash
dsh plugin --profile tui add '@deepseek-harness-tui/dsh-tui@0.10.0-beta.5'
dsh --profile tui
```

このインストール経路では旧版の dsh-dcp を追加しないでください。グローバルの `dsh-tui` コマンドは引き続き `dsh-tui` profile を探し、`tui` には自動で切り替わりません。

dsh-tui が `turn error · events is not iterable` を表示する場合は、まず dsh-dcp のバージョンと peer ABI を確認してください。旧版の dsh-dcp は dsh 0.1.2 で削除された `session.events` をまだ読み、新しいインターフェースは `session.snapshotEvents()` です。これは dsh-oc と dsh-tui の衝突ではありません。現在の dsh ABI に一致する dsh-dcp へ更新するか、dsh-tui 自身の profile patch / 診断 overlay 内でのみ `dcp` を一時的に無効にし（`- id: dcp` / `disabled: true`）、dsh-dcp/dsh-tui の上流に報告してください。

## 更新と開発

安定版、リリース候補、完全なリリースゲートは [docs/RELEASE.ja.md](docs/RELEASE.ja.md)、変更履歴は [docs/CHANGELOG.ja.md](docs/CHANGELOG.ja.md) を参照してください。開発環境、ブランチ戦略、セルフテストのゲートは [AGENTS.md](AGENTS.ja.md) と [CONTRIBUTING.md](CONTRIBUTING.ja.md) を参照してください。手動リグレッションの手順は [docs/MANUAL-TEST.ja.md](docs/MANUAL-TEST.ja.md)、次段階の計画は [docs/ROADMAP.ja.md](docs/ROADMAP.md) を参照してください。

簡単なセルフテストは次のとおりです。

```bash
pnpm run e2e:api   # 高速な API リグレッション
pnpm run e2e       # 完全な e2e（実際の opencode TUI）
```

## 謝辞

このフォークは他のプロジェクトの成果の上に成り立っています。

- [dsh-oc](https://github.com/shibadogcap/dsh-oc)：このフォークが追従する上流
  プロジェクト。ブリッジの設計、プロトコルの網羅範囲、テスト群の土台はここに
  あります。
- [OpenCode](https://github.com/sst/opencode)：組み込み、そして互換を実装して
  いるターミナル UI、Web UI、クライアントプロトコル。dsh-oc は公式バイナリを
  変更せずに使います。
- DeepSeek Harness（dsh）：ブリッジの背後にあるエージェントループ、セッション、
  ツール、モデル、承認、質問。
- OpenChamber：ブリッジの検証に使っている互換スイート。
- MCP のサーバーとクライアントの実装者。ブリッジはそのプロトコルをそのまま
  通します。
