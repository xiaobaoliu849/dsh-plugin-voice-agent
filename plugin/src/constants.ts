/**
 * Pure constants and defaults for voice providers, shared safely between
 * host relay and browser client without node dependencies.
 */

export const VOICE_AGENT_PROVIDERS = [
  'cartesia-deepseek',
  'qwen',
  'doubao',
  'gemini',
] as const

export type VoiceAgentProvider = typeof VOICE_AGENT_PROVIDERS[number]

/** Default provider: Cartesia + DeepSeek (ultra low-latency turn detection + DeepSeek coding brain). */
export const DEFAULT_PROVIDER: VoiceAgentProvider = 'cartesia-deepseek'

/** Default model per provider. */
export const PROVIDER_DEFAULT_MODELS: Record<VoiceAgentProvider, string> = {
  'cartesia-deepseek': 'deepseek-chat',
  'qwen': 'qwen3.8-omni-flash-realtime',
  'doubao': '1.2.6.1',
  'gemini': 'gemini-3.8-live',
}

/** Default voice per provider. */
export const PROVIDER_DEFAULT_VOICES: Record<VoiceAgentProvider, string> = {
  'cartesia-deepseek': 'f786b574-daa5-4673-aa0c-cbe3e8534c02', // Katie
  'qwen': 'Tina',
  'doubao': 'zh_female_vv_jupiter_bigtts',
  'gemini': 'Puck',
}

/** Prebuilt voice lists per provider. */
export const PROVIDER_VOICES: Record<VoiceAgentProvider, readonly string[]> = {
  'cartesia-deepseek': [
    'f786b574-daa5-4673-aa0c-cbe3e8534c02', // Katie (en)
    '227282cb-beee-4322-a9b4-7f15be0f0928', // Chinese / Multilingual
    'sonic-multilingual',
    'Jack',
    'Eileen',
  ],
  'qwen': [
    'Tina',
    'longanqian',
    'cherry',
    'longanlingxin',
    'Zane',
    'Cici',
  ],
  'doubao': [
    'zh_female_vv_jupiter_bigtts',
    'zh_female_xiaohe_jupiter_bigtts',
    'zh_male_yunzhou_jupiter_bigtts',
    'zh_male_xiaotian_jupiter_bigtts',
    'en_male_tim_uranus_bigtts',
  ],
  'gemini': [
    'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr',
  ],
}

export const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'
export const DEFAULT_MODEL = PROVIDER_DEFAULT_MODELS.gemini
export const VOICE_AGENT_VOICES = PROVIDER_VOICES.gemini
