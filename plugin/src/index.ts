/**
 * @deepseek-ai/dsh-host-voice-agent — host half of realtime voice control.
 *
 * Serves a status route and the `/api/voice-agent/ws` upgrade that pairs each browser call with
 * a realtime voice provider session.
 * @module @deepseek-ai/dsh-host-voice-agent
 */

import { WebSocketServer } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { runLiveCall } from './live.ts'
import {
  DEFAULT_API_KEY_ENV, DEFAULT_PROVIDER,
  PROVIDER_DEFAULT_MODELS, PROVIDER_DEFAULT_VOICES,
  VOICE_AGENT_NAMESPACE, VoiceAgentSettingsSchema,
  loadVoiceSpiritFallback, type VoiceAgentProvider, type VoiceAgentSettings,
} from './settings.ts'
import { FUNCTION_DECLARATIONS, buildInstructions } from './tools.ts'

export * from './settings.ts'
export { VOICE_AGENT_TOOLS } from './tools.ts'
export type { BrowserMessage, HostMessage } from './live.ts'

/** Route prefix owned by the voice-agent surface. */
export const VOICE_AGENT_API_PATH = '/api/voice-agent'

/** Plugin name; the bundle's profile entry id is also `voice-agent`. */
export const name = 'voice-agent'

/** Host services this plugin requires before it can compose. */
export const inject = ['webServer']

/**
 * Register the status route and the call upgrade.
 * @param ctx - host plugin context.
 * @param config - optional live references to plugin Config when run as a standalone bundle.
 */
export function apply(ctx: Context, config?: any): void {
  const settingsService = ctx.get('settings')
  const scope = settingsService !== undefined
    ? settingsService.register(VOICE_AGENT_NAMESPACE, VoiceAgentSettingsSchema)
    : undefined

  const settings = (): VoiceAgentSettings => {
    if (scope !== undefined) return scope.get()
    if (config?.model?.get !== undefined) {
      return {
        provider: (config.provider?.get?.() as VoiceAgentProvider) || DEFAULT_PROVIDER,
        model: config.model.get(),
        voice: config.voice.get(),
        apiKeyEnv: config.apiKeyEnv.get(),
        instructions: config.instructions.get(),
        priceAudioInput: config.priceAudioInput?.get?.() ?? 3,
        priceTextInput: config.priceTextInput?.get?.() ?? 0.75,
        priceAudioOutput: config.priceAudioOutput?.get?.() ?? 4.5,
        priceTextOutput: config.priceTextOutput?.get?.() ?? 4.5,
      }
    }
    return {
      provider: DEFAULT_PROVIDER,
      model: PROVIDER_DEFAULT_MODELS[DEFAULT_PROVIDER],
      voice: PROVIDER_DEFAULT_VOICES[DEFAULT_PROVIDER],
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      instructions: '',
      priceAudioInput: 3,
      priceTextInput: 0.75,
      priceAudioOutput: 4.5,
      priceTextOutput: 4.5,
    }
  }

  const resolveApiKey = async (provider: VoiceAgentProvider): Promise<string | undefined> => {
    const current = settings()
    const ref = credentialRef(current.apiKeyEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const resolved = (await credentials.resolve(ref))?.value
      if (resolved && resolved.length > 0) return resolved
    }

    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return ambient

    // Provider specific environment variables
    const envMap: Record<VoiceAgentProvider, string[]> = {
      'cartesia-deepseek': ['DEEPSEEK_API_KEY', 'CARTESIA_API_KEY'],
      'qwen': ['DASHSCOPE_API_KEY'],
      'doubao': ['DOUBAO_API_KEY', 'VOLC_API_KEY', 'VOLC_ACCESS_KEY'],
      'gemini': ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    }

    for (const envName of envMap[provider] ?? []) {
      const val = process.env[envName]
      if (val && val.length > 0) return val
    }

    // Fallback to D:\voicespirit\config.json
    const fallback = loadVoiceSpiritFallback()
    if (fallback) {
      if (provider === 'cartesia-deepseek') {
        if (fallback.cartesiaApiKey || fallback.deepseekApiKey) {
          return fallback.deepseekApiKey || fallback.cartesiaApiKey
        }
      } else if (provider === 'qwen' && fallback.dashscopeApiKey) {
        return fallback.dashscopeApiKey
      } else if (provider === 'doubao' && (fallback.doubaoApiKey || fallback.doubaoAccessToken)) {
        return fallback.doubaoApiKey || fallback.doubaoAccessToken
      } else if (provider === 'gemini' && fallback.googleApiKey) {
        return fallback.googleApiKey
      }
    }

    return undefined
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${VOICE_AGENT_API_PATH}/status`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedRequest(req)) {
        res.writeHead(403)
        res.end()
        return
      }
      const current = settings()
      const configuredKey = await resolveApiKey(current.provider)
      const body = JSON.stringify({
        ok: true,
        provider: current.provider,
        model: current.model,
        voice: current.voice,
        apiKeyEnv: current.apiKeyEnv,
        keyConfigured: configuredKey !== undefined,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    },
  }), 'host-voice-agent: status route')

  const sockets = new WebSocketServer({ noServer: true })
  ctx.effect(() => () => {
    for (const client of sockets.clients) client.terminate()
    sockets.close()
  }, 'host-voice-agent: socket server')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: `${VOICE_AGENT_API_PATH}/ws`,
    handler: (req, socket, head) => {
      if (!isTrustedRequest(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      sockets.handleUpgrade(req, socket, head, (client) => {
        const current = settings()
        void resolveApiKey(current.provider).then((apiKey) => {
          if (client.readyState !== client.OPEN) return
          if (apiKey === undefined) {
            client.send(JSON.stringify({
              type: 'error',
              message: `未配置 ${current.provider} API 密钥：请在设置或环境变量 / D:/voicespirit/config.json 中配置`,
            }))
            client.close(1008, 'missing API key')
            return
          }
          const fallback = loadVoiceSpiritFallback()
          const extraKeys = fallback ? {
            cartesiaApiKey: fallback.cartesiaApiKey,
            deepseekApiKey: fallback.deepseekApiKey,
            dashscopeApiKey: fallback.dashscopeApiKey,
            dashscopeWsUrl: fallback.dashscopeWsUrl,
            doubaoAccessToken: fallback.doubaoAccessToken,
            doubaoAppId: fallback.doubaoAppId,
            doubaoApiKey: fallback.doubaoApiKey,
            googleApiKey: fallback.googleApiKey,
          } : undefined

          runLiveCall(client, {
            provider: current.provider,
            apiKey,
            model: current.model,
            voice: current.voice,
            instructions: buildInstructions(current.instructions),
            functionDeclarations: FUNCTION_DECLARATIONS,
            prices: {
              audioInput: current.priceAudioInput,
              textInput: current.priceTextInput,
              audioOutput: current.priceAudioOutput,
              textOutput: current.priceTextOutput,
            },
            logger: ctx.logger,
            extraKeys,
          })
        }, (error: unknown) => {
          ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          client.close(1011, 'credential lookup failed')
        })
      })
    },
  }), 'host-voice-agent: call upgrade')
}

function isTrustedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}
