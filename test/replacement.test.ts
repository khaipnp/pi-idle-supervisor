import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { REPLACEMENT_TIMEOUT_MS } from "../src/extension.ts";
import { assertSchema, clientHeaders, createHost, type Host, openEvents, remoteGet } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const snapshotOf = async (url: string, token: string) => (await remoteGet(url, "/v1/snapshot", clientHeaders(token))).json();

describe("session replacement and quit", () => {
	test("/new keeps the token working, publishes session_replaced and shows the new conversation", async () => {
		host = await createHost();
		host.faux.setResponses([fauxAssistantMessage(fauxText("old"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);
		await host.type("hello");
		await stream.waitForType("settled");
		const before = await snapshotOf(url, token);
		expect(before.messages.length).toBeGreaterThan(0);

		await host.runtime.newSession();
		const replaced = await stream.waitForType("session_replaced");
		assertSchema("Event", replaced.data);
		expect(replaced.data.hostSession).toMatchObject({ id: host.session.sessionManager.getSessionId() });

		const after = await snapshotOf(url, token);
		assertSchema("Snapshot", after);
		expect(after.hostSession.id).toBe(host.session.sessionManager.getSessionId());
		expect(after.hostSession.id).not.toBe(before.hostSession.id);
		expect(after.messages).toEqual([]);
		expect(after.seq).toBeGreaterThan(before.seq);

		// The new runtime drives events and prompts through the same server.
		host.faux.setResponses([fauxAssistantMessage(fauxText("new"))]);
		await host.type("again");
		await expect.poll(() => stream.events.filter((e) => e.event === "settled").length).toBe(2);
		const seqs = stream.events.map((e) => e.data.seq);
		expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i)); // strictly +1: no gaps, no double emission
		const replacedAt = stream.events.findIndex((e) => e.event === "session_replaced");
		expect(stream.events.slice(replacedAt).filter((e) => e.event === "message_end")).toHaveLength(2); // user + assistant, once each
		stream.close();
	});

	test.each(["fork", "reload"] as const)("%s keeps the token working and publishes session_replaced", async (how) => {
		host = await createHost();
		host.faux.setResponses([fauxAssistantMessage(fauxText("old"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);
		await host.type("hello");
		await stream.waitForType("settled");
		const userEntry = host.session.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user")!.id;

		if (how === "fork") await host.runtime.fork(userEntry);
		else await host.session.reload();
		const replaced = await stream.waitForType("session_replaced");
		assertSchema("Event", replaced.data);
		const after = await snapshotOf(url, token);
		assertSchema("Snapshot", after);
		expect(after.hostSession.id).toBe(host.session.sessionManager.getSessionId());
		stream.close();
	});

	test("a replacement that never completes turns remote off instead of staying busy forever", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			// Shut the runtime down for a non-quit reason without a successor.
			await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
			expect((await remoteGet(url, "/v1/snapshot", clientHeaders(token))).status).toBe(503);
			await vi.advanceTimersByTimeAsync(REPLACEMENT_TIMEOUT_MS + 1);
		} finally {
			vi.useRealTimers();
		}
		await stream.waitForType("remote_off");
		await expect(remoteGet(url, "/v1/snapshot", clientHeaders(token))).rejects.toThrow();
		stream.close();
	});

	test("requests while the host session is being replaced get 503 busy", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		const statuses: number[] = [];
		await host.runtime.newSession({
			setup: async () => {
				statuses.push((await remoteGet(url, "/v1/snapshot", clientHeaders(token))).status);
			},
		});
		expect(statuses).toEqual([503]);
		expect((await remoteGet(url, "/v1/snapshot", clientHeaders(token))).status).toBe(200);
	});

	test("quit publishes remote_off, closes the port and revokes the token; cleanup is idempotent", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);

		await host.runtime.dispose();
		const off = await stream.waitForType("remote_off");
		assertSchema("Event", off.data);
		await expect(remoteGet(url, "/v1/snapshot", clientHeaders(token))).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
		stream.close();
	});

	test("/remote stop then quit publishes remote_off once and does not throw", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);
		await host.type("/remote stop");
		await host.runtime.dispose();
		await stream.waitForType("remote_off");
		expect(stream.events.filter((e) => e.event === "remote_off")).toHaveLength(1);
		stream.close();
	});

	test("/remote stop works from the runtime that replaced the old one", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		await host.runtime.newSession();
		await host.type("/remote stop");
		await expect(remoteGet(url, "/v1/snapshot", clientHeaders(token))).rejects.toThrow();
	});
});
