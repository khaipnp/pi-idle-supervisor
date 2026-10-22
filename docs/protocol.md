# Remote control protocol

The contract between a **host session** (the `pi-idle-supervisor` extension) and a **remote client** (for example the Android app, in its own repo). Terms follow `GLOSSARY.md`.

Protocol version: **1.0**. A change that breaks existing clients bumps the major version. Adding a field, event type, or endpoint bumps the minor version, and clients must ignore fields and event types they don't know.

## Transport

- HTTP/1.1. The server listens on `127.0.0.1` only (default port `7878`).
- The pairing `url` is chosen in this order: `/remote start --url <url>`, the `remote.publicUrl` setting, this machine's Tailscale MagicDNS name, then `http://127.0.0.1:<port>`. The last works only on the host machine, and the extension warns about it. Remote URLs must be `https`. Remote clients reach it through a tunnel the person sets up (Tailscale Serve, Cloudflare Tunnel), which provides HTTPS. See ADR-0002.
- Every path starts with `/v1`.
- Request and response bodies are JSON (`Content-Type: application/json`, UTF-8). The event stream is `text/event-stream`.

## Pairing

When remote turns on, the terminal shows a QR code and the same text as a pairing string:

```
pi-remote://pair?url=<percent-encoded base URL>&token=<access token>&v=1
```

- `url` is the public base URL, without `/v1`, for example `https://mac.tail1234.ts.net`.
- `token` is the access token: 43 characters of base64url (32 random bytes).
- `v` is the protocol major version.

The access token is valid until remote turns off or the person quits Pi. It survives `/new`, `/resume`, `/fork` and reload. See ADR-0003.

## Every request

Clients send these headers:

```
Authorization: Bearer <access token>
Pi-Remote-Protocol: 1.0
```

The server checks them in this order:

1. If the server is locked out, it responds `429 rate_limited`. The response includes a `Retry-After` header in seconds.
2. If the token is missing or wrong, it responds `401 unauthorized`. Ten failed attempts within 60 seconds lock out **all** clients for 60 seconds. The lockout is global because tunnelled requests all arrive from `127.0.0.1`.
3. If the header is missing or the major version differs, it responds `426 protocol_mismatch`, and the body includes `serverVersion`.

Errors always use this shape:

```json
{ "error": { "code": "unauthorized", "message": "human-readable text" } }
```

Error codes: `unauthorized`, `rate_limited`, `protocol_mismatch`, `bad_request`, `busy`, `dialog_closed`, `not_found`.

## Endpoints

### `GET /v1/snapshot`

Returns the whole current conversation of the host session, together with the event sequence number it is current up to.

```json
{
  "protocolVersion": "1.0",
  "seq": 1042,
  "hostSession": { "id": "…", "cwd": "/Users/me/project", "name": "optional" },
  "status": "working",
  "messages": [ /* Message, oldest first */ ],
  "dialogs": [ /* Dialog, every dialog still waiting for an answer */ ]
}
```

`status` is either `"working"` or `"settled"`.

To connect, a client fetches the snapshot, then opens the event stream with `Last-Event-ID: <seq>`.

### `GET /v1/events`

Opens the event stream as Server-Sent Events. Each event looks like this:

```
id: 1043
event: message_delta
data: {"seq":1043, ...}

```

- While the host session is being replaced (`/new`, `/resume`, `/fork`, reload), every request except `GET /v1/events` gets `503 busy`; retry after `session_replaced`. If no new session starts within 30 seconds, remote turns off and the server publishes `remote_off`.
- `seq` increases by one with each event and is never reused for as long as the server is running, including across session replacement.
- A client resumes by sending `Last-Event-ID: <last seq it saw>`, or `?after=<seq>` when it cannot set headers. The server replays everything after that point, then continues live.
- The server keeps the last 5000 events. If the requested seq is older than that or newer than the server has ever sent, the server sends a single `resync` event, and the client must fetch a new snapshot. The `resync` event has no SSE `id`, so a reconnecting client keeps its old `Last-Event-ID`.
- Without a resume point the stream carries only events from now on.
- A resume point that is not a non-negative integer gets `400 bad_request`.
- Every 15 seconds the server sends a `: ping` comment line, so that proxies and the client can detect a dead connection.

### `POST /v1/prompt`

Sends a prompt.

```json
{ "text": "run the tests", "deliverAs": "steer" }
```

- `deliverAs` is optional and is either `"steer"` or `"followUp"`.
- If the host session is settled, the prompt starts a run, and the server ignores `deliverAs`.
- If the host session is working and `deliverAs` is missing, the server responds `409 busy`.
- A body that is not JSON, is over 1 MB, has empty or non-string `text`, or has another `deliverAs` gets `400 bad_request`.
- On success the server responds `202 {}`. The prompt then appears in the event stream like any other message.

### `POST /v1/abort`

Stops the current run. If the host session is already settled, nothing happens. Responds `202 {}`.

### `POST /v1/dialogs/{id}/answer`

Answers a dialog. The body depends on the dialog kind:

```json
{ "value": true }
```

- For `confirm`, `value` is a boolean.
- For `select`, `value` is one of the options.
- For `input`, `value` is a string.
- To dismiss the dialog without answering, send `{ "cancelled": true }`.

The first answer from the terminal or from any remote client wins. A later answer gets `409 dialog_closed`. An unknown id gets `404 not_found`. A `value` with the wrong type for the dialog kind gets `400 bad_request`.

## Types

### Message

```jsonc
{
  "id": "m-17",                        // stable for this message within the host session
  "role": "user" | "assistant" | "toolResult",
  "timestamp": 1761234567890,          // ms since epoch
  "content": [ /* Block */ ],
  // only when role is toolResult:
  "toolCallId": "call-3",
  "toolName": "bash",
  "isError": false
}
```

### Block

```jsonc
{ "type": "text", "text": "…" }
{ "type": "thinking", "text": "…" }
{ "type": "toolCall", "id": "call-3", "name": "bash", "arguments": { /* JSON */ } }
{ "type": "image", "mimeType": "image/png" }       // image bytes are never sent
```

Text in a `toolResult` message, and text in a `tool_update` event, is cut to its first 16 KB (16384 UTF-8 bytes, never splitting a character). A cut block carries `"truncated": true, "originalBytes": 120000`.

### Dialog

```jsonc
{
  "id": "d-5",
  "kind": "confirm" | "select" | "input",
  "title": "Allow bash?",
  "message": "rm -rf build",    // only for confirm
  "options": ["Allow", "Block"],// only for select
  "placeholder": "…",           // only for input, and only when set
  "expiresAt": 1761234599000    // only when the dialog has a timeout
}
```

## Events

Every event has `seq` and `type`. The `type` field matches the SSE `event:` name.

| type | data (besides `seq`, `type`) | when |
|---|---|---|
| `status` | `status`: `"working"` | a run starts |
| `settled` | | the host session settles, with no more automatic work |
| `message_start` | `message`: Message (content may be empty) | a message begins |
| `message_delta` | `messageId`, `blockIndex`, `kind`: `"text"` or `"thinking"`, `delta` | streaming text from the assistant |
| `message_end` | `message`: Message | a message is final; this replaces everything streamed for it |
| `tool_start` | `toolCallId`, `toolName`, `arguments` | a tool starts running |
| `tool_update` | `toolCallId`, `text`, plus `truncated` and `originalBytes` when cut | partial output from a running tool |
| `tool_end` | `toolCallId`, `isError` | a tool finishes; its result arrives as a `toolResult` message |
| `dialog_open` | `dialog`: Dialog | a dialog is waiting for an answer |
| `dialog_closed` | `dialogId`, `closedBy`: `"terminal"`, `"remote"`, `"timeout"` or `"cancelled"` | a dialog is answered or gone |
| `session_replaced` | `hostSession` | `/new`, `/resume`, `/fork` or reload replaced the host session; refetch the snapshot |
| `remote_off` | | remote is turning off; the client should stop reconnecting and show that it is unpaired |
| `resync` | | the client fell too far behind; refetch the snapshot |

The JSON Schema for every body and event above lives in `schema/protocol.schema.json`.
