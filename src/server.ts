import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type EventBody, EventBuffer, type StoredEvent } from "./events.ts";
import type { DialogAnswerResult } from "./dialogs.ts";
import type { Snapshot } from "./snapshot.ts";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, Uploads, userContent } from "./uploads.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const PROTOCOL_VERSION = "1.1";
export const PROTOCOL_MAJOR = PROTOCOL_VERSION.split(".")[0];

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;
const PING_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 1_000_000;

type ErrorCode =
	| "unauthorized"
	| "rate_limited"
	| "protocol_mismatch"
	| "bad_request"
	| "busy"
	| "dialog_closed"
	| "not_found"
	| "storage_full";

export interface RemoteServerOptions {
	port: number;
	/** Builds the body of GET /v1/snapshot for an authorised request; `seq` is the last event so far. */
	snapshot: (seq: number) => Snapshot;
	/** Sends a prompt. Returns false when the host session is working and `deliverAs` is missing. */
	prompt: (content: string | (TextContent | ImageContent)[], deliverAs: "steer" | "followUp" | undefined) => boolean;
	/** Stops the current run; no-op when settled. */
	abort: () => void;
	/** Applies a remote answer to a pending dialog. */
	answerDialog: (id: string, body: unknown) => DialogAnswerResult;
	/** Called with the number of connected event-stream clients whenever it changes. */
	onClients: (count: number) => void;
}

/** HTTP server on 127.0.0.1 that owns the access token, auth checks, lockout and routing. */
export class RemoteServer {
	readonly token = randomBytes(32).toString("base64url");
	private readonly tokenHash = sha256(this.token);
	private readonly events = new EventBuffer();
	private failures: number[] = [];
	private lockedUntil = 0;
	private detached = false;
	private readonly streams = new Set<ServerResponse>();
	private readonly uploads = new Uploads();

	private constructor(
		private readonly server: Server,
		private options: RemoteServerOptions,
	) {}

	/** Points the server at a new host session's runtime (ADR-0003); token, port and event log are kept. */
	rebind(host: Pick<RemoteServerOptions, "snapshot" | "prompt" | "abort" | "onClients">): void {
		this.options = { ...this.options, ...host };
		this.detached = false;
	}

	/** The host session is going away: until the next `rebind`, requests that need it get 503 busy. */
	detach(): void {
		this.detached = true;
	}

	/** Binds 127.0.0.1:<port>. Rejects (e.g. EADDRINUSE) instead of falling back to another port. */
	static async start(options: RemoteServerOptions): Promise<RemoteServer> {
		const server = createServer();
		const remote = new RemoteServer(server, options);
		server.on("request", (req, res) => remote.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		return remote;
	}

	/** Connected event-stream clients. */
	get clients(): number {
		return this.streams.size;
	}

	get port(): number {
		return (this.server.address() as AddressInfo).port;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Numbers `body` and delivers it to every open event stream. */
	emit(body: EventBody): void {
		this.events.append(body);
	}

	/** Closes the server and every open connection; the token stops working immediately. */
	async stop(): Promise<void> {
		const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
		// End event streams gracefully so a last event (remote_off) is flushed before sockets are cut.
		// A stream whose client is gone never calls back, so also settle on close and cap the wait.
		const ended = [...this.streams].map(
			(res) =>
				new Promise<void>((resolve) => {
					if (res.destroyed) return resolve();
					res.once("close", () => resolve());
					res.end(() => resolve());
				}),
		);
		await Promise.race([Promise.all(ended), new Promise((resolve) => setTimeout(resolve, 1000).unref())]);
		this.server.closeAllConnections();
		await closed;
		await this.uploads.dispose();
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const now = Date.now();
		if (now < this.lockedUntil) {
			res.setHeader("Retry-After", String(Math.ceil((this.lockedUntil - now) / 1000)));
			return sendError(res, 429, "rate_limited", "Too many failed attempts; try again later");
		}
		if (!this.authorised(req.headers.authorization)) {
			this.recordFailure(now);
			return sendError(res, 401, "unauthorized", "Missing or wrong access token");
		}
		const protocol = req.headers["pi-remote-protocol"];
		if (typeof protocol !== "string" || protocol.split(".")[0] !== PROTOCOL_MAJOR) {
			return sendError(res, 426, "protocol_mismatch", `Server speaks protocol ${PROTOCOL_VERSION}`, {
				serverVersion: PROTOCOL_VERSION,
			});
		}

		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (this.detached && path !== "/v1/events") {
			// Between a session shutting down and the next one starting there is no host session to serve.
			return sendError(res, 503, "busy", "The host session is being replaced; retry shortly");
		}
		if (req.method === "GET" && path === "/v1/snapshot") {
			return sendJson(res, 200, this.options.snapshot(this.events.lastSeq));
		}
		if (req.method === "GET" && path === "/v1/events") return this.stream(req, res);
		if (req.method === "POST" && path === "/v1/files") {
			return void this.handleUpload(req, res).catch(() => sendFailure(res));
		}
		if (req.method === "POST" && path === "/v1/prompt") {
			return void this.handlePrompt(req, res).catch(() => sendFailure(res));
		}
		if (req.method === "POST" && path === "/v1/abort") {
			try {
				this.options.abort();
			} catch {
				return sendFailure(res);
			}
			return sendJson(res, 202, {});
		}
		const dialogRoute = path.match(/^\/v1\/dialogs\/([^/]+)\/answer$/);
		if (req.method === "POST" && dialogRoute) {
			return void this.handleDialogAnswer(dialogRoute[1], req, res).catch(() => sendFailure(res));
		}
		sendError(res, 404, "not_found", `No route for ${req.method} ${path}`);
	}

	private async handleDialogAnswer(rawId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		let id = rawId;
		try {
			id = decodeURIComponent(rawId);
		} catch {
			// malformed escape: no dialog can have this id; fall through as unknown
		}
		switch (this.options.answerDialog(id, body)) {
			case "ok":
				return sendJson(res, 200, {});
			case "unknown":
				return sendError(res, 404, "not_found", "No such dialog");
			case "closed":
				return sendError(res, 409, "dialog_closed", "The dialog was already answered or dismissed");
			case "invalid":
				return sendError(res, 400, "bad_request", 'Body must be {"value": boolean | string matching the dialog kind} or {"cancelled": true}');
		}
	}

	private async handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		// SAFETY: body is arbitrary client JSON; every field is validated below before use.
		const { text, deliverAs, attachments } = (typeof body === "object" && body !== null ? body : {}) as {
			text?: unknown;
			deliverAs?: unknown;
			attachments?: unknown;
		};
		const validDeliverAs = deliverAs === undefined || deliverAs === "steer" || deliverAs === "followUp";
		const ids = attachments === undefined ? [] : attachments;
		const validIds =
			Array.isArray(ids) && ids.length <= MAX_ATTACHMENTS && ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length;
		const validText = text === undefined ? validIds && ids.length > 0 : typeof text === "string" && (text !== "" || (validIds && ids.length > 0));
		if (!validText || !validDeliverAs || !validIds) {
			return sendError(
				res,
				400,
				"bad_request",
				`Body must be {"text"?: string, "attachments"?: up to ${MAX_ATTACHMENTS} distinct file ids, "deliverAs"?: "steer" | "followUp"} with text or an attachment`,
			);
		}
		const files = this.uploads.find(ids as string[]);
		if (!files) return sendError(res, 404, "not_found", "An attachment id is unknown");
		if (!this.options.prompt(userContent((text as string | undefined) ?? "", files), deliverAs)) {
			return sendError(res, 409, "busy", "The host session is working; set deliverAs to steer or followUp");
		}
		sendJson(res, 202, {});
	}

	/** Stores the raw request body as a file on the host machine; the name comes from `?name=`, the type from Content-Type. */
	private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const name = new URL(req.url ?? "/", "http://localhost").searchParams.get("name");
		const mimeType = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
		if (!name || !mimeType || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)) {
			await readBytes(req, 0);
			return sendError(res, 400, "bad_request", "Upload needs ?name=<file name> and a Content-Type");
		}
		const data = await readBytes(req, MAX_UPLOAD_BYTES);
		if (!data || data.length === 0) {
			return sendError(res, 400, "bad_request", `Upload must be 1 to ${MAX_UPLOAD_BYTES} bytes`);
		}
		const file = await this.uploads.save(name, mimeType, data);
		if (!file) return sendError(res, 507, "storage_full", "The host has stored too many uploads; turn remote off and on to clear them");
		sendJson(res, 201, { id: file.id, name: file.name, mimeType: file.mimeType, size: file.size });
	}

	/** SSE stream: replays events after the resume point, then continues live. */
	private stream(req: IncomingMessage, res: ServerResponse): void {
		const resumeAt = (req.headers["last-event-id"] as string | undefined) ?? new URL(req.url ?? "/", "http://localhost").searchParams.get("after");
		if (resumeAt !== null && resumeAt !== undefined && !/^\d+$/.test(resumeAt)) {
			return sendError(res, 400, "bad_request", "Last-Event-ID / after must be a non-negative integer");
		}
		// Without a resume point the client only wants what happens from now on.
		const after = resumeAt === null || resumeAt === undefined ? this.events.lastSeq : Number(resumeAt);

		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
		res.flushHeaders(); // otherwise clients wait for the first event before seeing the response
		const write = (event: StoredEvent, withId = true) =>
			res.write(`${withId ? `id: ${event.seq}\n` : ""}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

		// Replay and subscribe in one tick so no event falls between the two.
		const missed = this.events.replay(after);
		if (missed === "resync") {
			// resync is not part of the numbered sequence: it carries no SSE id, so a reconnecting
			// EventSource keeps its old Last-Event-ID instead of adopting one that skips events.
			write({ type: "resync", seq: Math.max(1, this.events.lastSeq) }, false);
			return void res.end();
		}
		for (const event of missed) write(event);
		this.streams.add(res);
		this.options.onClients(this.streams.size);
		const unsubscribe = this.events.subscribe(write);
		const ping = setInterval(() => res.write(": ping\n\n"), PING_INTERVAL_MS);
		res.on("close", () => {
			this.streams.delete(res);
			this.options.onClients(this.streams.size);
			unsubscribe();
			clearInterval(ping);
		});
	}

	private authorised(header: string | undefined): boolean {
		const match = header?.match(/^Bearer (\S+)$/);
		// Compare fixed-length digests so the comparison time does not depend on the guess.
		return match !== null && match !== undefined && timingSafeEqual(sha256(match[1]), this.tokenHash);
	}

	private recordFailure(now: number): void {
		this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
		this.failures.push(now);
		if (this.failures.length >= MAX_FAILURES) {
			this.lockedUntil = now + LOCKOUT_MS;
			this.failures = [];
		}
	}
}

/** Reads a request body of at most `limit` bytes. Returns undefined when it is larger. */
async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	// SAFETY: a request without setEncoding() yields Buffer chunks.
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		// Keep draining instead of returning, so the client gets its 400 rather than a reset connection.
		if (size <= limit) chunks.push(chunk);
	}
	return size > limit ? undefined : Buffer.concat(chunks);
}

/** Reads a JSON request body (max 1 MB). Returns undefined when it is too large or not valid JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
	const bytes = await readBytes(req, MAX_BODY_BYTES);
	if (!bytes) return undefined;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		return undefined;
	}
}

function sha256(text: string): Buffer {
	return createHash("sha256").update(text).digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function sendFailure(res: ServerResponse): void {
	if (res.headersSent) return void res.destroy();
	res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify({ error: { code: "bad_request", message: "Request could not be processed" } }));
}

function sendError(
	res: ServerResponse,
	status: number,
	code: ErrorCode,
	message: string,
	extra: Record<string, string> = {},
): void {
	sendJson(res, status, { error: { code, message, ...extra } });
}
