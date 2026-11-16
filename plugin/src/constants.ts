/**
 * Pure constants and defaults for voice providers, shared safely between
 * host relay and browser client without node dependencies.
 */

export const VOICE_AGENT_PROVIDERS = [
  'cartesia-deepseek',
  'qwen',
  'doubao',
  'gemini',
  'moss',
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
  'moss': 'moss-live-1.0',
}

/** Verified Mandarin voice that also synthesizes English with Sonic 3.6. */
export const CARTESIA_DEFAULT_VOICE = '6eb8965c-e295-47bd-a9e4-3eeebb3abcff'

/** Cartesia voice IDs and names returned by the voices API. */
export const CARTESIA_VOICE_NAMES: Record<string, string> = {
  [CARTESIA_DEFAULT_VOICE]: 'Jing - Clear Coordinator',
}

/** Curated MOSS-Live voices from MOSS Voice Library. */
export const MOSS_DEFAULT_CHINESE_VOICE = '42161c92-b6ad-4d12-a51e-48506ecfad82'
export const MOSS_DEFAULT_ENGLISH_VOICE = 'ad8f9ced-3276-42f1-a2ca-a686c7d5e01d'

/** MOSS-Live voice IDs and human-readable labels. */
export const MOSS_VOICE_NAMES: Record<string, string> = {
  [MOSS_DEFAULT_CHINESE_VOICE]: '豆包 · 原生中文 (Native Chinese)',
  [MOSS_DEFAULT_ENGLISH_VOICE]: 'Chenlin · 原生英语 (Native English)',
  '6c3152b1-1d4f-4e49-ade3-09f447712fec': '暖暖 · 温柔中文 (Warm Chinese)',
  '0f2815fb-0d4c-4cee-ac8c-0bb916af7b28': '女7 · 美式英语 (US English)',
  'b4b5f9c4-2829-4cfd-96f2-7fddaf8450bb': '自定义2 · 英语女声 (English Female)',
  'default': '默认中文音色 (Default)',
}

/** Default voice per provider. */
export const PROVIDER_DEFAULT_VOICES: Record<VoiceAgentProvider, string> = {
  'cartesia-deepseek': CARTESIA_DEFAULT_VOICE,
  'qwen': 'Tina',
  'doubao': 'zh_female_vv_jupiter_bigtts',
  'gemini': 'Puck',
  'moss': MOSS_DEFAULT_CHINESE_VOICE,
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
  'moss': Object.keys(MOSS_VOICE_NAMES),
}

export const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'
export const DEFAULT_MODEL = PROVIDER_DEFAULT_MODELS.gemini
export const VOICE_AGENT_VOICES = PROVIDER_VOICES.gemini
