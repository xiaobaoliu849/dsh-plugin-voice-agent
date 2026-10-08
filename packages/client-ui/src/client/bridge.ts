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
 */

import type { ISessions, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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
   * @param report - sends one `[agent update]` text to the voice model.
   * @param onActivity - receives agent activity changes for the dock.
   */
  constructor(
    private readonly sessions: ISessions,
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
          return this.status()
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
    const session = await this.currentSession(true)
    const wasRunning = session.getSnapshot().running
    // The watch exists before the prompt is sent: the prompt's `user/message`
    // and `turn/start` can be published before the prompt call resolves.
    const follower = this.follow(session.sessionId)
    await this.submit(session, task, 'queue', (requestId) => {
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
    const session = await this.currentSession(false)
    if (!session.getSnapshot().running) return this.ask(message)
    await this.submit(session, message, 'steer')
    return { status: 'sent', note: 'The correction was delivered to the running task.' }
  }

  private async stop(): Promise<Record<string, unknown>> {
    const session = await this.currentSession(false)
    if (!session.getSnapshot().running) return { status: 'idle', note: 'The agent was not working.' }
    for (const watch of this.followers.get(session.sessionId)?.watches ?? []) watch.silenced = true
    const result = await session.cancel()
    if (!result.ok) return { status: 'error', error: result.error.message }
    return { status: 'stopped' }
  }

  private status(): Record<string, unknown> {
    const id = this.sessions.list.getSnapshot().current
    const session = id === undefined ? undefined : this.sessions.binding(id)?.session
    if (session === undefined) return { status: 'no-session', note: 'No conversation is open.' }
    const snapshot = session.getSnapshot()
    const watches = this.followers.get(session.sessionId)?.watches ?? []
    const active = watches.at(-1)
    return {
      status: snapshot.running ? 'working' : 'idle',
      queuedTasks: snapshot.queue.length,
      ...active === undefined ? {} : {
        currentTask: active.task,
        recentTools: active.tools.slice(-8),
        latestText: truncate(active.answer, 600),
      },
      ...snapshot.lastAgentError === null ? {} : { lastError: snapshot.lastAgentError },
    }
  }

  /**
   * Resolve the session the user is viewing.
   * @param create - start a new session when none is open.
   * @returns its face.
   * @throws when no session is open and `create` is false.
   */
  private async currentSession(create: boolean): Promise<SessionFace> {
    let id = this.sessions.list.getSnapshot().current
    if (id === undefined) {
      if (!create) throw new Error('No conversation is open.')
      id = await this.sessions.create()
      this.sessions.open(id)
    }
    const binding = this.sessions.binding(id)
    if (binding === undefined) throw new Error('The open conversation is not available yet.')
    return binding.session
  }

  /**
   * Send one prompt through the composer's submission path.
   * @param session - target session.
   * @param text - prompt text.
   * @param mode - queue a new turn or steer the running one.
   * @param beforeSend - receives the request id before the prompt is sent.
   * @throws when the Host rejects the prompt.
   */
  private async submit(
    session: SessionFace,
    text: string,
    mode: 'queue' | 'steer',
    beforeSend?: (requestId: string) => void,
  ): Promise<void> {
    const submission = session.beginSubmission({ mode, text, images: [] })
    beforeSend?.(submission.requestId)
    const result = await session.prompt([{ type: 'text', text }], mode, undefined, submission.requestId)
    if (!result.ok) {
      this.forget(session.sessionId, submission.requestId)
      throw new Error(result.error.message)
    }
  }

  private forget(sessionId: SessionId, requestId: string): void {
    const follower = this.followers.get(sessionId)
    if (follower === undefined) return
    const index = follower.watches.findIndex(watch => watch.requestId === requestId)
    if (index !== -1) follower.watches.splice(index, 1)
  }

  private follow(sessionId: SessionId): Follower {
    const existing = this.followers.get(sessionId)
    if (existing !== undefined) return existing
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('The conversation closed.')
    const source = binding.eventSource
    const initial = source.getSnapshot().entries
    const follower: Follower = {
      watches: [],
      lastSeq: initial.at(-1)?.event.seq ?? -1,
      lastTurn: undefined,
      dispose: () => {},
    }
    follower.dispose = source.subscribe(() => {
      const window = source.getSnapshot()
      const entries = window.change.kind === 'append' ? window.change.entries : window.entries
      for (const entry of entries) this.observe(follower, entry)
    })
    this.followers.set(sessionId, follower)
    return follower
  }

  private observe(follower: Follower, entry: SessionEventLikeEntry): void {
    // Historical chunk rows never belong to a turn started during this call.
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

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${key}`)
  return value.trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
