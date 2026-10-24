import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapDialogs } from "../src/dialogs.ts";
import { afterEach, describe, expect, test } from "vitest";
import { assertSchema, clientHeaders, createHost, type Host, openEvents, remoteGet, remotePost } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

interface OpenDialog {
	id: string;
	message?: string;
	placeholder?: string;
}
const dialogOf = async (stream: { waitForType(t: string): Promise<{ data: { [k: string]: unknown } }> }) =>
	// SAFETY: events are validated against the schema's Event as they arrive.
	(await stream.waitForType("dialog_open")).data.dialog as OpenDialog;

/** A tool that runs `ask` against the shared ctx.ui, like any other extension would. */
function askingTool<T>(ask: (ui: ExtensionUIContext) => Promise<T>) {
	let resolve!: (value: T) => void;
	const result = { promise: new Promise<T>((r) => (resolve = r)), resolve };
	const tool: ToolDefinition = {
		name: "ask",
		label: "Ask",
		description: "Opens a dialog",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			result.resolve(await ask(ctx.ui));
			return { content: [{ type: "text", text: "asked" }], details: {} };
		},
	};
	return { tool, result: result.promise };
}

async function run(h: Host) {
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask", {}, { id: "a" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("done")),
	]);
	void h.type("go");
}

const answer = (url: string, token: string, id: string, body: unknown) => remotePost(url, `/v1/dialogs/${id}/answer`, token, body);
const snapshotOf = async (url: string, token: string) => (await remoteGet(url, "/v1/snapshot", clientHeaders(token))).json();

async function start(ask: (ui: ExtensionUIContext) => Promise<unknown>, remote = true) {
	const asking = askingTool(ask);
	host = await createHost({ tools: [asking.tool] });
	const connection = remote ? await host.startRemote() : { url: "", token: "" };
	const stream = remote ? await openEvents(connection.url, connection.token) : undefined;
	await run(host);
	return { ...connection, stream, result: asking.result };
}

describe("remote dialogs", () => {
	test("a remote answer resolves the caller and aborts the terminal dialog", async () => {
		const { url, token, stream, result } = await start((ui) => ui.select("Pick", ["a", "b"]));
		const open = await stream!.waitForType("dialog_open");
		assertSchema("Event", open.data);
		// SAFETY: events are validated against the schema's Event as they arrive.
		const dialog = open.data.dialog as { id: string };
		expect(dialog).toMatchObject({ kind: "select", title: "Pick", options: ["a", "b"] });
		expect((await snapshotOf(url, token)).dialogs).toEqual([dialog]);

		expect((await answer(url, token, dialog.id, { value: "b" })).status).toBe(200);
		expect(await result).toBe("b");
		expect(host!.terminalDialogs[0].signal?.aborted).toBe(true);
		expect((await stream!.waitForType("dialog_closed")).data).toMatchObject({ dialogId: dialog.id, closedBy: "remote" });
		expect((await snapshotOf(url, token)).dialogs).toEqual([]);
		stream!.close();
	});

	test("a terminal answer wins and a late remote answer gets 409 dialog_closed", async () => {
		const { url, token, stream, result } = await start((ui) => ui.confirm("Sure?", "Really"));
		const dialog = await dialogOf(stream!);
		expect(dialog.message).toBe("Really");
		host!.terminalDialogs[0].answer(true);
		expect(await result).toBe(true);
		expect((await stream!.waitForType("dialog_closed")).data).toMatchObject({ closedBy: "terminal" });

		const late = await answer(url, token, dialog.id, { value: false });
		expect(late.status).toBe(409);
		const body = await late.json();
		assertSchema("Error", body);
		expect(body.error.code).toBe("dialog_closed");
		stream!.close();
	});

	test("two clients racing: one wins, the other gets 409", async () => {
		const { url, token, stream, result } = await start((ui) => ui.input("Name", "type here"));
		const dialog = await dialogOf(stream!);
		expect(dialog.placeholder).toBe("type here");
		const statuses = (await Promise.all([answer(url, token, dialog.id, { value: "one" }), answer(url, token, dialog.id, { value: "two" })])).map((r) => r.status);
		expect(statuses.sort()).toEqual([200, 409]);
		expect(["one", "two"]).toContain(await result);
		stream!.close();
	});

	test("rejects unknown ids (404) and wrong value types (400) without closing the dialog", async () => {
		const { url, token, stream, result } = await start((ui) => ui.select("Pick", ["a", "b"]));
		const dialog = await dialogOf(stream!);
		expect((await answer(url, token, "nope", { value: "a" })).status).toBe(404);
		for (const body of [{ value: true }, { value: "c" }, {}, "x"]) {
			expect((await answer(url, token, dialog.id, body)).status).toBe(400);
		}
		expect((await snapshotOf(url, token)).dialogs).toHaveLength(1);
		await answer(url, token, dialog.id, { cancelled: true });
		expect(await result).toBeUndefined();
		expect((await stream!.waitForType("dialog_closed")).data).toMatchObject({ closedBy: "remote" });
		stream!.close();
	});

	test("the caller's timeout closes the dialog with expiresAt published", async () => {
		const { stream, result } = await start((ui) => ui.confirm("Quick", "now", { timeout: 50 }));
		const open = await stream!.waitForType("dialog_open");
		// SAFETY: events are validated against the schema's Event as they arrive.
		expect(typeof (open.data.dialog as { expiresAt: unknown }).expiresAt).toBe("number");
		expect(await result).toBe(false);
		expect((await stream!.waitForType("dialog_closed")).data).toMatchObject({ closedBy: "timeout" });
		expect(host!.terminalDialogs[0].signal?.aborted).toBe(true);
		stream!.close();
	});

	test("the caller's abort signal cancels the dialog", async () => {
		const controller = new AbortController();
		const { stream, result } = await start((ui) => {
			setTimeout(() => controller.abort(), 20);
			return ui.confirm("Cancelable", "msg", { signal: controller.signal });
		});
		await stream!.waitForType("dialog_open");
		expect(await result).toBe(false);
		const closed = await stream!.waitForType("dialog_closed");
		assertSchema("Event", closed.data);
		expect(closed.data).toMatchObject({ closedBy: "cancelled" });
		expect(host!.terminalDialogs[0].signal?.aborted).toBe(true);
		stream!.close();
	});

	test("/remote stop dismisses pending dialogs and a malformed id is a 404", async () => {
		const { url, token, stream, result } = await start((ui) => ui.confirm("Pending", "m"));
		await stream!.waitForType("dialog_open");
		expect((await answer(url, token, "%E0", { value: true })).status).toBe(404);
		await host!.type("/remote stop");
		expect(await result).toBe(false);
		expect(host!.terminalDialogs[0].signal?.aborted).toBe(true);
	});

	test("with remote off, dialogs go straight to the terminal", async () => {
		const { result } = await start((ui) => ui.select("Pick", ["a"]), false);
		await expect.poll(() => host!.terminalDialogs.length).toBe(1);
		host!.terminalDialogs[0].answer("a");
		expect(await result).toBe("a");
	});

	test("an unexpected UI context shape is left untouched and reported by wrapDialogs", () => {
		const ui = Object.freeze({ select: async () => undefined, confirm: async () => false, input: async () => undefined });
		// SAFETY: only select/confirm/input are inspected by wrapDialogs.
		expect(wrapDialogs(ui as unknown as ExtensionUIContext, () => undefined)).toBe(false);
	});
});
