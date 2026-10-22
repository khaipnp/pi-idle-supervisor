import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type FauxProviderHandle, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../schema/protocol.schema.json" with { type: "json" };
import extension from "../src/extension.ts";

const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);

/** Throws when `body` does not match `$defs/<def>` in schema/protocol.schema.json. */
export function assertSchema(def: string, body: unknown): void {
	const validate = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
	if (!validate) throw new Error(`no schema def ${def}`);
	if (!validate(body)) throw new Error(`${def} invalid: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body)}`);
}

export interface Notification {
	message: string;
	type?: "info" | "warning" | "error";
}

/** A dialog shown on the fake terminal; `answer` is what the person would pick. */
export interface TerminalDialog {
	kind: "select" | "confirm" | "input";
	title: string;
	signal: AbortSignal | undefined;
	answer(value: string | boolean | undefined): void;
}

export interface Host {
	/** Dialogs the extension host (or the wrapper) opened on the terminal, oldest first. */
	terminalDialogs: TerminalDialog[];
	session: AgentSession;
	faux: FauxProviderHandle;
	/** Everything the extension showed with ctx.ui.notify, oldest first. */
	notifications: Notification[];
	/** Type a line into the terminal, e.g. "/remote start". */
	type(line: string): Promise<void>;
	/** Run `/remote start` and return the base URL and token parsed from the pairing string. */
	startRemote(): Promise<{ url: string; token: string }>;
	dispose(): Promise<void>;
}

export async function createHost(options: { tools?: ToolDefinition[] } = {}): Promise<Host> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-remote-test-"));
	const agentDir = join(cwd, "agent");
	const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [extension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ remote: { port: 0 } } as object),
		noTools: "builtin",
		customTools: options.tools,
	});

	const notifications: Notification[] = [];
	const terminalDialogs: TerminalDialog[] = [];
	// Like Pi's real dialogs: resolves with the answer, or with the cancel value when the signal aborts.
	const open = <T>(kind: TerminalDialog["kind"], title: string, opts: { signal?: AbortSignal } | undefined, cancelled: T) =>
		new Promise<T>((resolve) => {
			// SAFETY: the dialog kind fixes the answer type T.
			const answer = (value: string | boolean | undefined) => resolve(value as T);
			terminalDialogs.push({ kind, title, signal: opts?.signal, answer });
			opts?.signal?.addEventListener("abort", () => resolve(cancelled), { once: true });
		});
	const terminal: Partial<ExtensionUIContext> = {
		select: (title, _options, opts) => open<string | undefined>("select", title, opts, undefined),
		confirm: (title, _message, opts) => open<boolean>("confirm", title, opts, false),
		input: (title, _placeholder, opts) => open<string | undefined>("input", title, opts, undefined),
		notify: (message, type) => notifications.push({ message, type }),
		setStatus: () => {},
	};
	await session.bindExtensions({ uiContext: terminal as ExtensionUIContext });

	const host: Host = {
		session,
		faux,
		notifications,
		terminalDialogs,
		type: (line) => session.prompt(line),
		async startRemote() {
			const before = notifications.length;
			await host.type("/remote start");
			const pairing = notifications
				.slice(before)
				.map((n) => n.message.match(/pi-remote:\/\/pair\?\S+/)?.[0])
				.find(Boolean);
			if (!pairing) throw new Error(`no pairing string in ${JSON.stringify(notifications.slice(before))}`);
			const params = new URL(pairing).searchParams;
			return { url: params.get("url")!, token: params.get("token")! };
		},
		async dispose() {
			await host.type("/remote stop");
			session.dispose();
		},
	};
	return host;
}

/** A remote client request with the documented headers, overridable per call. */
export function remoteGet(url: string, path: string, headers: Record<string, string | undefined>): Promise<Response> {
	const defined = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string>;
	return fetch(url + path, { headers: defined });
}

export function clientHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Pi-Remote-Protocol": "1.0" };
}

export interface SseEvent {
	id: string;
	event: string;
	data: { seq: number; type: string; [key: string]: unknown };
}

export interface EventStream {
	/** Everything received so far, oldest first. */
	events: SseEvent[];
	/** Raw SSE comment lines (": ping") received so far. */
	comments: string[];
	/** Resolves once at least `count` events have arrived. */
	waitFor(count: number): Promise<SseEvent[]>;
	/** Resolves when an event of this type has arrived. */
	waitForType(type: string): Promise<SseEvent>;
	close(): void;
}

/** Opens GET /v1/events like a remote client. Events are validated against $defs/Event as they arrive. */
export async function openEvents(
	url: string,
	token: string,
	options: { lastEventId?: number; after?: number } = {},
): Promise<EventStream> {
	const headers: Record<string, string> = clientHeaders(token);
	if (options.lastEventId !== undefined) headers["Last-Event-ID"] = String(options.lastEventId);
	const controller = new AbortController();
	const query = options.after === undefined ? "" : `?after=${options.after}`;
	const res = await fetch(`${url}/v1/events${query}`, { headers, signal: controller.signal });
	if (res.status !== 200) throw new Error(`events: HTTP ${res.status} ${await res.text()}`);

	const events: SseEvent[] = [];
	const comments: string[] = [];
	const waiters: Array<() => void> = [];
	const pump = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of res.body!) {
				buffer += decoder.decode(chunk, { stream: true });
				let end: number;
				while ((end = buffer.indexOf("\n\n")) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (block.startsWith(":")) comments.push(block);
					else {
						const field = (name: string) => block.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "";
						const data = JSON.parse(field("data"));
						assertSchema("Event", data);
						events.push({ id: field("id"), event: field("event"), data });
					}
					for (const wake of waiters.splice(0)) wake();
				}
			}
		} catch {
			// aborted by close()
		}
	})();
	void pump;

	const until = async (done: () => boolean) => {
		while (!done()) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(events.map((e) => e.data.type))}`)), 5000);
				waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	};
	return {
		events,
		comments,
		async waitFor(count) {
			await until(() => events.length >= count);
			return events;
		},
		async waitForType(type) {
			await until(() => events.some((e) => e.event === type));
			return events.find((e) => e.event === type)!;
		},
		close: () => controller.abort(),
	};
}

/** A remote client POST with the documented headers. `body` is sent as JSON unless it is a string (sent raw). */
export function remotePost(url: string, path: string, token: string, body?: unknown): Promise<Response> {
	const raw = typeof body === "string" ? body : JSON.stringify(body ?? {});
	return fetch(url + path, { method: "POST", headers: { ...clientHeaders(token), "Content-Type": "application/json" }, body: raw });
}
