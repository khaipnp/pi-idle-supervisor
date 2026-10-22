# Local server with a user-provided tunnel, no relay

Unlike Claude Code's remote control, the host session runs its own HTTP server bound to `127.0.0.1`, and the person makes it reachable through their own tunnel (Tailscale Serve, Cloudflare Tunnel). We chose this so there is no infrastructure to run, no account, and no third party seeing the conversation. The cost is that there is no push through a relay: the Android client keeps the event stream open from a foreground service and raises local notifications, and a person must set up a tunnel to use it away from home.
