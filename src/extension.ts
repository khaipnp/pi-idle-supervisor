import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderUnicodeCompact } from "uqr";
import { Dialogs, wrapDialogs } from "./dialogs.ts";
import { clientsLabel, pairingString, resolvePublicUrl } from "./pairing.ts";
import { RemoteServer } from "./server.ts";
import { hostSessionOf, nextMessageId, toMessage, toSnapshot, toolUpdateText } from "./snapshot.ts";
import { startSshTunnel, type Tunnel } from "./tunnel.ts";

const DEFAULT_PORT = 7878;
/** How long the server waits for a replacement session before giving up and turning remote off. */
export const REPLACEMENT_TIMEOUT_MS = 30_000;

interface RemoteSettings {
	port?: number;
	publicUrl?: string;
	/** "ssh" opens a localhost.run tunnel. Unset: use `publicUrl` or Tailscale. */
	tunnel?: string;
}

/** Value of `--name <value>` or `--name=<value>`; `""` when the flag has no value, undefined when absent. */
function flagValue(args: string, name: string): string | undefined {
	const tokens = args.trim().split(/\s+/);
	for (const [i, token] of tokens.entries()) {
		if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
		if (token === `--${name}`) {
			const next = tokens[i + 1];
			return next && !next.startsWith("--") ? next : "";
		}
	}
	return undefined;
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
	/** Where clients reach the server (tunnel URL); the server itself only knows 127.0.0.1. */
	publicUrl?: string;
	/** The tunnel this extension opened for the server, if any; it lives and dies with the server. */
	tunnel?: Tunnel;
	replacementTimer?: ReturnType<typeof setTimeout>;
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

	const FOOTER_KEY = "remote";
	/** Footer shows remote state and client count; undefined clears it. */
	const refreshFooter = () => {
		const { server } = state;
		const text = server ? `📡 remote · ${clientsLabel(server.clients)}` : undefined;
		if (!retired) ctx?.ui.setStatus(FOOTER_KEY, text);
	};

	pi.on("session_start", (_event, c) => {
		ctx = c;
		// Wrapping depends on how Pi builds ctx.ui (ADR-0001); if that changed, remote still works minus dialogs.
		if (!wrapDialogs(c.ui, () => state.dialogs) && !state.warnedDialogs) {
			state.warnedDialogs = true;
			c.ui.notify("Remote dialogs are unavailable: this Pi version's UI context is not what pi-idle-supervisor expects.", "warning");
		}
		// A previous runtime left the server running (/new, /resume, /fork, reload): take it over.
		clearTimeout(state.replacementTimer);
		if (state.server) {
			state.server.rebind({ snapshot, prompt, abort: () => ctx?.abort(), onClients: refreshFooter });
			refreshFooter();
			if (state.tunnel) {
				state.tunnel.onClose = onTunnelClose;
				if (state.tunnel.closedReason) onTunnelClose(state.tunnel.closedReason); // it ended between sessions
			}
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
		if (!state.server) return;
		state.server.detach();
		// If no session_start follows (a failed /resume, say), clients must not wait on 503 forever.
		clearTimeout(state.replacementTimer);
		state.replacementTimer = setTimeout(() => void stopRemote(), REPLACEMENT_TIMEOUT_MS);
		state.replacementTimer.unref();
	});

	/** Idempotent and awaitable: a second caller waits for the stop already in progress. */
	function stopRemote(): Promise<void> {
		const { server, dialogs } = state;
		if (!server) return state.stopping ?? Promise.resolve();
		clearTimeout(state.replacementTimer);
		state.tunnel?.stop();
		state.server = state.dialogs = state.publicUrl = state.tunnel = undefined;
		refreshFooter();
		dialogs?.dispose();
		server.emit({ type: "remote_off" });
		return (state.stopping = server.stop().finally(() => (state.stopping = undefined)));
	}

	/** A tunnel that ends on its own gets a new URL when restarted, so remote turns off and the old QR code dies with it. */
	function onTunnelClose(reason: string) {
		if (retired) return;
		void stopRemote();
		ctx?.ui.notify(`Remote turned off: the tunnel ended (${reason}). Run /remote start for a new address and QR code.`, "warning");
	}

	function snapshot(seq: number) {
		return toSnapshot(ctx!.sessionManager, working ? "working" : "settled", seq, state.dialogs?.list() ?? []);
	}

	function prompt(content: Parameters<typeof pi.sendUserMessage>[0], deliverAs: "steer" | "followUp" | undefined): boolean {
		// Same state as the snapshot: settled starts a run and ignores deliverAs.
		if (!working) pi.sendUserMessage(content);
		else if (deliverAs) pi.sendUserMessage(content, { deliverAs });
		else return false;
		return true;
	}

	pi.registerCommand("remote", {
		description: "Remote control: /remote start [--url <public url> | --tunnel ssh] | stop | status",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "status"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, c) => {
			ctx = c;
			const sub = args.trim().split(/\s+/)[0] || "status";
			if (sub === "start") {
				await state.stopping;
				if (state.server) return c.ui.notify(`Remote is already on at ${state.publicUrl ?? state.server.url}`, "warning");
				const settings = (pi.getSettings() as { remote?: RemoteSettings }).remote ?? {};
				const port = settings.port ?? DEFAULT_PORT;
				const flag = flagValue(args, "url");
				if (flag === "") return c.ui.notify("Usage: /remote start --url <https url>", "error");
				const tunnelFlag = flagValue(args, "tunnel");
				if (tunnelFlag !== undefined && tunnelFlag !== "ssh") return c.ui.notify("Usage: /remote start --tunnel ssh", "error");
				if (flag !== undefined && tunnelFlag !== undefined) return c.ui.notify("Use either --url or --tunnel, not both", "error");
				if (settings.tunnel !== undefined && settings.tunnel !== "ssh") {
					return c.ui.notify(`remote.tunnel must be "ssh", got "${settings.tunnel}"`, "error");
				}
				// An address typed now beats the settings; an explicit URL (flag or setting) beats a tunnel setting.
				const useTunnel = flag === undefined && (tunnelFlag ?? (settings.publicUrl ? undefined : settings.tunnel)) === "ssh";
				let started: RemoteServer;
				try {
					started = await RemoteServer.start({
						port,
						snapshot,
						prompt,
						abort: () => ctx?.abort(),
						answerDialog: (id, body) => state.dialogs?.answer(id, body) ?? "unknown",
						onClients: refreshFooter,
					});
				} catch (error) {
					const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
					const why = busy ? `port ${port} is already in use; change remote.port in settings or stop the other process` : (error as Error).message;
					return c.ui.notify(`Remote could not start on 127.0.0.1:${port}: ${why}`, "error");
				}
				// Publish the running server at once: a second start or a quit during the URL probe must see it.
				state.server = started;
				state.dialogs = new Dialogs((body) => started.emit(body));
				let publicUrl: Awaited<ReturnType<typeof resolvePublicUrl>> & { viaSsh?: boolean };
				let tunnel: Tunnel | undefined;
				try {
					if (useTunnel) {
						c.ui.notify("Opening a localhost.run tunnel over ssh...", "info");
						tunnel = await startSshTunnel({ port: started.port });
						publicUrl = { url: tunnel.url, localOnly: false, viaSsh: true };
					} else {
						publicUrl = await resolvePublicUrl({ flag, setting: settings.publicUrl, port: started.port });
					}
				} catch (error) {
					await stopRemote();
					return c.ui.notify(`Remote not started: ${(error as Error).message}`, "error");
				}
				if (state.server !== started) return tunnel?.stop(); // stopped while resolving
				if (tunnel) {
					state.tunnel = tunnel;
					tunnel.onClose = onTunnelClose;
					if (tunnel.closedReason) return onTunnelClose(tunnel.closedReason);
				}
				state.publicUrl = publicUrl.url;
				refreshFooter();
				const pairing = pairingString(publicUrl.url, started.token);
				let warning = "";
				if (publicUrl.localOnly) {
					warning = "\nWarning: no tunnel URL found, so only this machine can connect. Use --tunnel ssh, --url, the publicUrl setting, or Tailscale.";
				} else if (publicUrl.viaSsh) {
					warning = "\nNote: localhost.run relays this traffic and can read it, and the address changes after a few hours. For private work use Tailscale.";
				} else if (publicUrl.viaTailscale) {
					warning = `\nNote: URL taken from Tailscale MagicDNS; make sure it forwards here (tailscale serve --bg ${started.port}).`;
				}
				c.ui.notify(`Remote is on at ${publicUrl.url}${warning}\n${renderUnicodeCompact(pairing)}\nPair with: ${pairing}`, "info");
			} else if (sub === "stop") {
				if (!state.server) return c.ui.notify("Remote is off", "info");
				await stopRemote();
				c.ui.notify("Remote is off; the access token is revoked", "info");
			} else if (sub === "status") {
				c.ui.notify(
					state.server
						? `Remote is on at ${state.publicUrl} (port ${state.server.port}, ${clientsLabel(state.server.clients)})`
						: "Remote is off",
					"info",
				);
			} else {
				c.ui.notify(`Unknown subcommand "${sub}". Use /remote start | stop | status`, "error");
			}
		},
	});
}
