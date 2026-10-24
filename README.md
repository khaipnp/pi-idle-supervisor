# pi-idle-supervisor

Watch and steer a running [Pi](https://github.com/earendil-works/pi) session from another device. The extension runs a small HTTP server on your machine. A remote client (for example an Android app) pairs with a QR code, streams the conversation, sends prompts, and answers permission dialogs while you are away from the terminal.

- No relay and no account. You expose the local server through your own tunnel (Tailscale Serve, a named Cloudflare Tunnel, or the built-in `--tunnel ssh` option), so nobody else sees the conversation unless you pick the third-party option. See `docs/adr/0002-local-server-no-relay.md` and `docs/adr/0004-optional-ssh-tunnel-through-localhost-run.md`.
- Remote clients can attach images and files to a prompt (see below).
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

Restart Pi (or run `/reload`). The extension does nothing until you run `/remote` or `/remote start`.

## Commands

| Command | Effect |
| --- | --- |
| `/remote` | Asks how your phone will connect (LAN, Tailscale or a localhost.run tunnel), then turns remote on that way. If remote is already on, shows the status. |
| `/remote start [--lan \| --tailscale \| --tunnel ssh \| --url <https url>]` | Starts the server, creates a fresh access token, and shows a QR code and a `pi-remote://pair?...` string. Each flag picks one way to connect (see below); using more than one is an error. Without a flag, the address comes from the settings. |
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
    "publicUrl": "https://my-mac.tail1234.ts.net",
    "tunnel": "ssh"
  }
}
```

- `port`: local port, default `7878`. If it is busy, `/remote start` fails with an error. It never picks another port.
- `publicUrl`: the https address your tunnel serves. Optional.
- `tunnel`: `"ssh"` opens a localhost.run tunnel on every `/remote start`. Optional. A non-empty `publicUrl` wins over it.

The public URL put in the QR code is chosen in this order:

1. the choice in the `/remote` picker, or `/remote start --lan`, `--tailscale`, `--tunnel ssh` or `--url <url>`
2. the `remote.publicUrl` setting
3. the `remote.tunnel` setting
4. this machine's Tailscale MagicDNS name, from `tailscale status --json`
5. `http://127.0.0.1:<port>`, with a warning: only this machine can use it

Remote URLs must be `https`. Plain `http` is accepted only for localhost and for LAN mode.

## Ways to connect

In LAN mode the server listens on this machine's private network address. Otherwise it listens on `127.0.0.1` only, and a tunnel gives your phone an https address that forwards to it.

### LAN (same Wi-Fi, no setup)

```text
/remote start --lan
```

The server listens on this machine's private IPv4 address (for example `192.168.1.20`, never `0.0.0.0`) and the QR code holds `http://<that address>:<port>`. The phone must be on the same network.

Limits:

- Plain http: anyone on the network who captures the traffic can read the conversation and the access token. Use it only on a network you trust, such as your home Wi-Fi, not a café or office network.
- The address can change when your router hands out a new one. Run `/remote start --lan` again and pair again.
- Android blocks plain http unless the app allows it. The client app must allow cleartext traffic to private addresses.
- If your computer's firewall asks whether to accept incoming connections, allow them.

### Tailscale Serve

Install Tailscale on the computer and the phone and sign both in to the same tailnet. Then:

```sh
tailscale serve --bg 7878
```

Use your port if you changed it. `/remote start` finds the MagicDNS name itself, for example `https://my-mac.tail1234.ts.net`. It looks for `tailscale` on PATH, then for the command line tool inside the macOS app, and it only uses the name while Tailscale is running. If Tailscale is stopped, remote falls back to the localhost address, which a phone cannot reach. It cannot check that `tailscale serve` is running, so if the client cannot connect, run `tailscale serve status`.

### localhost.run (no install, no account)

```text
/remote start --tunnel ssh
```

This runs the `ssh` that ships with macOS, Linux and Windows 10+, forwards a `https://<name>.lhr.life` address to the server, and stops it when remote turns off or Pi quits. The phone needs nothing installed.

Limits:

- localhost.run ends TLS, so it can read the traffic, including the access token. Use Tailscale for private work.
- The address is new on every start and changes after a few hours. If `ssh` ends, remote turns off and tells you; run `/remote start` again and pair again. The extension does not restart the tunnel on its own, because the QR code would no longer match.
- It is a free third-party service with no uptime promise.

### Cloudflare Tunnel

Cloudflare Quick Tunnels do not support Server-Sent Events, which the event stream needs, so they do not work here. Use a named tunnel with `remote.publicUrl`.

```sh
cloudflared tunnel --url http://127.0.0.1:7878
```

Pass the https address of your named tunnel explicitly, or set `remote.publicUrl`:

```text
/remote start --url https://my-tunnel.example.com
```

## Attachments

A remote client can upload files and attach up to 4 of them to one prompt.

- Images (PNG, JPEG, GIF, WebP) reach Pi as images.
- Any other file is saved on your computer and its path is added to the prompt text, so the agent reads it with its own tools.
- Limits: 12 MB per file and 200 MB in total while remote is on.
- Uploads live in a private temporary folder and are deleted when remote turns off or Pi quits.

## Slash commands from the phone

A prompt sent from a remote client is handled like a line typed on the terminal:

- `/name args` runs an extension command right away, even while the agent is working.
- Prompt templates and `/skill:name` expand as usual.
- Pi's built-in commands (`/model`, `/compact`, ...) only work on the terminal, and so does `/remote`.
- A command can't carry attachments.

This is protocol 1.2. Clients written for 1.0 or 1.1 keep working, but text they send that starts with a command name now runs the command. Details are in `docs/protocol.md`.

## Pairing

Scan the QR code with the client, or paste the pairing string. The string looks like `pi-remote://pair?url=<public url>&token=<access token>&v=1`.

## Security

- **Access token.** Created every time remote turns on: 32 random bytes, base64url. It is the only credential, so treat the QR code and pairing string like a password. It stops working when remote turns off or Pi quits.
- **Bind address.** The server listens on `127.0.0.1`, so only your tunnel can reach it. In LAN mode it listens on one private address (10.x, 172.16–31.x or 192.168.x), never on all interfaces.
- **Lockout.** A wrong or missing token gets `401`. Ten failures within 60 seconds lock out all clients for 60 seconds (`429`). The lockout is global because tunnelled requests all arrive from `127.0.0.1`.
- **https only.** `--url` and `publicUrl` reject plain `http` for non-local hosts so the token is never sent in cleartext. LAN mode is the one exception and says so when it starts.
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
