/**
 * dsh-oc branding for the OpenCode TUI.
 *
 * The 2.1.0 TUI exposes its slot tree at `context.ui.slot`. It has no slot for
 * the home logo itself (the TUI renders its own), so the branding mark goes
 * into the home footer: a compact DSH ⨯ OC mark with the subtitle.
 */
/** @jsxImportSource @opentui/solid */

interface ThemeTokens {
  readonly text: {
    readonly base: unknown
    readonly muted: unknown
    readonly faint: unknown
    readonly feedback: Record<string, { readonly base: unknown; readonly muted: unknown }>
  }
}

interface TuiPluginApi {
  readonly theme: ThemeTokens
  readonly ui: {
    slot: (claim: {
      append: string
      render: (input: Record<string, never>) => unknown
    }) => () => void
  }
}

const SUBTITLE = "DeepSeek Harness × OpenCode TUI"

export default {
  id: "dsh-oc-logo",
  setup(api: TuiPluginApi): void {
    api.ui.slot({
      append: "home.footer",
      render: () => {
        const theme = api.theme
        const accent = theme.text.feedback.info?.base ?? theme.text.base
        return (
          <box flexDirection="column" alignItems="center" paddingTop={1} flexShrink={0}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text.base} bold>DSH</text>
              <text fg={theme.text.faint}>⨯</text>
              <text fg={accent} bold>OC</text>
            </box>
            <text fg={theme.text.muted}>{SUBTITLE}</text>
          </box>
        )
      },
    })
  },
}
