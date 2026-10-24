# Coding standards

Judgement calls for review. Mechanical rules live in `test/conventions.test.ts` and run with `npm test`.

## Remote events

- A runtime sends events to clients through `emit()` in `src/extension.ts`, which drops events from a retired runtime (ADR-0003). Calling `state.server.emit` directly is reserved for events about the server itself: `session_replaced` and `remote_off`.
- Anything forwarded to clients is checked for the access token first. A remote client must never receive the token or the pairing string.

## Protocol changes

- One change updates `docs/protocol.md`, `schema/protocol.schema.json`, README.md, and GLOSSARY.md when it adds a term, together with a test that validates the new shape against the schema.
- Adding a field, event type, endpoint or error code bumps the minor version, unless the current version is still unreleased (newer than the last `v*` tag); then the addition joins it, marked "added in X.Y".
- `src/server.ts` validates every client-supplied field before use and answers with a documented error code.

## Relying on Pi

- Behaviour Pi does not document (wrapping `ctx.ui`, process-global state) has an ADR that says why, and code that checks the shape it relies on and falls back with a warning instead of crashing. ADR-0001 is the pattern.
- Facts about Pi internals the code relies on go in `docs/agents/pi-internals.md`, with the Pi version they were checked on.

## Code

- Exported functions, types and constants have a doc comment saying what they are for, not restating the signature.
- A `// SAFETY:` comment says why the cast cannot be wrong at that point, not what it casts to.
- Tests drive the real extension through `test/harness.ts` (a real Pi session with a faux model), not mocks of Pi.
