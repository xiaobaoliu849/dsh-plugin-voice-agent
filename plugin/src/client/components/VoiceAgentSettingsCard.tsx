/**
 * Settings → Plugins card for the `voice-agent` namespace: provider selection,
 * API key, model, voice, and extra instructions.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { VoiceAgentKey } from '../locales.ts'
import {
  PROVIDER_DEFAULT_MODELS, PROVIDER_DEFAULT_VOICES, PROVIDER_VOICES,
  VOICE_AGENT_PROVIDERS, type VoiceAgentProvider,
} from '../../constants.ts'
import styles from './VoiceAgent.module.css'

/** Client view of the host `voice-agent` settings section. */
export interface VoiceAgentSettings {
  provider: VoiceAgentProvider
  model: string
  voice: string
  apiKeyEnv: string
  instructions: string
}

/** Credential operations the card needs (backed by `ctx.remote.credentials`). */
export interface CredentialAccess {
  /** @returns whether the reference holds a value, or undefined when the Host did not answer. */
  configured(ref: string): Promise<boolean | undefined>
  /** Store a value under the reference. */
  set(ref: string, value: string): Promise<void>
}

/** Props injected by the slot registration. */
export interface VoiceAgentSettingsCardProps {
  scope: ConfigForm<VoiceAgentSettings>
  credentials: CredentialAccess
  voices: readonly string[]
  t: (key: VoiceAgentKey) => string
}

type Notice = 'saved' | 'saveFailed' | null

const PROVIDER_KEY_NAMES: Record<VoiceAgentProvider, VoiceAgentKey> = {
  'cartesia-deepseek': 'providerCartesia',
  qwen: 'providerQwen',
  doubao: 'providerDoubao',
  gemini: 'providerGemini',
}

const PROVIDER_ENV_DEFAULTS: Record<VoiceAgentProvider, string> = {
  'cartesia-deepseek': 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  doubao: 'DOUBAO_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

/**
 * Render the settings card.
 */
export function VoiceAgentSettingsCard({ scope, credentials, voices, t }: VoiceAgentSettingsCardProps) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const read = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, read)
  const value = snapshot.value
  const [draft, setDraft] = useState<Omit<VoiceAgentSettings, 'apiKeyEnv'> | undefined>(undefined)
  const [key, setKey] = useState('')
  const [keyConfigured, setKeyConfigured] = useState<boolean | undefined>(undefined)
  const [notice, setNotice] = useState<Notice>(null)

  const activeProvider: VoiceAgentProvider = draft?.provider ?? value?.provider ?? 'cartesia-deepseek'
  const ref = value?.apiKeyEnv || PROVIDER_ENV_DEFAULTS[activeProvider] || 'GEMINI_API_KEY'

  const refreshKey = useCallback(async () => {
    setKeyConfigured(await credentials.configured(ref))
  }, [credentials, ref])
  useEffect(() => { void refreshKey() }, [refreshKey])

  if (value === undefined) return null

  const form: Omit<VoiceAgentSettings, 'apiKeyEnv'> = draft ?? {
    provider: value.provider || 'cartesia-deepseek',
    model: value.model,
    voice: value.voice,
    instructions: value.instructions,
  }

  const dirty =
    form.provider !== value.provider ||
    form.model !== value.model ||
    form.voice !== value.voice ||
    form.instructions !== value.instructions

  const edit = (patch: Partial<typeof form>): void => {
    setNotice(null)
    setDraft({ ...form, ...patch })
  }

  const handleProviderChange = (newProvider: VoiceAgentProvider): void => {
    edit({
      provider: newProvider,
      model: PROVIDER_DEFAULT_MODELS[newProvider] ?? form.model,
      voice: PROVIDER_DEFAULT_VOICES[newProvider] ?? form.voice,
    })
  }

  const save = async (): Promise<void> => {
    try {
      const ops = (['provider', 'model', 'voice', 'instructions'] as const)
        .filter(field => form[field] !== value[field])
        .map(field => ({ op: 'set' as const, path: [field], value: form[field] }))
      const accepted = await scope.mutate(ops, snapshot.revision)
      if (accepted) setDraft(undefined)
      setNotice(accepted ? 'saved' : 'saveFailed')
    } catch {
      setNotice('saveFailed')
    }
  }

  const saveKey = async (): Promise<void> => {
    try {
      await credentials.set(ref, key.trim())
      setKey('')
      setNotice('saved')
    } catch {
      setNotice('saveFailed')
    }
    await refreshKey()
  }

  const availableVoices = PROVIDER_VOICES[form.provider] ?? voices
  const voiceOptions = availableVoices.includes(form.voice) ? availableVoices : [form.voice, ...availableVoices]

  return (
    <div className={styles.card}>
      <div>
        <div className={styles.cardTitle}>{t('cardTitle')}</div>
        <div className={styles.cardDescription}>{t('cardDescription')}</div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="voice-agent-provider">{t('provider')}</label>
        <select
          id="voice-agent-provider"
          className={styles.input}
          value={form.provider}
          disabled={snapshot.status !== 'ready'}
          onChange={(event) => { handleProviderChange(event.target.value as VoiceAgentProvider) }}
        >
          {VOICE_AGENT_PROVIDERS.map(p => (
            <option key={p} value={p}>{t(PROVIDER_KEY_NAMES[p])}</option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="voice-agent-key">
          {t('apiKey')}
          {keyConfigured !== undefined && <span className={styles.keyState}> · {keyConfigured ? t('apiKeySet') : t('apiKeyUnset')}</span>}
        </label>
        <div className={styles.row}>
          <input
            id="voice-agent-key"
            className={styles.input}
            type="password"
            autoComplete="off"
            value={key}
            placeholder={t('apiKeyPlaceholder')}
            onChange={(event) => { setKey(event.target.value) }}
          />
          <button type="button" className={styles.button} disabled={key.trim() === ''} onClick={() => { void saveKey() }}>
            {t('saveKey')}
          </button>
        </div>
        <span className={styles.fieldHint}>{t('apiKeyHint')} ({ref})</span>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="voice-agent-model">{t('model')}</label>
        <input
          id="voice-agent-model"
          className={styles.input}
          value={form.model}
          disabled={snapshot.status !== 'ready'}
          onChange={(event) => { edit({ model: event.target.value }) }}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="voice-agent-voice">{t('voice')}</label>
        <select
          id="voice-agent-voice"
          className={styles.input}
          value={form.voice}
          disabled={snapshot.status !== 'ready'}
          onChange={(event) => { edit({ voice: event.target.value }) }}
        >
          {voiceOptions.map(voice => <option key={voice} value={voice}>{voice}</option>)}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="voice-agent-instructions">{t('instructions')}</label>
        <textarea
          id="voice-agent-instructions"
          className={`${styles.input} ${styles.textarea}`}
          value={form.instructions}
          disabled={snapshot.status !== 'ready'}
          onChange={(event) => { edit({ instructions: event.target.value }) }}
        />
        <span className={styles.fieldHint}>{t('instructionsHint')}</span>
      </div>

      <div className={styles.row}>
        <button type="button" className={styles.button} disabled={!dirty || snapshot.status !== 'ready'} onClick={() => { void save() }}>
          {t('save')}
        </button>
        {notice !== null && <span className={styles.notice} role="status">{t(notice)}</span>}
      </div>
    </div>
  )
}
