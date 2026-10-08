# DeepSeek Harness 语音智能体插件

中文 | [English](README.md)

像 Codex 实时语音一样，用语音指挥 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编程智能体：Gemini Live 负责听和说，harness 智能体负责在你的项目里真正干活。

```
你说话 ─▶ Gemini Live（语音）──工具调用──▶ DeepSeek Harness 智能体（文件、终端、代码）
                ▲                                        │
                └──────── 用语音总结结果 ◀───────────────┘
```

与 [Echo 插件](https://github.com/xiaobaoliu849/dsh-plugin-voicespirit) 不同，本插件不需要 Python 后端：harness 直接连接 Gemini Live。

## 可以怎么说

| 你说 | 发生什么 |
|---|---|
| “运行测试并告诉我结果” | `ask_harness`：任务像输入的消息一样发送到当前会话；语音先说“好的”，之后总结智能体的回答 |
| “其实只检查 src 文件夹” | `steer_harness`：把纠正发送给正在运行的任务 |
| “停” | `stop_harness`：取消智能体当前的任务 |
| “你在做什么？” | `harness_status`：运行状态、最近用过的工具、最新回答 |

智能体需要批准工具时，语音会提醒你在窗口中批准或拒绝。闲聊由语音模型直接回答。

## 包

| 包 | 作用 |
|---|---|
| `packages/host` → `@deepseek-ai/dsh-host-voice-agent` | `voice-agent` 设置命名空间；`GET /api/voice-agent/status`；`WS /api/voice-agent/ws` 把每次通话转发到 Gemini Live。API Key 从 harness 凭据存储读取，不会发到浏览器；拒绝其他来源（Origin）的连接。 |
| `packages/client-ui` → `@deepseek-ai/dsh-client-ui-voice-agent` | 输入框麦克风按钮、通话面板（状态、音量条、字幕、静音、挂断）、设置 → 插件卡片，以及通过 `ctx.sessions` 在当前会话上执行语音工具的桥接层。 |

## 安装（harness 源码）

已在 DeepSeek Harness `0.1.2-alpha.4` 上测试。

1. 把 `packages/host` 复制到 harness 的 `packages/host/voice-agent`，把 `packages/client-ui` 复制到 `packages/client/ui-voice-agent`。
2. 在 `packages/bundle/web-app/package.json` 依赖中加入两个包（`"workspace:^"`），并在 `packages/bundle/web-app/cordis.patch.yml` 中插入：
   ```yaml
       - id: host-voice-agent
         name: '@deepseek-ai/dsh-host-voice-agent'

       - id: ui-voice-agent
         name: '@deepseek-ai/dsh-client-ui-voice-agent'
   ```
3. 在 `tsconfig.host.json` 加入 `{ "path": "./packages/host/voice-agent" }`，在 `tsconfig.client.json` 加入 `{ "path": "./packages/client/ui-voice-agent" }`。
4. 运行 `pnpm install` 后构建：`pnpm run build:lib`，或只构建这两个包：`npx tsdown --env.DSH_BUILD_FACE host --filter @deepseek-ai/dsh-host-voice-agent` 和 `pnpm --filter @deepseek-ai/dsh-client-ui-voice-agent run bundle`。
5. 运行 `pnpm dsh web`，打开 **设置 → 插件 → 插件配置 → 语音智能体 (Gemini Live)**，保存 Gemini API Key（或设置环境变量 `GEMINI_API_KEY`）。
6. 打开一个工作区，点击输入框里的麦克风按钮，开始说话。

## 设置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `model` | `gemini-3.8-live` | Gemini Live 模型 ID（`supportedGenerationMethods` 包含 `bidiGenerateContent` 的模型） |
| `voice` | `Puck` | Gemini 预置音色 |
| `apiKeyEnv` | `GEMINI_API_KEY` | 保存 API Key 的凭据引用 |
| `instructions` | 空 | 追加到语音模型系统提示的文字，例如“始终用中文回答”。 |

## 已知限制

- 长任务：智能体这一轮结束前语音不会播报进度。
- 暂不支持已安装的桌面版（dsh `0.2.0-rc.2`）。
- 还没有单元测试。

## 许可证

[MIT](LICENSE)
