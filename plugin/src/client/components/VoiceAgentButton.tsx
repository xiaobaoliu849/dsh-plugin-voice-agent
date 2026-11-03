/**
 * Composer voice-call button (`conversation.input.right`): starts or ends the
 * voice call that controls the agent.
 *
 * It uses a sound-wave icon rather than a microphone, so it stays distinct
 * from the Harness dictation microphone that can sit in the same composer.
 * While a call is open it fills with the brand color, its bars move, and a
 * soft ring pulses; while the agent waits for approval the ring turns amber.
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { VoiceAgentController } from '../controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { VoiceAgentKey } from '../locales.ts'
import styles from './VoiceAgent.module.css'

/** Props injected by the slot registration. */
export interface VoiceAgentButtonProps {
  controller: VoiceAgentController
  t: (key: VoiceAgentKey) => string
  /** The conversation this composer belongs to (session-scoped slot standard prop). */
  sessionId?: SessionId | undefined
}

/**
 * Render the voice-call toggle.
 * @param props - the call controller and locale lookup.
 * @returns the button.
 */
export function VoiceAgentButton({ controller, t, sessionId }: VoiceAgentButtonProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { controller.setSession(sessionId) }, [controller, sessionId])
  const active = state.phase !== 'idle' && state.phase !== 'error'
  const label = active ? t('endCall') : t('startCall')
  const className = [
    styles.callBtn,
    active ? styles.callBtnActive : '',
    state.phase === 'connecting' || state.phase === 'reconnecting' ? styles.callBtnPending : '',
    active && state.activity === 'approval' ? styles.callBtnApproval : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={className}
      onClick={() => { if (active) controller.end(); else void controller.start() }}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <svg className={styles.waveIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <line className={styles.waveIconBar} x1="4" y1="10" x2="4" y2="14" />
        <line className={styles.waveIconBar} x1="8" y1="6" x2="8" y2="18" />
        <line className={styles.waveIconBar} x1="12" y1="3" x2="12" y2="21" />
        <line className={styles.waveIconBar} x1="16" y1="7" x2="16" y2="17" />
        <line className={styles.waveIconBar} x1="20" y1="10" x2="20" y2="14" />
      </svg>
    </button>
  )
}
