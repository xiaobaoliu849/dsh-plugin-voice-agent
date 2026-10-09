# Voice Agent Plugin for DeepSeek Harness

[中文文档](README.zh.md) | English

Talk to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) coding agent by voice in realtime: a voice model listens and talks, and the harness agent does the actual coding work in your project. Works seamlessly in the **DeepSeek Harness desktop app**.

```
You speak ─▶ Realtime Voice Provider ──tool call──▶ DeepSeek Harness agent (files, shell, code)
             (Cartesia+DeepSeek /                         │
              Qwen / Doubao / Gemini)                     │
                    ▲                                     │
                    └──── spoken summary of the result ◀──┘
```

Supports 4 voice backends:
1. **Cartesia + DeepSeek** (Recommended ultra-fast): Cartesia Ink-Whisper Chinese STT + DeepSeek-V3 streaming + Cartesia Sonic 3.6 TTS with the Jing voice, verified through the API for both Chinese and English output.
2. **Qwen Realtime (DashScope)**: Tongyi Qianwen end-to-end multimodal speech model (`qwen3.8-omni-flash-realtime`).
3. **Doubao Realtime (Volcengine)**: ByteDance Doubao duplex speech dialogue.
4. **Google Gemini Live**: Gemini bidirectional streaming voice (`gemini-3.8-live`).

Zero-config setup: If you have existing API keys in `D:\voicespirit\config.json`, the plugin automatically loads Cartesia, DeepSeek, DashScope, Doubao, or Google keys without requiring manual entry!

## What you can say

| You say | What happens |
|---|---|
| "Run the tests and tell me the result" | `ask_harness`: the task is sent to the open conversation like a typed message; the voice says "On it" and later summarizes the agent's answer |
| "Actually, only check the src folder" | `steer_harness`: the correction is delivered to the running task |
| "Stop" | `stop_harness`: the agent's current turn is cancelled |
| "What are you doing?" | `harness_status`: running state, recent tools, latest answer |

When the agent needs approval for a tool, the voice tells you to approve or deny it in the window. Small talk is answered by the voice model itself.

## Install into the desktop app

Requires DeepSeek Harness desktop `0.2.0-rc.2` or a compatible release. Version `0.3.3` fixes the settings API incompatibility during plugin startup and uses Cartesia Ink-Whisper with Chinese transcription, explicitly finalizing speech after microphone gating to dispatch tasks. The Host uses reactive `Config`, and the browser bundle registers its own `dsh-plugin-voice-agent` module ID. Build against the matching `0.2.0-rc.2` sources; the older `0.1.2-alpha.4` workspace is incompatible.

1. Quit the desktop app.
2. Install the bundle into the desktop profile with the app's own `dsh` command (PowerShell):
   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add (Resolve-Path .\release\dsh-plugin-voice-agent-0.3.4.tgz)
   ```
   A downloaded copy of the `.tgz` file works the same way: pass its local path instead of the URL.
3. Start the desktop app. Open **Plugins → dsh-plugin-voice-agent** and select your preferred voice provider. Save your API key or let it automatically resolve from `D:\voicespirit\config.json` or your environment variables.
4. Open a conversation, click the mic button in the composer, and talk.

To remove it, use **Uninstall** on the plugin's page, or `dsh.cmd plugin --profile desktop remove dsh-plugin-voice-agent`.

## Settings

Edited on the plugin's page; changes apply to the next call without a restart.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `cartesia-deepseek` | Voice provider: `cartesia-deepseek`, `qwen`, `doubao`, or `gemini` |
| `model` | default per provider | Model id (`deepseek-chat`, `qwen3.8-omni-flash-realtime`, `1.2.6.1`, `gemini-3.8-live`) |
| `voice` | default per provider | Prebuilt voice name or ID (e.g. `Katie`, `Tina`, `zh_female_vv_jupiter_bigtts`, `Puck`) |
| `apiKeyEnv` | default per provider | Credential reference holding the API key |
| `instructions` | empty | Extra text appended to the voice model's system prompt, e.g. "Always answer in Chinese." |
| `priceAudioInput` / `priceTextInput` | `3` / `0.75` | USD per million input tokens, for the cost shown in the call dock |
| `priceAudioOutput` / `priceTextOutput` | `4.5` / `4.5` | USD per million output tokens |

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
- Cost: Gemini Live bills audio by duration, so the plugin sends microphone audio only around speech and tells Gemini when the stream pauses; an open but silent call sends nothing. The call dock shows the call's Gemini tokens and estimated cost (hover for the per-modality breakdown). Each Gemini turn re-processes the whole conversation context, so long calls cost more per turn. The coding agent's own token usage is billed separately by your DeepSeek model provider.
- Requests are passed to the agent close to your own words, without added goals: a broadened task makes the agent do (and bill for) more work.
- The call controls the conversation whose composer it was started from; with no conversation open, the voice asks you to open one.
- No unit tests yet.

## License

[MIT](LICENSE)
