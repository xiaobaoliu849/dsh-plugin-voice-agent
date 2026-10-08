/**
 * Call dock (`conversation.input.dock`): shown above the composer while a
 * call is open or has just failed. Displays the connection phase, the agent's
 * activity, live mic/speaker levels, and the recent spoken transcript.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { VoiceAgentController, VoiceAgentState } from '../controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { VoiceAgentKey } from '../locales.ts'
import styles from './VoiceAgent.module.css'

/** Props injected by the slot registration. */
export interface VoiceAgentDockProps {
  controller: VoiceAgentController
  t: (key: VoiceAgentKey) => string
  /** The conversation this composer belongs to (session-scoped slot standard prop). */
  sessionId?: SessionId | undefined
}

const PHASE_KEY: Record<Exclude<VoiceAgentState['phase'], 'idle'>, VoiceAgentKey> = {
  connecting: 'phaseConnecting',
  live: 'phaseLive',
  reconnecting: 'phaseReconnecting',
  error: 'phaseError',
}

const SPEAKER_KEY: Record<'user' | 'assistant' | 'agent', VoiceAgentKey> = {
  user: 'speakerUser',
  assistant: 'speakerAssistant',
  agent: 'speakerAgent',
}

/** Bars in the level meter; the first half shows the mic, the second the speaker. */
const BARS = 6

/**
 * Render the dock, or nothing while no call is open.
 * @param props - the call controller and locale lookup.
 * @returns the dock.
 */
export function VoiceAgentDock({ controller, t, sessionId }: VoiceAgentDockProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { controller.setSession(sessionId) }, [controller, sessionId])
  const levels = useLevels(controller, state.phase === 'live')
  const linesRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const list = linesRef.current
    if (list !== null) list.scrollTop = list.scrollHeight
  }, [state.lines])

  if (state.phase === 'idle') return null
  const isError = state.phase === 'error'
  return (
    <section className={styles.dock} aria-label={t('startCall')}>
      <div className={styles.bar}>
        <div className={styles.meter} aria-hidden="true">
          {Array.from({ length: BARS }, (_, index) => {
            const speaker = index >= BARS / 2
            const level = speaker ? levels.speaker : levels.mic
            const height = 3 + Math.round(level * 17 * (0.6 + 0.4 * Math.sin(index * 1.7 + 1)))
            return <span key={index} className={`${styles.meterBar} ${speaker ? styles.meterBarSpeaker : ''}`} style={{ height }} />
          })}
        </div>
        <span className={`${styles.status} ${isError ? styles.statusError : ''}`} role="status">
          {isError && state.error !== null ? `${t('phaseError')}: ${state.error}` : t(PHASE_KEY[state.phase])}
        </span>
        {state.activity !== 'idle' && (
          <span className={`${styles.badge} ${state.activity === 'approval' ? styles.badgeApproval : ''}`}>
            {state.activity === 'approval' ? t('activityApproval') : t('activityWorking')}
          </span>
        )}
        {!isError && (
          <button
            type="button"
            className={`${styles.iconBtn} ${state.muted ? styles.iconBtnOn : ''}`}
            onClick={() => { controller.toggleMute() }}
            title={state.muted ? t('unmute') : t('mute')}
            aria-label={state.muted ? t('unmute') : t('mute')}
            aria-pressed={state.muted}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              {state.muted && <line x1="3" y1="3" x2="21" y2="21" />}
            </svg>
          </button>
        )}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => { controller.end() }}
          title={t('endCall')}
          aria-label={t('endCall')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
      {state.lines.length === 0
        ? !isError && <div className={styles.hint}>{t('emptyHint')}</div>
        : (
          <ul className={styles.lines} ref={linesRef}>
            {state.lines.map((line, index) => (
              <li key={index} className={`${styles.line} ${line.role === 'agent' ? styles.lineAgent : ''}`}>
                <span className={styles.speaker}>{t(SPEAKER_KEY[line.role])}</span>
                {line.text}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/**
 * Poll mic and speaker levels once per animation frame while live.
 * @param controller - source of the levels.
 * @param active - whether to poll.
 * @returns the latest levels.
 */
function useLevels(controller: VoiceAgentController, active: boolean): { mic: number; speaker: number } {
  const [levels, setLevels] = useState({ mic: 0, speaker: 0 })
  useEffect(() => {
    if (!active) {
      setLevels({ mic: 0, speaker: 0 })
      return
    }
    let frame = requestAnimationFrame(function tick() {
      setLevels(controller.levels())
      frame = requestAnimationFrame(tick)
    })
    return () => { cancelAnimationFrame(frame) }
  }, [controller, active])
  return levels
}
