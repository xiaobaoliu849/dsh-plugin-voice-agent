import { WebSocket } from 'ws'
import type { ProviderSessionOptions } from './providers/types.ts'
import { runGeminiCall } from './providers/gemini.ts'
import { runCartesiaDeepSeekCall } from './providers/cartesia-deepseek.ts'
import { runQwenCall } from './providers/qwen.ts'
import { runDoubaoCall } from './providers/doubao.ts'

export type {
  BrowserMessage,
  HostMessage,
  TokenPrices,
  CallUsage,
  ProviderSessionOptions as LiveCallOptions,
} from './providers/types.ts'

/**
 * Dispatch and run one voice call with the configured provider.
 * @param client - the browser WebSocket.
 * @param options - session configuration and provider options.
 */
export function runLiveCall(client: WebSocket, options: ProviderSessionOptions): void {
  const provider = options.provider || 'cartesia-deepseek'
  options.logger.info('voice-agent: starting call with provider "%s" (model: %s, voice: %s)', provider, options.model, options.voice)

  switch (provider) {
    case 'cartesia-deepseek':
      runCartesiaDeepSeekCall(client, options)
      break
    case 'qwen':
      runQwenCall(client, options)
      break
    case 'doubao':
      runDoubaoCall(client, options)
      break
    case 'gemini':
      runGeminiCall(client, options)
      break
    default:
      options.logger.warn('voice-agent: unknown provider "%s", falling back to cartesia-deepseek', provider)
      runCartesiaDeepSeekCall(client, options)
      break
  }
}
