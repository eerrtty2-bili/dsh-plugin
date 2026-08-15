# dsh-plugin · codex-import

**Codex (ChatGPT) conversation auto-importer** — a dynamic Cordis plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) that automatically imports your local Codex (desktop / CLI) conversation records from `~/.codex` into durable DSH sessions, grouped by project directory into workspaces.

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey) ![dsh](https://img.shields.io/badge/DSH-dynamic%20cordis%20plugin-blue)

> 中文文档见 [README.zh-CN.md](./README.md) · English docs here.

## Features

- **Auto-discovery of the data source** — derives your user home from the DSH settings file → `~/.codex`; no configuration needed. You can also point it at any custom path from the panel (custom `CODEX_HOME` etc.).
- **Supports both Codex record formats**:
  - Desktop thread format (`session_meta` / `turn_context` / `response_item` / `event_msg`, including MCP tool calls and patch-apply records)
  - Classic CLI rollout format (`session_start` / `user_message` / `agent_message` / `tool_call` / `command` …)
- **Thread-aware merging** — Codex desktop splits one thread's continuations across multiple rollout files (segments chain end-to-end). The plugin groups files by thread id, sorts them by time, and merges them into **one** DSH session — complete and up to date.
- **Streaming chunked import** — line-by-line streaming parse (`fs.streamText`), at most 30k records per pass — **arbitrarily large files** (including hundreds-of-MB sessions) import in bounded chunks with bounded memory.
- **Incremental auto-sync** — rescans every 30s; progress is tracked with a `codex/import` watermark event (file index + record line); only new content is appended. Live Codex sessions are imported as they grow, at most one scan cycle behind.
- **Faithful event mapping** — user/assistant messages (incl. reasoning), `function_call` / `custom_tool_call` / `mcp_tool_call_end` / `patch_apply_end` / command executions → standard DSH session events (turn/step/tool structure, valid surface ops).
- **Project workspaces** — each session's `cwd` maps to a DSH workspace (created or reused), so conversations appear under their project in the sidebar.
- **Live-session protection** — sessions that DSH resumed as active agent sessions are left alone to avoid write conflicts.
- **Control panel** — inside the Run card: data source, scan stats, recent imports, manual path override and a "scan now" button.
- **Model tools** — `codex_import_status` / `codex_import_now` to query state or trigger a scan at any time.

## Install / Run

This is a DSH dynamic Cordis plugin (Host + Client halves). Load it through DSH's dynamic-plugin flow:

1. Call `cordis_define` with `code.host` = [`host.js`](./host.js) and `code.client` = [`client.js`](./client.js).
2. Call `cordis_run` to activate (the first activation of the Client half needs approval on the Run card).
3. The first scan starts ~1s after activation, then every 30s.

> You can also paste both halves into a plugin row of your host `cordis.yml` to keep it permanently mounted.

## Usage

- **Panel** (inside the Run card, "Codex 对话自动导入"):
  - Shows data source, last scan stats (created / updated / skipped / errors) and recent imports;
  - Input field to override the Codex data directory ("应用/Apply" rescans immediately); "立即扫描/Scan now" triggers one scan.
- **Model tools**:
  - `codex_import_status` — current state and last report;
  - `codex_import_now` — run one scan import and return the report.
- **Viewing results**: refresh the DSH page — the left sidebar shows workspaces per project with their `codex-*` sessions (titles come from Codex thread names or the first user message). Open a session to browse the full conversation (tool calls and reasoning included).

## Data-source resolution (cross-platform)

| Platform | Default data source |
| --- | --- |
| Windows | `C:\Users\<user>\.codex` |
| macOS | `~/.codex` (per Codex version) |
| Linux | `~/.codex` |

Discovery: the plugin walks back from the DSH settings document path (`settings.documentPath`) to the user home, appends `.codex`, and verifies it exists; if that fails the panel prompts you to enter the path manually.

The plugin uses no platform-specific APIs — everything goes through DSH's `fs` / `sessionPersistence` / `workspaceRegistry` services — so Windows / macOS / Linux all work.

## Known limitations

- Imported sessions are read-only archives; if you open and continue one in DSH, the plugin stops appending to it (to avoid breaking seq continuity).
- Already-imported sessions are not re-imported automatically after plugin upgrades (idempotent watermark). For a full re-import with a new mapper: stop the plugin → delete the `codex-*` directories under `~/.dsh/sessions` → reactivate.
- Per-item caps: message text 120K chars, tool output 200K chars; oversized content is marked "…[内容已截断]".

## License

MIT
