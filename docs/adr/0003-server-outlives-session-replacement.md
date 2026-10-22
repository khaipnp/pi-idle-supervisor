# Server and access token outlive session replacement

Pi tears down the extension runtime on `/new`, `/resume`, `/fork` and reload, which would kill the server and force re-pairing every time. Only `session_shutdown` with `reason: "quit"` stops the server and revokes the access token; for other reasons the server and token are kept on `globalThis` and adopted by the next runtime, which tells clients the host session was replaced so they reload the snapshot. A reader will see process-global state in an extension and wonder why; this is why.
