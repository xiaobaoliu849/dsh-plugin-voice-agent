/**
 * The voice-agent plugin Config: which provider, model, voice, and API key
 * reference the call uses, and extra instructions. Every field is volatile,
 * so the Settings page edits it live and the next call start reads the new value.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_API_KEY_ENV, DEFAULT_PROVIDER,
  PROVIDER_DEFAULT_MODELS, PROVIDER_DEFAULT_VOICES,
  VOICE_AGENT_PROVIDERS, type VoiceAgentProvider,
} from './constants.ts'

export * from './constants.ts'
export { loadVoiceSpiritFallback, type VoiceSpiritFallbackConfig } from './fallback.ts'

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

/** Live references to the volatile fields of {@link VoiceAgentSettings}. */
export type Config = { [K in keyof VoiceAgentSettings]: Volatile<VoiceAgentSettings[K]> }

/** Plugin Config schema; the settings page edits these fields. */
export const Config = z.object({
  provider: z.union([...VOICE_AGENT_PROVIDERS]).default(DEFAULT_PROVIDER).volatile(),
  model: z.string().default(PROVIDER_DEFAULT_MODELS[DEFAULT_PROVIDER]).volatile(),
  voice: z.string().default(PROVIDER_DEFAULT_VOICES[DEFAULT_PROVIDER]).volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  instructions: z.string().default('').volatile(),
  priceAudioInput: z.number().min(0).default(3).volatile(),
  priceTextInput: z.number().min(0).default(0.75).volatile(),
  priceAudioOutput: z.number().min(0).default(4.5).volatile(),
  priceTextOutput: z.number().min(0).default(4.5).volatile(),
})
