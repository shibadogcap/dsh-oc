*[English](RELEASE.md) · 日本語 · [中文](RELEASE.zh.md)*

# dsh-oc のリリースとロールバック手順

`v0.2.0-rc.1` は 2026-09-07 に、`v0.2.0-rc.2` は 2026-09-08 にリリースしました。rc.1–rc.3 は dsh `>=0.1.2-rc.1` を対象とし、rc.4 以降は dsh `>=0.1.5-rc.2` を対象とします（host ABI の破壊的変更のため、0.1.2 と 0.1.5 をまたぐインストールは混在できません）。以降の候補はこのチェックリストを再利用し、文中の `<candidate-version>` を実際のバージョンに置き換えます。

今回の候補は `v0.2.0-rc.4` です。rc.1–rc.3 のリリース記録は履歴の証跡として残します。

リリースの判断根拠は `expert-advice/round-0002/decision.md` にあります。npm は引き続き NO-GO です。パッケージ `@chiro2001/dsh-oc` は GitHub ソースからのインストールだけを提供し、**完全な commit SHA** をリリースの正とします。`lib/` のビルド成果物はコミットに含め、ソースとの差分がゼロでなければなりません。

## 前提条件（すべての候補で満たすこと）

1. `pnpm typecheck && pnpm test` がすべて成功すること。`pnpm run probe` の全 fixture ルート、プロトコル、バージョン検査が通過すること（現在のベースライン出力は 63/63 です。ルートを追加した後は fixture の全通過を基準にします）。
2. `bash scripts/verify-release-artifacts.sh` が PASSED であること（HEAD をクリーンに再ビルドした後、コミット済みの `lib/` の差分がゼロ、npm pack にマシン固有の絶対パスがない、tarball と tree のハッシュを記録）。
3. `bash scripts/check-all.sh --e2e` がすべて成功すること（復旧の故障ドメイン、ゴールデントラック、queued-order-repro、permission-mini などの stable スイートを含みます）。
4. 安定ベースライン：`scripts/flake-mini-scan.sh` が release-lane の予算内で最小の高リスクスクリプトを実行済みであること（docs/perf/results-flake-consolidated-2026-08-17.md を参照）。

## 候補の手順

1. **バージョン bump**：`package.json` と `src/index.ts` の `DSH_OC_VERSION` を同時に `<candidate-version>` へ変更します。`pnpm build` で `lib/` を再ビルドし、コミットします。
2. **ローカルゲート**：typecheck、単体テスト、probe、成果物監査、全量 e2e を実行します。プロトコルまたは TUI の変更には、対応する tmux／公式 TUI の回帰を含めます。
3. **develop へ push** し、CI がすべて成功するまで待ちます（ci と 2 シャードの e2e）。
4. **リモート full-SHA 演習**を次のコマンドで行います。
   ```bash
   bash scripts/e2e-install-rollback.sh \
     --candidate "github:shibadogcap/dsh-oc#<full-sha>" \
     --previous "github:shibadogcap/dsh-oc#<同じ dsh-0.1.5 ABI の直前の不変 sha>"
   ```
   rc.4 は最初の 0.1.5-ABI バージョンで、同じ ABI の直前の不変 SHA がありません。そのためロールバック演習では rc.4 自身の full SHA を使ってコールドインストールと再インストールの冪等性を確認し、別途、ABI をまたいで rc.3 へ戻す場合は dsh CLI も同時に `0.1.2-rc.1` へ下げる必要があることを確認します（下げない場合は想定どおり起動できず、失敗には数えません）。
   確認項目は、コールドインストールの成功、パッケージバージョンが `<candidate-version>` であること、TUI スモークの通過、旧セッションの復元、ロールバックの実行可能性です。スクリプトは `pnpm-lock.yaml` が指定の full SHA に実際に解決されることも検証するため、同じバージョン番号だけでロールバック成功を装うことはできません。
   同じバージョンの可変 ref を使った in-place の結果はキャッシュ安全性の証明になりません（バージョン番号の変化と full SHA の両方が必要です）。
5. **実モデル smoke（リモート候補）**を次のコマンドで実行します。
   ```bash
   bash scripts/e2e-real-llm.sh --quick --add-spec "github:shibadogcap/dsh-oc#<full-sha>"
   ```
6. **main へマージ**して push します。リリースの 4 要素を記録します。`{opencode 1.18.18, asset sha256, package tree hash, dsh-oc commit}`。
7. **保護 tag**：`v<candidate-version>` を演習済みの full SHA に付けます。Release notes には full SHA、tarball/tree ハッシュ、既知の制限（ツールとキューの即時ビューでの順序ずれ、`Allow always` が再起動で消えること、終了 splash など）を書きます。
8. **ローカルインストールの更新**：`dsh plugin --profile oc add github:shibadogcap/dsh-oc#v<candidate-version>` を実行し、`dsh-oc --version` で dsh-oc と dsh のバージョンを確認します。

## v0.2.0-rc.1 のリリース記録（2026-09-07）

この候補はリリースゲートとリモート演習を完了しています。

- dsh ABI：host services の直結、legacy dcp rc.6 の互換 shim、history follow/page の iterator close、errors/approval/question の targeted テストがそろっています。
- bridge：status のメモリ内ホットパス、api-session/status/activity、上限付き SSE ring、再接続時の status 再送、queue/history/model/preset/subagent の回帰を網羅しています。
- ビルドと監査：`pnpm typecheck`、418 件の単体テスト、`pnpm build`、プロトコル probe の全 fixture、5000 セッションの性能テスト、release artifact 監査がすべて通過しました（rc.1 のリリースベースラインは 62/62、rc.2 は 63/63）。
- TUI とリモート：実 TUI の全量 e2e、高リスク flake scan 30/30、GitHub CI、full-SHA のコールドインストール、実 TUI smoke、同一 ABI のロールバック、DeepSeek 実モデルの quick smoke が通過しました。
- リリースの 4 要素：opencode `1.18.18`、dsh-oc の commit、tarball の SHA256、package tree hash。詳細は GitHub の prerelease notes にあります。

## v0.2.0-rc.3 の候補記録（2026-09-08）

- 公式 OpenCode の prompt トップレベル `variant` における reasoning effort の同期を修正しました。明示的な max/off は以降のターンでも効き続け、Default は dsh バックエンドの既定値に戻り、session、history、live、キューの user model ref も同期します。
- ユーザーによる TUI の max/off 複数ターン検証が通過しました。ローカルの host oracle で、provider request body の enabled/max と disabled/reasoning_effort なしの意味論を検証しています。
- ローカルの typecheck、435 件の単体テスト、63/63 の probe、perf smoke、artifact 監査、39 件の e2e（実 TUI、recovery、ゴールデントラックを含む）が初回実行でリトライなしにすべて成功しました。
- リモート CI のフィードバックで判明した、permission TUI のテーマ依存の選択同期と、`rg` がない場合の artifact scanner の挙動を修正し、それぞれに決定的な回帰テストを追加しました。
- full SHA、tarball の SHA256、package tree hash、最終的なリリース状態は GitHub notes を正とします。

## v0.2.0-rc.2 のリリース記録（2026-09-08）

- 公式 OpenCode の `!` shell mode を追加しました。ユーザーのコマンドと出力はモデルを起こさない context で次のモデル prompt に注入され、正確な PID／プロセスグループ単位のキャンセルと出力の予算は維持されます。
- `/preset` の最終 assistant カードでのモデル／variant の表示と `QUEUED` の完了状態を修正し、v1/v2 history と実 TUI の回帰を追加しました。
- profile の分離と dsh-tui/dsh-dcp の ABI トラブルシュート文書を整備しました。ビルド成果物のパスをまたぐハッシュのずれを修正し、TUI e2e の状態駆動の待ち合わせを厳密にしました。
- プロトコル probe のリリースベースラインは 63/63 です。完全な commit SHA、tarball の SHA256、package tree hash、opencode asset の SHA256 は [GitHub prerelease notes](https://github.com/shibadogcap/dsh-oc/releases) を正とし、本ドキュメントには変動しうるリリース識別子を転記しません。

## ロールバック

いずれかの手順で blocker（`lib` の欠落や stale、バージョンが `<candidate-version>` と不一致、リモート SHA のインストール失敗、旧セッションの非互換、復旧の不一致、CI の意味的な失敗をリトライで緑に見せている）が出たらリリースを停止します。修正後は汚染された環境で続行せず、**新しい profile** で該当の演習をやり直します。現在の RC は dsh ABI の breaking minor です。同じ dsh `0.1.5-rc.2` 内でのロールバックは、同一 ABI の直前の不変 SHA を再インストールできます（rc.4 の直前の不変 SHA は rc.3 ですが、これは dsh 0.1.2 向けで、本バージョンと dsh CLI を共有できません）。`dsh-oc v0.1.0` へロールバックする場合は、dsh CLI も `0.1.0-rc.6` へ同時に戻す必要があります。ABI をまたぐロールバックでは dsh CLI も同時に戻さなければなりません。戻さないと旧版の host-services／イベント契約が新しい dsh と異なり、起動できません。

## opencode バイナリのアップグレード（独立 lane、現在の候補には混ぜない）

opencode のバージョンアップは `<candidate-version>` に混ぜません。まず `bash scripts/upgrade-lane.sh --bin <candidate>` でゴールデントラックに対する意味差分を取り、すべて成功してから `opencode-version.json`／asset 一覧の更新を検討し、別の候補フローとして進めます。
