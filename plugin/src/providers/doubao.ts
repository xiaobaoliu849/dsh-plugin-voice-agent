import { WebSocket, type RawData } from 'ws'
import { OPENAI_TOOLS } from '../tools.ts'
import type { BrowserMessage, HostMessage, ProviderSessionOptions } from './types.ts'

const DEFAULT_DOUBAO_WS = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
const DEFAULT_MODEL = '1.2.6.1'
const DEFAULT_VOICE = 'zh_female_vv_jupiter_bigtts'

interface DoubaoServerEvent {
  event_type?: string
  type?: string
  text?: string
  transcript?: string
  delta?: string
  audio?: string
  data?: string
  id?: string
  call_id?: string
  name?: string
  function?: { name?: string }
  arguments?: string | Record<string, unknown>
  args?: Record<string, unknown>
  message?: string
  error?: string
}

export function runDoubaoCall(client: WebSocket, options: ProviderSessionOptions): void {
  const { logger } = options

  const apiKey = (
    options.extraKeys?.doubaoApiKey ||
    options.extraKeys?.doubaoAccessToken ||
    process.env.DOUBAO_API_KEY ||
    process.env.VOLC_API_KEY ||
    options.apiKey
  ).trim()

  const toBrowser = (message: HostMessage): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }

  if (!apiKey) {
    toBrowser({ type: 'error', message: 'Doubao API Key / Access Token 未配置。请在设置中配置或在 D:/voicespirit/config.json 中填入 doubao_access_token' })
    client.close(1008, 'Missing Doubao key')
    return
  }

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

  const toDoubao = (payload: object): void => {
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify(payload))
    }
  }

  const dispatchedToolCalls = new Set<string>()

  const connect = (): void => {
    const appId = (options.extraKeys?.doubaoAppId || process.env.DOUBAO_APP_ID || '').trim()
    const headers: Record<string, string> = {
      'X-Api-Key': apiKey,
      'X-Api-Access-Key': apiKey,
      Authorization: `Bearer;${apiKey}`,
    }
    if (appId) {
      headers['X-Api-App-Key'] = appId
    }

    upstream = new WebSocket(DEFAULT_DOUBAO_WS, {
      headers,
      handshakeTimeout: 15_000,
    })

    upstream.on('open', () => {
      toDoubao({
        event_type: 'start_connection',
        dialog: {
          model: options.model || DEFAULT_MODEL,
          voice: options.voice || DEFAULT_VOICE,
          system_prompt: options.instructions,
          bot_name: 'DeepSeek Harness Assistant',
        },
        tools: OPENAI_TOOLS,
      })
    })

    upstream.on('message', (raw: RawData) => {
      let event: DoubaoServerEvent
      try {
        event = JSON.parse(raw.toString('utf-8')) as DoubaoServerEvent
      } catch {
        return
      }

      const eventType = event.event_type || event.type
      switch (eventType) {
        case 'connection_started':
        case 'session_created':
        case 'ready':
          ready = true
          toBrowser({ type: 'ready', model: options.model || DEFAULT_MODEL })
          for (const chunk of pendingAudio.splice(0)) {
            toDoubao({
              event_type: 'audio_chat',
              audio: chunk.toString('base64'),
            })
          }
          break

        case 'interrupted':
        case 'user_speech_start':
        case 'barge_in':
          toBrowser({ type: 'interrupted' })
          break

        case 'user_transcript':
        case 'transcript':
          {
            const inText = event.text || event.transcript
            if (inText) {
              toBrowser({ type: 'input_transcript', text: inText })
            }
          }
          break

        case 'assistant_transcript':
        case 'delta_text':
          {
            const outText = event.text || event.delta
            if (outText) {
              toBrowser({ type: 'output_transcript', text: outText })
            }
          }
          break

        case 'audio':
        case 'delta_audio':
        case 'audio_response':
          {
            const audioB64 = event.audio || event.data || event.delta
            if (audioB64 && client.readyState === WebSocket.OPEN) {
              client.send(Buffer.from(audioB64, 'base64'), { binary: true })
            }
          }
          break

        case 'tool_call':
        case 'function_call':
          {
            const toolId = event.id || event.call_id || `tool_${Date.now()}`
            if (dispatchedToolCalls.has(toolId)) break
            dispatchedToolCalls.add(toolId)
            const name = event.name || event.function?.name
            let args: Record<string, unknown> = {}
            try {
              args = typeof event.arguments === 'string' ? JSON.parse(event.arguments) : (event.arguments ?? event.args ?? {})
            } catch {
              args = { raw: event.arguments }
            }
            if (name) {
              toBrowser({
                type: 'tool_call',
                id: toolId,
                name,
                args,
              })
            }
          }
          break

        case 'turn_complete':
        case 'assistant_finish':
        case 'response_done':
          dispatchedToolCalls.clear()
          toBrowser({ type: 'turn_complete' })
          break

        case 'error':
          logger.warn('voice-agent: Doubao error %s', JSON.stringify(event))
          toBrowser({ type: 'error', message: event.message || event.error || '豆包语音服务异常' })
          break
      }
    })

    upstream.on('close', (code, reason) => {
      if (ended) return
      toBrowser({ type: 'error', message: `豆包会话关闭 (${code}: ${reason.toString('utf-8')})` })
      end(1011, 'Doubao closed')
    })

    upstream.on('error', (err: Error) => {
      logger.warn('voice-agent: Doubao socket error %s', err.message)
      if (!ready) {
        toBrowser({ type: 'error', message: `无法连接豆包实时语音服务: ${err.message}` })
        end(1011, 'Doubao unreachable')
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
      toDoubao({
        event_type: 'audio_chat',
        audio: chunk.toString('base64'),
      })
      return
    }

    try {
      const msg = JSON.parse(rawBuffer(data).toString('utf-8')) as BrowserMessage
      if (msg.type === 'tool_response') {
        toDoubao({
          event_type: 'tool_response',
          id: msg.id,
          name: msg.name,
          response: msg.response,
        })
      } else if (msg.type === 'agent_update' || msg.type === 'text') {
        toDoubao({
          event_type: 'text_chat',
          text: msg.text,
        })
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
