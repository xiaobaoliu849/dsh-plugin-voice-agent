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
  'cartesia-deepseek': 'deepseek-flash',
  'qwen': 'qwen3.8-omni-flash-realtime',
  'doubao': '1.2.6.1',
  'gemini': 'gemini-3.8-live',
}

/** Verified Mandarin voice that also synthesizes English with Sonic 3.6. */
export const CARTESIA_DEFAULT_VOICE = '6eb8965c-e295-47bd-a9e4-3eeebb3abcff'

/** Cartesia voice IDs and names returned by the voices API. */
export const CARTESIA_VOICE_NAMES: Record<string, string> = {
  [CARTESIA_DEFAULT_VOICE]: 'Jing - Clear Coordinator',
}

/** Default voice per provider. */
export const PROVIDER_DEFAULT_VOICES: Record<VoiceAgentProvider, string> = {
  'cartesia-deepseek': CARTESIA_DEFAULT_VOICE,
  'qwen': 'Tina',
  'doubao': 'zh_female_vv_jupiter_bigtts',
  'gemini': 'Puck',
}

/** Prebuilt voice lists per provider. */
export const PROVIDER_VOICES: Record<VoiceAgentProvider, readonly string[]> = {
  'cartesia-deepseek': [CARTESIA_DEFAULT_VOICE],
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
