import type { ServerResponse } from 'node:http'
import type { BridgeGlobalEvent } from './events.js'

export interface SseClient {
  id: number
  res: ServerResponse
  controller: AbortController
  closed: boolean
  /** Optional per-connection session filter (attach `?sessionID=`). */
  filter?: (event: BridgeGlobalEvent) => boolean
}

export interface SseHubOptions {
  /** Maximum number of broadcast events retained for Last-Event-ID replay. */
  maxReplayEvents?: number
  /** Maximum serialized wire bytes retained for Last-Event-ID replay. */
  maxReplayBytes?: number
  /**
   * Interval of the SSE comment heartbeat, in milliseconds.
   *
   * The official opencode server merges `": heartbeat\n\n"` into the event
   * stream every 15 seconds. Clients treat a silent stream as stalled (the
   * opencode client and the OpenChamber upstream reader both give up after
   * 20-45 seconds) and reconnect, so the bridge has to keep the stream warm
   * even when no session activity produces events. A comment line is ignored
   * by every SSE parser but still counts as received data.
   */
  heartbeatMs?: number
}

interface ReplayEntry {
  event: BridgeGlobalEvent
  wire: string
  bytes: number
}

/** The SSE comment frame the official opencode server sends every 15 s. */
const HEARTBEAT_FRAME = ': heartbeat\n\n'

/** Default heartbeat interval; the same cadence the official server uses. */
const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * The wire object of one event.
 *
 * It carries the OpenCode 2.x envelope at the top level (`id`, `created`,
 * `type`, `durable`, `location`, `data`), so a 2.x client reads the stream
 * without knowing the 1.18.18 wrapper, and it keeps that wrapper
 * (`directory`, `payload`) for the bundled 1.18.18 TUI.
 */
export function toWireEvent(event: BridgeGlobalEvent): Record<string, unknown> {
  const { id, created, type, data, durable, location } = event.payload
  return {
    id,
    ...(created === undefined ? {} : { created }),
    type,
    ...(durable === undefined ? {} : { durable }),
    ...(location === undefined ? {} : { location }),
    data,
    directory: event.directory,
    ...(event.project === undefined ? {} : { project: event.project }),
    payload: event.payload,
  }
}

/** Registry of active SSE connections plus the encoder/cleanup logic. */
export class SseHub {
  private clients = new Set<SseClient>()
  /** Events enqueued before any client connected (raw replay mode). */
  private pending: BridgeGlobalEvent[] = []
  private readonly replay: ReplayEntry[] = []
  private replayBytes = 0
  private readonly maxReplayEvents: number
  private readonly maxReplayBytes: number
  private readonly heartbeatMs: number
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private nextId = 1

  constructor(
    private log: (message: string) => void,
    options: SseHubOptions = {},
  ) {
    this.maxReplayEvents = Math.max(1, Math.floor(options.maxReplayEvents ?? 512))
    this.maxReplayBytes = Math.max(1, Math.floor(options.maxReplayBytes ?? 4 * 1024 * 1024))
    this.heartbeatMs = Math.max(0, Math.floor(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS))
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs)
      // The timer must not hold the process open on its own.
      this.heartbeatTimer.unref?.()
    }
  }

  /**
   * Write the SSE comment heartbeat to every open connection.
   *
   * The official opencode server sends `": heartbeat\n\n"` every 15 seconds.
   * Without it a quiet session looks like a dead stream: the opencode client
   * drops the connection with "Event stream stalled" and the OpenChamber
   * upstream reader reconnects in a tight loop.
   */
  private heartbeat(): void {
    for (const client of [...this.clients]) {
      if (client.closed || client.res.destroyed) continue
      try {
        client.res.write(HEARTBEAT_FRAME)
      } catch (error) {
        this.log(`[bridge/sse] heartbeat to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        this.remove(client)
      }
    }
  }

  /** Stop the heartbeat timer. */
  dispose(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  add(res: ServerResponse, filter?: (event: BridgeGlobalEvent) => boolean): SseClient {
    const client: SseClient = {
      id: this.nextId++,
      res,
      controller: new AbortController(),
      closed: false,
      filter,
    }
    this.clients.add(client)
    // A client that connects late must still receive events queued before
    // it subscribed (raw replay / recorded traces).
    if (this.pending.length > 0) {
      const queued = this.pending.splice(0)
      for (const event of queued) this.send(client, event)
    }
    res.on('close', () => this.remove(client))
    res.on('error', (error) => {
      this.log(`[bridge/sse] client ${client.id} error: ${error.message}`)
      this.remove(client)
    })
    return client
  }

  remove(client: SseClient): void {
    if (client.closed) return
    client.closed = true
    this.clients.delete(client)
    client.controller.abort()
  }

  send(client: SseClient, event: BridgeGlobalEvent): void {
    if (client.closed || client.res.destroyed) return
    if (client.filter !== undefined && !client.filter(event)) return
    this.sendWire(client, this.encode(event))
  }

  private encode(event: BridgeGlobalEvent): ReplayEntry {
    const data = JSON.stringify(toWireEvent(event))
    const wire = `id: ${event.payload.id}\ndata: ${data}\n\n`
    return { event, wire, bytes: Buffer.byteLength(wire) }
  }

  private sendWire(client: SseClient, entry: ReplayEntry): void {
    if (client.closed || client.res.destroyed) return
    try {
      client.res.write(entry.wire)
    } catch (error) {
      this.log(`[bridge/sse] write to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      this.remove(client)
    }
  }

  private remember(event: BridgeGlobalEvent): ReplayEntry {
    const entry = this.encode(event)
    this.replay.push(entry)
    this.replayBytes += entry.bytes
    while (this.replay.length > this.maxReplayEvents || this.replayBytes > this.maxReplayBytes) {
      const removed = this.replay.shift()
      if (removed === undefined) break
      this.replayBytes -= removed.bytes
    }
    return entry
  }

  /** Replay events strictly after a known event id; return false when the id
   * is outside the bounded ring (or was never observed). */
  replayAfter(client: SseClient, lastEventId: string): boolean {
    const index = this.replay.findIndex((entry) => entry.event.payload.id === lastEventId)
    if (index === -1) return false
    for (const entry of this.replay.slice(index + 1)) {
      if (client.filter !== undefined && !client.filter(entry.event)) continue
      this.sendWire(client, entry)
    }
    return true
  }

  /** Fan one event batch out to every connected SSE client. */
  broadcast(events: BridgeGlobalEvent[]): void {
    const entries = events.map((event) => this.remember(event))
    for (const client of [...this.clients]) {
      for (const entry of entries) {
        if (client.filter !== undefined && !client.filter(entry.event)) continue
        this.sendWire(client, entry)
      }
    }
  }

  /**
   * Broadcast a batch while retaining it for the first client when the
   * bridge has not acquired an SSE subscriber yet.  Unlike calling
   * `enqueue()` followed by `broadcast()`, this remembers each event in the
   * Last-Event-ID ring exactly once.
   */
  broadcastAndBufferIfIdle(events: BridgeGlobalEvent[]): void {
    if (this.clients.size === 0) this.pending.push(...events)
    this.broadcast(events)
  }

  /** Broadcast now, or buffer until the first client connects. */
  enqueue(events: BridgeGlobalEvent[]): void {
    if (this.clients.size === 0) {
      this.pending.push(...events)
      return
    }
    this.broadcast(events)
  }

  closeAll(): void {
    for (const client of [...this.clients]) {
      this.remove(client)
    }
  }

  get size(): number {
    return this.clients.size
  }
}
