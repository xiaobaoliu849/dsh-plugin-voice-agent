import { WebSocket, type RawData } from 'ws'
import { MOSS_DEFAULT_CHINESE_VOICE } from '../constants.ts'
import { OPENAI_TOOLS } from '../tools.ts'
import type { BrowserMessage, HostMessage, ProviderSessionOptions } from './types.ts'

const DEFAULT_MOSS_WS_URL = 'wss://api.mosi.cn/v1/realtime'
const DEFAULT_MOSS_MODEL = 'moss-live-1.0'
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

const MOSS_OUTPUT_SAMPLE_RATE = 48_000
const MOSS_INPUT_FRAME_BYTES = 640 // 20 ms of 16 kHz mono S16LE
const MOSS_PLAYBACK_LEAD_SECONDS = 0.04

interface MossChunkContext {
  chunk_id?: string | undefined
  run_id?: string | undefined
  turn_id?: string | undefined
}

interface MossServerEvent {
  action?: string
  data?: {
    session_id?: string
    run_id?: string
    turn_id?: string
    chunk_id?: string
    text?: string
    status?: string
    error?: { message?: string; code?: string } | string
  }
}

interface QueuedPlaybackChunk {
  ctx: MossChunkContext
  start: number
  end: number
}

/**
 * Schedules `playback.chunk.completed` / `playback.completed` / `playback.stopped`
 * acknowledgements on the timeline the browser plays them. Without these acks,
 * MOSS-Live withholds transcripts and cuts off turns with `playback_timeout`.
 */
class MossPlaybackClock {
  private queue: QueuedPlaybackChunk[] = []
  private readonly doneRuns = new Set<string>()
  private readonly runTurns = new Map<string, string>()
  private readonly playedMsByRun = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly sendJson: (payload: object) => void) {}

  private nowSeconds(): number {
    return Date.now() / 1000
  }

  addChunk(ctx: MossChunkContext, nbytes: number): void {
    if (this.disposed || nbytes <= 0) return
    const duration = nbytes / (MOSS_OUTPUT_SAMPLE_RATE * 2)
    const now = this.nowSeconds()
    const prevEnd = this.queue.length > 0 ? this.queue[this.queue.length - 1]!.end : 0
    const start = Math.max(now + MOSS_PLAYBACK_LEAD_SECONDS, prevEnd)
    this.queue.push({
      ctx: { chunk_id: ctx.chunk_id, run_id: ctx.run_id, turn_id: ctx.turn_id },
      start,
      end: start + duration,
    })
    this.schedule()
  }

  noteRunTurn(runId: string, turnId: string): void {
    if (runId) this.runTurns.set(runId, turnId)
  }

  markAudioDone(runId: string): void {
    if (this.disposed || !runId) return
    this.doneRuns.add(runId)
    this.completeFinishedRuns()
  }

  stop(runId = '', turnId = ''): void {
    let playedMs = runId ? (this.playedMsByRun.get(runId) ?? 0) : 0
    if (this.queue.length > 0) {
      const head = this.queue[0]!
      playedMs += Math.round(Math.max(0, Math.min(this.nowSeconds(), head.end) - head.start) * 1000)
    }
    this.queue = []
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (runId) {
      this.doneRuns.delete(runId)
      this.playedMsByRun.delete(runId)
    }
    this.sendJson({
      action: 'playback.stopped',
      run_id: runId,
      turn_id: turnId,
      played_audio_ms: playedMs,
    })
  }

  private completeFinishedRuns(): void {
    if (this.disposed || this.queue.length > 0) return
    for (const runId of this.doneRuns) {
      const turnId = this.runTurns.get(runId) ?? ''
      this.runTurns.delete(runId)
      this.playedMsByRun.delete(runId)
      this.sendJson({
        action: 'playback.completed',
        run_id: runId,
        turn_id: turnId,
      })
    }
    this.doneRuns.clear()
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) {
      this.completeFinishedRuns()
      return
    }
    const delayMs = Math.max(0, Math.round((this.queue[0]!.end - this.nowSeconds()) * 1000))
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed) return
      const head = this.queue.shift()
      if (head) {
        const rId = head.ctx.run_id
        if (rId) {
          const chunkMs = Math.round(Math.max(0, head.end - head.start) * 1000)
          this.playedMsByRun.set(rId, (this.playedMsByRun.get(rId) ?? 0) + chunkMs)
        }
        this.sendJson({ action: 'playback.chunk.completed', ...head.ctx })
      }
      this.schedule()
    }, delayMs)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queue = []
    this.doneRuns.clear()
    this.runTurns.clear()
    this.playedMsByRun.clear()
  }
}

/** Downsample 48 kHz mono S16LE PCM to 24 kHz mono S16LE PCM (2:1 box filter). */
function downsample48kTo24k(buf: Buffer): Buffer {
  const samplePairs = Math.floor(buf.length / 4)
  if (samplePairs <= 0) return Buffer.alloc(0)
  const out = Buffer.allocUnsafe(samplePairs * 2)
  for (let i = 0; i < samplePairs; i++) {
    const s0 = buf.readInt16LE(i * 4)
    const s1 = buf.readInt16LE(i * 4 + 2)
    out.writeInt16LE((s0 + s1) >> 1, i * 2)
  }
  return out
}

function resolveMossWsEndpoint(rawUrl?: string): string {
  const trimmed = (rawUrl || process.env.MOSS_WS_URL || '').trim()
  if (!trimmed) return DEFAULT_MOSS_WS_URL
  const wsUrl = trimmed.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://').replace(/\/+$/, '')
  return wsUrl.endsWith('/realtime') ? wsUrl : `${wsUrl}/realtime`
}

/**
 * Route a finalized user utterance through DeepSeek Chat to decide whether
 * a DeepSeek Harness voice-control tool (`ask_harness`, `steer_harness`,
 * `stop_harness`, `harness_status`) should be invoked alongside MOSS-Live.
 */
async function routeHarnessToolCall(
  transcript: string,
  deepseekKey: string,
  recentUpdates: readonly string[],
  signal: AbortSignal,
): Promise<Array<{ id: string; name: string; args: Record<string, unknown> }>> {
  const contextNote = recentUpdates.length > 0
    ? `\nRecent harness updates:\n${recentUpdates.slice(-3).join('\n')}`
    : ''
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepseekKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0,
      max_tokens: 256,
      messages: [
        {
          role: 'system',
          content:
            'You are the tool router for DeepSeek Harness voice control. Given the user\'s spoken transcript, decide whether to call one of the harness tools (ask_harness, steer_harness, stop_harness, harness_status). Call a tool ONLY when the user is asking about their project/files/code/terminal/tests, steering a running task, stopping a task, or asking for harness status. For greetings or general small talk, return no tool calls.' +
            contextNote,
        },
        { role: 'user', content: transcript },
      ],
      tools: OPENAI_TOOLS,
      tool_choice: 'auto',
    }),
    signal,
  })
  if (!response.ok) return []
  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
    }>
  }
  const calls = data.choices?.[0]?.message?.tool_calls ?? []
  const out: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
  for (const call of calls) {
    const name = call.function?.name
    if (!name) continue
    let args: Record<string, unknown> = {}
    try {
      args = call.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
    } catch {
      args = {}
    }
    out.push({
      id: call.id || `moss_tool_${Date.now()}`,
      name,
      args,
    })
  }
  return out
}

export function runMossCall(client: WebSocket, options: ProviderSessionOptions): void {
  const { logger } = options

  const apiKey = (
    options.apiKey ||
    options.extraKeys?.mossApiKey ||
    process.env.MOSS_API_KEY ||
    ''
  ).trim()

  const deepseekKey = (
    options.extraKeys?.deepseekApiKey ||
    process.env.DEEPSEEK_API_KEY ||
    ''
  ).trim()

  const toBrowser = (message: HostMessage): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }

  if (!apiKey) {
    toBrowser({ type: 'error', message: 'MOSS API Key 未配置。请在设置中配置或在 D:/voicespirit/config.json 中填入 moss_api_key' })
    client.close(1008, 'Missing MOSS key')
    return
  }

  const rawModel = (options.model || DEFAULT_MOSS_MODEL).trim()
  const model = rawModel.startsWith('moss-live') ? rawModel : DEFAULT_MOSS_MODEL
  const voice = (options.voice || MOSS_DEFAULT_CHINESE_VOICE).trim()
  const endpoint = resolveMossWsEndpoint(options.extraKeys?.mossWsUrl)
  const wsUrl = `${endpoint}?model=${encodeURIComponent(model)}`

  let upstream: WebSocket | undefined
  let playbackClock: MossPlaybackClock | undefined
  let ended = false
  let handshakeDone = false
  let inputPending = Buffer.alloc(0)
  let pendingAudio: Buffer[] = []
  let aiText = ''
  let userFinalSent = false
  let currentRunId = ''
  const audioContexts: MossChunkContext[] = []
  const stoppedRuns = new Set<string>()
  const recentAgentUpdates: string[] = []
  const routerAbort = new AbortController()
  let warnedNoDeepSeek = false

  const buildSessionInstructions = (): string => {
    if (recentAgentUpdates.length === 0) return options.instructions
    return `${options.instructions}\n\nLatest DeepSeek Harness updates (context for your next reply):\n${recentAgentUpdates.slice(-4).join('\n')}`
  }

  const toMoss = (payload: object): void => {
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify(payload))
    }
  }

  const sendAudioToMoss = (chunk: Buffer): void => {
    if (upstream?.readyState !== WebSocket.OPEN) return
    inputPending = Buffer.concat([inputPending, chunk])
    while (inputPending.length >= MOSS_INPUT_FRAME_BYTES) {
      const frame = inputPending.subarray(0, MOSS_INPUT_FRAME_BYTES)
      inputPending = inputPending.subarray(MOSS_INPUT_FRAME_BYTES)
      upstream.send(frame, { binary: true })
    }
  }

  const end = (code: number, reason: string): void => {
    if (ended) return
    ended = true
    routerAbort.abort()
    playbackClock?.dispose()
    playbackClock = undefined
    try { upstream?.close() } catch { upstream?.terminate() }
    try { client.close(code, reason.slice(0, 120)) } catch { client.terminate() }
  }

  const emitAiTranscript = (rawText: string | undefined): void => {
    const text = String(rawText || '')
    if (!text || text === aiText) return
    const delta = text.startsWith(aiText) ? text.slice(aiText.length) : text
    aiText = text
    if (delta) {
      toBrowser({ type: 'output_transcript', text: delta })
    }
  }

  const handleUserFinalTranscript = (transcript: string): void => {
    toBrowser({ type: 'input_transcript', text: transcript })
    if (!deepseekKey) {
      if (!warnedNoDeepSeek) {
        warnedNoDeepSeek = true
        logger.warn('voice-agent[moss]: DEEPSEEK_API_KEY not configured; voice-control tool routing is disabled for this MOSS-Live call')
      }
      return
    }
    void routeHarnessToolCall(transcript, deepseekKey, recentAgentUpdates, routerAbort.signal)
      .then((calls) => {
        if (ended) return
        for (const call of calls) {
          logger.info('voice-agent[moss]: routed tool call %s', call.name)
          toBrowser({ type: 'tool_call', id: call.id, name: call.name, args: call.args })
        }
      })
      .catch((err: unknown) => {
        if (!routerAbort.signal.aborted) {
          logger.warn('voice-agent[moss]: tool router error: %s', err instanceof Error ? err.message : String(err))
        }
      })
  }

  const connect = (): void => {
    upstream = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'dsh-plugin-voice-agent/MOSS-Live',
      },
      handshakeTimeout: 15_000,
    })

    playbackClock = new MossPlaybackClock(toMoss)

    upstream.on('open', () => {
      toMoss({ action: 'attach_session' })
    })

    upstream.on('message', (raw: RawData, isBinary: boolean) => {
      if (ended) return
      if (isBinary) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
        if (buf.length === 0) return
        const ctx = audioContexts.shift() ?? {}
        const runId = String(ctx.run_id || '')
        if (runId && stoppedRuns.has(runId)) return
        playbackClock?.addChunk(ctx, buf.length)
        const pcm24k = downsample48kTo24k(buf)
        if (pcm24k.length > 0 && client.readyState === WebSocket.OPEN) {
          client.send(pcm24k, { binary: true })
        }
        return
      }

      let event: MossServerEvent
      try {
        event = JSON.parse(raw.toString('utf-8')) as MossServerEvent
      } catch {
        return
      }

      const action = String(event.action || '')
      const data = event.data ?? {}
      const runId = String(data.run_id || '')
      const turnId = String(data.turn_id || '')

      if (action === 'session_attached' && !handshakeDone) {
        if (voice && voice !== 'default') {
          toMoss({ action: 'change_voice', voice_name: voice })
        } else {
          toMoss({ action: 'session.update', session: { instructions: buildSessionInstructions() } })
        }
        return
      }

      if (action === 'voice_changed' && !handshakeDone) {
        toMoss({ action: 'session.update', session: { instructions: buildSessionInstructions() } })
        return
      }

      if (action === 'session.updated' && !handshakeDone) {
        if (data.error) {
          const errMsg = `MOSS-Live 会话配置失败: ${JSON.stringify(data.error)}`
          toBrowser({ type: 'error', message: errMsg })
          end(1011, errMsg)
          return
        }
        handshakeDone = true
        toMoss({ action: 'mic_state', enabled: true })
        toBrowser({ type: 'ready', model })
        for (const chunk of pendingAudio.splice(0)) {
          sendAudioToMoss(chunk)
        }
        return
      }

      if (action === 'input.speech.started') {
        userFinalSent = false
        return
      }

      if (action === 'input.transcript.done') {
        const transcript = String(data.text || '').trim()
        if (transcript && !userFinalSent) {
          userFinalSent = true
          handleUserFinalTranscript(transcript)
        }
        return
      }

      if (action === 'response.audio.started') {
        currentRunId = runId
        aiText = ''
        playbackClock?.noteRunTurn(runId, turnId)
        return
      }

      if (action === 'response.audio.context') {
        audioContexts.push({
          chunk_id: data.chunk_id,
          run_id: data.run_id,
          turn_id: data.turn_id,
        })
        return
      }

      if (action === 'output.transcript.updated' || action === 'output.transcript.done') {
        emitAiTranscript(data.text)
        return
      }

      if (action === 'response.audio.done') {
        playbackClock?.markAudioDone(runId)
        return
      }

      if (action === 'response.audio.stop') {
        if (runId) stoppedRuns.add(runId)
        playbackClock?.stop(runId, turnId)
        if (data.text) emitAiTranscript(data.text)
        toBrowser({ type: 'interrupted' })
        return
      }

      if (action === 'response.interrupted') {
        if (currentRunId) stoppedRuns.add(currentRunId)
        if (data.text) emitAiTranscript(data.text)
        toBrowser({ type: 'interrupted' })
        return
      }

      if (action === 'response.ended') {
        if (runId && stoppedRuns.has(runId)) {
          stoppedRuns.delete(runId)
          return
        }
        if (data.status === 'aborted') {
          toBrowser({ type: 'interrupted' })
          return
        }
        aiText = ''
        toBrowser({ type: 'turn_complete' })
        return
      }

      if (action === 'error') {
        const err = data.error
        const msg = typeof err === 'string'
          ? err
          : (err?.message || err?.code || JSON.stringify(data))
        logger.warn('voice-agent[moss]: server error: %s', msg)
        toBrowser({ type: 'error', message: `MOSS-Live: ${msg}` })
      }
    })

    upstream.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0
      const msg = (code === 401 || code === 403)
        ? `MOSS-Live 鉴权失败 (HTTP ${code})：API Key 无效或已过期。`
        : `MOSS-Live WebSocket 连接被拒绝 (HTTP ${code || 'error'})。`
      toBrowser({ type: 'error', message: msg })
      end(1008, msg)
    })

    upstream.on('error', (err) => {
      logger.warn('voice-agent[moss]: upstream error: %s', err.message)
      if (!ended) {
        toBrowser({ type: 'error', message: err.message })
        end(1011, err.message)
      }
    })

    upstream.on('close', (code, reason) => {
      if (!ended) {
        end(code === 1000 ? 1000 : 1011, reason.toString('utf-8') || 'MOSS-Live disconnected')
      }
    })
  }

  client.on('message', (data: RawData, isBinary: boolean) => {
    if (ended) return
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (!handshakeDone) {
        pendingAudio.push(buf)
        return
      }
      sendAudioToMoss(buf)
      return
    }

    let message: BrowserMessage
    try {
      message = JSON.parse(data.toString('utf-8')) as BrowserMessage
    } catch {
      return
    }

    switch (message.type) {
      case 'agent_update': {
        recentAgentUpdates.push(message.text)
        if (recentAgentUpdates.length > 8) recentAgentUpdates.shift()
        if (handshakeDone) {
          toMoss({
            action: 'session.update',
            session: { instructions: buildSessionInstructions() },
          })
        }
        break
      }
      case 'tool_response': {
        const summary = JSON.stringify(message.response)
        recentAgentUpdates.push(`[tool ${message.name}]: ${summary}`)
        if (recentAgentUpdates.length > 8) recentAgentUpdates.shift()
        if (handshakeDone) {
          toMoss({
            action: 'session.update',
            session: { instructions: buildSessionInstructions() },
          })
        }
        break
      }
      case 'text':
        recentAgentUpdates.push(`[user text]: ${message.text}`)
        if (recentAgentUpdates.length > 8) recentAgentUpdates.shift()
        if (handshakeDone) {
          toMoss({
            action: 'session.update',
            session: { instructions: buildSessionInstructions() },
          })
        }
        break
      case 'audio_end':
        // MOSS-Live runs server-side VAD; pad any partial 20 ms tail frame with silence.
        if (handshakeDone && inputPending.length > 0 && upstream?.readyState === WebSocket.OPEN) {
          const padded = Buffer.alloc(MOSS_INPUT_FRAME_BYTES)
          inputPending.copy(padded, 0, 0, Math.min(inputPending.length, MOSS_INPUT_FRAME_BYTES))
          inputPending = Buffer.alloc(0)
          upstream.send(padded, { binary: true })
        }
        break
    }
  })

  client.on('close', () => end(1000, 'browser closed'))
  client.on('error', () => end(1011, 'browser socket error'))

  connect()
}
