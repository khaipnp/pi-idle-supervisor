import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderUnicodeCompact } from "uqr";
import { Dialogs, wrapDialogs } from "./dialogs.ts";
import { clientsLabel, lanAddress, pairingString, probeTailscale, type PublicUrl, resolvePublicUrl } from "./pairing.ts";
import { wrapNotify } from "./notices.ts";
import { type CommandInfo, type DeliverAs, type PromptResult, RemoteServer } from "./server.ts";
import { hostSessionOf, nextMessageId, toMessage, toSnapshot, toolUpdateText } from "./snapshot.ts";
import { startSshTunnel, type Tunnel } from "./tunnel.ts";

const DEFAULT_PORT = 7878;
const REMOTE_COMMAND = "remote";
/** How long the server waits for a replacement session before giving up and turning remote off. */
export const REPLACEMENT_TIMEOUT_MS = 30_000;

interface RemoteSettings {
	port?: number;
	publicUrl?: string;
	/** "ssh" opens a localhost.run tunnel. Unset: use `publicUrl` or Tailscale. */
	tunnel?: string;
}

/** Pi renames colliding commands to `remote:1`, `remote:2`, so treat those as ours too rather than guess. */
function isRemoteCommand(name: string): boolean {
	return name === REMOTE_COMMAND || name.startsWith(`${REMOTE_COMMAND}:`);
}

/** How the phone reaches the server. "auto": --url, then publicUrl, then Tailscale if running, then localhost. */
type Mode = "auto" | "lan" | "tailscale" | "ssh";

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
	warnedUiWrap?: boolean;
	stopping?: Promise<void>;
	/** Where clients reach the server: a tunnel URL, or the LAN address the server listens on. */
	publicUrl?: string;
	/** The tunnel this extension opened for the server, if any; it lives and dies with the server. */
	tunnel?: Tunnel;
	replacementTimer?: ReturnType<typeof setTimeout>;
}
const SHARED_KEY = Symbol.for("pi-idle-supervisor.remote");
function shared(): Shared {
	// SAFETY: only this extension writes SHARED_KEY on globalThis, and always a Shared.
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
		const dialogsWrapped = wrapDialogs(c.ui, () => state.dialogs);
		const noticesWrapped = wrapNotify(c.ui, (message, level) => {
			// The pairing notification carries the access token; clients must never see it.
			if (state.server && !message.includes(state.server.token)) emit({ type: "notice", message, level });
		});
		if (!(dialogsWrapped && noticesWrapped) && !state.warnedUiWrap) {
			state.warnedUiWrap = true;
			c.ui.notify("Remote dialogs or notices are unavailable: this Pi version's UI context is not what pi-idle-supervisor expects.", "warning");
		}
		// A previous runtime left the server running (/new, /resume, /fork, reload): take it over.
		clearTimeout(state.replacementTimer);
		if (state.server) {
			state.server.rebind({ snapshot, prompt, commands, abort: () => ctx?.abort(), onClients: refreshFooter });
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

	/**
	 * Handles remote text like the terminal does: `/name args` runs an extension command (at once,
	 * even while working), and prompt templates and `/skill:` commands expand. Anything else is a prompt.
	 */
	function prompt(content: Parameters<typeof pi.sendUserMessage>[0], deliverAs: DeliverAs | undefined): PromptResult {
		const text = typeof content === "string" ? content : content.find((part) => part.type === "text")?.text ?? "";
		// Pi takes the name up to the first space, so match that exactly.
		const name = text.startsWith("/") ? text.slice(1).split(" ", 1)[0] : undefined;
		// Stopping or restarting remote from the phone would cut off the phone itself.
		if (name !== undefined && isRemoteCommand(name)) {
			return { rejected: `/${REMOTE_COMMAND} can only be run on the host terminal` };
		}
		const isExtensionCommand = name !== undefined && pi.getCommands().some((c) => c.source === "extension" && c.name === name);
		// Pi passes a command only the text, so attachments would be dropped or end up in its arguments.
		if (isExtensionCommand && typeof content !== "string") return { rejected: "A slash command cannot have attachments" };
		// Same state as the snapshot. Settled: Pi starts a run and ignores deliverAs, but if a run started
		// after `working` was read (typed on the terminal, say), followUp queues this instead of Pi dropping it.
		if (working && !deliverAs && !isExtensionCommand) return "busy";
		pi.sendUserMessage(content, { deliverAs: working ? deliverAs : "followUp", expandPromptTemplates: true });
		return "sent";
	}

	/** What a remote client may send as `/name`: everything Pi lists except /remote, which is terminal-only. */
	function commands(): CommandInfo[] {
		return pi
			.getCommands()
			.filter((c) => !isRemoteCommand(c.name))
			.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), source: c.source }));
	}

	/** Ways a phone can reach the server, as offered by `/remote` with no arguments. */
	const PICKS: Record<Exclude<Mode, "auto">, string> = {
		lan: "LAN: devices on the same Wi-Fi or network (plain http, no setup)",
		tailscale: "Tailscale: devices signed in to your tailnet (needs tailscale serve)",
		ssh: "Tunnel: a public address through localhost.run (relayed, no setup)",
	};

	function showStatus(c: ExtensionContext) {
		c.ui.notify(
			state.server
				? `Remote is on at ${state.publicUrl} (port ${state.server.port}, ${clientsLabel(state.server.clients)})`
				: "Remote is off",
			"info",
		);
	}

	async function startRemote(c: ExtensionContext, mode: Mode, flag: string | undefined, settings: RemoteSettings) {
		const port = settings.port ?? DEFAULT_PORT;
		let host = "127.0.0.1";
		if (mode === "lan") {
			const address = lanAddress();
			if (!address) return c.ui.notify("Remote not started: this machine has no private network address. Connect to Wi-Fi or Ethernet first.", "error");
			host = address;
		}
		let started: RemoteServer;
		try {
			started = await RemoteServer.start({
				host,
				port,
				snapshot,
				prompt,
				commands,
				abort: () => ctx?.abort(),
				answerDialog: (id, body) => state.dialogs?.answer(id, body) ?? "unknown",
				onClients: refreshFooter,
			});
		} catch (error) {
			// SAFETY: server.start(), the tunnel and resolvePublicUrl reject with Error instances; `code` is optional.
			const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
			const why = busy ? `port ${port} is already in use; change remote.port in settings or stop the other process` : (error as Error).message;
			return c.ui.notify(`Remote could not start on ${host}:${port}: ${why}`, "error");
		}
		// Publish the running server at once: a second start or a quit during the URL probe must see it.
		state.server = started;
		state.dialogs = new Dialogs((body) => started.emit(body));
		let publicUrl: PublicUrl & { viaSsh?: boolean; viaLan?: boolean };
		let tunnel: Tunnel | undefined;
		try {
			if (mode === "ssh") {
				c.ui.notify("Opening a localhost.run tunnel over ssh...", "info");
				tunnel = await startSshTunnel({ port: started.port });
				publicUrl = { url: tunnel.url, localOnly: false, viaSsh: true };
			} else if (mode === "lan") {
				publicUrl = { url: `http://${host}:${started.port}`, localOnly: false, viaLan: true };
			} else if (mode === "tailscale") {
				const url = await probeTailscale();
				if (!url) throw new Error("Tailscale is not installed or not running on this machine. Turn it on, or pick another way to connect.");
				publicUrl = { url, localOnly: false, viaTailscale: true };
			} else {
				publicUrl = await resolvePublicUrl({ flag, setting: settings.publicUrl, port: started.port });
			}
		} catch (error) {
			await stopRemote();
			// SAFETY: server.start(), the tunnel and resolvePublicUrl reject with Error instances.
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
			warning = "\nWarning: no tunnel URL found, so only this machine can connect. Run /remote to pick LAN, Tailscale or a tunnel, or set remote.publicUrl.";
		} else if (publicUrl.viaLan) {
			warning = "\nNote: LAN mode uses plain http. Anyone on this network who captures the traffic can read the conversation and the access token, so use it only on a network you trust. The phone must be on the same network.";
		} else if (publicUrl.viaSsh) {
			warning = "\nNote: localhost.run relays this traffic and can read it, and the address changes after a few hours. For private work use Tailscale.";
		} else if (publicUrl.viaTailscale) {
			warning = `\nNote: URL taken from Tailscale MagicDNS; make sure it forwards here (tailscale serve --bg ${started.port}).`;
		}
		c.ui.notify(`Remote is on at ${publicUrl.url}${warning}\n${renderUnicodeCompact(pairing)}\nPair with: ${pairing}`, "info");
	}

	pi.registerCommand(REMOTE_COMMAND, {
		description: "Remote control: /remote (pick how to connect) | start [--lan | --tailscale | --tunnel ssh | --url <https url>] | stop | status",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "status"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, c) => {
			ctx = c;
			const sub = args.trim().split(/\s+/)[0];
			// SAFETY: `remote` is this extension's own settings key, documented in README.md as RemoteSettings.
			const settings = (pi.getSettings() as { remote?: RemoteSettings }).remote ?? {};
			if (!sub) {
				await state.stopping;
				if (state.server || !c.hasUI) return showStatus(c);
				const choice = await c.ui.select("Turn remote on. How will your phone connect?", Object.values(PICKS));
				// SAFETY: Object.keys of an object literal returns exactly its keys.
				const mode = (Object.keys(PICKS) as (keyof typeof PICKS)[]).find((key) => PICKS[key] === choice);
				if (!mode || state.server) return;
				return startRemote(c, mode, undefined, settings);
			}
			if (sub === "start") {
				await state.stopping;
				if (state.server) return c.ui.notify(`Remote is already on at ${state.publicUrl ?? state.server.url}`, "warning");
				const flag = flagValue(args, "url");
				if (flag === "") return c.ui.notify("Usage: /remote start --url <https url>", "error");
				const tunnelFlag = flagValue(args, "tunnel");
				if (tunnelFlag !== undefined && tunnelFlag !== "ssh") return c.ui.notify("Usage: /remote start --tunnel ssh", "error");
				const tokens = args.trim().split(/\s+/);
				const lan = tokens.includes("--lan");
				const tailscale = tokens.includes("--tailscale");
				const chosen = [flag !== undefined && "--url", tunnelFlag !== undefined && "--tunnel", lan && "--lan", tailscale && "--tailscale"].filter(Boolean);
				if (chosen.length > 1) return c.ui.notify(`Use only one of ${chosen.join(", ")}`, "error");
				if (settings.tunnel !== undefined && settings.tunnel !== "ssh") {
					return c.ui.notify(`remote.tunnel must be "ssh", got "${settings.tunnel}"`, "error");
				}
				// A choice typed now beats the settings; an explicit URL (flag or setting) beats a tunnel setting.
				const tunnelSetting = flag === undefined && !settings.publicUrl && settings.tunnel === "ssh";
				const mode: Mode = lan ? "lan" : tailscale ? "tailscale" : tunnelFlag === "ssh" || tunnelSetting ? "ssh" : "auto";
				return startRemote(c, mode, flag, settings);
			}
			if (sub === "stop") {
				if (!state.server) return c.ui.notify("Remote is off", "info");
				await stopRemote();
				return c.ui.notify("Remote is off; the access token is revoked", "info");
			}
			if (sub === "status") return showStatus(c);
			c.ui.notify(`Unknown subcommand "${sub}". Use /remote, or /remote start | stop | status`, "error");
		},
	});
}
