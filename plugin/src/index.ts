/**
 * @deepseek-ai/dsh-host-voice-agent — host half of realtime voice control.
 *
 * Serves a status route and the `/api/voice-agent/ws` upgrade that pairs each browser call with a Gemini
 * Live session (see {@link runLiveCall}). The Gemini API key is resolved from
 * the credentials store on every call start and never reaches the browser.
 * @module @deepseek-ai/dsh-host-voice-agent
 */

import { WebSocketServer } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { runLiveCall } from './live.ts'
import type { Config, VoiceAgentSettings } from './settings.ts'
import { FUNCTION_DECLARATIONS, buildInstructions } from './tools.ts'

export {
  Config, DEFAULT_API_KEY_ENV, DEFAULT_MODEL, VOICE_AGENT_VOICES, type VoiceAgentSettings,
} from './settings.ts'
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
 * @param config - live references to the plugin Config.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = (): VoiceAgentSettings => ({
    model: config.model.get(),
    voice: config.voice.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    instructions: config.instructions.get(),
  })

  const resolveApiKey = async (): Promise<string | undefined> => {
    const ref = credentialRef(settings().apiKeyEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = process.env[ref]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${VOICE_AGENT_API_PATH}/status`,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      const current = settings()
      const body = JSON.stringify({
        ok: true,
        model: current.model,
        voice: current.voice,
        apiKeyEnv: current.apiKeyEnv,
        keyConfigured: (await resolveApiKey()) !== undefined,
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    },
  }), 'host-voice-agent: status route')

  const sockets = new WebSocketServer({ noServer: true })
  ctx.effect(() => () => { sockets.close() }, 'host-voice-agent: socket server')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: `${VOICE_AGENT_API_PATH}/ws`,
    handler: (req, socket, head) => {
      // WebSockets are exempt from CORS: without this check any web page the
      // user visits could open a call on their Gemini key.
      if (!isSameOrigin(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      sockets.handleUpgrade(req, socket, head, (client) => {
        void resolveApiKey().then((apiKey) => {
          const current = settings()
          if (apiKey === undefined) {
            client.send(JSON.stringify({
              type: 'error',
              message: `No Gemini API key: set ${current.apiKeyEnv} in Settings → Plugins → Voice Agent`,
            }))
            client.close(1008, 'missing API key')
            return
          }
          runLiveCall(client, {
            apiKey,
            model: current.model,
            voice: current.voice,
            instructions: buildInstructions(current.instructions),
            functionDeclarations: FUNCTION_DECLARATIONS,
            logger: ctx.logger,
          })
        }, (error: unknown) => {
          ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          client.close(1011, 'credential lookup failed')
        })
      })
    },
  }), 'host-voice-agent: call upgrade')
}

/**
 * Whether an upgrade request comes from a page served by this host. Requests
 * without an Origin header (non-browser local clients) are accepted.
 * @param req - the upgrade request.
 * @returns true when the Origin host matches the Host header.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    // An unparsable Origin cannot name this host.
    return false
  }
}
