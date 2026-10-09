import { readFileSync } from 'node:fs'

/** Cached keys from D:\voicespirit\config.json for seamless zero-config fallback. */
export interface VoiceSpiritFallbackConfig {
  cartesiaApiKey?: string | undefined
  deepseekApiKey?: string | undefined
  dashscopeApiKey?: string | undefined
  dashscopeWsUrl?: string | undefined
  doubaoAccessToken?: string | undefined
  doubaoAppId?: string | undefined
  doubaoApiKey?: string | undefined
  googleApiKey?: string | undefined
}

let cachedVoiceSpiritConfig: VoiceSpiritFallbackConfig | null | undefined

/** Safely read keys from D:\voicespirit\config.json if available. */
export function loadVoiceSpiritFallback(): VoiceSpiritFallbackConfig | null {
  if (cachedVoiceSpiritConfig !== undefined) return cachedVoiceSpiritConfig
  try {
    const raw = readFileSync('D:/voicespirit/config.json', 'utf8')
    const parsed = JSON.parse(raw) as {
      api_keys?: Record<string, string>
      realtime_api_urls?: Record<string, string>
    }
    const keys = parsed.api_keys ?? {}
    const urls = parsed.realtime_api_urls ?? {}
    cachedVoiceSpiritConfig = {
      cartesiaApiKey: keys.cartesia_api_key ? keys.cartesia_api_key.trim() : undefined,
      deepseekApiKey: keys.deepseek_api_key ? keys.deepseek_api_key.trim() : undefined,
      dashscopeApiKey: keys.dashscope_api_key ? keys.dashscope_api_key.trim() : undefined,
      dashscopeWsUrl: urls.DashScope ? urls.DashScope.trim() : undefined,
      doubaoAccessToken: keys.doubao_access_token ? keys.doubao_access_token.trim() : undefined,
      doubaoAppId: keys.doubao_app_id ? keys.doubao_app_id.trim() : undefined,
      doubaoApiKey: keys.doubao_websearch_api_key ? keys.doubao_websearch_api_key.trim() : undefined,
      googleApiKey: keys.google_api_key ? keys.google_api_key.trim() : undefined,
    }
  } catch {
    cachedVoiceSpiritConfig = null
  }
  return cachedVoiceSpiritConfig ?? null
}
