# Remote follow-ups wait in the extension, not in Pi's queue

A follow-up sent by a remote client while the agent is working is held in the extension's own follow-up queue (`src/queue.ts`) and handed to Pi with `pi.sendUserMessage` only when the run settles, oldest first and one run at a time. Until then the client sees it in the snapshot and `queue` events and can steer it into the current run or cancel it. We did this because the Android client shows a sent follow-up with a Steer button, and Pi's queue cannot support that from an extension: `ExtensionContext` only has `hasPendingMessages()`, with no way to list, remove or reorder queued messages, and Pi tells extensions nothing about its queue until a message starts. Handing a follow-up to Pi and then steering it would deliver it twice.

Consequences:

- Remote follow-ups no longer join Pi's own follow-up batch. Each one starts its own run after `agent_settled`, so clients see `settled` then `status: working` between them. Pi defers a prompt sent from an `agent_settled` handler until the handlers finish (`docs/agents/pi-internals.md`).
- An aborted run (`agent_settled` with `aborted`) drops the waiting follow-ups, as Escape takes Pi's own queue back into the editor. Clients see an empty `queue` event.
- The queue belongs to one extension runtime, so `/new`, `/resume`, `/fork` and reload drop it (ADR-0003 keeps only the server).
- Follow-ups typed on the terminal stay in Pi's queue and are not listed to clients.
- If Pi rejects the prompt sent for a follow-up (during compaction, say), it is lost and reported only through Pi's own error handler, like any `sendUserMessage` failure.
