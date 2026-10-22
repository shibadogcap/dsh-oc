*[English](README.md) · [日本語](README.ja.md) · 中文*
# dsh-oc

DeepSeek Harness（dsh）的 OpenCode TUI 前端：使用官方 OpenCode 终端界面，
由 dsh 提供 Agent、会话、工具、模型、权限和提问能力。

[![CI](https://github.com/shibadogcap/dsh-oc/actions/workflows/ci.yml/badge.svg)](https://github.com/shibadogcap/dsh-oc/actions/workflows/ci.yml)
[![e2e](https://github.com/shibadogcap/dsh-oc/actions/workflows/e2e.yml/badge.svg)](https://github.com/shibadogcap/dsh-oc/actions/workflows/e2e.yml)

## 工作方式

- **界面**：官方 `opencode --server` TUI，只负责终端渲染、键盘交互和生命周期。
- **后端**：dsh 负责 Agent、Session、工具、模型、权限和用户提问。
- **桥接**：dsh-oc 在 dsh 进程内提供 OpenCode 兼容的 HTTP/SSE bridge，并启动官方 TUI。

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (--server)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

当前兼容基线：dsh `0.2.1-rc.2`、官方 opencode `2.1.0`。本 fork 跟随
`feat-opencode-2-1` 分支，dsh 0.2.1 与 OpenCode 2.1.0 的适配都在这里；上游 `main`
仍指向 `v0.2.0-rc.4` 的 prerelease。包名沿用上游的 `@chiro2001/dsh-oc`，
未发布到 npm registry，安装和更新走 GitHub 源。

## 安装并启动

### 从 fork 安装

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'
dsh --profile oc
```

这里的 profile 名称是 `oc`，不是 `dsh-oc`。更新同一来源时重复执行上面的安装命令即可。

### 固定 commit 与开发线

分支是移动的引用，需要可复现的安装时请固定完整的 commit SHA：

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#<full-sha>'
```

要回到分支时，重新执行上一节的安装命令。npm 包名是 `@chiro2001/dsh-oc`，
但目前未发布到 npm registry。

本地开发可用 `dsh plugin --profile oc add .` 链接工作树；修改 TypeScript 后执行
`pnpm build` 即可让 profile 使用新构建。

安装后也可使用 `dsh-oc` 简写。将 profile 的 bin 目录加入 PATH：

```bash
export PATH="$HOME/.dsh/profiles/oc/node_modules/.bin:$PATH"
dsh-oc                        # 等价于 dsh --profile oc
dsh-oc --mini                 # 等价于 dsh --profile oc --mini
dsh-oc --version              # 同时输出 dsh-oc 与 dsh 的版本
```

pnpm 提示缺少 `@deepseek-ai/cordis` 等 peer 属于预期警告；这些依赖由 dsh 宿主在
运行时提供。

## 5 分钟上手

启动后可以直接输入普通任务，例如“只回复 OK”。常用的控制命令如下：

| 输入 | 作用 |
|---|---|
| `!`，再输入 shell 命令 | 在完整 OpenCode TUI 中执行用户指定的 shell 命令 |
| `/preset` | 列出可用的 dsh agent preset |
| `/preset minimal` | 切换到 `minimal` preset，不触发模型回合 |
| `/goal <目标>` | 创建或查看 goal，状态会同步到侧栏 |
| `/help` | 在 TUI 中显示能力摘要 |

### `!` shell mode

在完整 TUI 输入框输入 `!`，再输入例如 `printf DSH_OC_SHELL_OK` 并回车。命令经
dsh-oc 以当前 OS 用户身份启动精确的 shell 子进程（POSIX 仅使用绝对路径的
`$SHELL -c`，否则回退 `/bin/sh`；Windows 使用 `ComSpec`，缺失时回退
`cmd.exe`）。`!` 本身就是用户授权边界；它不经过 dsh 的模型工具、approval 或
sandbox waterfall。TUI 显示一张 shell tool card、输出和退出结果，但不会触发模型
回复；命令完成后会以明确标注“用户手动执行”的非唤醒 context 注入下一次真实 prompt，
让模型能看到命令和输出。注入本身不会开启新的 turn，session 被清理时不会迟到注入。
stdout/stderr 各自最多保留 1 MiB；超过后继续 drain 子进程，但在卡片中追加截断标记，
不会因为输出超过阈值而 kill 命令。发送给模型的 context 有独立预算：命令最多 16 KiB、
stdout/stderr 各最多 64 KiB、完整文本最多约 144 KiB，并带明确截断标记。
命令和输出会发送给当前配置的模型，可能包含 token、密码或个人数据；使用 `!` 前请
确认不会泄露敏感信息。

`--dir <path>` 会设置 bridge cwd；已记录的 session cwd 优先，只有冷启动时才用它作
shell cwd fallback。shell 卡片属于 bridge 的短期投影，不伪造 dsh agent-loop 事件；
完成后的输出在当前 bridge 生命周期内可通过历史重新加载。

### `/preset`

空白会话中使用 `/preset <name>` 或 Tab 选择 agent 后，当前会话和之后新建的会话会
使用该 preset。`/preset` 的结果卡片在命令完成后立即结束，不需要再发送一条消息来
清除 `QUEUED` 状态。

会话已经产生回复后，dsh 会锁定 agent preset；此时切换会显示一次
`Agent switch locked`，请新建会话后再切换。

## 浏览器访问（官方 Web UI）

bridge 除了 API 也会伺服官方 OpenCode 的 Web UI，两者同一个源，所以浏览器
直接打开 bridge 地址就能用：

```bash
dsh --profile oc
```

启动日志里的 `bridge listening on http://127.0.0.1:<port>` 就是要在浏览器里
打开的地址。官方 Web UI 用 `location.origin` 访问 API，同源之后既不需要 CORS
也不需要登录。

Web UI 的文件是 opencode 二进制里内嵌的资源，bridge 第一次运行时把它解到
`$DSH_HOME/opencode/web-ui/<版本>/`（当前 `2.1.0`）。bridge 只查找 opencode
二进制，不会替你安装它；TUI 插件本来就要装这个二进制，所以 Web UI 从下一次
启动起就出现。找不到二进制时只是没有 Web UI，API 不受影响。

说明：dsh-oc 的验证环境里没有真实浏览器，Web UI 的界面交互未在这里实测；
UI 资产能被服务、官方 OpenCode 2.1.0 客户端能订阅 bridge 的事件流，这两点
已确认。

### 相关环境变量

| 变量 | 作用 |
|---|---|
| `DSH_OC_HOST` | bridge 的绑定地址，默认 `127.0.0.1` |
| `DSH_OC_PORT` | bridge 的监听端口，默认随机端口 |
| `DSH_OC_CORS` | 允许跨源访问的 origin 列表（逗号分隔），用于局域网上的浏览器 UI。默认已允许 `localhost`、`127.0.0.1`、`oc://renderer`、tauri 源和 `*.opencode.ai` |
| `DSH_OC_WEB_UI` | 指定官方 Web UI 的目录（需要是已解开的目录，含 `index.html`）。不指定时用 `$DSH_HOME/opencode/web-ui/<版本>/` |
| `DSH_OC_HTTP_LOG` | 设为 `1` 时把每个 HTTP 请求打到 stderr（`[bridge/http] GET /api/info`），用来在没有浏览器时看 UI 的调用模式 |

## 能力状态

> 完整矩阵见 [docs/FEATURES.md](docs/FEATURES.zh.md)，协议细节见
> [docs/PROTOCOL.md](docs/PROTOCOL.zh.md)；`dsh --profile oc --help` 展示离线能力摘要。

| 能力 | 状态 |
|---|---|
| 会话列表/新建/续聊/fork/compact、SSE 流式消息 | ✅ |
| 官方 OpenCode Web UI（与 API 同源，浏览器直接打开 bridge 地址） | ✅ |
| 会话回退（revert）：stage/clear/commit、按回合的文件回滚、会话 id 不变、下一条 prompt 自动提交 | ✅ |
| 会话标题、历史恢复和目录过滤 | ✅ |
| 模型目录、reasoning effort、agent preset 切换 | ✅ |
| `!` shell mode（用户授权的 OS shell、固定 bash tool card） | ✅ |
| 工具卡片（bash/read/write/edit）、参数流、diff 与 Modified Files | ✅ |
| 权限/提问流、子代理会话树与后台子代理 | ✅ |
| Goal 创建/查看/暂停/恢复/完成 | ✅ |
| 文本/图片附件 | ✅（PDF 等二进制暂不支持） |
| `Allow always` 权限 | 🟡（仅当前会话内存记忆） |
| dsh profile 中配置的 MCP 服务器（工具以 `mcp__<server>__<tool>` 出现） | ✅ |
| LSP / formatter / integration / reference 等外围路由 | ❌（schema-valid stub） |

## MCP 服务器

MCP 服务器是 dsh 的插件，不是桥接的状态。桥接原样透传其工具，并列出已注册工具的
服务器，dsh 以此表示连接正常。先安装客户端，再为每个服务器在 profile 的
`cordis.patch.yml` 中添加一个条目。

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

远程服务器改用 `transport: streamable-http` 并提供 `url` 与 `headers`，不再使用
`command`/`args`/`env`。重启 dsh 后，服务器工具在模型侧以
`mcp__<serverName>__<tool>` 出现，在 TUI 中显示为普通工具卡片，MCP 面板会列出该
服务器。运行时添加、删除或切换服务器返回 400，配置由 profile 持有。

## 演示

<img src="docs/demo/dsh-oc-demo.gif" alt="dsh-oc 核心功能演示（真实 DeepSeek 模型）" width="900">

真实录制：品牌启动画面 → 真实模型运行 `pnpm test` → 全部单测通过 → 退出提示。复现方式：按上一节从 fork 安装，然后运行 `dsh --profile oc`。

## 启动参数

支持透传给官方 opencode TUI 的参数（dsh-oc 以 `opencode --server <bridge-url>` 启动
TUI；`--mini` 走 `opencode mini --server <bridge-url>`）：

- `--continue` / `-c`、`--session` / `-s`、`--fork`、`--dir`、`--mini`、
  `--print-logs`、`--log-level`

示例：

```bash
dsh --profile oc --session <session-id>
dsh --profile oc --dir ~/project --mini
```

其它参数会显式打印 `ignored unsupported arg` 警告，不会静默丢弃。

## 数据、安全与限制

- OpenCode 的配置、数据、状态和缓存隔离在 `$DSH_HOME/opencode`；模型和凭据由 dsh
  后端管理，dsh-oc 不向 OpenCode 注入 provider/key。
- 官方 Web UI 与 API 共享同一个端口。bridge 默认只绑定 `127.0.0.1`，所以 Web UI
  也只有本机能访问；改 `DSH_OC_HOST` 或 `DSH_OC_CORS` 把服务放到局域网之前，先
  想清楚这个暴露面。
- 官方二进制锁定为 `2.1.0`；自动更新、远程模型目录抓取和 LSP 下载均关闭。
- shell mode 由用户显式输入 `!` 授权，继承当前 OS 用户权限与 session cwd；不宣称
  dsh approval/sandbox 保护。取消只针对当前 bridge/session 登记的精确子进程/进程组，
  不按进程名结束其它进程；POSIX 使用自有 process group，Windows 使用自有 PID
  的 `taskkill /T` 树。Windows 使用 `ComSpec`（不是 dsh 的 pwsh sandbox），这项
  平台差异应在 Windows 主机上单独验收。
- shell 路径只在子进程结束后发布保留的 stdout/stderr，不提供实时输出流；每路最多
  保留 1 MiB，超出后继续 drain 并追加截断标记。shell-only 卡片是 bridge 内存投影；
  另有一条 dsh `agent/inbox/spliced` pending context 供下一次 prompt 使用，claim 后
  如发生 compaction 不保证逐字长期保留。
- `Allow always` 只在当前会话内记忆，重启后清空。
- 官方退出 splash 无法替换；dsh-oc 会在下方补一行 dsh 恢复说明，可用
  `DSH_OC_DISABLE_EXIT_NOTE=1` 关闭。
- `--mini` 不加载 TUI branding 插件，因此入口仍可能显示官方 OpenCode 字符画；
  dsh-oc 会在启动前打印 DSH OC 品牌。
- 流式回合中全量 TUI 与 `--mini` 都需要连按两次 Esc 打断；dsh-oc 会转为
  `session.cancel`。
- 工具回合在忙碌时排队第二条消息，官方 TUI 的即时转录顺序可能暂时错位；内容
  不丢失、不重复，重新进入会话后顺序正确。
- LSP/formatter/integration/reference 等外围路由目前只提供 schema-valid stub，
  不伪造结果。
- 会话回退（revert）的边界是排他的：被指定的消息及其之后的消息在提交时一并丢弃，
  会话 id 保持不变（提交后对话切到 dsh 的 fork 上）。dsh 表达不了空 fork，切点在
  第一条消息之前时返回 400；文件 diff 是首尾改动行之间的一个粗 hunk，不是完整的
  LCS diff。

## 排障：Profile 隔离与 dsh-tui

`dsh-oc` 只在 `dsh --profile oc` 的 dsh 进程中加载。它的 bridge、OpenCode 配置和
兼容 shim 都是该进程的本地状态，不会跨进程修改其它 profile；不要把 dsh-oc 安装
到 dsh-tui 所用的 profile 来修复 dsh-tui。

dsh-tui launcher 当前固定使用 `dsh --profile dsh-tui`，不是泛称的 `tui`。两者可以
同时存在；只读查看实际组合树：

```bash
dsh --profile oc --dump-config
dsh --profile tui --dump-config
dsh --profile dsh-tui --dump-config
```

如果你明确希望 profile 名称就是 `tui`，可以考虑安装 dsh-tui bundle 并直接使用该
profile（以下只是建议命令，本轮没有替用户 profile 执行）：

```bash
dsh plugin --profile tui add '@deepseek-harness-tui/dsh-tui@0.10.0-beta.5'
dsh --profile tui
```

该安装路径不要再添加旧版 dsh-dcp；全局 `dsh-tui` 命令仍会查找 `dsh-tui` profile，
不会自动转向 `tui`。

如果 dsh-tui 显示 `turn error · events is not iterable`，优先检查其 dsh-dcp 版本和
peer ABI。旧版 dsh-dcp 仍读取 dsh 0.1.2 已移除的 `session.events`，而新接口是
`session.snapshotEvents()`；这不是 dsh-oc 与 dsh-tui 的冲突。应升级到与当前 dsh
ABI 匹配的 dsh-dcp，或仅在 dsh-tui 自己的 profile patch/诊断 overlay 中暂时禁用
`dcp`（`- id: dcp` / `disabled: true`），再向 dsh-dcp/dsh-tui 上游反馈。

## 更新与开发

稳定版本、候选版本和完整发布门禁见 [docs/RELEASE.md](docs/RELEASE.zh.md)；变更记录见
[docs/CHANGELOG.md](docs/CHANGELOG.zh.md)。开发环境、分支策略和自测门槛见
[AGENTS.md](AGENTS.zh.md) 与 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。手动回归步骤见
[docs/MANUAL-TEST.md](docs/MANUAL-TEST.zh.md)，下一阶段计划见
[docs/ROADMAP.md](docs/ROADMAP.zh.md)。

快速自测：

```bash
pnpm run e2e:api   # 快速 API 回归
pnpm run e2e       # 全量 e2e（真实 opencode TUI）
```

## 致谢

这个 fork 建立在他人的工作之上。

- [dsh-oc](https://github.com/shibadogcap/dsh-oc)：本 fork 跟随的上游项目。桥接
  设计、协议覆盖和测试体系都源自这里。
- [OpenCode](https://github.com/sst/opencode)：本项目嵌入并兼容的终端 UI、Web UI
  与客户端协议。dsh-oc 直接使用官方二进制，不做修改。
- DeepSeek Harness（dsh）：桥接背后的 agent 循环、会话、工具、模型、审批与提问。
- OpenChamber：用于验证桥接的兼容测试套件。
- MCP 服务器与客户端的实现者。桥接原样透传其协议。
