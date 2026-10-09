import { WebSocket, type RawData } from 'ws'
import { OPENAI_TOOLS } from '../tools.ts'
import { CARTESIA_DEFAULT_VOICE } from '../constants.ts'
import type { BrowserMessage, HostMessage, ProviderSessionOptions } from './types.ts'

const CARTESIA_VERSION = '2024-06-10'
const DEFAULT_STT_MODEL = 'ink-whisper'
const DEFAULT_TTS_MODEL = 'sonic-3.6'
const DEFAULT_VOICE_ID = CARTESIA_DEFAULT_VOICE
const CARTESIA_WS_BASE = 'wss://api.cartesia.ai'
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

/**
 * Ink-Whisper has no language auto-detection (the `language` param defaults to
 * `en` and rejects `auto`), and Chinese under `en` comes out as garbage while
 * English under `zh` comes back empty. So the primary socket pins Chinese and
 * an empty transcript with real audio behind it is replayed once on a
 * throwaway English socket.
 */
const PRIMARY_STT_LANGUAGE = 'zh'
const FALLBACK_STT_LANGUAGE = 'en'
/** Minimum buffered audio (0.5s of pcm_s16le 16kHz) worth an English retry. */
const MIN_RETRY_BYTES = 16000
/** Cap on the per-utterance replay buffer (~60s of pcm_s16le 16kHz). */
const MAX_UTTERANCE_BYTES = 1920000

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export function runCartesiaDeepSeekCall(client: WebSocket, options: ProviderSessionOptions): void {
  const { logger } = options

  // Resolve keys with priority: explicit option -> extraKeys (D:\voicespirit fallback) -> env vars
  const cartesiaKey = (
    options.extraKeys?.cartesiaApiKey ||
    process.env.CARTESIA_API_KEY ||
    (options.apiKey.startsWith('sk_car') ? options.apiKey : '')
  ).trim()

  const deepseekKey = (
    options.extraKeys?.deepseekApiKey ||
    process.env.DEEPSEEK_API_KEY ||
    (options.apiKey.startsWith('sk-') && !options.apiKey.startsWith('sk_car') ? options.apiKey : '')
  ).trim()

  const toBrowser = (message: HostMessage): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }

  if (!cartesiaKey) {
    toBrowser({ type: 'error', message: 'Cartesia API Key 未配置。请在设置中配置或在 D:/voicespirit/config.json 中填入 cartesia_api_key' })
    client.close(1008, 'Missing Cartesia key')
    return
  }

  if (!deepseekKey) {
    toBrowser({ type: 'error', message: 'DeepSeek API Key 未配置。请在设置中配置或在 D:/voicespirit/config.json 中填入 deepseek_api_key' })
    client.close(1008, 'Missing DeepSeek key')
    return
  }

  let ended = false
  let ready = false

  const history: ChatMessage[] = []
  let currentTurnSeq = 0
  let currentContextId = ''
  let outputLanguage: 'zh' | 'en' = 'zh'
  let currentAbortController: AbortController | null = null

  const pendingAudio: Buffer[] = []
  let inputTranscript = ''
  let inputActive = false
  /** Buffered audio of the current utterance, kept for the English retry. */
  let utteranceChunks: Buffer[] = []
  let utteranceBytes = 0
  let fallbackSocket: WebSocket | null = null
  const toolWaiters = new Map<string, (resp: Record<string, unknown>) => void>()

  const headers = {
    Authorization: `Bearer ${cartesiaKey}`,
    'Cartesia-Version': CARTESIA_VERSION,
  }

  // Connect STT WebSocket (Chinese primary; see the language note above).
  const sttUrl = `${CARTESIA_WS_BASE}/stt/websocket?model=${DEFAULT_STT_MODEL}&language=${PRIMARY_STT_LANGUAGE}&encoding=pcm_s16le&sample_rate=16000&cartesia_version=${CARTESIA_VERSION}`
  const sttWs = new WebSocket(sttUrl, { headers })

  // Connect TTS WebSocket
  const ttsUrl = `${CARTESIA_WS_BASE}/tts/websocket?cartesia_version=${CARTESIA_VERSION}`
  const ttsWs = new WebSocket(ttsUrl, { headers })

  const end = (code: number, reason: string): void => {
    if (ended) return
    ended = true
    toolWaiters.clear()
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    if (fallbackSocket) {
      try { fallbackSocket.close() } catch { fallbackSocket.terminate() }
      fallbackSocket = null
    }
    try { sttWs?.close() } catch { sttWs?.terminate() }
    try { ttsWs?.close() } catch { ttsWs?.terminate() }
    try { client.close(code, reason.slice(0, 120)) } catch { client.terminate() }
  }

  const bargeIn = (): void => {
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    if (currentContextId && ttsWs?.readyState === WebSocket.OPEN) {
      try {
        ttsWs.send(JSON.stringify({ context_id: currentContextId, cancel: true }))
      } catch {
        // ignore
      }
    }
    toBrowser({ type: 'interrupted' })
  }

  /**
   * Replay the buffered utterance on a throwaway English STT socket. Called
   * when the Chinese socket flushed with an empty transcript despite real
   * audio — Ink-Whisper under `zh` drops English speech silently.
   */
  const retryWithEnglishStt = (chunks: readonly Buffer[]): void => {
    if (ended || fallbackSocket) return
    const url = `${CARTESIA_WS_BASE}/stt/websocket?model=${DEFAULT_STT_MODEL}&language=${FALLBACK_STT_LANGUAGE}&encoding=pcm_s16le&sample_rate=16000&cartesia_version=${CARTESIA_VERSION}`
    const ws = new WebSocket(url, { headers })
    fallbackSocket = ws
    let transcript = ''
    const finish = (): void => {
      if (fallbackSocket !== ws) return
      fallbackSocket = null
      try { ws.close() } catch { ws.terminate() }
      const text = transcript.trim()
      // Skip dispatch when the call ended or the user is already speaking
      // again — a stale retry must not hijack the new utterance's turn.
      if (text && !ended && !inputActive) {
        toBrowser({ type: 'input_transcript', text })
        void generateReply(text)
      }
    }
    const timeout = setTimeout(() => {
      logger.warn('voice-agent: English STT retry timed out')
      finish()
    }, 15000)
    const finishOnce = (): void => { clearTimeout(timeout); finish() }
    ws.on('open', () => {
      for (const chunk of chunks) ws.send(chunk)
      ws.send('finalize')
    })
    ws.on('message', (raw: RawData) => {
      try {
        const event = JSON.parse(raw.toString('utf-8')) as { type?: string; text?: string; is_final?: boolean }
        if (event.type === 'transcript' && event.is_final) transcript += event.text ?? ''
        else if (event.type === 'flush_done') finishOnce()
      } catch {
        // ignore
      }
    })
    ws.on('error', () => finishOnce())
    ws.on('close', finishOnce)
  }

  const handleToolResponse = (id: string, response: Record<string, unknown>): void => {
    const waiter = toolWaiters.get(id)
    if (waiter) {
      toolWaiters.delete(id)
      waiter(response)
    }
  }

  const generateReply = async (userPrompt: string): Promise<void> => {
    bargeIn()
    outputLanguage = /\p{Script=Han}/u.test(userPrompt) ? 'zh' : 'en'
    currentTurnSeq += 1
    const seq = currentTurnSeq
    const contextId = `vs-ds-${seq}-${Date.now().toString(36)}`
    currentContextId = contextId

    history.push({ role: 'user', content: userPrompt })
    // Keep bounded history
    if (history.length > 20) history.splice(0, history.length - 20)

    const abortController = new AbortController()
    currentAbortController = abortController

    const voiceId = options.voice || DEFAULT_VOICE_ID
    const ttsModel = DEFAULT_TTS_MODEL

    const sendTtsText = (textChunk: string, isContinue: boolean): void => {
      if (ttsWs?.readyState === WebSocket.OPEN && currentContextId === contextId) {
        ttsWs.send(JSON.stringify({
          model_id: ttsModel,
          voice: { mode: 'id', id: voiceId },
          language: outputLanguage,
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
          context_id: contextId,
          transcript: textChunk,
          continue: isContinue,
        }))
      }
    }

    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: options.instructions },
        ...history,
      ]

      const resp = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deepseekKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model || 'deepseek-chat',
          messages,
          tools: OPENAI_TOOLS,
          stream: true,
          temperature: 0.3,
        }),
        signal: abortController.signal,
      })

      if (!resp.ok) {
        const errorText = await resp.text()
        toBrowser({ type: 'error', message: `DeepSeek API 响应异常 (${resp.status}): ${errorText}` })
        return
      }

      if (!resp.body) {
        toBrowser({ type: 'error', message: 'DeepSeek API 返回空数据流' })
        return
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let assistantText = ''

      const accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') break

          try {
            const parsed = JSON.parse(dataStr) as {
              choices?: Array<{
                delta?: {
                  content?: string
                  tool_calls?: Array<{
                    index: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
              }>
            }
            const delta = parsed.choices?.[0]?.delta
            if (!delta) continue

            if (delta.content) {
              assistantText += delta.content
              toBrowser({ type: 'output_transcript', text: delta.content })
              sendTtsText(delta.content, true)
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = accumulatedToolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' }
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.name = tc.function.name
                if (tc.function?.arguments) existing.arguments += tc.function.arguments
                accumulatedToolCalls.set(tc.index, existing)
              }
            }
          } catch {
            // ignore non-json SSE lines
          }
        }
      }

      // Finish this text turn with Sonic
      sendTtsText('', false)

      if (assistantText) {
        history.push({ role: 'assistant', content: assistantText })
      }

      // If tool calls were generated, dispatch them to browser
      if (accumulatedToolCalls.size > 0) {
        const calls = Array.from(accumulatedToolCalls.values())
        history.push({
          role: 'assistant',
          tool_calls: calls.map(c => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        })

        for (const call of calls) {
          let parsedArgs = {}
          try {
            parsedArgs = JSON.parse(call.arguments || '{}') as Record<string, unknown>
          } catch {
            parsedArgs = { raw: call.arguments }
          }
          toBrowser({
            type: 'tool_call',
            id: call.id,
            name: call.name,
            args: parsedArgs,
          })

          // Wait for browser tool response with abort resilience
          const toolResult = await new Promise<Record<string, unknown>>((resolve, reject) => {
            if (abortController.signal.aborted) {
              return reject(new DOMException('Aborted', 'AbortError'))
            }
            const onAbort = (): void => {
              toolWaiters.delete(call.id)
              reject(new DOMException('Aborted', 'AbortError'))
            }
            abortController.signal.addEventListener('abort', onAbort, { once: true })
            toolWaiters.set(call.id, (resp) => {
              abortController.signal.removeEventListener('abort', onAbort)
              resolve(resp)
            })
          })

          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          })
        }

        // Run a follow-up turn to let DeepSeek summarize the tool execution result
        await generateReplySummary()
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        // Barge-in occurred; quiet abort
        return
      }
      logger.error('voice-agent: DeepSeek error %s', (err as Error)?.message)
      toBrowser({ type: 'error', message: `DeepSeek 生成出错: ${(err as Error)?.message}` })
    } finally {
      if (currentAbortController === abortController) {
        currentAbortController = null
      }
    }
  }

  const generateReplySummary = async (): Promise<void> => {
    const contextId = `vs-ds-summary-${Date.now().toString(36)}`
    currentContextId = contextId
    const voiceId = options.voice || DEFAULT_VOICE_ID

    const sendTtsText = (textChunk: string, isContinue: boolean): void => {
      if (ttsWs?.readyState === WebSocket.OPEN && currentContextId === contextId) {
        ttsWs.send(JSON.stringify({
          model_id: DEFAULT_TTS_MODEL,
          voice: { mode: 'id', id: voiceId },
          language: outputLanguage,
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
          context_id: contextId,
          transcript: textChunk,
          continue: isContinue,
        }))
      }
    }

    try {
      const resp = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deepseekKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model || 'deepseek-chat',
          messages: [
            { role: 'system', content: options.instructions },
            ...history,
          ],
          stream: true,
          temperature: 0.3,
        }),
      })

      if (!resp.ok || !resp.body) return
      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let summaryText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') break
          try {
            const parsed = JSON.parse(dataStr) as { choices?: Array<{ delta?: { content?: string } }> }
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) {
              summaryText += delta
              toBrowser({ type: 'output_transcript', text: delta })
              sendTtsText(delta, true)
            }
          } catch {
            // ignore
          }
        }
      }
      sendTtsText('', false)
      if (summaryText) {
        history.push({ role: 'assistant', content: summaryText })
      }
    } catch {
      // ignore abort / error
    }
  }


  let sttReady = false
  let ttsReady = false

  const checkReady = (): void => {
    if (sttReady && ttsReady && !ready) {
      ready = true
      toBrowser({ type: 'ready', model: options.model || 'deepseek-chat' })
      for (const chunk of pendingAudio.splice(0)) {
        if (sttWs?.readyState === WebSocket.OPEN) sttWs.send(chunk)
      }
    }
  }

  sttWs.on('open', () => {
    sttReady = true
    checkReady()
  })

  ttsWs.on('open', () => {
    ttsReady = true
    checkReady()
  })

  sttWs.on('message', (raw: RawData) => {
    try {
      const event = JSON.parse(raw.toString('utf-8')) as {
        type?: string
        text?: string
        is_final?: boolean
        message?: string
      }
      if (event.type === 'transcript' && event.is_final) {
        inputTranscript += event.text ?? ''
      } else if (event.type === 'flush_done') {
        const text = inputTranscript.trim()
        inputTranscript = ''
        const chunks = utteranceChunks
        const bytes = utteranceBytes
        utteranceChunks = []
        utteranceBytes = 0
        if (text) {
          toBrowser({ type: 'input_transcript', text })
          void generateReply(text)
        } else if (bytes >= MIN_RETRY_BYTES) {
          retryWithEnglishStt(chunks)
        }
      } else if (event.type === 'error') {
        toBrowser({ type: 'error', message: `Cartesia STT: ${event.message || 'unknown error'}` })
      }
    } catch {
      // ignore
    }
  })

  ttsWs.on('message', (raw: RawData) => {
    try {
      const event = JSON.parse(raw.toString('utf-8')) as {
        type?: string
        data?: string
        audio?: string
        context_id?: string
        done?: boolean
        error?: string
      }
      if (event.type === 'chunk') {
        if (event.context_id && event.context_id !== currentContextId) return
        const audioB64 = event.data || event.audio
        if (audioB64 && client.readyState === WebSocket.OPEN) {
          client.send(Buffer.from(audioB64, 'base64'), { binary: true })
        }
        if (event.done) {
          toBrowser({ type: 'turn_complete' })
        }
      } else if (event.type === 'done') {
        toBrowser({ type: 'turn_complete' })
      } else if (event.type === 'error') {
        toBrowser({ type: 'error', message: `Cartesia TTS: ${event.error || 'unknown error'}` })
      }
    } catch {
      // ignore
    }
  })

  sttWs.on('error', (err: Error) => {
    logger.warn('voice-agent: Cartesia STT error %s', err.message)
    toBrowser({ type: 'error', message: `Cartesia STT 错误: ${err.message}` })
  })

  ttsWs.on('error', (err: Error) => {
    logger.warn('voice-agent: Cartesia TTS error %s', err.message)
    toBrowser({ type: 'error', message: `Cartesia TTS 错误: ${err.message}` })
  })

  client.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      if (!inputActive) {
        inputActive = true
        bargeIn()
      }
      const chunk = rawBuffer(data)
      if (utteranceBytes < MAX_UTTERANCE_BYTES) {
        utteranceChunks.push(chunk)
        utteranceBytes += chunk.length
      }
      if (!ready || sttWs?.readyState !== WebSocket.OPEN) {
        pendingAudio.push(chunk)
        return
      }
      sttWs.send(chunk)
      return
    }

    try {
      const msg = JSON.parse(rawBuffer(data).toString('utf-8')) as BrowserMessage
      if (msg.type === 'audio_end') {
        inputActive = false
        if (sttWs.readyState === WebSocket.OPEN) sttWs.send('finalize')
      } else if (msg.type === 'tool_response') {
        handleToolResponse(msg.id, msg.response)
      } else if (msg.type === 'agent_update' || msg.type === 'text') {
        void generateReply(msg.text)
      }
    } catch {
      toBrowser({ type: 'error', message: 'Invalid control message' })
    }
  })

  client.on('close', () => { end(1000, 'call ended') })
  client.on('error', () => { end(1011, 'browser socket error') })
}

function rawBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}
