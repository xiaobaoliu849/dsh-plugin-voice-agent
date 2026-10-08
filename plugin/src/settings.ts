/**
 * The voice-agent plugin Config: which Gemini Live model and voice the call
 * uses, which credential reference holds the Gemini API key, and extra
 * instructions. Every field is volatile, so the Settings page edits it live
 * and the next call start reads the new value. The key itself lives in the
 * credentials store (or the environment), never in this Config.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Credential reference the Gemini API key is stored under by default. */
export const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'

/** Default Gemini Live model: native audio, tool calling, low latency. */
export const DEFAULT_MODEL = 'gemini-3.8-live'

/** Prebuilt Gemini Live voices offered by the settings page. */
export const VOICE_AGENT_VOICES = [
  'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr',
] as const

/** Resolved values of one call's settings. */
export interface VoiceAgentSettings {
  /** Gemini Live model id, without the `models/` prefix. */
  model: string
  /** Prebuilt voice name. */
  voice: string
  /** Credential reference holding the Gemini API key. */
  apiKeyEnv: string
  /** Extra instructions appended to the built-in voice prompt (e.g. "Always answer in Chinese"). */
  instructions: string
}

/** Live references to the volatile fields of {@link VoiceAgentSettings}. */
export type Config = { [K in keyof VoiceAgentSettings]: Volatile<VoiceAgentSettings[K]> }

/** Plugin Config schema; the settings page edits these fields. */
export const Config = z.object({
  model: z.string().default(DEFAULT_MODEL).volatile(),
  voice: z.string().default('Puck').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  instructions: z.string().default('').volatile(),
})
