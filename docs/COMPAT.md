*English · [日本語](COMPAT.ja.md)*

# Compatibility matrix

## The three upgrade axes

| Axis | Current target | Where it is isolated | How the diff is detected |
| --- | --- | --- | --- |
| dsh | 0.2.1-rc.2 | the dsh-dependent parts of `src/bridge/` | `engines.dsh`, typecheck, feature detection, the dsh@next compatibility test |
| OpenCode | 2.1.0 | `src/bridge/convert/`, `src/bridge/routes/` | generated types, route table comparison, contract tests |
| OpenChamber | 2.5.x | `tests/e2e/` | contract tests for the public client and the reducer, startup records |

## Supported combinations

| Combination | Status |
| --- | --- |
| dsh 0.2.1-rc.2 + OpenCode 2.1.0 + OpenChamber 2.5.x | release gate |
| dsh next + OpenCode latest + OpenChamber main | nightly early detection |

## Upgrade procedure for OpenCode

The routes the official client calls come and go. The diff is detected automatically, so the
procedure has six steps.

### 1. Look at the diff

```bash
# extract the new client
npm pack @opencode/client@<new-version>
tar -xzf opencode-client-<new-version>.tgz

# diff the route table
node -e "
const fs=require('fs');
const dir='<extract-dir>/package/dist/chunks';
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

As of 2025-11 the actual diff (2.0.32 → 2.1.0) was a single added route
(`PATCH /api/permission/saved/:id`). In the types, `SessionMessageProviderState` was renamed to
`SessionMessageNative`, and the `session.archived` / `session.unarchived` event types were added.

### 2. Pin the version

```bash
# package.json: move @opencode/client to the new version
# opencode-version.json: move version and npm to the new version
# src/bridge/convert/common.ts and src/index.ts: OPENCODE_VERSION
pnpm install
```

### 3. Update the route table and the probe baseline

```bash
# record the baseline from the new client
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
  version:'<new-version>',
  comment:'Route table of @opencode/client@<new-version>.',
  routes,
},null,2)+'\n');
"
```

### 4. Implement the missing routes

```bash
node scripts/check-client-routes.mjs   # implement until missing: 0
```

Add only the routes listed under `missing` to the matching domain in `src/bridge/routes/`.

### 5. Align types and tests

```bash
pnpm typecheck
pnpm test
```

### 6. Check against the real thing

```bash
pnpm run probe
pnpm run e2e:openchamber -- --bridge http://127.0.0.1:<port>
pnpm run e2e:openchamber-events -- --bridge http://127.0.0.1:<port>
```

## Upgrade procedure for dsh

1. Move the dsh dependencies in `package.json` to the new rc and update the `engines.dsh` range.
2. Run `pnpm typecheck` to see the ABI diff.
3. What breaks usually concentrates in `src/bridge/rpc.ts` (host service calls) and
   `src/bridge/state.ts` (in-memory state).
4. Check that the plugin lines in `cordis.patch.yml` match the plugin names of the new dsh
   (`agent-presets` split into `agent-preset-registry` and `agent-preset`).

## Upgrade procedure for OpenChamber

1. Fetch the official build with `pnpm --filter @openchamber/web install`.
2. Run `scripts/e2e-openchamber-bootstrap.mjs` (the 22 calls at startup) and
   `scripts/e2e-openchamber-events.ts` (reducer pass-through).
3. When the reducer gains new vocabulary, `src/bridge/events.ts` needs matching additions.
   The OpenChamber reducer only interprets the vocabulary that `translateWireEvent` in
   `packages/ui/src/lib/opencode/events.ts` reads.

### Known browser E2E constraint

The Obscura browser cannot deliver a streaming HTTP response to `fetch()`. The headers that
promise a chunked response never resolve, so both OpenChamber 2.5 and the official OpenCode Web
app stall at `/api/event`. A plain Node HTTP server that writes the same headers as the official
opencode server shows the same symptom, while responses that complete (`GET /api/info` and so on)
arrive. The official OpenCode 2.1.0 client (Node, not a browser) can subscribe to the bridge's
`/api/event`, and the bridge-side stream is correct.

Browser-level E2E therefore cannot run with the Obscura available in this environment. This is a
constraint of the local tooling, not of dsh-oc or of OpenChamber. The API path is verified with
`scripts/e2e-openchamber-bootstrap.mjs`.

## Model (provider) configuration

dsh lists a model for a provider **only when that provider has usable credentials**. Without
credentials `/api/model` is empty, and a client that resolves models against the catalog (the TUI
does) stays on "no model selected" and falls into OpenCode's provider connection flow. dsh-oc does
not use that flow, so you cannot get back out of that screen.

What the bridge does instead:

- Even with an empty catalog, expose the default model from the dsh configuration on `/api/model`,
  `/api/provider`, and `/api/model/default` (the model name is visible, but calling it needs
  credentials).
- Return `{ type: "document", info: { model, default_agent } }` from `/api/config` (the TUI reads
  the default model and agent from there).
- If `POST /api/session` with an explicit model fails, still create the session. The real error
  appears at prompt time.
- When a model switch fails with `session/model-unavailable`, include which key to set in the
  message.
- Log the reason the catalog is empty once per startup
  (`[bridge/model] the model catalog is empty (...)`).

The dsh-oc profile uses the `dsh-base` default (`deepseek-official` + `DEEPSEEK_API_KEY`) as is.
To use another provider, add `llm-pi-ai` and `agent-default-model` to the profile's
`cordis.patch.yml`. Example (the key goes under `refs` in `~/.dsh/.credentials.yaml`; do not
display the value):

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: high
```

Install `@deepseek-ai/dsh-llm-pi-ai` into the profile:

```bash
dsh plugin --profile oc add @deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2
```

When pnpm 12 stops with `ERR_PNPM_IGNORED_BUILDS` (a transitive dependency has a build script),
install while explicitly rejecting that package's script:

```bash
cd ~/.dsh/profiles/oc
pnpm add @deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2 \
  --allow-build='!@google/genai' --allow-build='!protobufjs'
```

To verify, check the count on `/api/model`, the `id` on `/api/model/default`, and the
`Minimal · <model name> <provider>` label at the bottom of the TUI home screen.

### Updating from the GitHub source

```bash
dsh plugin --profile oc add 'github:<owner>/dsh-oc#<branch>'
```

pnpm 12 may reuse the resolution of the same ref, finish with "Lockfile is up to date", and stay on
the old commit. In that case run `pnpm update` in the profile and check that the `tar.gz/<sha>` in
`pnpm-lock.yaml` points at the new commit:

```bash
cd ~/.dsh/profiles/oc
pnpm update @chiro2001/dsh-oc
rg -o 'dsh-oc/tar.gz/[a-f0-9]+' pnpm-lock.yaml | head -1
```
