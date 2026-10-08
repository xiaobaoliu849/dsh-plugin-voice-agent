# Voice Agent Plugin for DeepSeek Harness

[中文文档](README.zh.md) | English

Talk to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) coding agent by voice, the way Codex realtime works: a Gemini Live voice model listens and talks, and the harness agent does the actual work in your project. Works in the **DeepSeek Harness desktop app**.

```
You speak ─▶ Gemini Live (voice) ──tool call──▶ DeepSeek Harness agent (files, shell, code)
                    ▲                                        │
                    └──── spoken summary of the result ◀─────┘
```

Unlike the [Echo plugin](https://github.com/xiaobaoliu849/dsh-plugin-voicespirit), this plugin needs no Python backend: the harness talks to Gemini Live directly.

## What you can say

| You say | What happens |
|---|---|
| "Run the tests and tell me the result" | `ask_harness`: the task is sent to the open conversation like a typed message; the voice says "On it" and later summarizes the agent's answer |
| "Actually, only check the src folder" | `steer_harness`: the correction is delivered to the running task |
| "Stop" | `stop_harness`: the agent's current turn is cancelled |
| "What are you doing?" | `harness_status`: running state, recent tools, latest answer |

When the agent needs approval for a tool, the voice tells you to approve or deny it in the window. Small talk is answered by the voice model itself.

## Install into the desktop app

Requires DeepSeek Harness desktop `0.2.0-rc.2` or a compatible release.

1. Quit the desktop app.
2. Install the bundle into the desktop profile with the app's own `dsh` command (PowerShell):
   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add https://github.com/xiaobaoliu849/dsh-plugin-voice-agent/raw/main/release/dsh-plugin-voice-agent-0.2.3.tgz
   ```
   A downloaded copy of the `.tgz` file works the same way: pass its local path instead of the URL.
3. Start the desktop app. Open **Plugins → dsh-plugin-voice-agent** and save your Gemini API key (stored as `GEMINI_API_KEY` in the harness credentials store). A key already present in `~/.dsh/.credentials.yaml` or the `GEMINI_API_KEY` environment variable is used as is.
4. Open a conversation, click the mic button in the composer, and talk.

To remove it, use **Uninstall** on the plugin's page, or `dsh.cmd plugin --profile desktop remove dsh-plugin-voice-agent`.

## Settings

Edited on the plugin's page; changes apply to the next call without a restart.

| Field | Default | Meaning |
|---|---|---|
| `model` | `gemini-3.8-live` | Gemini Live model id (any model whose `supportedGenerationMethods` include `bidiGenerateContent`) |
| `voice` | `Puck` | Prebuilt Gemini voice |
| `apiKeyEnv` | `GEMINI_API_KEY` | Credential reference holding the API key |
| `instructions` | empty | Extra text appended to the voice model's system prompt, e.g. "Always answer in Chinese." |

## How it works

`dsh-plugin-voice-agent` is one package with three roles:

- **Bundle**: `cordis.patch.yml` inserts one profile entry, `voice-agent`.
- **Host half** (`src/index.ts`, `src/live.ts`): serves `GET /api/voice-agent/status` and `WS /api/voice-agent/ws`, which relays each call to Gemini Live with session resumption. The API key is resolved from the harness credentials store and never reaches the browser; upgrades from other origins are rejected.
- **Browser half** (`src/client`): the composer mic button, the call dock (status, level meter, transcript, mute, hang up), the settings page in the `plugins.bundle.config` slot, and the bridge that runs the voice tools against the open session through `ctx.sessions` (prompt, cancel, and the session event window).

Harness packages (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-credentials`) are peer dependencies resolved from the desktop installation; the only installed dependency is `ws`.

## Security

- The call routes accept only loopback `Host` headers and same-origin browser requests, the same fence the harness API uses, so other websites (including DNS-rebinding pages) cannot open calls on your Gemini key.
- The agent's answers can quote files and web pages. They reach the voice model marked as data, and `ask_harness` / `steer_harness` are refused unless you spoke since the last agent update, so text inside a file cannot start or redirect agent work by itself.
- The coding agent still runs under the harness permission mode you selected; approval prompts appear in the window as usual.

## Build from source

The package builds inside a DeepSeek Harness checkout of the matching release, because its tsconfig and tsdown files reference the monorepo build presets.

1. Check out `deepseek-ai/deepseek-harness` at tag `dsh-v0.2.0-rc.2`, run `pnpm install`, then `pnpm run build:lib:host`.
2. Copy `plugin/` to `packages/client/voice-agent-plugin` in that checkout and run `pnpm install` again.
3. Type-check and build: `node ./node_modules/typescript/bin/tsc -b packages/client/voice-agent-plugin/tsconfig.json`, then `pnpm --filter dsh-plugin-voice-agent run bundle`.
4. Pack: `pnpm --filter dsh-plugin-voice-agent pack`.

The `v0.1.0` tag holds the earlier version for source checkouts of dsh `0.1.2-alpha.4` (two packages wired into the web-app bundle).

## Known limitations

- Long tasks: the voice stays quiet until the agent's turn ends; there are no spoken progress updates yet.
- Cost: Gemini Live bills audio by duration, so the plugin sends microphone audio only around speech and tells Gemini when the stream pauses; an open but silent call sends nothing. The coding agent's own token usage is billed separately by your DeepSeek model provider.
- The call controls the conversation whose composer it was started from; with no conversation open, the voice asks you to open one.
- No unit tests yet.

## License

[MIT](LICENSE)
