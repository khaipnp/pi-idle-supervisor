# Remote dialogs by wrapping the shared ctx.ui

Pi has no API for one extension to see or answer dialogs opened by another (`ui_prompt_start` carries only kind and title), yet remote control is useless if permission prompts from other extensions block a person who is away. All extensions share one `ctx.ui` object (runner `createContext()` returns `runner.uiContext`), rebuilt on every bind just before `session_start`, so on `session_start` we replace its `select`/`confirm`/`input` with wrappers that show the terminal dialog with an `AbortSignal` and offer it to remote clients at the same time; the first answer wins and the other side is dismissed.

The same wrap covers `notify` (protocol 1.2): every notification still shows on the terminal and is also sent to remote clients as a `notice` event, because a slash command run from the phone usually reports its result only through `notify` and Pi gives extensions no other way to see a command's outcome or error. A notification that contains the access token (the pairing message) is never sent.

This relies on unofficial behaviour and may break on a Pi upgrade, so the wrapper checks the shape it expects first and, if that fails, turns off remote dialogs and notices with a warning instead of crashing. Dialogs Pi opens itself without going through `ctx.ui` are not reachable. We will propose an official dialog hook upstream and switch to it when it lands.

## Considered Options

- Remote only this extension's own dialogs: rejected, it leaves every permission gate unreachable.
- Wait for an upstream hook: rejected for v1, it blocks the feature on someone else's release.
