# Remote dialogs by wrapping the shared ctx.ui

Pi has no API for one extension to see or answer dialogs opened by another (`ui_prompt_start` carries only kind and title), yet remote control is useless if permission prompts from other extensions block a person who is away. All extensions share one `ctx.ui` object (runner `createContext()` returns `runner.uiContext`), rebuilt on every bind just before `session_start`, so on `session_start` we replace its `select`/`confirm`/`input` with wrappers that show the terminal dialog with an `AbortSignal` and offer it to remote clients at the same time; the first answer wins and the other side is dismissed.

This relies on unofficial behaviour and may break on a Pi upgrade, so the wrapper checks the shape it expects first and, if that fails, turns off remote dialogs with a warning instead of crashing. Dialogs Pi opens itself without going through `ctx.ui` are not reachable. We will propose an official dialog hook upstream and switch to it when it lands.

## Considered Options

- Remote only this extension's own dialogs: rejected, it leaves every permission gate unreachable.
- Wait for an upstream hook: rejected for v1, it blocks the feature on someone else's release.
