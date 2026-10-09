import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_API_KEY_ENV, DEFAULT_PROVIDER,
  PROVIDER_DEFAULT_MODELS, PROVIDER_DEFAULT_VOICES,
  VOICE_AGENT_PROVIDERS, type VoiceAgentProvider,
} from './constants.ts'

export * from './constants.ts'
export { loadVoiceSpiritFallback, type VoiceSpiritFallbackConfig } from './fallback.ts'

/** Settings namespace owned by the voice-agent host plugin. */
export const VOICE_AGENT_NAMESPACE = 'voice-agent'

/** Resolved values of one call's settings. */
export interface VoiceAgentSettings {
  /** Active provider. */
  provider: VoiceAgentProvider
  /** Model id. */
  model: string
  /** Prebuilt voice name or id. */
  voice: string
  /** Primary credential reference holding the API key. */
  apiKeyEnv: string
  /** Extra instructions appended to the built-in voice prompt. */
  instructions: string
  /** USD per million audio input tokens, for the per-call cost estimate. */
  priceAudioInput: number
  /** USD per million text input tokens (prompt, tool results, agent updates). */
  priceTextInput: number
  /** USD per million audio output tokens. */
  priceAudioOutput: number
  /** USD per million text output and thinking tokens. */
  priceTextOutput: number
}

/** Plugin Config schema; the settings page edits these fields. */
export const VoiceAgentSettingsSchema: z<VoiceAgentSettings> = z.object({
  provider: z.union([...VOICE_AGENT_PROVIDERS]).default(DEFAULT_PROVIDER),
  model: z.string().default(PROVIDER_DEFAULT_MODELS[DEFAULT_PROVIDER]),
  voice: z.string().default(PROVIDER_DEFAULT_VOICES[DEFAULT_PROVIDER]),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  instructions: z.string().default(''),
  priceAudioInput: z.number().min(0).default(3),
  priceTextInput: z.number().min(0).default(0.75),
  priceAudioOutput: z.number().min(0).default(4.5),
  priceTextOutput: z.number().min(0).default(4.5),
})

export const Config = VoiceAgentSettingsSchema
