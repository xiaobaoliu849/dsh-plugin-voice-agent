# Voice Agent Plugin for DeepSeek Harness

[中文文档](README.zh.md) | English

Talk to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) coding agent by voice, the way Codex realtime works: a Gemini Live voice model listens and talks, and the harness agent does the actual work in your project.

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

## Packages

| Package | Role |
|---|---|
| `packages/host` → `@deepseek-ai/dsh-host-voice-agent` | `voice-agent` settings namespace; `GET /api/voice-agent/status`; `WS /api/voice-agent/ws`, which relays one call to Gemini Live. The API key is resolved from the harness credentials store and never reaches the browser. Upgrades from other origins are rejected. |
| `packages/client-ui` → `@deepseek-ai/dsh-client-ui-voice-agent` | Composer mic button, call dock (status, level meter, transcript, mute, hang up), Settings → Plugins card, and the bridge that runs the voice tools against the open session through `ctx.sessions`. |

## Install (harness source checkout)

Tested with DeepSeek Harness `0.1.2-alpha.4`.

1. Copy `packages/host` to `packages/host/voice-agent` and `packages/client-ui` to `packages/client/ui-voice-agent` in the harness workspace.
2. Add both packages to `packages/bundle/web-app/package.json` dependencies (`"workspace:^"`) and insert them in `packages/bundle/web-app/cordis.patch.yml`:
   ```yaml
       - id: host-voice-agent
         name: '@deepseek-ai/dsh-host-voice-agent'

       - id: ui-voice-agent
         name: '@deepseek-ai/dsh-client-ui-voice-agent'
   ```
3. Add `{ "path": "./packages/host/voice-agent" }` to `tsconfig.host.json` and `{ "path": "./packages/client/ui-voice-agent" }` to `tsconfig.client.json`.
4. Run `pnpm install`, then build with `pnpm run build:lib`, or build only these packages with `npx tsdown --env.DSH_BUILD_FACE host --filter @deepseek-ai/dsh-host-voice-agent` and `pnpm --filter @deepseek-ai/dsh-client-ui-voice-agent run bundle`.
5. Run `pnpm dsh web`, open **Settings → Plugins → Plugin configuration → Voice Agent (Gemini Live)** and save your Gemini API key (or set the `GEMINI_API_KEY` environment variable).
6. Open a workspace, click the mic button in the composer, and talk.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `model` | `gemini-3.8-live` | Gemini Live model id (any model whose `supportedGenerationMethods` include `bidiGenerateContent`) |
| `voice` | `Puck` | Prebuilt Gemini voice |
| `apiKeyEnv` | `GEMINI_API_KEY` | Credential reference holding the API key |
| `instructions` | empty | Extra text appended to the voice model's system prompt, e.g. "Always answer in Chinese." |

## Known limitations

- Long tasks: the voice stays quiet until the agent's turn ends; there are no spoken progress updates yet.
- The installed desktop app (dsh `0.2.0-rc.2`) is not supported yet.
- No unit tests yet.

## License

[MIT](LICENSE)
