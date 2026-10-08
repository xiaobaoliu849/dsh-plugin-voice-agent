# DeepSeek Harness 语音智能体插件

中文 | [English](README.md)

像 Codex 实时语音一样，用语音指挥 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编程智能体：Gemini Live 负责听和说，harness 智能体负责在你的项目里真正干活。支持 **DeepSeek Harness 桌面版**。

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

## 安装到桌面版

需要 DeepSeek Harness 桌面版 `0.2.0-rc.2` 或兼容版本。

1. 退出桌面应用。
2. 用应用自带的 `dsh` 命令把插件安装到桌面 profile（PowerShell）：
   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add https://github.com/xiaobaoliu849/dsh-plugin-voice-agent/raw/main/release/dsh-plugin-voice-agent-0.2.0.tgz
   ```
   也可以先下载 `.tgz` 文件，把 URL 换成本地路径。
3. 启动桌面应用，打开 **插件 → dsh-plugin-voice-agent**，保存 Gemini API Key（以 `GEMINI_API_KEY` 存入 harness 凭据存储）。如果 `~/.dsh/.credentials.yaml` 或环境变量 `GEMINI_API_KEY` 里已有 key，会直接使用。
4. 打开一个会话，点击输入框里的麦克风按钮，开始说话。

卸载：在插件页面点击 **卸载**，或运行 `dsh.cmd plugin --profile desktop remove dsh-plugin-voice-agent`。

## 设置

在插件页面编辑；修改对下一次通话立即生效，无需重启。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `model` | `gemini-3.8-live` | Gemini Live 模型 ID（`supportedGenerationMethods` 包含 `bidiGenerateContent` 的模型） |
| `voice` | `Puck` | Gemini 预置音色 |
| `apiKeyEnv` | `GEMINI_API_KEY` | 保存 API Key 的凭据引用 |
| `instructions` | 空 | 追加到语音模型系统提示的文字，例如“始终用中文回答”。 |

## 工作原理

`dsh-plugin-voice-agent` 是一个同时承担三种角色的包：

- **Bundle**：`cordis.patch.yml` 插入一个 profile 条目 `voice-agent`。
- **Host 端**（`src/index.ts`、`src/live.ts`）：提供 `GET /api/voice-agent/status` 和 `WS /api/voice-agent/ws`，把每次通话转发到 Gemini Live，并支持会话续接。API Key 从 harness 凭据存储读取，不会发到浏览器；拒绝其他来源（Origin）的连接。
- **浏览器端**（`src/client`）：输入框麦克风按钮、通话面板（状态、音量条、字幕、静音、挂断）、`plugins.bundle.config` 插槽中的设置页，以及通过 `ctx.sessions`（prompt、cancel、会话事件窗口）在当前会话上执行语音工具的桥接层。

harness 自身的包（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-credentials`）是 peer 依赖，由桌面版安装提供；唯一实际安装的依赖是 `ws`。

## 从源码构建

本包需要在对应版本的 DeepSeek Harness 源码中构建，因为它的 tsconfig 和 tsdown 配置引用了 monorepo 的构建预设。

1. 检出 `deepseek-ai/deepseek-harness` 的 `dsh-v0.2.0-rc.2` 标签，运行 `pnpm install`，再运行 `pnpm run build:lib:host`。
2. 把 `plugin/` 复制到该源码的 `packages/client/voice-agent-plugin`，再运行一次 `pnpm install`。
3. 类型检查并构建：`node ./node_modules/typescript/bin/tsc -b packages/client/voice-agent-plugin/tsconfig.json`，然后 `pnpm --filter dsh-plugin-voice-agent run bundle`。
4. 打包：`pnpm --filter dsh-plugin-voice-agent pack`。

`v0.1.0` 标签保存了适用于 dsh `0.1.2-alpha.4` 源码的早期版本（两个包，接入 web-app bundle）。

## 已知限制

- 长任务：智能体这一轮结束前语音不会播报进度。
- 通话控制的是发起通话时所在的会话；没有打开会话时，语音会请你先打开一个。
- 还没有单元测试。

## 许可证

[MIT](LICENSE)
