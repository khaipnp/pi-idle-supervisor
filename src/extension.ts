import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_MAJOR, RemoteServer } from "./server.ts";
import { toSnapshot } from "./snapshot.ts";

const DEFAULT_PORT = 7878;

interface RemoteSettings {
	port?: number;
}

/** Registers `/remote start|stop|status`. The factory does no I/O; the server starts only from the command. */
export default function remoteExtension(pi: ExtensionAPI): void {
	let server: RemoteServer | undefined;
	let ctx: ExtensionContext | undefined;
	let working = false;

	pi.on("session_start", (_event, c) => {
		ctx = c;
	});
	pi.on("agent_start", () => {
		working = true;
	});
	pi.on("agent_settled", () => {
		working = false;
	});
	// Until #6 lets the next runtime adopt the server (ADR-0003), any shutdown turns remote off:
	// this runtime's ctx is invalid afterwards, so the snapshot could not be served.
	pi.on("session_shutdown", async () => {
		await server?.stop();
		server = undefined;
	});

	const snapshot = () => toSnapshot(ctx!.sessionManager, working ? "working" : "settled");

	pi.registerCommand("remote", {
		description: "Remote control: /remote start | stop | status",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "status"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, c) => {
			ctx = c;
			const sub = args.trim().split(/\s+/)[0] || "status";
			if (sub === "start") {
				if (server) return c.ui.notify(`Remote is already on at ${server.url}`, "warning");
				const settings = (pi.getSettings() as { remote?: RemoteSettings }).remote ?? {};
				const port = settings.port ?? DEFAULT_PORT;
				try {
					server = await RemoteServer.start({ port, snapshot });
				} catch (error) {
					return c.ui.notify(`Remote could not start on 127.0.0.1:${port}: ${(error as Error).message}`, "error");
				}
				const pairing = `pi-remote://pair?url=${encodeURIComponent(server.url)}&token=${server.token}&v=${PROTOCOL_MAJOR}`;
				c.ui.notify(`Remote is on at ${server.url}\nPair with: ${pairing}`, "info");
			} else if (sub === "stop") {
				if (!server) return c.ui.notify("Remote is off", "info");
				await server.stop();
				server = undefined;
				c.ui.notify("Remote is off; the access token is revoked", "info");
			} else if (sub === "status") {
				c.ui.notify(server ? `Remote is on at ${server.url} (port ${server.port})` : "Remote is off", "info");
			} else {
				c.ui.notify(`Unknown subcommand "${sub}". Use /remote start | stop | status`, "error");
			}
		},
	});
}
