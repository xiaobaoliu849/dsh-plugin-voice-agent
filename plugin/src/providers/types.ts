import type { Context } from '@deepseek-ai/cordis'
import type { VoiceAgentProvider } from '../settings.ts'

/** Browser → host control messages (audio travels as binary PCM16 16kHz frames). */
export type BrowserMessage =
  | { type: 'tool_response'; id: string; name: string; response: Record<string, unknown> }
  | { type: 'agent_update'; text: string }
  | { type: 'text'; text: string }
  | { type: 'audio_end' }

/** Host → browser control messages (model audio travels as binary PCM16 24kHz frames). */
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
  | { type: 'usage'; usage: CallUsage }

/** USD per million tokens, by direction and modality. */
export interface TokenPrices {
  audioInput: number
  textInput: number
  audioOutput: number
  textOutput: number
}

/** Token and cost totals for one call. */
export interface CallUsage {
  audioInputTokens: number
  textInputTokens: number
  audioOutputTokens: number
  textOutputTokens: number
  costUsd: number
}

/** Everything one call needs to open its voice session. */
export interface ProviderSessionOptions {
  provider: VoiceAgentProvider
  apiKey: string
  model: string
  voice: string
  instructions: string
  functionDeclarations: readonly object[]
  prices: TokenPrices
  logger: Context['logger']
  extraKeys?: {
    cartesiaApiKey?: string | undefined
    deepseekApiKey?: string | undefined
    dashscopeApiKey?: string | undefined
    dashscopeWsUrl?: string | undefined
    doubaoAccessToken?: string | undefined
    doubaoAppId?: string | undefined
    doubaoApiKey?: string | undefined
    googleApiKey?: string | undefined
  } | undefined
}
