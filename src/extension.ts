import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_MAJOR, RemoteServer } from "./server.ts";
import { nextMessageId, toMessage, toSnapshot, toolUpdateText } from "./snapshot.ts";

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
		server?.emit({ type: "status", status: "working" });
	});
	// agent_settled, not agent_end: agent_end fires before queued follow-ups and retries have run.
	pi.on("agent_settled", () => {
		working = false;
		server?.emit({ type: "settled" });
	});
	const liveMessage = (message: Parameters<typeof toMessage>[0], c: ExtensionContext) =>
		server ? toMessage(message, nextMessageId(c.sessionManager.getBranch())) : undefined;
	pi.on("message_start", (event, c) => {
		const message = liveMessage(event.message, c);
		if (message) server?.emit({ type: "message_start", message });
	});
	pi.on("message_update", (event, c) => {
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
		const message = liveMessage(event.message, c);
		if (!message) return;
		const kind = update.type === "text_delta" ? "text" : "thinking";
		server?.emit({ type: "message_delta", messageId: message.id, blockIndex: update.contentIndex, kind, delta: update.delta });
	});
	pi.on("message_end", (event, c) => {
		const message = liveMessage(event.message, c);
		if (message) server?.emit({ type: "message_end", message });
	});
	pi.on("tool_execution_start", (event) => {
		server?.emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, arguments: event.args });
	});
	pi.on("tool_execution_update", (event) => {
		server?.emit({ type: "tool_update", toolCallId: event.toolCallId, ...toolUpdateText(event.partialResult) });
	});
	pi.on("tool_execution_end", (event) => {
		server?.emit({ type: "tool_end", toolCallId: event.toolCallId, isError: event.isError });
	});
	// Until #6 lets the next runtime adopt the server (ADR-0003), any shutdown turns remote off:
	// this runtime's ctx is invalid afterwards, so the snapshot could not be served.
	pi.on("session_shutdown", async () => {
		await server?.stop();
		server = undefined;
	});

	const snapshot = (seq: number) => toSnapshot(ctx!.sessionManager, working ? "working" : "settled", seq);

	const prompt = (text: string, deliverAs: "steer" | "followUp" | undefined) => {
		// Same state as the snapshot: settled starts a run and ignores deliverAs.
		if (!working) pi.sendUserMessage(text);
		else if (deliverAs) pi.sendUserMessage(text, { deliverAs });
		else return false;
		return true;
	};

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
					server = await RemoteServer.start({ port, snapshot, prompt, abort: () => ctx?.abort() });
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
