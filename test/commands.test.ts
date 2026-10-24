import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertSchema, callGate, clientHeaders, createHost, gatedTool, type Host, openEvents, remoteGet, remotePost } from "./harness.ts";

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

/** An extension whose before_agent_start blocks the first run until released: Pi is busy, but agent_start has not fired. */
function slowStart() {
	let release: () => void = () => {};
	let entered: () => void = () => {};
	const reached = new Promise<void>((resolve) => (entered = resolve));
	let first = true;
	const extension: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", async () => {
			if (!first) return;
			first = false;
			entered();
			await new Promise<void>((resolve) => (release = resolve));
		});
	};
	return { extension, reached, release: () => release() };
}

describe("remote prompts racing a run that is starting", () => {
	test("a prompt sent while settled is queued, not lost, when a run starts first", async () => {
		const slow = slowStart();
		host = await createHost({ extensions: [slow.extension] });
		host.faux.setResponses([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two"))]);
		const { url, token } = await host.startRemote();

		const typed = host.type("from the terminal");
		await slow.reached;
		expect((await remotePost(url, "/v1/prompt", token, { text: "from the phone" })).status).toBe(202);
		slow.release();
		await typed;
		await vi.waitFor(() => expect(userTexts(host!)).toEqual(["from the terminal", "from the phone"]));
	});
});

function userTexts(h: Host): string[] {
	// SAFETY: user messages in these tests carry text content.
	return h.session.messages.filter((m) => m.role === "user").map((m) => (m as { content: Array<{ text?: string }> }).content[0].text ?? "");
}

/** A directory holding one prompt template, `/greet <name>`. */
function greetTemplate(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-prompts-"));
	writeFileSync(join(dir, "greet.md"), "---\ndescription: Greets someone\n---\nSay hello to $1.\n");
	return dir;
}

describe("prompt templates from a remote client", () => {
	test("a template expands before the prompt reaches the model", async () => {
		host = await createHost({ promptTemplates: [greetTemplate()] });
		host.faux.setResponses([fauxAssistantMessage(fauxText("hello"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);

		expect((await remotePost(url, "/v1/prompt", token, { text: "/greet Bob" })).status).toBe(202);
		await stream.waitForType("settled");
		expect(userTexts(host)).toEqual(["Say hello to Bob."]);
		stream.close();
	});
});

describe("GET /v1/commands", () => {
	test("lists extension commands and prompt templates, without /remote", async () => {
		host = await createHost({ extensions: [echoCommand().extension], promptTemplates: [greetTemplate()] });
		const { url, token } = await host.startRemote();

		const res = await remoteGet(url, "/v1/commands", clientHeaders(token));
		expect(res.status).toBe(200);
		const body = await res.json();
		assertSchema("CommandList", body);
		expect(body.commands).toEqual([
			{ name: "echo", description: "Records its arguments", source: "extension" },
			{ name: "greet", description: "Greets someone", source: "prompt" },
		]);
	});
});

describe("notice events", () => {
	test("a notification shown on the terminal reaches remote clients as a notice", async () => {
		const extension: ExtensionFactory = (pi) => {
			pi.registerCommand("ping", { handler: async (_args, c) => c.ui.notify("pong", "warning") });
		};
		host = await createHost({ extensions: [extension] });
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token, { after: 0 });

		await remotePost(url, "/v1/prompt", token, { text: "/ping" });
		const notice = await stream.waitForType("notice");
		expect(notice.data).toMatchObject({ type: "notice", message: "pong", level: "warning" });
		expect(host.notifications.at(-1)).toEqual({ message: "pong", type: "warning" });
		// The pairing notification carries the access token and must never be sent to clients.
		expect(stream.events.some((e) => JSON.stringify(e.data).includes(token))).toBe(false);
		stream.close();
	});
});
