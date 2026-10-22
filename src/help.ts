import { DSH_OC_VERSION, OPENCODE_VERSION } from './index.js'

/** Languages the help screen is written in; English is the default. */
export type HelpLanguage = 'en' | 'ja' | 'zh'

/** `DSH_OC_LANG=ja` / `zh` selects another language; anything else is English. */
export function helpLanguageFromEnv(env: NodeJS.ProcessEnv = process.env): HelpLanguage {
  const raw = (env.DSH_OC_LANG ?? '').trim().toLowerCase()
  if (raw.startsWith('ja')) return 'ja'
  if (raw.startsWith('zh')) return 'zh'
  return 'en'
}

interface HelpLabels {
  readonly usage: string
  readonly options: string
  readonly tuiArgs: string
  readonly forward: (bridge: string) => string
  readonly capabilities: string
  readonly docs: string
  readonly protocol: string
  readonly roadmap: string
}

const LABELS: Record<HelpLanguage, HelpLabels> = {
  en: {
    usage: 'Usage',
    options: 'options',
    tuiArgs: 'TUI options',
    forward: (bridge) => `(forwarded to opencode --server ${bridge}; --dir only changes the bridge cwd)`,
    capabilities: 'Capabilities',
    docs: 'Full capability matrix: docs/FEATURES.md (in the repository)',
    protocol: 'Protocol and routes: docs/PROTOCOL.md',
    roadmap: 'Next-stage requirements: docs/ROADMAP.md',
  },
  ja: {
    usage: '使い方',
    options: '引数',
    tuiArgs: '対応する TUI 引数',
    forward: (bridge) => `（opencode --server ${bridge} に転送。--dir は bridge の作業ディレクトリだけを変える）`,
    capabilities: '主な機能',
    docs: '能力の全一覧: docs/FEATURES.md（リポジトリ内）',
    protocol: 'プロトコルとルート: docs/PROTOCOL.md',
    roadmap: '次の段階の要件: docs/ROADMAP.md',
  },
  zh: {
    usage: '用法',
    options: '参数',
    tuiArgs: '支持的 TUI 参数',
    forward: (bridge) => `（转发给 opencode --server ${bridge}；--dir 只改 bridge 的工作目录）`,
    capabilities: '核心能力',
    docs: '完整能力矩阵: docs/FEATURES.md（仓库内）',
    protocol: '协议与路由: docs/PROTOCOL.md',
    roadmap: '下一阶段需求: docs/ROADMAP.md',
  },
}

const CAPABILITIES: Record<HelpLanguage, readonly string[]> = {
  en: [
    '✅ session list/new/continue/fork/compact, streaming SSE messages',
    '✅ dsh model catalog, reasoning effort, agent preset switching',
    '✅ ! shell mode (user-authorized OS shell, exact process ownership, no model turn)',
    '✅ /preset lists and switches presets; the result card does not stay QUEUED',
    '✅ tool cards (bash/read/write/edit), streaming tool arguments, diffs and Modified Files',
    '✅ permission/question flow, subagent session tree and background subagents',
    '✅ MCP servers configured in the dsh profile (tools appear as mcp__<server>__<tool>)',
    '✅ autoupdate disabled, binary version pinned to {opencode}',
    '✅ DSH OC branded start logo',
    '✅ real session titles in the list (title → directory name → id)',
    '✅ Esc interrupt/cancel (press twice in the full TUI and --mini); /preset applies to new sessions',
    '🟡 file attachments support text and images; "Allow always" is remembered for the session only',
    '🟡 the official opencode splash stays on exit; a dsh resume hint is printed below it (can be disabled)',
    '❌ LSP/formatter/integration/reference and similar peripheral routes are stubs',
  ],
  ja: [
    '✅ セッションの一覧・新規・継続・fork・compact、SSE のストリーミング',
    '✅ dsh のモデル一覧、reasoning effort、agent preset の切り替え',
    '✅ ! shell mode（ユーザーが許可した OS shell、正確なプロセス所有、モデルのターンは発生しない）',
    '✅ /preset で一覧と切り替え。完了カードが QUEUED のまま残らない',
    '✅ ツールカード（bash/read/write/edit）、ツール引数のストリーミング、diff と Modified Files',
    '✅ 権限・質問のフロー、サブエージェントのセッションツリーとバックグラウンド実行',
    '✅ dsh の profile で設定した MCP サーバー（ツールは mcp__<server>__<tool> として見える）',
    '✅ 自動更新を無効化し、バイナリのバージョンを {opencode} に固定',
    '✅ DSH OC のブランドロゴ',
    '✅ セッション一覧の実際のタイトル（タイトル → ディレクトリ名 → id の順で決まる）',
    '✅ Esc で中断・取消（全量 TUI と --mini のどちらも 2 回押す）。/preset は新しいセッションに引き継がれる',
    '🟡 添付はテキストと画像に対応。"Allow always" はセッション内のメモリだけ',
    '🟡 終了時に公式 opencode の splash が残り、その下に dsh の再開案内を 1 行出す（無効にできる）',
    '❌ LSP/formatter/integration/reference などの周辺ルートは stub',
  ],
  zh: [
    '✅ 会话列表/新建/续聊/fork/compact，SSE 流式消息',
    '✅ dsh 模型目录、reasoning effort、agent preset 切换',
    '✅ ! shell mode（用户授权 OS shell、精确进程归属，不触发模型回合）',
    '✅ /preset 列出/切换 preset，完成卡片不会持续显示 QUEUED',
    '✅ 工具卡片（bash/read/write/edit）、流式工具参数、diff 与 Modified Files',
    '✅ 权限/提问流、子代理会话树与后台子代理',
    '✅ dsh profile 中配置的 MCP 服务器（工具以 mcp__<server>__<tool> 出现）',
    '✅ 自动更新关闭、二进制版本锁定 {opencode}',
    '✅ DSH OC 品牌启动 logo',
    '✅ 会话列表真实标题（标题 → 目录名 → id 回退）',
    '✅ Esc 打断/取消（全量与 --mini 均连按两次），/preset 新会话继承',
    '🟡 文件附件支持文本/图片；"Allow always" 为会话内内存记忆',
    '🟡 退出时官方 opencode splash 保留，下方补一行 dsh 恢复说明（可关闭）',
    '❌ LSP/formatter/integration/reference 等外围路由为 stub',
  ],
}

/**
 * `dsh --profile oc --help` and TUI `/help` output; kept deliberately static
 * so it works offline and is identical across entry points. English is the
 * default; `DSH_OC_LANG=ja` or `zh` selects another language.
 */
export function ocHelp(version: string = DSH_OC_VERSION, language: HelpLanguage = helpLanguageFromEnv()): string {
  const labels = LABELS[language]
  return `dsh-oc ${version} — DeepSeek Harness × OpenCode TUI (opencode ${OPENCODE_VERSION})

${labels.usage}:
  dsh --profile oc [TUI ${labels.options}]

${labels.tuiArgs}:
  --continue/-c, --session/-s, --fork, --dir, --mini, --print-logs, --log-level
  ${labels.forward('<bridge-url>')}

${labels.capabilities}:
${CAPABILITIES[language].map((line) => `  ${line.replaceAll('{opencode}', OPENCODE_VERSION)}`).join('\n')}

${labels.docs}
${labels.protocol}
${labels.roadmap}
`
}

/** Whether the raw dsh args request the dsh-oc help screen. */
export function helpRequested(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}
