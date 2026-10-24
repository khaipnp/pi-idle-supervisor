import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { assertSchema, callGate, clientHeaders, createHost, gatedTool, type Host, openEvents, remoteGet, remotePost } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function sessionsOf(url: string, token: string) {
	const res = await remoteGet(url, "/v1/sessions", clientHeaders(token));
	expect(res.status).toBe(200);
	const body = await res.json();
	assertSchema("SessionList", body);
	// SAFETY: assertSchema above checked the body against SessionList.
	return body.sessions as { id: string; title: string; messageCount: number; current: boolean }[];
}

/** A session file exists once it has an assistant reply, so give the session one. */
async function talk(text: string) {
	host!.faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
	await host!.type(text);
}

describe("host sessions", () => {
	test("lists the working directory's sessions, titled by their first prompt, with the open one marked", async () => {
		host = await createHost({ persist: true });
		const { url, token } = await host.startRemote();
		await talk("fix the flaky test");

		const sessions = await sessionsOf(url, token);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ id: host.session.sessionManager.getSessionId(), title: "fix the flaky test", current: true });
	});

	test("a client opens a new session, then switches back; each reaches clients as session_replaced", async () => {
		host = await createHost({ persist: true });
		const { url, token } = await host.startRemote();
		await talk("first conversation");
		const first = host.session.sessionManager.getSessionId();
		const stream = await openEvents(url, token);

		expect((await remotePost(url, "/v1/session/new", token)).status).toBe(202);
		await stream.waitForType("session_replaced");
		expect(host.session.sessionManager.getSessionId()).not.toBe(first);
		await talk("second conversation");

		const listed = await sessionsOf(url, token);
		expect(listed.map((s) => s.title)).toEqual(["second conversation", "first conversation"]);
		expect(listed.map((s) => s.current)).toEqual([true, false]);

		stream.events.length = 0;
		expect((await remotePost(url, "/v1/session", token, { id: first })).status).toBe(202);
		await stream.waitForType("session_replaced");
		expect(host.session.sessionManager.getSessionId()).toBe(first);
		stream.close();
	});

	test("an unknown session is 404, a malformed body 400, and the session command is not offered or accepted", async () => {
		host = await createHost({ persist: true });
		const { url, token } = await host.startRemote();

		expect((await remotePost(url, "/v1/session", token, { id: "nope" })).status).toBe(404);
		expect((await remotePost(url, "/v1/session", token, {})).status).toBe(400);
		const commands = await (await remoteGet(url, "/v1/commands", clientHeaders(token))).json();
		expect(commands.commands.map((c: { name: string }) => c.name)).not.toContain("remote-session");
		expect((await remotePost(url, "/v1/prompt", token, { text: "/remote-session new" })).status).toBe(400);
	});

	test("while working the session cannot be left", async () => {
		const gate = gatedTool();
		host = await createHost({ persist: true, tools: [gate.tool] });
		const { url, token } = await host.startRemote();
		host.faux.setResponses([callGate(), fauxAssistantMessage(fauxText("done"))]);
		const stream = await openEvents(url, token);
		await remotePost(url, "/v1/prompt", token, { text: "go" });
		await stream.waitForType("tool_start");

		expect((await remotePost(url, "/v1/session/new", token)).status).toBe(409);

		gate.release();
		await stream.waitForType("settled");
		stream.close();
	});
});
