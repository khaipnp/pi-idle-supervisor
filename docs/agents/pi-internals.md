# Pi internals this extension relies on

Checked on Pi 1.4.0. Paths are under `node_modules/@earendil-works/pi-coding-agent/dist/core/`. After a Pi upgrade, re-check the lines here before trusting them.

## Sending a prompt (`agent-session.js`)

- `pi.sendUserMessage(content, { deliverAs?, expandPromptTemplates? })` calls `session.prompt()` with `expandPromptTemplates` defaulting to `false` (:1933) and `streamingBehavior: deliverAs`. It is fire-and-forget: the extension runtime wrapper catches a rejection and reports it with `runner.emitError({ event: "send_user_message" })` (:2778), so the caller never sees it.
- `prompt()`:
  - Defers while `agent_settled` handlers run (`_isEmittingAgentSettled`, :1632).
  - With `expandPromptTemplates`, text starting with `/` tries an extension command first (`_tryExecuteExtensionCommand`, :1641). The name is the text up to the first space. The command runs at once, even while the agent is streaming, and adds no user message. A throwing handler goes to `emitError` as `command:<name>`.
  - Then `/skill:name` and prompt templates expand.
  - Throws "Cannot submit a prompt while compaction is in progress..." during compaction (:1649).
  - While streaming without `streamingBehavior`, throws "Agent is already processing..." (:1667). When idle, `streamingBehavior` is ignored.
- `_startRun` sets `_isAgentRunActive = true` (:1424) before awaiting `before_agent_start`; `agent_start` fires later. So there is a window where Pi is busy but an extension tracking `agent_start` still thinks it is settled.

## Commands and errors (`extensions/runner.js`)

- Colliding command names are renamed `name:1`, `name:2` (:570). `pi.getCommands()` returns these invocation names; skills appear as `skill:<name>`.
- `runner.onError` / `emitError` (:493-500). Only the host binds a listener (`bindings.onError`, `agent-session.js:2676`); an extension cannot subscribe, so it never sees a command's error.
- Pi's built-in TUI commands (`/model`, `/compact`, `/new`, ...) are handled by interactive mode, not `prompt()`, and are not reachable from `sendUserMessage`.

## UI context

- Every extension shares one `ctx.ui` object per runtime, with plain writable methods. ADR-0001 wraps `select`, `confirm`, `input` and `notify` on it.
- Pi's own messages (`showError`, `showStatus`, `showWarning` in interactive mode) do not go through `ctx.ui.notify`.
