# Pi Remote Control

Lets a person watch and steer a Pi session that is running in a terminal from a remote client, such as a phone, while away from the keyboard.

## Language

### Parties

**Host session**:
The Pi session running in a terminal that remote clients attach to and control.
_Avoid_: server, backend, instance

**Remote client**:
An app on another device, paired with a host session, that shows it and sends it commands.
_Avoid_: phone, mobile, device

### Access

**Remote on / Remote off**:
Whether the host session is currently accepting remote clients; only the person at the terminal turns it on or off.
_Avoid_: enabled, listening, sharing

**Pairing**:
A remote client learning a host session's address and access token by scanning the code shown in the terminal.
_Avoid_: login, registration, linking

**Access token**:
The secret created each time remote is turned on, which a remote client must present; it dies when remote turns off or the host session ends.
_Avoid_: password, API key, pairing code

### Conversation

**Prompt**:
A message from a person to the agent, typed in the terminal or sent by a remote client.
_Avoid_: input, command, ui prompt

**Slash command**:
A line starting with `/name` that runs an extension's command instead of reaching the agent, typed in the terminal or sent by a remote client in place of a prompt.
_Avoid_: command (alone), action

**Notice**:
A short notification that an extension shows on the terminal through `ctx.ui.notify`, such as a slash command's result, also sent to remote clients.
_Avoid_: toast, alert, message

**Steer**:
A prompt sent while the agent is working, delivered after its current turn.
_Avoid_: interrupt

**Follow-up**:
A prompt sent while the agent is working, delivered after the whole run finishes.
_Avoid_: queued prompt

**Follow-up queue**:
The remote follow-ups waiting for the run to settle, held by the extension so a remote client can still steer or cancel each one; follow-ups typed on the terminal wait in Pi's own queue instead.
_Avoid_: pending messages, outbox

**Dialog**:
A question that Pi or an extension blocks on until a person answers it (confirm, select, or input). It is offered to the terminal and every remote client at once, and the first answer wins.
_Avoid_: approval, prompt, ui prompt

**Settled**:
The host session has finished all automatic work and is waiting for a person.
_Avoid_: done, idle, finished

**Model**:
The language model the host session sends its requests to; a remote client may switch it to one of the offered models, the session's model scope (`enabledModels`) or else every model with credentials.
_Avoid_: provider, engine

**Thinking level**:
How much reasoning the model is asked to do before answering, from `off` to `max`; each model takes only some levels, and Pi moves any other level to the nearest one it takes.
_Avoid_: reasoning effort, thinking budget

### Sync

**Snapshot**:
The whole current conversation of the host session, as a remote client receives it on connecting.
_Avoid_: history, dump, transcript

**Event stream**:
The ordered live feed of changes in the host session sent to remote clients, which lets a reconnecting client catch up on what it missed.
_Avoid_: socket, feed, log
