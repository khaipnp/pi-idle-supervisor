import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Snapshot } from "./snapshot.ts";

export const PROTOCOL_VERSION = "1.0";
export const PROTOCOL_MAJOR = PROTOCOL_VERSION.split(".")[0];

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;

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
	/** Builds the body of GET /v1/snapshot for an authorised request. */
	snapshot: () => Snapshot;
}

/** HTTP server on 127.0.0.1 that owns the access token, auth checks, lockout and routing. */
export class RemoteServer {
	readonly token = randomBytes(32).toString("base64url");
	private readonly tokenHash = sha256(this.token);
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
		if (req.method === "GET" && path === "/v1/snapshot") return sendJson(res, 200, this.options.snapshot());
		sendError(res, 404, "not_found", `No route for ${req.method} ${path}`);
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
