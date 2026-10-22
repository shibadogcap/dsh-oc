*[English](ACCEPTANCE.md) · 日本語*
# 完了条件

## 全体

1. T0 が Linux、macOS、Windows で通る。
2. T2 が OpenChamber と TUI の実際の呼び出しをすべて覆い、未実装の 404 がない。
3. T3 がブリッジの発行する全 session.* を覆い、OpenChamber の reducer が unknown を出さない。
4. T4 の起動記録で bootstrapGlobal と bootstrapDirectory の失敗が 0 件。
5. チャットのシナリオが最後まで通る。
6. 履歴の再読み込み後、メッセージ、part、ツール状態がリアルタイムの流れと一致する。
7. SSE の強制切断と再接続で、メッセージと part の重複も欠落もない。
8. dsh の再起動後、セッション一覧、履歴、モデル、agent、タイトル、巻き戻しのエイリアスが残る。
9. v1 のルートをすべて削除し、rg で /session と /global/event の登録が見つからない。
10. docs/PROTOCOL.md の全ルートに MAP、STUB、UNSUPPORTED のいずれかが付いている。
11. compat.json が固定版本の組と一致する。
12. /api/info が 100ms 以内、1000 セッションの一覧が 300ms 以内、イベント配信の p95 が 50ms 以内、10 セッション時のメモリが 250MB 未満。