/**
 * Composer mic button (`conversation.input.right`): starts or ends the voice
 * call that controls the agent.
 */

import { useSyncExternalStore } from 'react'
import type { VoiceAgentController } from '../controller.ts'
import type { VoiceAgentKey } from '../locales.ts'
import styles from './VoiceAgent.module.css'

/** Props injected by the slot registration. */
export interface VoiceAgentButtonProps {
  controller: VoiceAgentController
  t: (key: VoiceAgentKey) => string
}

/**
 * Render the mic toggle.
 * @param props - the call controller and locale lookup.
 * @returns the button.
 */
export function VoiceAgentButton({ controller, t }: VoiceAgentButtonProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const active = state.phase !== 'idle' && state.phase !== 'error'
  const label = active ? t('endCall') : t('startCall')
  return (
    <button
      type="button"
      className={`${styles.micBtn} ${active ? styles.micBtnActive : ''}`}
      onClick={() => { if (active) controller.end(); else void controller.start() }}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    </button>
  )
}
