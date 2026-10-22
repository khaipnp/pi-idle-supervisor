import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Dialogs, wrapDialogs } from "./dialogs.ts";
import { PROTOCOL_MAJOR, RemoteServer } from "./server.ts";
import { hostSessionOf, nextMessageId, toMessage, toSnapshot, toolUpdateText } from "./snapshot.ts";

const DEFAULT_PORT = 7878;

interface RemoteSettings {
	port?: number;
}

/**
 * Remote state that outlives one extension runtime (ADR-0003): Pi rebuilds the runtime on /new,
 * /resume, /fork and reload, and the server and access token must survive that. Only quitting ends them.
 */
interface Shared {
	server?: RemoteServer;
	dialogs?: Dialogs;
	warnedDialogs?: boolean;
	stopping?: Promise<void>;
}
const SHARED_KEY = Symbol.for("pi-idle-supervisor.remote");
function shared(): Shared {
	const holder = globalThis as { [SHARED_KEY]?: Shared };
	return (holder[SHARED_KEY] ??= {});
}

/** Registers `/remote start|stop|status`. The factory does no I/O; the server starts only from the command. */
export default function remoteExtension(pi: ExtensionAPI): void {
	const state = shared();
	let ctx: ExtensionContext | undefined;
	let working = false;
	// Set when this runtime shuts down: its handlers must not touch the shared server any more.
	let retired = false;
	const emit = (body: Parameters<RemoteServer["emit"]>[0]) => {
		if (!retired) state.server?.emit(body);
	};

	pi.on("session_start", (_event, c) => {
		ctx = c;
		// Wrapping depends on how Pi builds ctx.ui (ADR-0001); if that changed, remote still works minus dialogs.
		if (!wrapDialogs(c.ui, () => state.dialogs) && !state.warnedDialogs) {
			state.warnedDialogs = true;
			c.ui.notify("Remote dialogs are unavailable: this Pi version's UI context is not what pi-idle-supervisor expects.", "warning");
		}
		// A previous runtime left the server running (/new, /resume, /fork, reload): take it over.
		if (state.server) {
			state.server.rebind({ snapshot, prompt, abort: () => ctx?.abort() });
			state.server.emit({ type: "session_replaced", hostSession: hostSessionOf(c.sessionManager) });
		}
	});
	pi.on("agent_start", () => {
		working = true;
		emit({ type: "status", status: "working" });
	});
	// agent_settled, not agent_end: agent_end fires before queued follow-ups and retries have run.
	pi.on("agent_settled", () => {
		working = false;
		emit({ type: "settled" });
	});
	const liveMessage = (message: Parameters<typeof toMessage>[0], c: ExtensionContext) =>
		state.server && !retired ? toMessage(message, nextMessageId(c.sessionManager.getBranch())) : undefined;
	pi.on("message_start", (event, c) => {
		const message = liveMessage(event.message, c);
		if (message) emit({ type: "message_start", message });
	});
	pi.on("message_update", (event, c) => {
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
		const message = liveMessage(event.message, c);
		if (!message) return;
		const kind = update.type === "text_delta" ? "text" : "thinking";
		emit({ type: "message_delta", messageId: message.id, blockIndex: update.contentIndex, kind, delta: update.delta });
	});
	pi.on("message_end", (event, c) => {
		const message = liveMessage(event.message, c);
		if (message) emit({ type: "message_end", message });
	});
	pi.on("tool_execution_start", (event) => {
		emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, arguments: event.args });
	});
	pi.on("tool_execution_update", (event) => {
		emit({ type: "tool_update", toolCallId: event.toolCallId, ...toolUpdateText(event.partialResult) });
	});
	pi.on("tool_execution_end", (event) => {
		emit({ type: "tool_end", toolCallId: event.toolCallId, isError: event.isError });
	});
	// Only quitting ends remote (ADR-0003). For /new, /resume, /fork and reload the next runtime adopts
	// the server; this runtime's handlers die with it, and requests in between get 503 busy.
	pi.on("session_shutdown", async (event) => {
		retired = true;
		if (event.reason === "quit") return stopRemote();
		// Replacement: dialogs belong to the old UI, so dismiss them; the next runtime adopts the server.
		state.dialogs?.dispose();
		state.server?.detach();
	});

	/** Idempotent and awaitable: a second caller waits for the stop already in progress. */
	function stopRemote(): Promise<void> {
		const { server, dialogs } = state;
		if (!server) return state.stopping ?? Promise.resolve();
		state.server = state.dialogs = undefined;
		dialogs?.dispose();
		server.emit({ type: "remote_off" });
		return (state.stopping = server.stop().finally(() => (state.stopping = undefined)));
	}

	function snapshot(seq: number) {
		return toSnapshot(ctx!.sessionManager, working ? "working" : "settled", seq, state.dialogs?.list() ?? []);
	}

	function prompt(text: string, deliverAs: "steer" | "followUp" | undefined): boolean {
		// Same state as the snapshot: settled starts a run and ignores deliverAs.
		if (!working) pi.sendUserMessage(text);
		else if (deliverAs) pi.sendUserMessage(text, { deliverAs });
		else return false;
		return true;
	}

	pi.registerCommand("remote", {
		description: "Remote control: /remote start | stop | status",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "status"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, c) => {
			ctx = c;
			const sub = args.trim().split(/\s+/)[0] || "status";
			if (sub === "start") {
				await state.stopping;
				if (state.server) return c.ui.notify(`Remote is already on at ${state.server.url}`, "warning");
				const settings = (pi.getSettings() as { remote?: RemoteSettings }).remote ?? {};
				const port = settings.port ?? DEFAULT_PORT;
				try {
					const started = await RemoteServer.start({
						port,
						snapshot,
						prompt,
						abort: () => ctx?.abort(),
						answerDialog: (id, body) => state.dialogs?.answer(id, body) ?? "unknown",
					});
					state.server = started;
					state.dialogs = new Dialogs((body) => started.emit(body));
				} catch (error) {
					return c.ui.notify(`Remote could not start on 127.0.0.1:${port}: ${(error as Error).message}`, "error");
				}
				const pairing = `pi-remote://pair?url=${encodeURIComponent(state.server.url)}&token=${state.server.token}&v=${PROTOCOL_MAJOR}`;
				c.ui.notify(`Remote is on at ${state.server.url}\nPair with: ${pairing}`, "info");
			} else if (sub === "stop") {
				if (!state.server) return c.ui.notify("Remote is off", "info");
				await stopRemote();
				c.ui.notify("Remote is off; the access token is revoked", "info");
			} else if (sub === "status") {
				c.ui.notify(state.server ? `Remote is on at ${state.server.url} (port ${state.server.port})` : "Remote is off", "info");
			} else {
				c.ui.notify(`Unknown subcommand "${sub}". Use /remote start | stop | status`, "error");
			}
		},
	});
}
