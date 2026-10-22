import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { assertSchema, clientHeaders, createHost, type Host, remoteGet } from "./harness.ts";

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
