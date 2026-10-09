import { WebSocket, type RawData } from 'ws'
import type { BrowserMessage, HostMessage, ProviderSessionOptions, CallUsage } from './types.ts'

const GEMINI_LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
const INPUT_MIME = 'audio/pcm;rate=16000'
const MAX_RESUME_ATTEMPTS = 3

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
  usageMetadata?: {
    promptTokenCount?: number
    responseTokenCount?: number
    thoughtsTokenCount?: number
    toolUsePromptTokenCount?: number
    promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>
    responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>
  }
}

export function runGeminiCall(client: WebSocket, options: ProviderSessionOptions): void {
  const { logger } = options
  let upstream: WebSocket | undefined
  let resumeHandle: string | undefined
  let ended = false
  let resumeAttempts = 0
  let resumeTimer: ReturnType<typeof setTimeout> | undefined
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
        return
      }
      handleServerMessage(socket, message)
    })
    socket.on('close', (code, reason) => {
      if (ended || socket !== upstream) return
      const text = reason.toString('utf-8')
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

function setupMessage(options: ProviderSessionOptions, handle: string | undefined): object {
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

function rawBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}

function rawText(data: RawData): string {
  return rawBuffer(data).toString('utf-8')
}

function addUsage(total: CallUsage, turn: NonNullable<LiveServerMessage['usageMetadata']>, prices: ProviderSessionOptions['prices']): void {
  const audioIn = (turn.promptTokensDetails ?? []).filter(e => e.modality === 'AUDIO').reduce((s, e) => s + (e.tokenCount ?? 0), 0)
  const textIn = Math.max(0, (turn.promptTokenCount ?? 0) - audioIn) + (turn.toolUsePromptTokenCount ?? 0)
  const audioOut = (turn.responseTokensDetails ?? []).filter(e => e.modality === 'AUDIO').reduce((s, e) => s + (e.tokenCount ?? 0), 0)
  const textOut = Math.max(0, (turn.responseTokenCount ?? 0) - audioOut) + (turn.thoughtsTokenCount ?? 0)
  total.audioInputTokens += audioIn
  total.textInputTokens += textIn
  total.audioOutputTokens += audioOut
  total.textOutputTokens += textOut
  total.costUsd += (audioIn * prices.audioInput + textIn * prices.textInput
    + audioOut * prices.audioOutput + textOut * prices.textOutput) / 1_000_000
}
