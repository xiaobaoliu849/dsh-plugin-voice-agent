/**
 * Settings → Plugins card for the `voice-agent` namespace: the Gemini API key
 * (written to the credentials store, never read back), model, voice, and
 * extra instructions.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { VoiceAgentKey } from '../locales.ts'
import styles from './VoiceAgent.module.css'

/** Client view of the host `voice-agent` settings section. */
export interface VoiceAgentSettings {
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

/**
 * Render the card.
 * @param props - settings scope, credential access, voice list, and locale lookup.
 * @returns the card.
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
  const ref = value?.apiKeyEnv ?? 'GEMINI_API_KEY'

  const refreshKey = useCallback(async () => {
    setKeyConfigured(await credentials.configured(ref))
  }, [credentials, ref])
  useEffect(() => { void refreshKey() }, [refreshKey])

  if (value === undefined) return null
  const form = draft ?? { model: value.model, voice: value.voice, instructions: value.instructions }
  const dirty = form.model !== value.model || form.voice !== value.voice || form.instructions !== value.instructions
  const edit = (patch: Partial<typeof form>): void => {
    setNotice(null)
    setDraft({ ...form, ...patch })
  }

  const save = async (): Promise<void> => {
    try {
      const ops = (['model', 'voice', 'instructions'] as const)
        .filter(field => form[field] !== value[field])
        .map(field => ({ op: 'set' as const, path: [field], value: form[field] }))
      const accepted = await scope.mutate(ops, snapshot.revision)
      if (accepted) setDraft(undefined)
      setNotice(accepted ? 'saved' : 'saveFailed')
    } catch {
      // The scope reloads Host state after a refused write; the notice is the only report.
      setNotice('saveFailed')
    }
  }

  const saveKey = async (): Promise<void> => {
    try {
      await credentials.set(ref, key.trim())
      setKey('')
      setNotice('saved')
    } catch {
      // The re-read below reports whether the Host holds a key after the failure.
      setNotice('saveFailed')
    }
    await refreshKey()
  }

  const voiceOptions = voices.includes(form.voice) ? voices : [form.voice, ...voices]
  return (
    <div className={styles.card}>
      <div>
        <div className={styles.cardTitle}>{t('cardTitle')}</div>
        <div className={styles.cardDescription}>{t('cardDescription')}</div>
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
