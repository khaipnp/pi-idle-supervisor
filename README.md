# pi-idle-supervisor

Watch and steer a running [Pi](https://github.com/earendil-works/pi) session from another device. The extension runs a small HTTP server on your machine. A remote client (for example an Android app) pairs with a QR code, streams the conversation, sends prompts, and answers permission dialogs while you are away from the terminal.

- No relay and no account. You expose the local server through your own tunnel (Tailscale Serve or Cloudflare Tunnel), so nobody else sees the conversation. See `docs/adr/0002-local-server-no-relay.md`.
- Works with Pi 1.4.x and Node 22 or newer.

## Install

```sh
# from npm
pi install npm:pi-idle-supervisor

# from git
pi install git:github.com/khaipnp/pi-idle-supervisor

# from a local checkout
pi install ./pi-idle-supervisor
```

Restart Pi (or run `/reload`). The extension does nothing until you run `/remote start`.

## Commands

| Command | Effect |
| --- | --- |
| `/remote start [--url <https url>]` | Starts the server, creates a fresh access token, and shows a QR code and a `pi-remote://pair?...` string. |
| `/remote stop` | Closes the server and revokes the token. |
| `/remote status` | Shows whether remote is on, the public URL, the port and the number of connected clients. |

While remote is on, the footer shows `📡 remote · N clients`.

Remote stays on across `/new`, `/resume`, `/fork` and reload, with the same token. It turns off when you run `/remote stop` or quit Pi.

## Settings

Add a `remote` object to `~/.pi/agent/settings.json` (or the project's `.pi/settings.json`):

```json
{
  "remote": {
    "port": 7878,
    "publicUrl": "https://my-mac.tail1234.ts.net"
  }
}
```

- `port`: local port, default `7878`. If it is busy, `/remote start` fails with an error. It never picks another port.
- `publicUrl`: the https address your tunnel serves. Optional.

The public URL put in the QR code is chosen in this order:

1. `/remote start --url <url>`
2. the `remote.publicUrl` setting
3. this machine's Tailscale MagicDNS name, from `tailscale status --json`
4. `http://127.0.0.1:<port>`, with a warning: only this machine can use it

Remote URLs must be `https`. Plain `http` is accepted only for localhost.

## Set up a tunnel

The server listens on `127.0.0.1` only. A tunnel gives your phone an https address that forwards to it.

### Tailscale Serve

Install Tailscale on the computer and the phone and sign both in to the same tailnet. Then:

```sh
tailscale serve --bg 7878
```

Use your port if you changed it. `/remote start` finds the MagicDNS name itself, for example `https://my-mac.tail1234.ts.net`. It cannot check that `tailscale serve` is running, so if the client cannot connect, run `tailscale serve status`.

### Cloudflare Tunnel

```sh
cloudflared tunnel --url http://127.0.0.1:7878
```

Cloudflare prints an `https://...trycloudflare.com` address. Pass it explicitly:

```text
/remote start --url https://example-words.trycloudflare.com
```

For a stable address, create a named tunnel and set `remote.publicUrl`.

## Pairing

Scan the QR code with the client, or paste the pairing string. The string looks like `pi-remote://pair?url=<public url>&token=<access token>&v=1`.

## Security

- **Access token.** Created every time remote turns on: 32 random bytes, base64url. It is the only credential, so treat the QR code and pairing string like a password. It stops working when remote turns off or Pi quits.
- **Localhost bind.** The server never listens on a public interface. Only your tunnel can reach it.
- **Lockout.** A wrong or missing token gets `401`. Ten failures within 60 seconds lock out all clients for 60 seconds (`429`). The lockout is global because tunnelled requests all arrive from `127.0.0.1`.
- **https only.** `--url` and `publicUrl` reject plain `http` for non-local hosts so the token is never sent in cleartext.
- **Dialogs (ADR-0001 caveat).** To let you answer permission prompts from other extensions remotely, the extension wraps `select`, `confirm` and `input` on Pi's shared UI context. That relies on unofficial Pi behaviour and may break on a Pi upgrade. If Pi's UI context looks different from what is expected, remote dialogs are turned off with a warning and the rest keeps working. Dialogs Pi opens without going through that context cannot be answered remotely. See `docs/adr/0001-remote-dialogs-by-wrapping-shared-ctx-ui.md`.
- Anyone holding the token can read the whole conversation and run anything the agent can run. Run `/remote stop` when you are done.

## For client authors

The wire protocol (pairing, endpoints, events, errors) is in [docs/protocol.md](docs/protocol.md), with a JSON Schema in `schema/protocol.schema.json`.

## Development

```sh
npm install
npm run typecheck
npm test
```
