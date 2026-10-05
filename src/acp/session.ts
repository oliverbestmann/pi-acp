import type {
  AgentSideConnection,
  ContentBlock,
  CreateElicitationResponse,
  EnumOption,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import {
  PiRpcProcess,
  PiRpcSpawnError,
  SESSION_STATS_TIMEOUT_MS,
  type PiRpcEvent,
  type PiSessionStats
} from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  capBashOutput,
  isBashTool
} from './translate/bash.js'
import { toolInputContent, toolResultToText, toolTitle } from './translate/pi-tools.js'
import { customMessageToolCall } from './translate/pi-messages.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  supportsElicitationForm?: boolean
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  title?: string
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  title?: string
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

/**
 * Map pi's `stats.contextUsage` to an ACP `usage_update`. Returns null whenever pi
 * reports no trustworthy token count (e.g. `tokens: null` right after compaction) or
 * the values are not usable integers.
 */
function toUsageUpdate(stats: PiSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow

  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null

  return { sessionUpdate: 'usage_update', used, size }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      autoTitle: true,
      initialSessionName: typeof state?.sessionName === 'string' ? state.sessionName : undefined,
      supportsElicitationForm: params.supportsElicitationForm ?? false
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      autoTitle: false,
      supportsElicitationForm: params.supportsElicitationForm ?? false
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false
  private initialTitlePending: boolean
  private lastPublishedTitle: string | null | undefined
  private titleUpdateQueue: Promise<void> = Promise.resolve()

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly supportsElicitationForm: boolean

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()
  private lastSessionName: string | undefined
  private lastUsageCheckAt = 0
  private usageCheckInFlight = false

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    autoTitle?: boolean
    initialSessionName?: string
    supportsElicitationForm?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.initialTitlePending = opts.autoTitle ?? false
    this.lastSessionName = opts.initialSessionName
    this.supportsElicitationForm = opts.supportsElicitationForm ?? false

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  /** Record a session name we just set ourselves (e.g. via `/name`), to avoid re-announcing it. */
  noteSessionNameSet(name: string): void {
    this.lastSessionName = name
  }

  /**
   * Pi has no push event for context-window usage. Poll `get_session_stats` and emit ACP
   * `usage_update` so clients can render a context/cost meter. Called once per turn on
   * settlement, and throttled during streaming (see `maybeCheckUsageWhileStreaming`) so long
   * turns don't leave the meter stale until the very end.
   */
  private async checkUsageChanged(): Promise<void> {
    if (this.usageCheckInFlight) return
    this.usageCheckInFlight = true
    this.lastUsageCheckAt = Date.now()
    try {
      let stats: unknown
      try {
        stats = await this.proc.getSessionStats()
      } catch {
        return
      }

      const s = stats as { contextUsage?: { tokens?: unknown; contextWindow?: unknown }; cost?: unknown } | null
      const used = s?.contextUsage?.tokens
      const size = s?.contextUsage?.contextWindow
      if (typeof used !== 'number' || typeof size !== 'number') return

      const cost = typeof s?.cost === 'number' ? { amount: s.cost, currency: 'USD' } : null

      this.emit({
        sessionUpdate: 'usage_update',
        used,
        size,
        cost
      })
    } finally {
      this.usageCheckInFlight = false
    }
  }

  /**
   * During a long turn, pi streams assistant text/thinking token deltas continuously.
   * Piggyback on that stream to refresh the usage meter roughly every 2s instead of only
   * once the whole turn settles, without spamming `get_session_stats` on every token.
   */
  private maybeCheckUsageWhileStreaming(): void {
    if (Date.now() - this.lastUsageCheckAt < 2000) return
    void this.checkUsageChanged()
  }

  /**
   * Pi has no RPC event for session renames made outside the `/name` command (e.g. another
   * extension calling `pi.setSessionName()` directly). Poll `get_state` after each turn settles
   * and diff against the last known name, emitting `session_info_update` on change.
   */
  private async checkSessionNameChanged(): Promise<void> {
    let state: unknown
    try {
      state = await this.proc.getState()
    } catch {
      return
    }

    const name = (state as { sessionName?: unknown } | null)?.sessionName
    const current = typeof name === 'string' ? name : undefined
    if (current === this.lastSessionName) return

    this.lastSessionName = current
    // publishTitle dedupes against titles already sent via /name or auto-titling.
    void this.publishTitle(current ?? null)
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = [], title?: string): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, title, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  async setSessionName(name: string): Promise<void> {
    return this.enqueueTitleUpdate(async () => {
      await this.proc.setSessionName(name)
      this.publishTitle(name)
    })
  }

  private enqueueTitleUpdate(update: () => Promise<void>): Promise<void> {
    const result = this.titleUpdateQueue.then(update)
    this.titleUpdateQueue = result.catch(() => {})
    return result
  }

  publishTitle(title: string | null, updatedAt: string | null = new Date().toISOString()): Promise<void> {
    if (this.lastPublishedTitle === title) return this.lastEmit
    this.lastPublishedTitle = title
    this.emit({
      sessionUpdate: 'session_info_update',
      title,
      ...(updatedAt ? { updatedAt } : {})
    })
    return this.lastEmit
  }

  private async maybeAutoTitle(title?: string): Promise<void> {
    if (!this.initialTitlePending || !title) return
    this.initialTitlePending = false

    try {
      await this.enqueueTitleUpdate(async () => {
        const state = (await this.proc.getState()) as { sessionName?: unknown } | null
        const currentTitle = typeof state?.sessionName === 'string' ? state.sessionName.trim() : ''
        if (currentTitle) {
          this.publishTitle(currentTitle)
          return
        }
        if (this.lastPublishedTitle) return

        await this.proc.setSessionName(title)
        this.publishTitle(title)
      })
    } catch {
      // Auto-titling is best-effort and must not fail the completed prompt.
    }
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  /**
   * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
   * Queued updates are flushed even when the stats query fails or times out, so callers
   * can await this before resolving `session/prompt`.
   */
  async publishContextUsage(): Promise<void> {
    try {
      // Older/stubbed pi processes may not expose the stats RPC at all.
      if (typeof this.proc.getSessionStats === 'function') {
        const update = toUsageUpdate(await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS))
        if (update) this.emit(update)
      }
    } catch {
      // Context usage is auxiliary; never fail or delay the turn because of it.
    }

    await this.flushEmits()
  }

  private async settleTurn(): Promise<void> {
    // Ensure all updates derived from pi events (plus the final usage update) are
    // delivered before we resolve the ACP `session/prompt` request.
    await this.publishContextUsage()

    const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
    this.pendingTurn?.resolve(reason)
    this.pendingTurn = null
    this.inAgentLoop = false

    // Start next queued prompt, if any.
    const next = this.turnQueue.shift()
    if (next) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = capBashOutput(bashResultText(params.result))
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false

    this.pendingTurn = { title: t.title, resolve: t.resolve, reject: t.reject }
    void this.maybeAutoTitle(t.title)

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(err => {
      // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
      // Also ensure we flush any already-enqueued updates first.
      void this.flushEmits().finally(() => {
        // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
        const authErr = maybeAuthRequiredError(err)
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null
        this.inAgentLoop = false

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
      })
      void err
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'session_info_changed': {
        const name = (ev as { name?: unknown }).name
        if (typeof name === 'string' || name === undefined) this.publishTitle(name ?? null)
        break
      }

      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          this.maybeCheckUsageWhileStreaming()
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          this.maybeCheckUsageWhileStreaming()
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolTitle(toolName, rawInput),
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput,
                content: toolInputContent(toolName, rawInput)
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                title: toolTitle(toolName, rawInput),
                status,
                locations,
                rawInput,
                content: toolInputContent(toolName, rawInput)
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'message_start': {
        const update = customMessageToolCall((ev as any).message)
        if (update) this.emit(update)
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolTitle(toolName, args),
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args,
            content: toolInputContent(toolName, args)
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            title: toolTitle(toolName, args),
            status: 'in_progress',
            locations,
            rawInput: args,
            content: toolInputContent(toolName, args)
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'extension_error': {
        const extensionPath = stringProp(ev, 'extensionPath')
        const hookEvent = stringProp(ev, 'event')
        const error = stringProp(ev, 'error') ?? 'unknown error'
        const source = extensionPath ? `${extensionPath} (${hookEvent ?? 'unknown hook'})` : (hookEvent ?? 'extension')

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Extension error in ${source}: ${error}` } satisfies ContentBlock,
          _meta: { piAcp: { notify: { level: 'warning' } } }
        })
        break
      }

      // pi renamed `auto_compaction_start`/`auto_compaction_end` to `compaction_start`/`compaction_end`
      // (with a `reason` field: 'manual' | 'threshold' | 'overflow') in pi v0.63.1. `reason: 'manual'`
      // is skipped here because the `/compact` slash command already reports its own result from
      // the RPC response (see agent.ts); only threshold/overflow compaction needs a message here.
      case 'compaction_start': {
        if (stringProp(ev, 'reason') === 'manual') break

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'compaction_end': {
        if (stringProp(ev, 'reason') === 'manual') break

        const aborted = ev.aborted === true
        const errorMessage = stringProp(ev, 'errorMessage')
        const text = aborted
          ? 'Automatic compaction was aborted.'
          : errorMessage
            ? `Automatic compaction failed: ${errorMessage}`
            : 'Automatic compaction finished; context was summarized to continue the session.'

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        // settleTurn() publishes the final usage update, so only the name check is needed here.
        void this.checkSessionNameChanged()
        void this.settleTurn()
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      if (this.supportsElicitationForm) {
        await this.handleExtensionTextInput(ev, id, method)
        return
      }

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported by this client; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock,
        _meta: { piAcp: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
      })
      return
    }

    // `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, and any other fire-and-forget method:
    // pi does not expect an `extension_ui_response` for these (see docs/rpc.md), unlike the dialog
    // methods handled above.
  }

  // pi's built-in `select` UI flattens each option into one `"label — description"` string
  // (its `ctx.ui.select()` only accepts plain strings). We split that back apart so ACP clients
  // that support elicitation forms can render a proper wrapped option list (title + description
  // on separate lines) instead of squeezing the whole string into one unwrapped permission
  // button label.
  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (this.supportsElicitationForm) {
      await this.handleExtensionSelectViaElicitation(ev, id, options)
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionSelectViaElicitation(ev: PiRpcEvent, id: string, options: string[]): Promise<void> {
    const title = stringProp(ev, 'title') ?? 'Choose an option'

    // `EnumOption.description` is supported by ACP clients (incl. Zed) but missing from the
    // `@agentclientprotocol/sdk` types we currently depend on; the field still round-trips fine
    // over the JSON-RPC wire, so we widen the type locally instead of bumping the (major-version
    // behind) SDK dependency just for this.
    const oneOf = options.map(option => {
      const { title: optionTitle, description } = splitSelectOption(option)
      return { const: option, title: optionTitle, description } as unknown as EnumOption
    })

    let response: CreateElicitationResponse
    try {
      response = await this.conn.unstable_createElicitation({
        mode: 'form',
        sessionId: this.sessionId,
        message: title,
        requestedSchema: {
          type: 'object',
          properties: {
            value: {
              type: 'string',
              title,
              oneOf
            }
          },
          required: ['value']
        }
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const value = response.action === 'accept' ? response.content?.['value'] : null
    await this.proc.sendExtensionUiResponse(typeof value === 'string' ? { id, value } : { id, cancelled: true })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  // Maps pi's `input`/`editor` UI requests to ACP's unstable `session/create_elicitation` (form
  // mode, single string field), the only ACP mechanism for free-text prompts. Only called when
  // the client advertised `clientCapabilities.elicitation.form` at initialize.
  private async handleExtensionTextInput(ev: PiRpcEvent, id: string, method: 'input' | 'editor'): Promise<void> {
    const title = stringProp(ev, 'title') ?? (method === 'editor' ? 'Edit text' : 'Enter a value')
    const placeholder = stringProp(ev, 'placeholder')
    const prefill = stringProp(ev, 'prefill')

    let response: CreateElicitationResponse
    try {
      response = await this.conn.unstable_createElicitation({
        mode: 'form',
        sessionId: this.sessionId,
        message: title,
        requestedSchema: {
          type: 'object',
          properties: {
            value: {
              type: 'string',
              title,
              description: method === 'input' && placeholder ? `e.g. ${placeholder}` : undefined,
              default: method === 'editor' ? (prefill ?? undefined) : undefined
            }
          },
          required: ['value']
        }
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const value = response.action === 'accept' ? response.content?.['value'] : null
    if (typeof value !== 'string') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, value })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

// Splits pi's flattened "label — description" select option text (see e.g. the built-in
// ask_user_question tool) into a short title and an optional longer description, so ACP
// clients that support elicitation forms can render a proper wrapped option list instead of
// a single unwrapped button/line. Falls back to using the whole string as the title.
const OPTION_TITLE_DESCRIPTION_SEPARATOR = ' — '

function splitSelectOption(text: string): { title: string; description?: string } {
  const separatorIndex = text.indexOf(OPTION_TITLE_DESCRIPTION_SEPARATOR)
  if (separatorIndex === -1) return { title: text }

  const title = text.slice(0, separatorIndex).trim()
  const description = text.slice(separatorIndex + OPTION_TITLE_DESCRIPTION_SEPARATOR.length).trim()
  return title ? { title, description: description || undefined } : { title: text }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
