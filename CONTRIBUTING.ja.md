*[English](CONTRIBUTING.md) · 日本語 · [中文](CONTRIBUTING.zh.md)*

# dsh-oc の開発に参加する

> AI Agent がリポジトリを引き継ぐ場合は、まず [AGENTS.ja.md](AGENTS.ja.md) を読んでください（構成、コマンド、セルフテストゲート、注意点をまとめています）。本ドキュメントは人間のコントリビューター向けです。

dsh-oc は DeepSeek Harness × OpenCode TUI のフロントエンドです。バックエンドのロジックはすべて dsh が担当し、公式 opencode TUI は描画とキーボードだけを担当します。dsh-oc は dsh プロセス内で OpenCode 互換の HTTP/SSE ブリッジを提供します。リポジトリは `shibadogcap/dsh-oc`、npm パッケージ名は `@chiro2001/dsh-oc` です（registry には公開していないため、インストールと更新は GitHub ソース経由で行います）。

## 開発環境

必要なものは Node.js 22+ と pnpm 11.x です。

```bash
pnpm install
pnpm build          # lib/ を生成する（コミットと一緒に push が必須。GitHub からの直接インストールは、lib/ があるときだけ新しいロジックを含む）
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest の単体テスト
pnpm run probe      # opencode 1.18.18 のプロトコルルートプローブ
pnpm run perf       # セッション性能の負荷テスト（一時 DSH_HOME + mock）
pnpm run features:update   # docs/FEATURES.md の自動追跡部分を更新する
```

セルフテストの一括入口は次のとおりです。

```bash
bash scripts/check-all.sh              # typecheck + 単体テスト + プローブ + 性能スモーク
bash scripts/check-all.sh --e2e        # 全量 e2e も実行する（実 opencode TUI を含む）
bash scripts/check-all.sh --scale 5000 # 5000 セッションの負荷テストも実行する
```

dsh profile へローカルで直接接続する手順は次のとおりです（リアルタイム検証向けです。`pnpm build` の直後から有効になります）。

```bash
dsh plugin --profile oc add .
```

GitHub のブランチからインストールする手順は次のとおりです（リモートのビルド成果物を検証します）。

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#<branch>'
```

## ブランチ戦略

- `main`：安定版のリリースラインです。README のインストール／更新コマンドは既定で `#main` を指します。
- `develop`：統合と配布のラインです。日常の開発とユーザーによるリアルタイム検証はどちらもこのラインで行います。機能が安定したら `main` へマージします。
- 機能ブランチ：`develop` から切り、短い寿命で運用し、PR は `develop` へ戻します。名前は `feat-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `chore-*` に統一します（小文字の kebab-case）。
- 過去に残っている `feat-*` ブランチはすべて `main` にマージ済みで、削除してよいブランチです。`scripts/cleanup-merged-branches.sh` で一覧表示と削除ができます（既定は dry-run）。

e2e スクリプトは `main` / `develop` と `chore-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `feat-*` でのみ実行できます（CI のトリガーブランチと一致させています）。一時的なブランチで無効な結果が出るのを防ぐためです。

## コミット規約

- Conventional Commits を使います。種類は `feat` / `fix` / `docs` / `perf` / `test` / `chore` / `refactor` です。
- `lib/` はビルド成果物ですが、ソースと一緒にコミットする必要があります。コミットを忘れると、GitHub からの直接インストールが古いロジックで動きます。
- コミットの前に、マシン固有の絶対パスを確認します。`rg -n --hidden -g '!node_modules' -g '!.git' 'chiro' . | rg -v 'chiro2001|/home/chiro/'`
- 機能一覧に関わる場合は `pnpm run features:update` を実行し、結果も一緒にコミットします。

## セルフテストゲート（PR の前に必須）

1. `pnpm typecheck && pnpm test` がすべて成功します。
2. `pnpm run probe` が 63/63 で通過します。
3. プロトコルやブリッジの変更では、対応する `scripts/e2e-api*.sh` を少なくとも実行します。
4. TUI の変更では、関連する `scripts/e2e-tui-*.sh`（boot/turn/mini/brand/continue など）を実行します。完全な回帰には `bash scripts/check-all.sh --e2e` を使います。
5. ビルド成果物やリリースの変更では、`bash scripts/verify-release-artifacts.sh` を実行します（lib の差分がゼロ、pack に絶対パスと src の漏れがないこと）。リリース候補の演習は `docs/RELEASE.md` を参照してください。
6. PR の説明にテストコマンドと結果の要約を添えます。

## 提出フロー

1. `develop` から短命のブランチを切ります。
2. 実装し、単体テスト／e2e を追加して、上記のゲートに沿ってセルフテストします。
3. `pnpm run features:update` を実行し（機能に関わる場合）、コミットします。
4. `develop` への PR を作成し、変更内容、影響範囲、テストの証跡を書きます。
5. CI が成功しレビューが通ったらマージします。ユーザーによるリアルタイム検証が必要な変更は develop と一緒に有効になります。
6. 安定したら、メンテナーが `develop` を `main` にマージして push します。

## Issue と PR のテンプレート

リポジトリには `.github/ISSUE_TEMPLATE/`（bug / feature）と `.github/pull_request_template.md` があります。テンプレートに沿って記入してください。
