import { WebSocket, type RawData } from 'ws'
import { OPENAI_REALTIME_TOOLS } from '../tools.ts'
import type { BrowserMessage, HostMessage, ProviderSessionOptions } from './types.ts'

const DEFAULT_DASHSCOPE_WS = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const DEFAULT_MODEL = 'qwen3.8-omni-flash-realtime'
const DEFAULT_VOICE = 'Tina'

export function runQwenCall(client: WebSocket, options: ProviderSessionOptions): void {
  const { logger } = options

  const apiKey = (
    options.extraKeys?.dashscopeApiKey ||
    process.env.DASHSCOPE_API_KEY ||
    options.apiKey
  ).trim()

  const toBrowser = (message: HostMessage): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }

  if (!apiKey) {
    toBrowser({ type: 'error', message: 'DashScope API Key 未配置。请在设置中配置或在 D:/voicespirit/config.json 中填入 dashscope_api_key' })
    client.close(1008, 'Missing DashScope key')
    return
  }

  const wsUrl = options.extraKeys?.dashscopeWsUrl || DEFAULT_DASHSCOPE_WS
  let upstream: WebSocket | undefined
  let ended = false
  let ready = false

  const pendingAudio: Buffer[] = []

  const end = (code: number, reason: string): void => {
    if (ended) return
    ended = true
    try { upstream?.close() } catch { upstream?.terminate() }
    try { client.close(code, reason.slice(0, 120)) } catch { client.terminate() }
  }

  const toQwen = (payload: object): void => {
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify(payload))
    }
  }

  const dispatchedToolCalls = new Set<string>()

  const dispatchToolCall = (id: string, name: string, rawArgs: string | undefined): void => {
    if (!id || dispatchedToolCalls.has(id)) return
    dispatchedToolCalls.add(id)
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(rawArgs || '{}')
    } catch {
      args = { raw: rawArgs }
    }
    toBrowser({
      type: 'tool_call',
      id,
      name,
      args,
    })
  }

  const connect = (): void => {
    upstream = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
      handshakeTimeout: 15_000,
    })

    upstream.on('open', () => {
      // Send session.update
      toQwen({
        event_id: `evt_setup_${Date.now()}`,
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          model: options.model || DEFAULT_MODEL,
          voice: options.voice || DEFAULT_VOICE,
          instructions: options.instructions,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'gummy-realtime-v1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.2,
            silence_duration_ms: 800,
            prefix_padding_ms: 300,
          },
          tools: OPENAI_REALTIME_TOOLS,
        },
      })
    })

    upstream.on('message', (raw: RawData) => {
      let event: any
      try {
        event = JSON.parse(raw.toString('utf-8'))
      } catch {
        return
      }

      switch (event.type) {
        case 'session.updated':
        case 'session.created':
          ready = true
          toBrowser({ type: 'ready', model: options.model || DEFAULT_MODEL })
          for (const chunk of pendingAudio.splice(0)) {
            toQwen({
              type: 'input_audio_buffer.append',
              audio: chunk.toString('base64'),
            })
          }
          break

        case 'input_audio_buffer.speech_started':
          toBrowser({ type: 'interrupted' })
          break

        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript) {
            toBrowser({ type: 'input_transcript', text: event.transcript })
          }
          break

        case 'response.audio_transcript.delta':
          if (event.delta) {
            toBrowser({ type: 'output_transcript', text: event.delta })
          }
          break

        case 'response.audio.delta':
          if (event.delta && client.readyState === WebSocket.OPEN) {
            client.send(Buffer.from(event.delta, 'base64'), { binary: true })
          }
          break

        case 'response.output_item.done':
          if (event.item?.type === 'function_call') {
            const item = event.item
            dispatchToolCall(item.call_id || item.id, item.name, item.arguments)
          }
          break

        case 'response.function_call_arguments.done':
          dispatchToolCall(event.call_id, event.name, event.arguments)
          break

        case 'response.done':
          dispatchedToolCalls.clear()
          toBrowser({ type: 'turn_complete' })
          break

        case 'error':
          logger.warn('voice-agent: Qwen Realtime error %s', JSON.stringify(event.error))
          toBrowser({ type: 'error', message: event.error?.message || '通义千问 Realtime 发生错误' })
          break
      }
    })

    upstream.on('close', (code, reason) => {
      if (ended) return
      toBrowser({ type: 'error', message: `Qwen Realtime 会话关闭 (${code}: ${reason.toString('utf-8')})` })
      end(1011, 'Qwen closed')
    })

    upstream.on('error', (err: Error) => {
      logger.warn('voice-agent: Qwen socket error %s', err.message)
      if (!ready) {
        toBrowser({ type: 'error', message: `无法连接通义千问 Realtime 服务: ${err.message}` })
        end(1011, 'Qwen unreachable')
      }
    })
  }

  client.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      const chunk = rawBuffer(data)
      if (!ready || upstream?.readyState !== WebSocket.OPEN) {
        pendingAudio.push(chunk)
        return
      }
      toQwen({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      })
      return
    }

    try {
      const msg = JSON.parse(rawBuffer(data).toString('utf-8')) as BrowserMessage
      if (msg.type === 'tool_response') {
        toQwen({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: msg.id,
            output: JSON.stringify(msg.response),
          },
        })
        toQwen({ type: 'response.create' })
      } else if (msg.type === 'agent_update' || msg.type === 'text') {
        toQwen({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: msg.text }],
          },
        })
        toQwen({ type: 'response.create' })
      }
    } catch {
      toBrowser({ type: 'error', message: 'Invalid control message' })
    }
  })

  client.on('close', () => { end(1000, 'call ended') })
  client.on('error', () => { end(1011, 'browser socket error') })

  connect()
}

function rawBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}
