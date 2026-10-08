/**
 * Voice-agent browser plugin: the composer mic button, the call dock, and the
 * configuration page on the bundle's Settings → Plugins page. One {@link VoiceAgentController} owns the call; its
 * bridge drives the session the user is viewing through `ctx.sessions`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { VoiceAgentButton } from './components/VoiceAgentButton.tsx'
import { VoiceAgentDock } from './components/VoiceAgentDock.tsx'
import {
  VoiceAgentSettingsCard, type CredentialAccess, type VoiceAgentSettings,
} from './components/VoiceAgentSettingsCard.tsx'
import { VoiceAgentController } from './controller.ts'
import { en, zh, type VoiceAgentKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'voice-agent': VoiceAgentKey
  }
}

/** Locale namespace. */
const NS = 'voice-agent'

/** Profile entry id of the host plugin row; its Config form is the settings page's data. */
const ENTRY_ID = 'voice-agent'

/** npm package name; keys the bundle's configuration page. */
const PACKAGE_NAME = 'dsh-plugin-voice-agent'

/** Prebuilt Gemini Live voices (mirrors the host package's VOICE_AGENT_VOICES). */
const VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'] as const

export const inject = ['slots', 'locale', 'sessions', 'configForms', 'remote', 'remote.credentials']

/**
 * Register the dictionaries, the mic button, the dock, and the settings card.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-agent: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new VoiceAgentController(ctx.sessions)
  ctx.effect(() => () => { controller.end() }, 'ui-voice-agent: hang up on dispose')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    {
      name: 'conversation.input.right',
      id: 'ui-voice-agent:mic',
      order: 91,
      inject: () => ({ controller, t }),
    },
    VoiceAgentButton,
  ))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    {
      name: 'conversation.input.dock',
      id: 'ui-voice-agent:dock',
      order: 11,
      inject: () => ({ controller, t }),
    },
    VoiceAgentDock,
  ))

  const scope = ctx.configForms.get(ENTRY_ID) as unknown as ConfigForm<VoiceAgentSettings>
  const credentials: CredentialAccess = {
    configured: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? (response.value[ref]?.configured ?? false) : undefined
    },
    set: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      if (!response.ok) throw new Error(response.error.message)
    },
  }
  ctx.slots.inject('plugins.bundle.config', function* () {
    yield ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE_NAME,
      inject: () => ({ scope, credentials, voices: VOICES, t }),
    }, VoiceAgentSettingsCard)
  })
}
