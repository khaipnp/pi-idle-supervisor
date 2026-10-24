import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertSchema, callGate, clientHeaders, createHost, gatedTool, type Host, openEvents, remotePost } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

/** Another extension's command, recording the arguments it was run with. */
function echoCommand() {
	const calls: string[] = [];
	const extension: ExtensionFactory = (pi) => {
		pi.registerCommand("echo", { description: "Records its arguments", handler: async (args) => void calls.push(args) });
	};
	return { extension, calls };
}

describe("slash commands from a remote client", () => {
	test("a prompt naming an extension command runs it like the terminal would, without a user message", async () => {
		const echo = echoCommand();
		host = await createHost({ extensions: [echo.extension] });
		const { url, token } = await host.startRemote();

		const res = await remotePost(url, "/v1/prompt", token, { text: "/echo hi there" });
		expect(res.status).toBe(202);
		await vi.waitFor(() => expect(echo.calls).toEqual(["hi there"]));
		expect(host.session.messages).toHaveLength(0);
	});

	test("an extension command runs at once while the host session is working, even without deliverAs", async () => {
		const echo = echoCommand();
		const gate = gatedTool();
		host = await createHost({ extensions: [echo.extension], tools: [gate.tool] });
		host.faux.setResponses([callGate(), fauxAssistantMessage(fauxText("done"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);

		await remotePost(url, "/v1/prompt", token, { text: "start" });
		await stream.waitForType("tool_start");
		expect((await remotePost(url, "/v1/prompt", token, { text: "/echo now" })).status).toBe(202);
		await vi.waitFor(() => expect(echo.calls).toEqual(["now"]));
		// Text that is not a command still needs deliverAs while working.
		expect((await remotePost(url, "/v1/prompt", token, { text: "/nope" })).status).toBe(409);

		gate.release();
		await stream.waitForType("settled");
		stream.close();
	});

	test("/remote can only be run on the host terminal", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();

		const res = await remotePost(url, "/v1/prompt", token, { text: "/remote stop" });
		expect(res.status).toBe(400);
		const body = await res.json();
		assertSchema("Error", body);
		expect(body.error.code).toBe("bad_request");
		expect((await remotePost(url, "/v1/prompt", token, { text: "still on" })).status).toBe(202);
	});

	test("a slash command with attachments gets 400 and does not run", async () => {
		const echo = echoCommand();
		host = await createHost({ extensions: [echo.extension] });
		const { url, token } = await host.startRemote();
		const upload = await fetch(`${url}/v1/files?name=notes.txt`, {
			method: "POST",
			headers: { ...clientHeaders(token), "Content-Type": "text/plain" },
			body: "hello",
		});
		const { id } = await upload.json();

		const res = await remotePost(url, "/v1/prompt", token, { text: "/echo hi", attachments: [id] });
		expect(res.status).toBe(400);
		assertSchema("Error", await res.json());
		expect(echo.calls).toEqual([]);
	});

	test("text starting with / that names no command reaches the model as typed", async () => {
		host = await createHost();
		host.faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);

		expect((await remotePost(url, "/v1/prompt", token, { text: "/tmp/log is empty" })).status).toBe(202);
		await stream.waitForType("settled");
		// SAFETY: a remote text prompt is a user message with text content.
		const user = host.session.messages.find((m) => m.role === "user") as { content: Array<{ text?: string }> };
		expect(user.content[0].text).toBe("/tmp/log is empty");
		stream.close();
	});
});
