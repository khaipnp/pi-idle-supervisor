# pi-idle-supervisor

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Pi internals

Before reading Pi's `dist/` source, check `docs/agents/pi-internals.md`: how prompts, slash commands, errors and `ctx.ui` behave inside Pi, with line numbers.

## Android client

The Android remote client lives in its own repo at `~/Develop/android-idle-supervisor`. It speaks the protocol in `docs/protocol.md` and `schema/protocol.schema.json`; check it there when changing the protocol.
