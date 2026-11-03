# 🎙️ Voice Agent for DeepSeek Harness

[中文文档](README.zh.md) | English

Talk to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) coding agent out loud. A voice model listens and talks; the Harness agent does the real work in your project; you hear a short spoken summary when it is done.

```
 You speak ──▶ Voice provider ──tool call──▶ DeepSeek Harness agent
               (Cartesia + DeepSeek,           (files, shell, code)
                Qwen, Doubao, Gemini)                 │
                     ▲                                │
                     ├──── short progress notes ◀─────┤  (long tasks)
                     └──── spoken summary ◀───────────┘  (when done)
```

**Works with:** DeepSeek Harness desktop `0.2.0-rc.2` up to the latest `0.2.x` (tested on `0.2.2-alpha.2`).

---

## ✨ What's new in 0.4.0

- **Works with newer Harness versions.** Earlier tarballs only installed on exactly `0.2.0-rc.2`; 0.4.0 declares `engines.dsh: ">=0.2.0-rc.2 <0.3.0"`, so Harness 0.2.1 and 0.2.2 accept it.
- **Spoken progress on long tasks.** After about 20 seconds the voice says a short line such as "Still on it, now running the tests", then at most every 40 seconds, up to three times per task. It never talks over you or over itself.
- **Redesigned call dock.** Live status dot, call timer, model name, a waveform that shows who is talking, a task card (elapsed time, step count, current tool, queue, approval warning), chat-style transcript, and a Retry button after errors.
- **A distinct call button.** The composer button is now a sound-wave icon with a pulsing ring during calls, so it is not confused with Harness's own dictation microphone.
- **Language fix (Cartesia + DeepSeek).** Agent reports no longer switch the voice to English when you speak Chinese.

## 🗣️ What you can say

| You say | What happens |
|---|---|
| "Run the tests and tell me the result" | `ask_harness`: the task goes into the open conversation like a typed message. The voice says "On it", gives short progress notes on long tasks, and summarizes the answer at the end |
| "Actually, only check the src folder" | `steer_harness`: the correction goes to the running task |
| "Stop" | `stop_harness`: the agent's current turn is cancelled |
| "What are you doing?" | `harness_status`: running state, recent tools, latest answer |

When the agent needs approval for a tool, the voice tells you, and the dock turns amber until you approve or deny it in the window. Small talk is answered by the voice model itself.

## 🔊 Choosing a voice provider

The voice model only listens, hands tasks to Harness, and reads back summaries, so it does not need to be a strong model. Cheap and fast is the right choice.

| Provider | How it works | Best for |
|---|---|---|
| **Cartesia + DeepSeek** (default) | Speech-to-text (Cartesia Ink-Whisper) → `deepseek-flash` text model → text-to-speech (Cartesia Sonic). Billed as text tokens plus speech minutes | Lowest cost; clear Chinese and English |
| **Qwen Realtime** (DashScope) | One end-to-end speech model, `qwen3.8-omni-flash-realtime` | Users in mainland China; no VPN needed |
| **Doubao Realtime** (Volcengine) | ByteDance full-duplex speech model | Natural Chinese conversation |
| **Gemini Live** | Google's bidirectional speech model, `gemini-3.8-live` | Most natural interruptions; highest cost; needs Google access |

**About cost.** Realtime speech models bill by audio tokens, not by how long the call is open. The plugin sends microphone audio only while you are speaking, so waiting while the agent works costs almost nothing. What makes long calls expensive is that each turn re-sends the whole conversation, and that spoken output is the priciest part. The coding agent's own token usage is billed separately by your DeepSeek model provider.

## 📦 Install into the desktop app

1. Quit the desktop app.
2. Install the bundle with the app's own `dsh` command (PowerShell):
   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add (Resolve-Path .\release\dsh-plugin-voice-agent-0.4.0.tgz)
   ```
3. Start the app, open **Plugins → dsh-plugin-voice-agent**, and pick a voice provider. Save the API key there, or let the plugin read it from `D:\voicespirit\config.json` or environment variables (`DEEPSEEK_API_KEY` and `CARTESIA_API_KEY`, `DASHSCOPE_API_KEY`, `DOUBAO_API_KEY`, `GEMINI_API_KEY`).
4. Open a conversation, click the sound-wave button in the composer, and talk.

To remove it, use **Uninstall** on the plugin's page, or run `dsh.cmd plugin --profile desktop remove dsh-plugin-voice-agent`.

## ⚙️ Settings

Edited on the plugin's page; changes apply to the next call without a restart.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `cartesia-deepseek` | `cartesia-deepseek`, `qwen`, `doubao`, or `gemini` |
| `model` | per provider | `deepseek-flash`, `qwen3.8-omni-flash-realtime`, `1.2.6.1`, `gemini-3.8-live` |
| `voice` | per provider | Voice name or ID (Cartesia "Jing", `Tina`, `zh_female_vv_jupiter_bigtts`, `Puck`) |
| `apiKeyEnv` | `GEMINI_API_KEY` | Credential reference holding the API key |
| `instructions` | empty | Extra text for the voice model's system prompt, e.g. "Always answer in Chinese." |
| `priceAudioInput` / `priceTextInput` | `3` / `0.75` | USD per million input tokens, for the Gemini cost shown in the dock |
| `priceAudioOutput` / `priceTextOutput` | `4.5` / `4.5` | USD per million output tokens |

## 🧩 How it works

`dsh-plugin-voice-agent` is one package with three roles:

- **Bundle:** `cordis.patch.yml` inserts one profile entry, `voice-agent`.
- **Host half** (`src/index.ts`, `src/live.ts`, `src/providers/`): serves `GET /api/voice-agent/status` and `WS /api/voice-agent/ws`, and connects each call to the selected provider. API keys are resolved on the Host and never reach the browser.
- **Browser half** (`src/client`): the composer call button, the call dock, the settings page, and the bridge that runs the voice tools against the open conversation through `ctx.sessions` (prompt, cancel, and the session event window).

Harness packages (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-credentials`) are peer dependencies supplied by the desktop installation; the only installed dependency is `ws`.

## 🔒 Security

- The call routes accept only loopback `Host` headers and same-origin browser requests, so other websites (including DNS-rebinding pages) cannot open calls with your keys.
- Agent answers can quote files and web pages. They reach the voice model marked as data, and `ask_harness` / `steer_harness` are refused unless you spoke since the last agent update, so text inside a file cannot start or redirect agent work.
- Progress notes contain only your own task text and tool names, never agent output.
- The coding agent still runs under the Harness permission mode you chose; approval prompts appear in the window as usual.

## 🛠️ Build from source

The package builds inside a DeepSeek Harness checkout, because its tsconfig and tsdown files use the monorepo build presets. Node `>=24.9` is required.

1. Check out `deepseek-ai/deepseek-harness` at tag `dsh-v0.2.2-alpha.2`, then run `pnpm install` and `pnpm run build:lib:host`.
2. Copy `plugin/` to `packages/client/voice-agent-plugin` in that checkout and run `pnpm install` again.
3. Type-check and build: `node ./node_modules/typescript/bin/tsc -b packages/client/voice-agent-plugin/tsconfig.json`, then `pnpm --filter dsh-plugin-voice-agent run bundle`.
4. Pack: `pnpm --filter dsh-plugin-voice-agent pack`.

Harness `0.2.2` changed the client build helper to take the package directory (`clientBundle(import.meta.dirname, …)`), so this source no longer builds inside a `0.2.0-rc.2` checkout; use commit `fd1b762` (release 0.3.7) for that. The `v0.1.0` tag holds the version for dsh `0.1.2-alpha.4`.

## ⚠️ Known limitations

- Progress notes are triggered by agent steps. A single long step (for example a slow test run) produces no note until the next step starts.
- The token and cost pill in the dock is shown for Gemini Live only; the other providers do not report usage yet.
- Requests go to the agent close to your own words, without added goals: a broadened task makes the agent do (and bill for) more work.
- A call controls the conversation it was started from; with no conversation open, the voice asks you to open one.
- No unit tests yet.

## 📄 License

[MIT](LICENSE)
