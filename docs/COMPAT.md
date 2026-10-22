# 互換性マトリクス

## 三つの更新軸

| 軸 | 現在の目標 | 隔離する場所 | 差分の検出 |
| --- | --- | --- | --- |
| dsh | 0.2.1-rc.2 | `src/bridge/` の dsh 依存部 | `engines.dsh`、型検査、機能検出、dsh@next の互換テスト |
| OpenCode | 2.1.0 | `src/bridge/convert/`、`src/bridge/routes/` | 生成型、ルート表の照合、契約テスト |
| OpenChamber | 2.5 系 | `tests/e2e/` | 公開クライアントと reducer の契約テスト、起動記録 |

## 対応マトリクス

| 組み合わせ | 状態 |
| --- | --- |
| dsh 0.2.1-rc.2 + OpenCode 2.1.0 + OpenChamber 2.5.x | リリースの門番 |
| dsh next + OpenCode latest + OpenChamber main | 毎晩の先行検出 |

## OpenCode を上げる手順

公式クライアントが呼ぶルートは増減する。差分は自動で検出されるので、手順は次の
6 步。

### 1. 差分を見る

```bash
# 新しい client 取出
npm pack @opencode/client@<新バージョン>
tar -xzf opencode-client-<新バージョン>.tgz

# ルート表の差分
node -e "
const fs=require('fs');
const dir='<展開先>/package/dist/chunks';
let best='',bestn=0;
for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.js'))){
  const s=fs.readFileSync(dir+'/'+f,'utf8');
  const n=(s.match(/path: \`/g)??[]).length;
  if(n>bestn){bestn=n;best=s;}
}
const re=/method: \"(GET|POST|PATCH|PUT|DELETE)\",\s*\n\s*path: \`([^\`]+)\`/g;
let m; const out=[];
while((m=re.exec(best))!==null) out.push(m[1]+' '+m[2]);
console.log(out.join('\n'));
"
```

2025-11 時点の実際の差分（2.0.32 → 2.1.0）は、ルート 1 本の追加
（`PATCH /api/permission/saved/:id`）だけだった。型は
`SessionMessageProviderState` が `SessionMessageNative` に改名され、
`session.archived` / `session.unarchived` のイベント型が追加された。

### 2. バージョンを固定する

```bash
# package.json: @opencode/client を新バージョンへ
# opencode-version.json: version と npm を新バージョンへ
# src/bridge/convert/common.ts と src/index.ts: OPENCODE_VERSION
pnpm install
```

### 3. ルート表と探針基準を更新する

```bash
# 新しい client から基準を録る
node -e "
const fs=require('fs');
const dir='node_modules/@opencode/client/dist/chunks';
let best='',bestn=0;
for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.js'))){
  const s=fs.readFileSync(dir+'/'+f,'utf8');
  const n=(s.match(/path: \`/g)??[]).length;
  if(n>bestn){bestn=n;best=s;}
}
const re=/method: \"(GET|POST|PATCH|PUT|DELETE)\",\s*\n\s*path: \`([^\`]+)\`/g;
const seen=new Set(), routes=[]; let m;
while((m=re.exec(best))!==null){
  const method=m[1];
  const path=m[2].replace(/\\\$\{encodeURIComponent\(input\.[A-Za-z]+\)\}/g,':param').replace(/\\\$\{encodePath\(input\.path\)\}/g,':param');
  const key=method+' '+path;
  if(seen.has(key)) continue; seen.add(key);
  const kind=(path==='/api/event'||path.endsWith('/log'))?'sse':'json';
  routes.push({method,path,kind});
}
fs.writeFileSync('tests/fixtures/opencode/routes.json', JSON.stringify({
  version:'<新バージョン>',
  comment:'@opencode/client@<新バージョン> のルート表。',
  routes,
},null,2)+'\n');
"
```

### 4. 足りないルートを実装する

```bash
node scripts/check-client-routes.mjs   # missing: 0 になるまで実装
```

`missing` に出たルートだけを `src/bridge/routes/` の該当ドメインへ足す。

### 5. 型とテストを合わせる

```bash
pnpm typecheck
pnpm test
```

### 6. 実物で確かめる

```bash
pnpm run probe
pnpm run e2e:openchamber -- --bridge http://127.0.0.1:<ポート>
pnpm run e2e:openchamber-events -- --bridge http://127.0.0.1:<ポート>
```

## dsh を上げる手順

1. `package.json` の dsh 系依存を新しい rc へ、`engines.dsh` の範囲を更新する。
2. `pnpm typecheck` で ABI 差分を見る。
3. 動かなかった箇所は `src/bridge/rpc.ts`（ホストサービス呼び出し）と
   `src/bridge/state.ts`（メモリ状態）に集まることが多い。
4. `cordis.patch.yml` の插件行が新しい dsh の插件名と一致しているか確認する
   （`agent-presets` は `agent-preset-registry` と `agent-preset` に分かれた）。

## OpenChamber を上げる手順

1. `pnpm --filter @openchamber/web install` で公式ビルドを取る。
2. `scripts/e2e-openchamber-bootstrap.mjs`（起動時 22 呼び出し）と
   `scripts/e2e-openchamber-events.ts`（reducer 通過）を回す。
3. reducer が新しい語彙を増えた場合は `src/bridge/events.ts` 側の追加対応が要る。
   OpenChamber の reducer は `packages/ui/src/lib/opencode/events.ts` の
   `translateWireEvent` が読む語彙しか解釈しない。

### ブラウザ E2E の既知の制約

Obscura のブラウザは `fetch()` にストリーミング HTTP 応答を届けられない。chunked
応答を約束するヘッダが解決しないまま止まるので、OpenChamber 2.5 も公式 OpenCode
Web アプリも `/api/event` で止まる。公式 opencode サーバと同じヘッダを書く素の
Node HTTP サーバでも同じ症状になり、完了する応答（`GET /api/info` など）は届く。
公式 OpenCode 2.1.0 クライアント（Node、ブラウザではない）は bridge の
`/api/event` に購読でき、bridge 側のストリームは正しい。

つまりブラウザレベルの E2E は、この環境で使える Obscura では実施できない。
dsh-oc の制約でも OpenChamber 側の制約でもなく、手元のツールの制約である。API 経路は
`scripts/e2e-openchamber-bootstrap.mjs` で検証する。
