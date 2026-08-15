# dsh-plugin · codex-import

**Codex（ChatGPT）对话自动导入插件** —— 为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 编写的动态 Cordis 插件，自动把本机 Codex 桌面版/CLI 的会话记录（`~/.codex`）导入为 DSH 持久化会话，并按项目目录挂载到对应工作区。

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey) ![dsh](https://img.shields.io/badge/DSH-dynamic%20cordis%20plugin-blue)

## 功能特性

- **自动发现数据源**：从 DSH 设置文件推导用户主目录 → `~/.codex`，无需任何配置；也支持面板手动指定任意路径（`CODEX_HOME` 自定义目录等）。
- **兼容两种 Codex 记录格式**：
  - 桌面版线程格式（`session_meta` / `turn_context` / `response_item` / `event_msg`，含 MCP 工具调用与补丁应用记录）
  - 经典 CLI rollout 格式（`session_start` / `user_message` / `agent_message` / `tool_call` / `command` …）
- **线程感知合并**：Codex 桌面版对同一线程的续写会拆成多个 rollout 文件（各段首尾衔接）。插件按线程 id 分组、按时间排序后合并导入**一个** DSH 会话，保证完整、最新。
- **流式分块导入**：逐行流式解析（`fs.streamText`），每轮最多处理 3 万条记录 —— **任意大小文件**（包括数百 MB 的会话）都能分块导入，内存占用恒定有界。
- **增量续导（自动）**：每 30 秒自动扫描；以 `codex/import` 水印事件记录进度（文件索引 + 行号），只追加新内容；运行中的 Codex 会话边写边导，最长延迟一个扫描周期。
- **事件映射保真**：用户/助手消息（含 reasoning 思维链）、`function_call` / `custom_tool_call` / `mcp_tool_call_end` / `patch_apply_end` / 命令执行 → 标准 DSH 会话事件（turn/step/tool 结构，surfaceOp 合法）。
- **按项目挂载工作区**：会话 `cwd` → 自动创建/复用 DSH 工作区并挂载会话，左侧栏按项目浏览。
- **Live 会话保护**：被用户在 DSH 里打开/继续（被 agent loop 接管）的导入会话自动放行，避免与活跃写入冲突。
- **控制面板**：Run 卡片内显示数据源、扫描统计、最近导入，支持手动指定目录与"立即扫描"。
- **模型工具**：`codex_import_status` / `codex_import_now` —— 随时查询状态或触发扫描。

## 安装 / 运行

这是 DSH 的动态 Cordis 插件（Host + Client 双半区），通过 DSH 的动态插件流程加载：

1. 在 DSH 会话中调用 `cordis_define`，`code.host` 使用 [`host.js`](./host.js)，`code.client` 使用 [`client.js`](./client.js)（即插件源码）。
2. 调用 `cordis_run` 激活（Client 半区首次激活需在 Run 卡片上授权）。
3. 首次扫描在激活后约 1 秒自动开始，之后每 30 秒增量扫描。

> 也可以把两段源码复制进宿主 `cordis.yml` 的插件行（`plugin: [{ name, apply }]` 形式），随 DSH 常驻。

## 使用

- **面板**（Run 卡片内"Codex 对话自动导入"）：
  - 显示数据源、上次扫描统计（新导入 / 更新 / 跳过 / 错误）、最近导入列表；
  - 输入框可手动指定 Codex 数据目录（点击"应用"后立即扫描）；"立即扫描"手动触发一轮扫描。
- **模型工具**：
  - `codex_import_status` — 查看当前状态与最近报告；
  - `codex_import_now` — 立即执行一次扫描导入并返回报告。
- **查看导入结果**：刷新 DSH 页面，左侧工作区列表按项目显示导入的 `codex-*` 会话（会话标题取自 Codex 线程名或首条消息），点击即可浏览完整对话（含工具调用、思维链）。

## 数据源定位（跨平台）

| 平台 | 默认数据源 |
| --- | --- |
| Windows | `C:\Users\<用户>\.codex` |
| macOS | `~/Library/...` 或 `~/.codex`（依 Codex 版本，通常 `~/.codex`） |
| Linux | `~/.codex` |

自动发现逻辑：从 DSH 设置文件路径（`settings.documentPath`）反推用户主目录，拼接 `.codex` 并校验存在；失败时面板会提示，可手动输入路径。

插件本身不依赖任何平台特有 API（全部通过 DSH 的 `fs` / `sessionPersistence` / `workspaceRegistry` 服务），Windows / macOS / Linux 通用。

## 已知限制

- 导入会话为只读归档；若在 DSH 中打开并继续对话，插件会停止向该会话追加（避免破坏 seq 连续性）。
- 已导入会话不会因插件版本升级而自动重导（幂等水印保护）。如需用新映射全量重导：停止插件 → 删除 `~/.dsh/sessions` 下 `codex-*` 目录 → 重新激活。
- 文本/工具输出有单条上限（消息 120K 字符、工具输出 200K 字符），超长内容会以"…[内容已截断]"标记。

## License

MIT
