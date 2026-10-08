/**
 * One voice call: a browser WebSocket paired with a Gemini Live session.
 *
 * The browser speaks a small protocol (binary PCM16 frames plus JSON control
 * messages, see {@link BrowserMessage} and {@link HostMessage}); this module
 * translates it to the Gemini Live BidiGenerateContent wire and back. Tool
 * calls are not executed here: they are forwarded to the browser, which owns
 * the harness session the user is looking at, and the browser answers with a
 * `tool_response`. The API key never leaves the host.
 *
 * Gemini closes a Live connection after a fixed lifetime (announced with
 * `goAway`); the relay reconnects with the latest session-resumption handle so
 * the conversation continues across connections.
 */

import { WebSocket, type RawData } from 'ws'
import type { Context } from '@deepseek-ai/cordis'

/** Gemini Live BidiGenerateContent endpoint (API-key authenticated). */
const GEMINI_LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

/** Microphone format the browser sends and Gemini expects. */
const INPUT_MIME = 'audio/pcm;rate=16000'

/**
 * Resumptions attempted after Gemini closes before a new session completes
 * setup. A connection that keeps closing (quota, revoked key) ends the call
 * instead of reconnecting in a loop.
 */
const MAX_RESUME_ATTEMPTS = 3

/** Browser → host control messages (audio travels as binary frames). */
export type BrowserMessage =
  | { type: 'tool_response'; id: string; name: string; response: Record<string, unknown> }
  | { type: 'agent_update'; text: string }
  | { type: 'text'; text: string }
  /** The browser paused its microphone stream because the user is silent. */
  | { type: 'audio_end' }

/** Host → browser control messages (model audio travels as binary PCM16 24 kHz frames). */
export type HostMessage =
  | { type: 'ready'; model: string }
  | { type: 'input_transcript'; text: string }
  | { type: 'output_transcript'; text: string }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_cancel'; ids: string[] }
  | { type: 'reconnecting' }
  | { type: 'error'; message: string }
  /** Running totals for this call, sent after every model turn that reports usage. */
  | { type: 'usage'; usage: CallUsage }

/** USD per million tokens, by direction and modality. */
export interface TokenPrices {
  audioInput: number
  textInput: number
  audioOutput: number
  /** Also applied to thinking tokens. */
  textOutput: number
}

/**
 * Token and cost totals for one call. Gemini Live reports usage per model
 * turn, and each turn's prompt count covers the whole context window that turn
 * re-processed, so the call's billed tokens are the sum over turns.
 */
export interface CallUsage {
  audioInputTokens: number
  textInputTokens: number
  audioOutputTokens: number
  /** Text output plus thinking tokens. */
  textOutputTokens: number
  /** Estimated cost in USD at the configured prices; cached-context discounts are not applied. */
  costUsd: number
}

/** Everything one call needs to open its Gemini Live session. */
export interface LiveCallOptions {
  apiKey: string
  model: string
  voice: string
  /** Complete system instruction text. */
  instructions: string
  /** Gemini function declarations offered to the voice model. */
  functionDeclarations: readonly object[]
  prices: TokenPrices
  logger: Context['logger']
}

/** Gemini Live server message fields this relay reads. */
interface LiveServerMessage {
  setupComplete?: object
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> }
    inputTranscription?: { text?: string }
    outputTranscription?: { text?: string }
    interrupted?: boolean
    turnComplete?: boolean
  }
  toolCall?: { functionCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }> }
  toolCallCancellation?: { ids?: string[] }
  goAway?: { timeLeft?: string }
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean }
  error?: { message?: string }
  usageMetadata?: UsageMetadata
}

/** Gemini usage report for one model turn. */
interface UsageMetadata {
  promptTokenCount?: number
  responseTokenCount?: number
  thoughtsTokenCount?: number
  toolUsePromptTokenCount?: number
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>
  responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>
}

/**
 * Run one call until either side closes.
 * @param client - the accepted browser WebSocket.
 * @param options - model, voice, prompt, tools, and credential for this call.
 */
export function runLiveCall(client: WebSocket, options: LiveCallOptions): void {
  const { logger } = options
  let upstream: WebSocket | undefined
  let resumeHandle: string | undefined
  let ended = false
  /** Consecutive resumptions without a completed setup. */
  let resumeAttempts = 0
  let resumeTimer: ReturnType<typeof setTimeout> | undefined
  /** Control frames the browser sent while (re)connecting; audio is dropped instead of queued. */
  const pending: string[] = []
  let ready = false
  const usage: CallUsage = { audioInputTokens: 0, textInputTokens: 0, audioOutputTokens: 0, textOutputTokens: 0, costUsd: 0 }

  const toBrowser = (message: HostMessage): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }
  const toGemini = (payload: object): void => {
    if (ready && upstream?.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify(payload))
      return
    }
    pending.push(JSON.stringify(payload))
  }

  const end = (code: number, reason: string): void => {
    if (ended) return
    ended = true
    clearTimeout(resumeTimer)
    try { upstream?.close() } catch { upstream?.terminate() }
    try { client.close(code, reason.slice(0, 120)) } catch { client.terminate() }
  }

  const connect = (): void => {
    ready = false
    const socket = new WebSocket(`${GEMINI_LIVE_URL}?key=${encodeURIComponent(options.apiKey)}`, {
      handshakeTimeout: 15_000,
    })
    upstream = socket
    socket.on('open', () => {
      socket.send(JSON.stringify({ setup: setupMessage(options, resumeHandle) }))
    })
    socket.on('message', (data) => {
      let message: LiveServerMessage
      try {
        message = JSON.parse(rawText(data)) as LiveServerMessage
      } catch {
        // Gemini only sends JSON frames; a non-JSON frame carries nothing to relay.
        return
      }
      handleServerMessage(socket, message)
    })
    socket.on('close', (code, reason) => {
      if (ended || socket !== upstream) return
      const text = reason.toString('utf-8')
      // A resumable session that closed on its own (lifetime limit, goAway)
      // continues on a fresh connection; anything else ends the call.
      if (resumeHandle !== undefined && code !== 1008 && code !== 1007 && resumeAttempts < MAX_RESUME_ATTEMPTS) {
        resumeAttempts += 1
        logger.info('voice-agent: Gemini Live connection closed (%d %s); resuming (attempt %d)', code, text, resumeAttempts)
        toBrowser({ type: 'reconnecting' })
        resumeTimer = setTimeout(connect, 1000 * (resumeAttempts - 1))
        return
      }
      toBrowser({ type: 'error', message: `Gemini Live closed the session (${String(code)}${text === '' ? '' : `: ${text}`})` })
      end(1011, 'Gemini Live closed')
    })
    socket.on('error', (error: Error) => {
      logger.warn('voice-agent: Gemini Live socket error: %s', error.message)
      if (!ready) {
        toBrowser({ type: 'error', message: `Cannot reach Gemini Live: ${error.message}` })
        end(1011, 'Gemini Live unreachable')
      }
    })
  }

  const handleServerMessage = (socket: WebSocket, message: LiveServerMessage): void => {
    // Usage rides on other messages (with serverContent), so it is read before any early return.
    if (message.usageMetadata !== undefined) {
      addUsage(usage, message.usageMetadata, options.prices)
      toBrowser({ type: 'usage', usage: { ...usage } })
    }
    if (message.setupComplete !== undefined) {
      ready = true
      resumeAttempts = 0
      for (const frame of pending.splice(0)) socket.send(frame)
      toBrowser({ type: 'ready', model: options.model })
      return
    }
    if (message.sessionResumptionUpdate?.resumable === true && message.sessionResumptionUpdate.newHandle) {
      resumeHandle = message.sessionResumptionUpdate.newHandle
      return
    }
    if (message.goAway !== undefined) {
      logger.info('voice-agent: Gemini Live goAway (time left %s)', message.goAway.timeLeft ?? '?')
      return
    }
    if (message.toolCall?.functionCalls !== undefined) {
      for (const call of message.toolCall.functionCalls) {
        toBrowser({ type: 'tool_call', id: call.id, name: call.name, args: call.args ?? {} })
      }
      return
    }
    if (message.toolCallCancellation?.ids !== undefined) {
      toBrowser({ type: 'tool_cancel', ids: message.toolCallCancellation.ids })
      return
    }
    if (message.error?.message !== undefined) {
      toBrowser({ type: 'error', message: message.error.message })
      return
    }
    const content = message.serverContent
    if (content === undefined) return
    for (const part of content.modelTurn?.parts ?? []) {
      const audio = part.inlineData?.data
      if (audio !== undefined && client.readyState === WebSocket.OPEN) {
        client.send(Buffer.from(audio, 'base64'), { binary: true })
      }
    }
    if (content.inputTranscription?.text) toBrowser({ type: 'input_transcript', text: content.inputTranscription.text })
    if (content.outputTranscription?.text) toBrowser({ type: 'output_transcript', text: content.outputTranscription.text })
    if (content.interrupted === true) toBrowser({ type: 'interrupted' })
    if (content.turnComplete === true) toBrowser({ type: 'turn_complete' })
  }

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      // Audio captured while the upstream is (re)connecting is stale by the
      // time it could be delivered, so it is dropped rather than queued.
      if (!ready || upstream?.readyState !== WebSocket.OPEN) return
      const chunk = rawBuffer(data)
      upstream.send(JSON.stringify({ realtimeInput: { audio: { data: chunk.toString('base64'), mimeType: INPUT_MIME } } }))
      return
    }
    let message: BrowserMessage
    try {
      message = JSON.parse(rawText(data)) as BrowserMessage
    } catch {
      toBrowser({ type: 'error', message: 'Invalid control message' })
      return
    }
    switch (message.type) {
      case 'tool_response':
        toGemini({ toolResponse: { functionResponses: [{ id: message.id, name: message.name, response: message.response }] } })
        return
      case 'audio_end':
        // Flushes Gemini's buffered audio so its activity detection can close
        // the turn; a pause sent while reconnecting is meaningless and dropped.
        if (ready && upstream?.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
        }
        return
      case 'agent_update':
      case 'text':
        toGemini({ clientContent: { turns: [{ role: 'user', parts: [{ text: message.text }] }], turnComplete: true } })
        return
      default:
        toBrowser({ type: 'error', message: 'Unknown control message' })
    }
  })
  client.on('close', () => { end(1000, 'call ended') })
  client.on('error', () => { end(1011, 'browser socket error') })

  connect()
}

/**
 * Build the Gemini Live `setup` message.
 * @param options - call options.
 * @param handle - resumption handle when continuing an earlier connection.
 * @returns the setup payload.
 */
function setupMessage(options: LiveCallOptions, handle: string | undefined): object {
  return {
    model: `models/${options.model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
    },
    systemInstruction: { parts: [{ text: options.instructions }] },
    tools: [{ functionDeclarations: options.functionDeclarations }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 300,
        silenceDurationMs: 800,
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: handle === undefined ? {} : { handle },
  }
}

/**
 * Join one ws frame payload into a single buffer.
 * @param data - frame payload as ws delivers it.
 * @returns the payload bytes.
 */
function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/**
 * Decode one ws frame payload as UTF-8 text.
 * @param data - frame payload as ws delivers it.
 * @returns the decoded text.
 */
function rawText(data: RawData): string {
  return rawBuffer(data).toString('utf-8')
}

/**
 * Add one turn's usage to the call totals. Prompt tokens not reported as audio
 * (text, tool results, tool-use prompt) are priced as text input; response
 * tokens not reported as audio, plus thinking tokens, as text output.
 * @param total - running call totals, updated in place.
 * @param turn - Gemini's usage report for one model turn.
 * @param prices - USD per million tokens.
 */
function addUsage(total: CallUsage, turn: UsageMetadata, prices: TokenPrices): void {
  const audioIn = modalityTokens(turn.promptTokensDetails, 'AUDIO')
  const textIn = Math.max(0, (turn.promptTokenCount ?? 0) - audioIn) + (turn.toolUsePromptTokenCount ?? 0)
  const audioOut = modalityTokens(turn.responseTokensDetails, 'AUDIO')
  const textOut = Math.max(0, (turn.responseTokenCount ?? 0) - audioOut) + (turn.thoughtsTokenCount ?? 0)
  total.audioInputTokens += audioIn
  total.textInputTokens += textIn
  total.audioOutputTokens += audioOut
  total.textOutputTokens += textOut
  total.costUsd += (audioIn * prices.audioInput + textIn * prices.textInput
    + audioOut * prices.audioOutput + textOut * prices.textOutput) / 1_000_000
}

/**
 * @param details - per-modality token counts.
 * @param modality - modality name as Gemini reports it.
 * @returns the tokens reported for that modality.
 */
function modalityTokens(details: UsageMetadata['promptTokensDetails'], modality: string): number {
  return (details ?? []).filter(entry => entry.modality === modality).reduce((sum, entry) => sum + (entry.tokenCount ?? 0), 0)
}
