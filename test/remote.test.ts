import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertSchema, clientHeaders, createHost, type Host, openEvents, remoteGet } from "./harness.ts";

async function expectError(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
	expect(res.status).toBe(status);
	const body = await res.json();
	assertSchema("Error", body);
	expect(body.error.code).toBe(code);
	return body.error;
}

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("remote on/off", () => {
	test("a paired client can fetch a snapshot of an empty host session", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();

		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const res = await remoteGet(url, "/v1/snapshot", clientHeaders(token));
		expect(res.status).toBe(200);
		const body = await res.json();
		assertSchema("Snapshot", body);
		expect(body).toMatchObject({
			protocolVersion: "1.0",
			hostSession: { id: host.session.sessionManager.getSessionId(), cwd: host.session.sessionManager.getCwd() },
			status: "settled",
			messages: [],
			dialogs: [],
		});
	});

	test("/remote status reports on/off, URL and port", async () => {
		host = await createHost();
		await host.type("/remote status");
		expect(host.notifications.at(-1)?.message).toMatch(/off/);

		const { url } = await host.startRemote();
		await host.type("/remote status");
		const status = host.notifications.at(-1)!.message;
		expect(status).toContain(url);
		expect(status).toContain(`port ${new URL(url).port}`);
	});

	test("/remote stop closes the server and revokes the token", async () => {
		host = await createHost();
		const first = await host.startRemote();
		await host.type("/remote stop");

		await expect(remoteGet(first.url, "/v1/snapshot", clientHeaders(first.token))).rejects.toThrow();

		const second = await host.startRemote();
		expect(second.token).not.toBe(first.token);
		await expectError(await remoteGet(second.url, "/v1/snapshot", clientHeaders(first.token)), 401, "unauthorized");
		expect((await remoteGet(second.url, "/v1/snapshot", clientHeaders(second.token))).status).toBe(200);
	});
});

describe("request checks", () => {
	test("a missing or wrong token gets 401, checked before the protocol header", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();

		await expectError(await remoteGet(url, "/v1/snapshot", { "Pi-Remote-Protocol": "1.0" }), 401, "unauthorized");
		await expectError(await remoteGet(url, "/v1/snapshot", clientHeaders(token + "x")), 401, "unauthorized");
		await expectError(await remoteGet(url, "/v1/snapshot", { Authorization: "Bearer nope" }), 401, "unauthorized");
	});

	test("a missing or major-mismatched protocol header gets 426 with serverVersion", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();

		for (const protocol of [undefined, "2.0", "0.9"]) {
			const headers = { ...clientHeaders(token), "Pi-Remote-Protocol": protocol };
			const error = await expectError(await remoteGet(url, "/v1/snapshot", headers), 426, "protocol_mismatch");
			expect(error.serverVersion).toBe("1.0");
		}
		// A newer minor version is still compatible.
		expect((await remoteGet(url, "/v1/snapshot", { ...clientHeaders(token), "Pi-Remote-Protocol": "1.7" })).status).toBe(200);
	});

	test("ten failures lock out every client, even with the right token, with Retry-After", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();

		for (let i = 0; i < 9; i++) {
			await expectError(await remoteGet(url, "/v1/snapshot", clientHeaders("wrong")), 401, "unauthorized");
		}
		expect((await remoteGet(url, "/v1/snapshot", clientHeaders(token))).status).toBe(200);
		await expectError(await remoteGet(url, "/v1/snapshot", clientHeaders("wrong")), 401, "unauthorized");

		const locked = await remoteGet(url, "/v1/snapshot", clientHeaders(token));
		await expectError(locked, 429, "rate_limited");
		const retryAfter = Number(locked.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(60);
	});

	test("an unknown path gets 404 not_found", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		await expectError(await remoteGet(url, "/v1/nope", clientHeaders(token)), 404, "not_found");
	});
});

describe("snapshot", () => {
	const bigOutput = "€".repeat(6000); // 3 bytes each: 18000 bytes, and 16384 is not a multiple of 3
	const dump: ToolDefinition = {
		name: "dump",
		label: "Dump",
		description: "Prints a lot",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: bigOutput }], details: {} }),
	};

	test("contains the active branch as protocol messages, with tool output truncated on a character boundary", async () => {
		host = await createHost({ tools: [dump] });
		host.faux.setResponses([
			fauxAssistantMessage([fauxThinking("let me look"), fauxToolCall("dump", { n: 1 }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxText("done")),
		]);
		await host.session.prompt("show me", { images: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", mimeType: "image/png" }] });
		const { url, token } = await host.startRemote();

		const body = await (await remoteGet(url, "/v1/snapshot", clientHeaders(token))).json();
		assertSchema("Snapshot", body);
		expect(body.status).toBe("settled");
		expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const [user, call, result, reply] = body.messages;
		expect(user.content).toEqual([
			{ type: "text", text: "show me" },
			{ type: "image", mimeType: "image/png" },
		]);
		expect(call.content).toEqual([
			{ type: "thinking", text: "let me look" },
			{ type: "toolCall", id: "call-1", name: "dump", arguments: { n: 1 } },
		]);
		expect(result).toMatchObject({ toolCallId: "call-1", toolName: "dump", isError: false });
		expect(result.content).toEqual([
			{ type: "text", text: "€".repeat(5461), truncated: true, originalBytes: 18000 },
		]);
		expect(reply.content).toEqual([{ type: "text", text: "done" }]);

		// Ids are stable across snapshots.
		const again = await (await remoteGet(url, "/v1/snapshot", clientHeaders(token))).json();
		expect(again.messages.map((m: { id: string }) => m.id)).toEqual(body.messages.map((m: { id: string }) => m.id));
		expect(new Set(body.messages.map((m: { id: string }) => m.id)).size).toBe(4);
	});
});

describe("event stream", () => {
	const echo: ToolDefinition = {
		name: "echo",
		label: "Echo",
		description: "Streams two updates",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "half" }], details: {} });
			return { content: [{ type: "text", text: "whole" }], details: {} };
		},
	};
	const script = () => [
		fauxAssistantMessage([fauxThinking("hmm"), fauxToolCall("echo", {}, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("done")),
	];
	const types = (events: Array<{ event: string }>) => events.map((e) => e.event);

	test("a terminal prompt produces the documented sequence ending in settled", async () => {
		host = await createHost({ tools: [echo] });
		host.faux.setResponses(script());
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token, { after: 0 });

		await host.type("go");
		await stream.waitForType("settled");

		expect(types(stream.events)).toEqual([
			"status",
			"message_start", "message_end", // user
			"message_start", "message_delta", "message_end", // assistant: thinking + tool call
			"tool_start", "tool_update", "tool_end",
			"message_start", "message_end", // toolResult
			"message_start", "message_delta", "message_end", // assistant: "done"
			"settled",
		].filter(Boolean));
	});

	test("event ids increase by one, streamed text and tool output are carried, snapshot seq matches the last event", async () => {
		host = await createHost({ tools: [echo] });
		host.faux.setResponses(script());
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token, { after: 0 });
		await host.type("go");
		await stream.waitForType("settled");

		expect(stream.events.map((e) => Number(e.id))).toEqual(stream.events.map((_, i) => i + 1));
		const find = (type: string) => stream.events.find((e) => e.event === type)!.data;
		expect(find("message_delta")).toMatchObject({ blockIndex: 0, kind: "thinking", delta: "hmm" });
		expect(find("tool_start")).toMatchObject({ toolCallId: "call-1", toolName: "echo" });
		expect(find("tool_update")).toMatchObject({ toolCallId: "call-1", text: "half" });
		expect(find("tool_end")).toMatchObject({ toolCallId: "call-1", isError: false });

		const snapshot = await (await remoteGet(url, "/v1/snapshot", clientHeaders(token))).json();
		expect(snapshot.seq).toBe(stream.events.length);
		// message_end carries the same ids the snapshot uses.
		const ended = stream.events.filter((e) => e.event === "message_end").map((e) => (e.data.message as { id: string }).id);
		expect(ended).toEqual(snapshot.messages.map((m: { id: string }) => m.id));
		stream.close();
	});

	test("tool_update text is cut at 16 KB on a character boundary", async () => {
		const big: ToolDefinition = {
			...echo,
			name: "big",
			execute: async (_id, _params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "\u20ac".repeat(6000) }], details: {} });
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		host = await createHost({ tools: [big] });
		host.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}, { id: "c" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("done")),
		]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token, { after: 0 });
		await host.type("go");
		const update = await stream.waitForType("tool_update");
		expect(update.data).toMatchObject({ text: "\u20ac".repeat(5461), truncated: true, originalBytes: 18000 });
		stream.close();
	});

	test("a reconnecting client receives exactly the events it missed, via header or ?after=", async () => {
		host = await createHost({ tools: [echo] });
		host.faux.setResponses(script());
		const { url, token } = await host.startRemote();
		const first = await openEvents(url, token, { after: 0 });
		await host.type("go");
		await first.waitForType("settled");
		first.close();
		const all = first.events;

		const viaHeader = await openEvents(url, token, { lastEventId: 5 });
		await viaHeader.waitFor(all.length - 5);
		expect(viaHeader.events.map((e) => e.data)).toEqual(all.slice(5).map((e) => e.data));
		viaHeader.close();

		const viaQuery = await openEvents(url, token, { after: all.length - 1 });
		await viaQuery.waitFor(1);
		expect(viaQuery.events.map((e) => e.data)).toEqual(all.slice(-1).map((e) => e.data));
		viaQuery.close();
	});

	test("a client without a resume point only sees new events, and several clients can stream at once", async () => {
		host = await createHost({ tools: [echo] });
		host.faux.setResponses(script());
		const { url, token } = await host.startRemote();
		const a = await openEvents(url, token);
		const b = await openEvents(url, token);
		await host.type("go");
		await a.waitForType("settled");
		await b.waitForType("settled");
		expect(a.events.map((e) => e.data)).toEqual(b.events.map((e) => e.data));
		expect(a.events[0].data.seq).toBe(1);
		a.close();
		b.close();
	});

	test("a resume point older than the last 5000 events, or from the future, gets a single resync", async () => {
		const flood: ToolDefinition = {
			...echo,
			name: "flood",
			execute: async (_id, _params, _signal, onUpdate) => {
				for (let i = 0; i < 5100; i++) onUpdate?.({ content: [{ type: "text", text: String(i) }], details: {} });
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		host = await createHost({ tools: [flood] });
		host.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("flood", {}, { id: "c" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("done")),
		]);
		const { url, token } = await host.startRemote();
		await host.type("go");

		for (const after of [0, 999_999]) {
			const stream = await openEvents(url, token, { after });
			await stream.waitFor(1);
			expect(stream.events.map((e) => e.event)).toEqual(["resync"]);
			expect(stream.events[0].id).toBe(""); // not part of the numbered sequence
			stream.close();
		}
		const snapshot = await (await remoteGet(url, "/v1/snapshot", clientHeaders(token))).json();
		const recent = await openEvents(url, token, { after: snapshot.seq - 1 });
		await recent.waitFor(1);
		expect(recent.events.map((e) => e.data.seq)).toEqual([snapshot.seq]);
		recent.close();
	});

	test("a malformed resume point gets 400 bad_request", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		for (const after of ["abc", "", "1e3", "-1"]) {
			await expectError(await remoteGet(url, `/v1/events?after=${after}`, clientHeaders(token)), 400, "bad_request");
		}
	});

	test("a : ping comment is sent every 15 seconds", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			host = await createHost();
			const { url, token } = await host.startRemote();
			const stream = await openEvents(url, token);
			await vi.advanceTimersByTimeAsync(15_000);
			await vi.waitFor(() => expect(stream.comments).toEqual([": ping"]));
			stream.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
