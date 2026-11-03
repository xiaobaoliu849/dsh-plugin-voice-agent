/**
 * Call dock (`conversation.input.dock`): shown above the composer while a
 * call is open or has just failed.
 *
 * Layout, top to bottom:
 * - Header: status dot and text, call timer, model chip, usage, mute, hang up.
 * - Waveform: one meter whose color shows who is talking (you or the voice).
 * - Task card: what the agent is doing for this call, how long it has run,
 *   its latest step, and whether it waits for approval in the window.
 * - Transcript: your words, the voice's replies, and short agent notices.
 * - On failure: the error and a Retry button.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CallUsage, TranscriptLine, VoiceAgentController, VoiceAgentState } from '../controller.ts'
import type { AgentTask } from '../bridge.ts'
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

const SPEAKER_KEY: Record<'user' | 'assistant', VoiceAgentKey> = {
  user: 'speakerUser',
  assistant: 'speakerAssistant',
}

const NOTICE_KEY = {
  finished: 'noticeFinished',
  cancelled: 'noticeCancelled',
  failed: 'noticeFailed',
  approval: 'noticeApproval',
} as const satisfies Record<string, VoiceAgentKey>

const NOTICE_CLASS = {
  finished: styles.noticeFinished,
  cancelled: styles.noticeCancelled,
  failed: styles.noticeFailed,
  approval: styles.noticeApproval,
} as const

/** Longest task text a notice line shows. */
const MAX_NOTICE_DETAIL = 80

/** Bars in the waveform. */
const BARS = 14

/**
 * Text of one agent notice; it stays one short line, since the full answer is
 * in the conversation and the voice speaks its summary.
 */
function noticeText(notice: Extract<TranscriptLine, { role: 'agent' }>['notice'], t: (key: VoiceAgentKey) => string): string {
  const { kind, detail } = notice
  if (kind === 'approval') return t(NOTICE_KEY.approval)
  const short = detail.length <= MAX_NOTICE_DETAIL ? detail : `${detail.slice(0, MAX_NOTICE_DETAIL)}…`
  return `${t(NOTICE_KEY[kind])}${short}`
}

/** @returns all tokens counted for the call. */
function totalTokens(usage: CallUsage): number {
  return usage.audioInputTokens + usage.textInputTokens + usage.audioOutputTokens + usage.textOutputTokens
}

/** @returns a compact token count such as `850 tok` or `12.4K tok`. */
function formatTokens(tokens: number): string {
  return tokens < 1000 ? `${String(tokens)} tok` : `${(tokens / 1000).toFixed(1)}K tok`
}

/** @returns USD with enough digits that sub-cent calls are not shown as zero. */
function formatCost(usd: number): string {
  return usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)
}

/** @returns `m:ss`, or `h:mm:ss` past an hour. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}` : `${String(minutes)}:${seconds}`
}

/** @returns the per-modality breakdown shown in the tooltip. */
function usageDetail(usage: CallUsage, t: (key: VoiceAgentKey) => string): string {
  return [
    `${t('usageAudioIn')} ${String(usage.audioInputTokens)}`,
    `${t('usageTextIn')} ${String(usage.textInputTokens)}`,
    `${t('usageAudioOut')} ${String(usage.audioOutputTokens)}`,
    `${t('usageTextOut')} ${String(usage.textOutputTokens)}`,
  ].join(' · ')
}

/**
 * Render the dock, or nothing while no call is open.
 * @param props - the call controller and locale lookup.
 * @returns the dock.
 */
export function VoiceAgentDock({ controller, t, sessionId }: VoiceAgentDockProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { controller.setSession(sessionId) }, [controller, sessionId])
  const levels = useLevels(controller, state.phase === 'live')
  const now = useNow(state.liveSince !== null || state.task !== null)
  const linesRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const list = linesRef.current
    if (list !== null) list.scrollTop = list.scrollHeight
  }, [state.lines])

  if (state.phase === 'idle') return null
  const isError = state.phase === 'error'
  const speakerTalking = levels.speaker > levels.mic
  const level = Math.max(levels.mic, levels.speaker)

  return (
    <section className={`${styles.dock} ${isError ? styles.dockError : ''}`} aria-label={t('dockLabel')}>
      <header className={styles.header}>
        <span className={`${styles.dot} ${styles[`dot_${state.phase}`] ?? ''}`} aria-hidden="true" />
        <span className={styles.status} role="status">
          {t(PHASE_KEY[state.phase])}
          {state.muted && !isError && <span className={styles.mutedTag}>{t('mutedTag')}</span>}
        </span>
        {state.liveSince !== null && !isError && (
          <span className={styles.timer} title={t('callDuration')}>{formatDuration(now - state.liveSince)}</span>
        )}
        {state.model !== null && !isError && <span className={styles.chip} title={t('model')}>{state.model}</span>}
        {state.usage !== null && (
          <span className={styles.usage} title={`${t('usageTitle')}\n${usageDetail(state.usage, t)}`}>
            {formatTokens(totalTokens(state.usage))} · ${formatCost(state.usage.costUsd)}
          </span>
        )}
        <span className={styles.spacer} />
        {!isError && (
          <button
            type="button"
            className={`${styles.iconBtn} ${state.muted ? styles.iconBtnMuted : ''}`}
            onClick={() => { controller.toggleMute() }}
            title={state.muted ? t('unmute') : t('mute')}
            aria-label={state.muted ? t('unmute') : t('mute')}
            aria-pressed={state.muted}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
              {state.muted && <line x1="3" y1="3" x2="21" y2="21" />}
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`${styles.iconBtn} ${styles.hangUpBtn}`}
          onClick={() => { controller.end() }}
          title={isError ? t('close') : t('endCall')}
          aria-label={isError ? t('close') : t('endCall')}
        >
          {isError
            ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            )
            : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.5 13.5c4.4-3.6 10.6-3.6 15 0l-1.8 2.6a1 1 0 0 1-1.3.3l-2.2-1.1a1 1 0 0 1-.5-.9v-1.6a12 12 0 0 0-3.4 0v1.6a1 1 0 0 1-.5.9l-2.2 1.1a1 1 0 0 1-1.3-.3Z" />
              </svg>
            )}
        </button>
      </header>

      {!isError && (
        <div
          className={`${styles.wave} ${speakerTalking ? styles.waveSpeaker : ''} ${state.phase !== 'live' ? styles.wavePending : ''}`}
          aria-hidden="true"
        >
          {Array.from({ length: BARS }, (_, index) => {
            // A symmetric envelope, taller in the middle, so the meter reads as a wave.
            const center = 1 - Math.abs(index - (BARS - 1) / 2) / (BARS / 2)
            const ripple = 0.55 + 0.45 * Math.sin(index * 1.9 + level * 6)
            const height = 3 + Math.round(level * 20 * (0.35 + 0.65 * center) * ripple)
            return <span key={index} className={styles.waveBar} style={{ height }} />
          })}
          <span className={styles.waveLabel}>
            {state.phase !== 'live' ? '' : level < 0.04 ? t('waveQuiet') : speakerTalking ? t('waveVoice') : t('waveYou')}
          </span>
        </div>
      )}

      {state.task !== null && !isError && (
        <TaskCard task={state.task} approval={state.activity === 'approval'} now={now} t={t} />
      )}

      {isError && (
        <div className={styles.errorBox} role="alert">
          <div className={styles.errorText}>{state.error ?? t('phaseError')}</div>
          <button type="button" className={styles.button} onClick={() => { void controller.start() }}>
            {t('retry')}
          </button>
        </div>
      )}

      {state.lines.length === 0
        ? !isError && (
          <div className={styles.hint}>
            <span className={styles.hintTitle}>{t('emptyTitle')}</span>
            <span className={styles.examples}>
              <span className={styles.example}>{t('example1')}</span>
              <span className={styles.example}>{t('example2')}</span>
              <span className={styles.example}>{t('example3')}</span>
            </span>
          </div>
        )
        : (
          <ul className={styles.lines} ref={linesRef} aria-live="polite">
            {state.lines.map((line, index) => line.role === 'agent'
              ? (
                <li key={index} className={`${styles.agentNotice} ${NOTICE_CLASS[line.notice.kind]}`}>
                  <NoticeIcon kind={line.notice.kind} />
                  <span className={styles.noticeText}>{noticeText(line.notice, t)}</span>
                </li>
              )
              : (
                <li key={index} className={`${styles.line} ${line.role === 'user' ? styles.lineUser : styles.lineVoice}`}>
                  <span className={styles.speaker}>{t(SPEAKER_KEY[line.role])}</span>
                  <span className={styles.bubble}>{line.text}</span>
                </li>
              ))}
          </ul>
        )}
    </section>
  )
}

/** The agent's current task: spinner, elapsed time, steps, latest tool, and queue. */
function TaskCard({ task, approval, now, t }: {
  task: AgentTask
  approval: boolean
  now: number
  t: (key: VoiceAgentKey) => string
}) {
  return (
    <div className={`${styles.task} ${approval ? styles.taskApproval : ''}`}>
      <div className={styles.taskHead}>
        {approval
          ? <span className={styles.taskAlert} aria-hidden="true">!</span>
          : <span className={styles.spinner} aria-hidden="true" />}
        <span className={styles.taskTitle}>{approval ? t('activityApproval') : t('activityWorking')}</span>
        <span className={styles.taskMeta}>
          {formatDuration(now - task.startedAt)}
          {task.steps > 0 && ` · ${String(task.steps)} ${t('steps')}`}
          {task.queued > 0 && ` · +${String(task.queued)} ${t('queued')}`}
        </span>
      </div>
      <div className={styles.taskText} title={task.text}>{task.text}</div>
      {task.tool !== undefined && !approval && (
        <div className={styles.taskTool}>
          <span className={styles.taskToolLabel}>{t('nowRunning')}</span>
          <code className={styles.toolChip}>{task.tool}</code>
        </div>
      )}
    </div>
  )
}

/** Small icon for an agent notice. */
function NoticeIcon({ kind }: { kind: keyof typeof NOTICE_KEY }) {
  return (
    <svg className={styles.noticeIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'finished' && <polyline points="5 12.5 10 17.5 19 7" />}
      {kind === 'failed' && (<><line x1="7" y1="7" x2="17" y2="17" /><line x1="17" y1="7" x2="7" y2="17" /></>)}
      {kind === 'cancelled' && <line x1="6" y1="12" x2="18" y2="12" />}
      {kind === 'approval' && (<><line x1="12" y1="6" x2="12" y2="13" /><line x1="12" y1="18" x2="12" y2="18.01" /></>)}
    </svg>
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

/**
 * The current time, refreshed once a second while `active`.
 * @param active - whether anything on screen counts time.
 * @returns milliseconds since epoch.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [active])
  return now
}
