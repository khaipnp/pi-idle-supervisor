import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type EventBody, EventBuffer, type StoredEvent } from "./events.ts";
import type { Snapshot } from "./snapshot.ts";

export const PROTOCOL_VERSION = "1.0";
export const PROTOCOL_MAJOR = PROTOCOL_VERSION.split(".")[0];

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;
const PING_INTERVAL_MS = 15_000;

type ErrorCode =
	| "unauthorized"
	| "rate_limited"
	| "protocol_mismatch"
	| "bad_request"
	| "busy"
	| "dialog_closed"
	| "not_found";

export interface RemoteServerOptions {
	port: number;
	/** Builds the body of GET /v1/snapshot for an authorised request; `seq` is the last event so far. */
	snapshot: (seq: number) => Snapshot;
}

/** HTTP server on 127.0.0.1 that owns the access token, auth checks, lockout and routing. */
export class RemoteServer {
	readonly token = randomBytes(32).toString("base64url");
	private readonly tokenHash = sha256(this.token);
	private readonly events = new EventBuffer();
	private failures: number[] = [];
	private lockedUntil = 0;

	private constructor(
		private readonly server: Server,
		private readonly options: RemoteServerOptions,
	) {}

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
		this.server.closeAllConnections();
		await closed;
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
		if (req.method === "GET" && path === "/v1/snapshot") {
			return sendJson(res, 200, this.options.snapshot(this.events.lastSeq));
		}
		if (req.method === "GET" && path === "/v1/events") return this.stream(req, res);
		sendError(res, 404, "not_found", `No route for ${req.method} ${path}`);
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
		const unsubscribe = this.events.subscribe(write);
		const ping = setInterval(() => res.write(": ping\n\n"), PING_INTERVAL_MS);
		res.on("close", () => {
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

function sha256(text: string): Buffer {
	return createHash("sha256").update(text).digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
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
