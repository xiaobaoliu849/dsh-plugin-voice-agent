/**
 * One voice call's lifecycle and UI state: the WebSocket to the host relay,
 * microphone capture, speech playback, and the harness bridge that executes
 * the voice model's tool calls. Every surface (mic button, dock) reads the
 * same snapshot through {@link VoiceAgentController.subscribe}.
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SpeechGate, startMic, SpeechPlayer, type MicCapture } from './audio.ts'
import { HarnessBridge, type AgentActivity, type AgentNotice } from './bridge.ts'

/** Host route the call WebSocket upgrades on. */
const CALL_PATH = '/api/voice-agent/ws'

/**
 * The call WebSocket URL. A page served by the Host resolves the route against
 * its own document; the desktop app serves the page from `dsh-app://app` and
 * names its Host's HTTP origin in `__DSH_TRANSPORT__.streamBaseUrl`, the same
 * base the harness Gateway uses for its own WebSocket.
 * @returns the absolute `ws:`/`wss:` URL of the call route.
 */
function callUrl(): string {
  const globals = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
  const url = new URL(CALL_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

/** Lines kept in the dock transcript. */
const MAX_LINES = 8

/** Call connection phase. */
export type CallPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'

/** One transcript line: speech from the user or the voice model, or a short agent notice. */
export type TranscriptLine =
  | { readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly role: 'agent'; readonly notice: AgentNotice }

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
  /** Incremented on every start and teardown; async steps from an older call abandon their result. */
  private generation = 0
  private micOpening = false
  /**
   * Whether the speech gate heard the user since the last agent update.
   * ask_harness and steer_harness require it: an agent update can quote file
   * or web content, and text injected there must not be able to start or
   * redirect agent work without the user speaking.
   */
  private userSpoke = false

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
    const generation = ++this.generation
    this.userSpoke = false
    const player = new SpeechPlayer()
    this.player = player
    await player.resume()
    // Hung up while the audio output was resuming: teardown already closed the player.
    if (generation !== this.generation) return
    this.bridge = new HarnessBridge(
      this.sessions,
      () => this.sessionId,
      (text, notice) => { this.sendUpdate(text, notice) },
      (activity) => { this.set({ ...this.state, activity }) },
    )
    const socket = new WebSocket(callUrl())
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
        if (this.mic === undefined && !this.micOpening) void this.openMic()
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
      case 'tool_call': {
        if ((message.name === 'ask_harness' || message.name === 'steer_harness') && !this.userSpoke) {
          this.send({
            type: 'tool_response',
            id: message.id,
            name: message.name,
            response: {
              status: 'refused',
              error: 'Only a request the user has just spoken can start or change a task. Ask the user what they want.',
            },
          })
          return
        }
        const bridge = this.bridge
        void bridge?.call(message.name, message.args).then((response) => {
          if (bridge === this.bridge) this.send({ type: 'tool_response', id: message.id, name: message.name, response })
        })
        return
      }
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
    const generation = this.generation
    this.micOpening = true
    try {
      const gate = new SpeechGate(
        (frame) => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame) },
        () => { this.send({ type: 'audio_end' }) },
        () => { this.userSpoke = true },
      )
      const mic = await startMic((frame) => { gate.push(frame) })
      // Hung up while the permission prompt or device setup was pending:
      // release the device instead of leaving it open without a call.
      if (generation !== this.generation) {
        mic.stop()
        return
      }
      this.mic = mic
      mic.setMuted(this.state.muted)
    } catch (error) {
      if (generation !== this.generation) return
      this.teardown()
      this.set({ ...this.state, phase: 'error', activity: 'idle', error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (generation === this.generation) this.micOpening = false
    }
  }

  private sendUpdate(text: string, notice: AgentNotice): void {
    this.userSpoke = false
    this.pushLine({ role: 'agent', notice })
    this.send({ type: 'agent_update', text })
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  /** Streamed transcript fragments extend the last line while the same speaker continues. */
  private appendText(role: 'user' | 'assistant', fragment: string): void {
    const last = this.state.lines.at(-1)
    if (last !== undefined && last.role === role && 'text' in last) {
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
    this.generation += 1
    this.micOpening = false
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
