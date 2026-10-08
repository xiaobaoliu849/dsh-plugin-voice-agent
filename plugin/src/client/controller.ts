/**
 * One voice call's lifecycle and UI state: the WebSocket to the host relay,
 * microphone capture, speech playback, and the harness bridge that executes
 * the voice model's tool calls. Every surface (mic button, dock) reads the
 * same snapshot through {@link VoiceAgentController.subscribe}.
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { startMic, SpeechPlayer, type MicCapture } from './audio.ts'
import { HarnessBridge, type AgentActivity } from './bridge.ts'

/** Host route the call WebSocket upgrades on. */
const CALL_PATH = '/api/voice-agent/ws'

/** Lines kept in the dock transcript. */
const MAX_LINES = 8

/** Call connection phase. */
export type CallPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'

/** One transcript line: the user, the voice model, or an agent report. */
export interface TranscriptLine {
  readonly role: 'user' | 'assistant' | 'agent'
  readonly text: string
}

/** Immutable snapshot every voice-agent surface renders. */
export interface VoiceAgentState {
  readonly phase: CallPhase
  readonly muted: boolean
  readonly activity: AgentActivity
  readonly lines: readonly TranscriptLine[]
  /** Raw error text from the host, the browser, or Gemini; shown verbatim. */
  readonly error: string | null
}

/** Host → browser control messages (mirrors the host package's HostMessage). */
type HostMessage =
  | { type: 'ready'; model: string }
  | { type: 'input_transcript'; text: string }
  | { type: 'output_transcript'; text: string }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_cancel'; ids: string[] }
  | { type: 'reconnecting' }
  | { type: 'error'; message: string }

const IDLE: VoiceAgentState = { phase: 'idle', muted: false, activity: 'idle', lines: [], error: null }

/** Owns at most one call at a time. */
export class VoiceAgentController {
  private state: VoiceAgentState = IDLE
  private readonly listeners = new Set<() => void>()
  private socket: WebSocket | undefined
  private mic: MicCapture | undefined
  private player: SpeechPlayer | undefined
  private bridge: HarnessBridge | undefined
  private sessionId: SessionId | undefined

  /** @param sessions - the client sessions service the bridge drives. */
  constructor(private readonly sessions: ISessions) {}

  /**
   * Point the call at the conversation the user is viewing. The composer's
   * session-scoped controls report it on every render.
   * @param id - the viewed session, or undefined while none is open.
   */
  setSession(id: SessionId | undefined): void {
    this.sessionId = id
  }

  /** @returns the current snapshot (stable until the next change). */
  getSnapshot = (): VoiceAgentState => this.state

  /**
   * Observe snapshot changes.
   * @param listener - called after each change.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns microphone and speaker levels in [0, 1] for the activity meter. */
  levels(): { mic: number; speaker: number } {
    return { mic: this.mic?.level() ?? 0, speaker: this.player?.level() ?? 0 }
  }

  /** Start a call; no-op while one is running. Must run inside a user gesture (autoplay policy). */
  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') return
    this.set({ ...IDLE, phase: 'connecting' })
    const player = new SpeechPlayer()
    this.player = player
    await player.resume()
    this.bridge = new HarnessBridge(
      this.sessions,
      () => this.sessionId,
      (text) => { this.sendUpdate(text) },
      (activity) => { this.set({ ...this.state, activity }) },
    )
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${window.location.host}${CALL_PATH}`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data !== 'string') {
        this.player?.enqueue(event.data)
        return
      }
      this.handle(JSON.parse(event.data) as HostMessage)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      const message = event.code === 1000 ? null : (this.state.error ?? (event.reason || `Connection closed (${String(event.code)})`))
      this.teardown()
      this.set({ ...this.state, phase: message === null ? 'idle' : 'error', error: message, activity: 'idle' })
    }
  }

  /** Hang up. Tasks already handed to the agent keep running. */
  end(): void {
    this.teardown()
    this.set({ ...this.state, phase: 'idle', activity: 'idle' })
  }

  /** Toggle sending microphone audio. */
  toggleMute(): void {
    const muted = !this.state.muted
    this.mic?.setMuted(muted)
    this.set({ ...this.state, muted })
  }

  private handle(message: HostMessage): void {
    switch (message.type) {
      case 'ready':
        this.set({ ...this.state, phase: 'live', error: null })
        if (this.mic === undefined) void this.openMic()
        return
      case 'input_transcript':
        this.appendText('user', message.text)
        return
      case 'output_transcript':
        this.appendText('assistant', message.text)
        return
      case 'interrupted':
        this.player?.flush()
        return
      case 'turn_complete':
        return
      case 'tool_call':
        void this.bridge?.call(message.name, message.args).then((response) => {
          this.send({ type: 'tool_response', id: message.id, name: message.name, response })
        })
        return
      case 'tool_cancel':
        // Harness tasks are not cancelled with the voice model's call: the
        // user stops the agent explicitly through stop_harness.
        return
      case 'reconnecting':
        this.set({ ...this.state, phase: 'reconnecting' })
        return
      case 'error':
        this.set({ ...this.state, error: message.message })
        return
      default:
        message satisfies never
    }
  }

  private async openMic(): Promise<void> {
    try {
      this.mic = await startMic((frame) => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame)
      })
      this.mic.setMuted(this.state.muted)
    } catch (error) {
      this.teardown()
      this.set({ ...this.state, phase: 'error', activity: 'idle', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private sendUpdate(text: string): void {
    this.pushLine({ role: 'agent', text: text.replace(/^\[agent update\]\s*/, '') })
    this.send({ type: 'agent_update', text })
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  /** Streamed transcript fragments extend the last line while the same speaker continues. */
  private appendText(role: 'user' | 'assistant', fragment: string): void {
    const last = this.state.lines.at(-1)
    if (last?.role === role) {
      const lines = [...this.state.lines.slice(0, -1), { role, text: last.text + fragment }]
      this.set({ ...this.state, lines })
      return
    }
    this.pushLine({ role, text: fragment.trimStart() })
  }

  private pushLine(line: TranscriptLine): void {
    this.set({ ...this.state, lines: [...this.state.lines, line].slice(-MAX_LINES) })
  }

  private teardown(): void {
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined && socket.readyState <= WebSocket.OPEN) socket.close(1000)
    this.mic?.stop()
    this.mic = undefined
    this.player?.close()
    this.player = undefined
    this.bridge?.dispose()
    this.bridge = undefined
  }

  private set(next: VoiceAgentState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
