import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertSchema, callGate, clientHeaders, createHost, type EventStream, gatedTool, type Host, openEvents, remoteGet, remotePost } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

interface Queued {
	id: string;
	text: string;
	attachments: { name: string; mimeType: string }[];
}

const snapshotOf = async (url: string, token: string) => {
	const body = await (await remoteGet(url, "/v1/snapshot", clientHeaders(token))).json();
	assertSchema("Snapshot", body);
	// SAFETY: assertSchema just checked the body against the schema's Snapshot.
	return body as { status: string; messages: Array<{ role: string; content: Array<{ text?: string }> }>; queue: Queued[] };
};
const userTexts = (snapshot: Awaited<ReturnType<typeof snapshotOf>>) =>
	snapshot.messages.filter((m) => m.role === "user").map((m) => m.content[0].text);
// SAFETY: events are validated against the schema's Event as they arrive.
const queues = (stream: EventStream) => stream.events.filter((e) => e.event === "queue").map((e) => e.data.queue as Queued[]);
const cancel = (url: string, token: string, id: string) =>
	fetch(`${url}/v1/queue/${encodeURIComponent(id)}`, { method: "DELETE", headers: clientHeaders(token) });

async function expectError(res: Response, status: number, code: string): Promise<void> {
	expect(res.status).toBe(status);
	const body = await res.json();
	assertSchema("Error", body);
	expect(body.error.code).toBe(code);
}

/** A host whose first run waits in the gate tool until `release`, with a remote follow-up queued behind it. */
async function workingWithFollowUp(...replies: string[]) {
	const gate = gatedTool();
	host = await createHost({ tools: [gate.tool] });
	host.faux.setResponses([callGate(), ...replies.map((text) => fauxAssistantMessage(fauxText(text)))]);
	const { url, token } = await host.startRemote();
	const stream = await openEvents(url, token);
	await remotePost(url, "/v1/prompt", token, { text: "start" });
	await stream.waitForType("tool_start");
	const res = await remotePost(url, "/v1/prompt", token, { text: "then this", deliverAs: "followUp" });
	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({});
	await stream.waitForType("queue");
	const [queued] = (await snapshotOf(url, token)).queue;
	return { url, token, stream, release: gate.release, queued };
}

describe("follow-up queue", () => {
	test("a follow-up while working waits in the queue and starts the next run once the first settles", async () => {
		const { url, token, stream, release, queued } = await workingWithFollowUp("first done", "follow-up done");

		expect(queued).toEqual({ id: expect.any(String), text: "then this", attachments: [] });
		expect(queues(stream)).toEqual([[queued]]);
		// Pi has not seen it yet.
		expect(userTexts(await snapshotOf(url, token))).toEqual(["start"]);

		release();
		await vi.waitFor(() => expect(stream.events.filter((e) => e.event === "settled")).toHaveLength(2));
		expect(userTexts(await snapshotOf(url, token))).toEqual(["start", "then this"]);
		expect(queues(stream)).toEqual([[queued], []]);
		expect((await snapshotOf(url, token)).queue).toEqual([]);
		stream.close();
	});

	test("steering a queued follow-up delivers it within the run", async () => {
		const { url, token, stream, release, queued } = await workingWithFollowUp("saw steer");

		const res = await remotePost(url, `/v1/queue/${queued.id}/steer`, token);
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({});
		expect((await snapshotOf(url, token)).queue).toEqual([]);

		release();
		await stream.waitForType("settled");
		const roles = (await snapshotOf(url, token)).messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
		expect(userTexts(await snapshotOf(url, token))).toEqual(["start", "then this"]);
		await expectError(await remotePost(url, `/v1/queue/${queued.id}/steer`, token), 404, "not_found");
		stream.close();
	});

	test("a cancelled follow-up is never sent; unknown ids get 404", async () => {
		const { url, token, stream, release, queued } = await workingWithFollowUp("first done", "never");

		const res = await cancel(url, token, queued.id);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
		await vi.waitFor(() => expect(queues(stream).at(-1)).toEqual([]));
		await expectError(await cancel(url, token, queued.id), 404, "not_found");
		await expectError(await cancel(url, token, "%E0%A4%A"), 404, "not_found");

		release();
		await stream.waitForType("settled");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(userTexts(await snapshotOf(url, token))).toEqual(["start"]);
		stream.close();
	});

	test("aborting the run drops the queue", async () => {
		const { url, token, stream } = await workingWithFollowUp("never", "never");

		await remotePost(url, "/v1/abort", token);
		await stream.waitForType("settled");

		await vi.waitFor(() => expect(queues(stream).at(-1)).toEqual([]));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(userTexts(await snapshotOf(url, token))).toEqual(["start"]);
		expect((await snapshotOf(url, token)).status).toBe("settled");
		stream.close();
	});

	test("a queued follow-up lists its attachments and keeps them when sent", async () => {
		const gate = gatedTool();
		host = await createHost({ tools: [gate.tool] });
		host.faux.setResponses([callGate(), fauxAssistantMessage(fauxText("first")), fauxAssistantMessage(fauxText("read"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);
		await remotePost(url, "/v1/prompt", token, { text: "start" });
		await stream.waitForType("tool_start");

		const file = await (
			await fetch(`${url}/v1/files?name=notes.txt`, {
				method: "POST",
				headers: { ...clientHeaders(token), "Content-Type": "text/plain" },
				body: Buffer.from("hello"),
			})
		).json();
		await remotePost(url, "/v1/prompt", token, { text: "read it", attachments: [file.id], deliverAs: "followUp" });
		await stream.waitForType("queue");
		expect((await snapshotOf(url, token)).queue).toEqual([{ id: expect.any(String), text: "read it", attachments: [{ name: "notes.txt", mimeType: "text/plain" }] }]);

		gate.release();
		await vi.waitFor(() => expect(stream.events.filter((e) => e.event === "settled")).toHaveLength(2));
		expect(userTexts(await snapshotOf(url, token))[1]).toMatch(/^read it\n\nAttached files:\n- \S+notes\.txt \(text\/plain, 5 bytes\)$/);
		stream.close();
	});

	test("a replacement host session starts with an empty queue", async () => {
		const { url, token, stream } = await workingWithFollowUp("never", "never");

		await host!.runtime.newSession();
		await stream.waitForType("session_replaced");

		const snapshot = await snapshotOf(url, token);
		expect(snapshot.queue).toEqual([]);
		expect(userTexts(snapshot)).toEqual([]);
		stream.close();
	});
});
