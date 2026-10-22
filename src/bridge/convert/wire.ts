/**
 * OpenCode 1.x-shaped wire types.
 *
 * The HTTP surface of the bridge speaks OpenCode 2.1.0 only, but the SSE
 * stream still publishes the `message.updated` / `message.part.updated`
 * projection the bundled TUI reads. These structural types describe that
 * projection so the package no longer depends on the 1.18.18 SDK.
 */

/** Timing block carried by a text or reasoning part. */
export interface WirePartTime {
  start: number
  end?: number
}

/** The zero-token counter every synthetic assistant card carries. */
export interface WireTokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** Model identity of a message card. */
export interface WireModelRef {
  providerID: string
  modelID: string
  variant?: string
}

/** The `message.updated` payload of one message card. */
export interface WireMessageInfo {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  time: { created: number; completed?: number }
  agent?: string
  mode?: string
  parentID?: string
  modelID?: string
  providerID?: string
  variant?: string
  model?: WireModelRef
  path?: { cwd: string; root: string }
  cost?: number
  tokens?: WireTokenUsage
  finish?: string
}

/** A text part of the `message.part.updated` payload. */
export interface WireTextPart {
  id: string
  sessionID: string
  messageID: string
  type: 'text'
  text: string
  synthetic?: boolean
  time: WirePartTime
}

/** A reasoning part of the `message.part.updated` payload. */
export interface WireReasoningPart {
  id: string
  sessionID: string
  messageID: string
  type: 'reasoning'
  text: string
  time: WirePartTime
}

/**
 * The state block of a tool part. The four states are a discriminated union,
 * mirroring the tool state the OpenCode TUI reads.
 */
export type WireToolState =
  | {
      status: 'pending'
      input: Record<string, unknown>
      raw: string
    }
  | {
      status: 'running'
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: 'completed'
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number; compacted?: number }
    }
  | {
      status: 'error'
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }

/** A tool part of the `message.part.updated` payload. */
export interface WireToolPart {
  id: string
  sessionID: string
  messageID: string
  type: 'tool'
  callID: string
  tool: string
  state: WireToolState
  metadata?: Record<string, unknown>
}

/** A compaction marker part. */
export interface WireCompactionPart {
  id: string
  sessionID: string
  messageID: string
  type: 'compaction'
  auto: boolean
}

/** Every part shape the bridge publishes on the SSE channel. */
export type WirePart = WireTextPart | WireReasoningPart | WireToolPart | WireCompactionPart

/** One message card plus its parts, as the bridge stores it. */
export interface WireMessageEntry {
  info: WireMessageInfo
  parts: WirePart[]
}

/** The `session.updated` payload of one session card. */
export interface WireSessionInfo {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  agent: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  parentID?: string
  metadata?: Record<string, unknown>
  time: { created: number; updated: number }
}
