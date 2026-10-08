/**
 * The `voice-agent` settings namespace: which Gemini Live model and voice the
 * call uses, and which credential reference holds the Gemini API key. The key
 * itself lives in the credentials store (or the environment), never here.
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the voice-agent host plugin. */
export const VOICE_AGENT_NAMESPACE = 'voice-agent'

/** Credential reference the Gemini API key is stored under by default. */
export const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'

/** Default Gemini Live model: native audio, tool calling, low latency. */
export const DEFAULT_MODEL = 'gemini-3.8-live'

/** Prebuilt Gemini Live voices offered in the settings card. */
export const VOICE_AGENT_VOICES = [
  'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr',
] as const

/** Harness-side configuration persisted under the `voice-agent` namespace. */
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

/** Schema for the namespace; also the wire envelope configuration UIs render. */
export const VoiceAgentSettingsSchema: z<VoiceAgentSettings> = z.object({
  model: z.string().default(DEFAULT_MODEL),
  voice: z.string().default('Puck'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  instructions: z.string().default(''),
})
