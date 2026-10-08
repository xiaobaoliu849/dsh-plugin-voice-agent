/**
 * Executes the voice model's harness tools against the session the user is
 * viewing, and reports the agent's progress back to the voice model.
 *
 * `ask_harness` submits the task through the same prompt path the composer
 * uses (so it appears in the transcript as a normal user message), then
 * follows the session event window: the `user/message` carrying the prompt's
 * request id identifies the turn, and that turn's `turn/end` produces one
 * `[agent update]` with the final answer. Approval requests inside a followed
 * turn are reported as they happen so the user knows to act in the window.
 * Each followed session is retained (`voiceAgent` reference source) until the
 * call ends, so its event window stays live while the user looks elsewhere.
 */

import type {
  ISessions, SessionBinding, SessionEventLikeEntry, SessionFace, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A voice call following the turns it handed to the agent. */
    voiceAgent: unknown
  }
}

/** Longest final answer forwarded to the voice model, in characters. */
const MAX_ANSWER_CHARS = 1500

/** One task the voice model handed to the agent and is waiting on. */
interface Watch {
  readonly task: string
  readonly requestId: string
  /** Turn number, known once the prompt's `user/message` is observed. */
  turn: number | undefined
  tools: string[]
  answer: string
  /** Set by stop_harness: the turn's end is not reported. */
  silenced: boolean
}

/** Per-session event-window follower shared by all watches on that session. */
interface Follower {
  readonly session: SessionFace
  readonly watches: Watch[]
  lastSeq: number
  lastTurn: number | undefined
  dispose: () => void
}

/** What the dock shows about the agent. */
export type AgentActivity = 'idle' | 'working' | 'approval'

/**
 * Runs harness tools for one call.
 */
export class HarnessBridge {
  private readonly followers = new Map<SessionId, Follower>()

  /**
   * @param sessions - the client sessions service.
   * @param currentSession - the session the call controls (the one the mic button belongs to).
   * @param report - sends one `[agent update]` text to the voice model.
   * @param onActivity - receives agent activity changes for the dock.
   */
  constructor(
    private readonly sessions: ISessions,
    private readonly currentSession: () => SessionId | undefined,
    private readonly report: (text: string) => void,
    private readonly onActivity: (activity: AgentActivity) => void,
  ) {}

  /**
   * Execute one tool call from the voice model.
   * @param name - tool name.
   * @param args - tool arguments as the model produced them.
   * @returns the function response sent back to the voice model.
   */
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      switch (name) {
        case 'ask_harness':
          return await this.ask(stringArg(args, 'task'))
        case 'steer_harness':
          return await this.steer(stringArg(args, 'message'))
        case 'stop_harness':
          return await this.stop()
        case 'harness_status':
          return await this.status()
        default:
          return { status: 'error', error: `Unknown tool ${name}` }
      }
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Stop following every session; pending tasks keep running in the harness. */
  dispose(): void {
    for (const follower of this.followers.values()) follower.dispose()
    this.followers.clear()
  }

  private async ask(task: string): Promise<Record<string, unknown>> {
    const follower = await this.follow()
    const wasRunning = follower.session.getSnapshot().running
    // The watch exists before the prompt is sent: the prompt's `user/message`
    // and `turn/start` can be published before the prompt call resolves.
    await this.submit(follower, task, 'queue', (requestId) => {
      follower.watches.push({ task, requestId, turn: undefined, tools: [], answer: '', silenced: false })
    })
    this.onActivity('working')
    return {
      status: wasRunning ? 'queued' : 'started',
      note: wasRunning
        ? 'The agent is busy; this task runs after the current one. The result arrives later as an [agent update] message.'
        : 'The agent is working. The result arrives later as an [agent update] message.',
    }
  }

  private async steer(message: string): Promise<Record<string, unknown>> {
    const follower = await this.follow()
    if (!follower.session.getSnapshot().running) return this.ask(message)
    await this.submit(follower, message, 'steer')
    return { status: 'sent', note: 'The correction was delivered to the running task.' }
  }

  private async stop(): Promise<Record<string, unknown>> {
    const follower = await this.follow()
    if (!follower.session.getSnapshot().running) return { status: 'idle', note: 'The agent was not working.' }
    for (const watch of follower.watches) watch.silenced = true
    const result = await follower.session.cancel()
    if (!result.ok) return { status: 'error', error: result.error.message }
    return { status: 'stopped' }
  }

  private async status(): Promise<Record<string, unknown>> {
    const follower = await this.follow()
    const snapshot = follower.session.getSnapshot()
    const active = follower.watches.at(-1)
    return {
      status: snapshot.running ? 'working' : 'idle',
      ...active === undefined ? {} : {
        currentTask: active.task,
        recentTools: active.tools.slice(-8),
        latestText: truncate(active.answer, 600),
      },
      ...snapshot.lastAgentError === null ? {} : { lastError: snapshot.lastAgentError },
    }
  }

  /**
   * Send one prompt through the composer's submission path.
   * @param follower - follower of the target session.
   * @param text - prompt text.
   * @param mode - queue a new turn or steer the running one.
   * @param beforeSend - receives the request id before the prompt is sent.
   * @throws when the Host rejects the prompt.
   */
  private async submit(
    follower: Follower,
    text: string,
    mode: 'queue' | 'steer',
    beforeSend?: (requestId: string) => void,
  ): Promise<void> {
    const submission = follower.session.beginSubmission({ mode, text, attachments: [] })
    beforeSend?.(submission.requestId)
    const result = await follower.session.prompt([{ type: 'text', text }], mode, undefined, submission.requestId)
    if (!result.ok) {
      const index = follower.watches.findIndex(watch => watch.requestId === submission.requestId)
      if (index !== -1) follower.watches.splice(index, 1)
      throw new Error(result.error.message)
    }
  }

  /**
   * Follow the session the call controls, retaining it on first use.
   * @returns its follower.
   * @throws when no conversation is open.
   */
  private async follow(): Promise<Follower> {
    const sessionId = this.currentSession()
    if (sessionId === undefined) throw new Error('No conversation is open. Ask the user to open or start one.')
    const existing = this.followers.get(sessionId)
    if (existing !== undefined) return existing
    const reference: SessionReference = this.sessions.retain(sessionId, { source: 'voiceAgent' })
    let binding: SessionBinding
    try {
      binding = await reference.ready
    } catch (error) {
      reference.release()
      throw error
    }
    const raced = this.followers.get(sessionId)
    if (raced !== undefined) {
      reference.release()
      return raced
    }
    const source = binding.eventSource
    const follower: Follower = {
      session: binding.session,
      watches: [],
      lastSeq: lastDurableSeq(source.getSnapshot().entries),
      lastTurn: undefined,
      dispose: () => {},
    }
    const unsubscribe = source.subscribe(() => {
      const change = source.getSnapshot().change
      switch (change.kind) {
        case 'append':
          for (const entry of change.entries) this.observe(follower, entry)
          return
        case 'settle-assistant':
          if (change.entry !== undefined) this.observe(follower, change.entry)
          return
        default:
          // replace / prepend: rescan the window; already-seen sequence numbers are skipped.
          for (const entry of source.getSnapshot().entries) this.observe(follower, entry)
      }
    })
    follower.dispose = () => {
      unsubscribe()
      reference.release()
    }
    this.followers.set(sessionId, follower)
    return follower
  }

  private observe(follower: Follower, entry: SessionEventLikeEntry): void {
    // Transient live chunks are previews; the settled assistant/message carries the text.
    if (entry.type !== 'event') return
    const event = entry.event
    if (event.seq <= follower.lastSeq) return
    follower.lastSeq = event.seq
    switch (event.type) {
      case 'turn/start':
        follower.lastTurn = event.data.turn
        return
      case 'user/message': {
        const source = event.data.source as { kind?: string; rpcId?: string }
        const watch = follower.watches.find(candidate => candidate.requestId === source.rpcId)
        if (watch !== undefined) watch.turn = follower.lastTurn
        return
      }
      case 'tool/call':
        this.watchOf(follower, event.data.turn)?.tools.push(event.data.name)
        return
      case 'assistant/message': {
        const watch = this.watchOf(follower, event.data.turn)
        const text = event.data.message.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])
          .join('')
          .trim()
        if (watch !== undefined && text !== '') watch.answer = text
        return
      }
      case 'turn/end':
        this.finish(follower, event.data.turn, event.data.reason)
        return
      default:
        if ((event.type as string) === 'approval/asked' && follower.watches.some(watch => watch.turn !== undefined)) {
          const data = (event as { data: { toolName?: string; reason?: string } }).data
          this.onActivity('approval')
          this.report(`[agent update] The agent is waiting for the user's approval in the window before running the ${data.toolName ?? 'next'} tool${data.reason === undefined ? '' : ` (${data.reason})`}. Ask the user to approve or deny it there.`)
        }
    }
  }

  private watchOf(follower: Follower, turn: number): Watch | undefined {
    return follower.watches.find(watch => watch.turn === turn)
  }

  private finish(follower: Follower, turn: number, reason: { kind: string; error?: { message?: string } }): void {
    const index = follower.watches.findIndex(watch => watch.turn === turn)
    if (index === -1) return
    const [watch] = follower.watches.splice(index, 1)
    if (follower.watches.length === 0) this.onActivity('idle')
    if (watch === undefined || watch.silenced) return
    const tools = watch.tools.length === 0 ? 'none' : [...new Set(watch.tools)].join(', ')
    if (reason.kind === 'aborted') {
      this.report(`[agent update] The task "${watch.task}" was cancelled before it finished.`)
      return
    }
    if (reason.kind === 'error') {
      this.report(`[agent update] The task "${watch.task}" failed: ${reason.error?.message ?? 'unknown error'}.`)
      return
    }
    this.report(`[agent update] The agent finished the task "${watch.task}". Tools used: ${tools}. Its final answer:\n${truncate(watch.answer, MAX_ANSWER_CHARS) || '(no text answer)'}`)
  }
}

/** Highest durable event sequence in a window; transient entries carry no durable seq. */
function lastDurableSeq(entries: readonly SessionEventLikeEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.type === 'event') return entry.event.seq
  }
  return -1
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${key}`)
  return value.trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
