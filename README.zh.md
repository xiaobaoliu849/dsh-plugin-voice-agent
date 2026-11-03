# 🎙️ DeepSeek Harness 语音智能体插件

中文 | [English](README.md)

直接开口指挥 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编程智能体：语音模型负责听和说，Harness 智能体在你的项目里真正干活，完成后用一两句话告诉你结果。

```
 你说话 ──▶ 语音服务商 ──工具调用──▶ DeepSeek Harness 智能体
          (Cartesia + DeepSeek /        （文件、终端、代码）
           通义千问 / 豆包 / Gemini)            │
                 ▲                              │
                 ├──── 简短进度播报 ◀───────────┤ （长任务）
                 └──── 语音总结结果 ◀───────────┘ （完成时）
```

**适用版本：** DeepSeek Harness 桌面版 `0.2.0-rc.2` 至最新 `0.2.x`（已在 `0.2.2-alpha.2` 上验证）。

---

## ✨ 0.4.0 新功能

- **兼容新版 Harness。** 旧版安装包只能装在 `0.2.0-rc.2` 上；0.4.0 声明了 `engines.dsh: ">=0.2.0-rc.2 <0.3.0"`，Harness 0.2.1 和 0.2.2 都能安装。
- **长任务语音进度播报。** 任务运行约 20 秒后，语音会说一句简短进度，例如“还在处理，正在跑测试”；之后最多每 40 秒一次，每个任务最多 3 次。你或语音正在说话时不会插话。
- **全新通话面板。** 在线状态指示灯、通话计时、模型名称、显示“谁在说话”的声波、任务卡片（已用时间、步骤数、当前工具、排队数、等待批准提醒）、聊天气泡式字幕，以及出错后的“重试”按钮。
- **更好认的通话按钮。** 输入框按钮改成声波图标，通话中有脉冲光圈，不会和 Harness 自带的语音输入麦克风混淆。
- **语言修复（Cartesia + DeepSeek）。** 你说中文时，智能体汇报不会再让语音切换成英文。

## 🗣️ 可以怎么说

| 你说 | 发生什么 |
|---|---|
| “运行测试并告诉我结果” | `ask_harness`：任务像输入的消息一样发到当前会话；语音先说“好的”，长任务会播报进度，结束时总结回答 |
| “其实只检查 src 文件夹” | `steer_harness`：把纠正发送给正在运行的任务 |
| “停” | `stop_harness`：取消智能体当前的任务 |
| “你在做什么？” | `harness_status`：运行状态、最近用过的工具、最新回答 |

智能体需要批准工具时，语音会提醒你，通话面板也会变成琥珀色，直到你在窗口中批准或拒绝。闲聊由语音模型直接回答。

## 🔊 如何选择语音服务商

语音模型只负责听、把任务交给 Harness、再读出总结，并不需要很强的模型，便宜和快速最重要。

| 服务商 | 工作方式 | 适合 |
|---|---|---|
| **Cartesia + DeepSeek**（默认） | 语音转文字（Cartesia Ink-Whisper）→ `deepseek-flash` 文本模型 → 文字转语音（Cartesia Sonic）。按文本 token 加语音时长计费 | 成本最低；中英文都清晰 |
| **通义千问 Realtime**（DashScope） | 端到端语音模型 `qwen3.8-omni-flash-realtime` | 中国大陆用户，无需 VPN |
| **豆包 Realtime**（火山引擎） | 字节跳动全双工语音模型 | 自然的中文对话 |
| **Gemini Live** | 谷歌双向语音模型 `gemini-3.8-live` | 打断最自然；费用最高；需要能访问谷歌 |

**关于费用。** 实时语音模型按音频 token 计费，而不是按通话开着的时间计费。插件只在你说话时发送麦克风音频，所以等待智能体干活时几乎不花钱。真正让长通话变贵的是：每一轮都要重新发送整个对话上下文，而语音输出是最贵的部分。编程智能体自己的 token 用量由你的 DeepSeek 模型服务商另行计费。

## 📦 安装到桌面版

1. 退出桌面应用。
2. 用应用自带的 `dsh` 命令安装（PowerShell）：
   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add (Resolve-Path .\release\dsh-plugin-voice-agent-0.4.0.tgz)
   ```
3. 启动应用，打开 **插件 → dsh-plugin-voice-agent**，选择语音服务商。可以在这里保存 API Key，也可以让插件自动读取 `D:\voicespirit\config.json` 或环境变量（`DEEPSEEK_API_KEY` 和 `CARTESIA_API_KEY`、`DASHSCOPE_API_KEY`、`DOUBAO_API_KEY`、`GEMINI_API_KEY`）。
4. 打开一个会话，点击输入框里的声波按钮，开始说话。

卸载：在插件页面点击 **卸载**，或运行 `dsh.cmd plugin --profile desktop remove dsh-plugin-voice-agent`。

## ⚙️ 设置

在插件页面编辑，下次通话立即生效，无需重启。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `cartesia-deepseek` | `cartesia-deepseek`、`qwen`、`doubao` 或 `gemini` |
| `model` | 随服务商 | `deepseek-flash`、`qwen3.8-omni-flash-realtime`、`1.2.6.1`、`gemini-3.8-live` |
| `voice` | 随服务商 | 音色名称或 ID（Cartesia “Jing”、`Tina`、`zh_female_vv_jupiter_bigtts`、`Puck`） |
| `apiKeyEnv` | `GEMINI_API_KEY` | 保存 API Key 的凭据引用 |
| `instructions` | 空 | 追加到语音模型系统提示的文字，例如“始终用中文回答” |
| `priceAudioInput` / `priceTextInput` | `3` / `0.75` | 每百万输入 token 的美元单价，用于面板中的 Gemini 费用估算 |
| `priceAudioOutput` / `priceTextOutput` | `4.5` / `4.5` | 每百万输出 token 的美元单价 |

## 🧩 工作原理

`dsh-plugin-voice-agent` 是一个同时承担三种角色的包：

- **Bundle**：`cordis.patch.yml` 插入一个 profile 条目 `voice-agent`。
- **Host 端**（`src/index.ts`、`src/live.ts`、`src/providers/`）：提供 `GET /api/voice-agent/status` 和 `WS /api/voice-agent/ws`，把每次通话连接到所选服务商。API Key 只在 Host 端读取，不会发到浏览器。
- **浏览器端**（`src/client`）：输入框通话按钮、通话面板、设置页，以及通过 `ctx.sessions`（prompt、cancel、会话事件窗口）在当前会话上执行语音工具的桥接层。

Harness 自身的包（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-credentials`）是 peer 依赖，由桌面版安装提供；唯一实际安装的依赖是 `ws`。

## 🔒 安全

- 通话接口只接受 loopback 的 `Host` 和同源浏览器请求，其他网站（包括 DNS rebinding 页面）无法用你的 Key 发起通话。
- 智能体的回答可能引用文件或网页内容。这些内容以“数据”标记交给语音模型；而且只有在上次智能体汇报之后你亲口说过话，`ask_harness` / `steer_harness` 才会执行，所以文件里的文字无法自行启动或改变任务。
- 进度播报只包含你自己的任务原话和工具名，不包含智能体输出。
- 编程智能体仍按你选择的 Harness 权限模式运行，需要批准时照常在窗口中弹出。

## 🛠️ 从源码构建

本包需要在 DeepSeek Harness 源码中构建，因为它的 tsconfig 和 tsdown 配置引用了 monorepo 的构建预设。需要 Node `>=24.9`。

1. 检出 `deepseek-ai/deepseek-harness` 的 `dsh-v0.2.2-alpha.2` 标签，运行 `pnpm install` 和 `pnpm run build:lib:host`。
2. 把 `plugin/` 复制到该源码的 `packages/client/voice-agent-plugin`，再运行一次 `pnpm install`。
3. 类型检查并构建：`node ./node_modules/typescript/bin/tsc -b packages/client/voice-agent-plugin/tsconfig.json`，然后 `pnpm --filter dsh-plugin-voice-agent run bundle`。
4. 打包：`pnpm --filter dsh-plugin-voice-agent pack`。

Harness `0.2.2` 把客户端构建函数改成接收包目录（`clientBundle(import.meta.dirname, …)`），所以当前源码不能再在 `0.2.0-rc.2` 源码中构建；如需旧版，请使用提交 `fd1b762`（0.3.7 版）。`v0.1.0` 标签对应 dsh `0.1.2-alpha.4`。

## ⚠️ 已知限制

- 进度播报由智能体的步骤触发。单个很长的步骤（例如很慢的测试）在下一步开始前不会播报。
- 面板中的 token 和费用只对 Gemini Live 显示，其他服务商暂不上报用量。
- 你的请求会尽量按原话交给智能体，不会添加额外目标：任务被扩大会让智能体做更多工作，也会花更多钱。
- 通话控制的是发起通话时所在的会话；没有打开会话时，语音会请你先打开一个。
- 还没有单元测试。

## 📄 许可证

[MIT](LICENSE)
