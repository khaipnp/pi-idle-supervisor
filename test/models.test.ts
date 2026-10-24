import { afterEach, describe, expect, test } from "vitest";
import { assertSchema, callGate, clientHeaders, createHost, gatedTool, type Host, openEvents, remoteGet, remotePost } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const MODELS = [
	{ id: "faux-1", name: "Faux One", reasoning: true },
	{ id: "faux-2", name: "Faux Two" },
	{ id: "faux-3", name: "Faux Three", reasoning: true },
];
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"];

async function remote(options: { scoped?: string[] } = {}) {
	host = await createHost({ models: MODELS, ...options });
	return host.startRemote();
}

async function json(res: Response, status: number, def: string) {
	expect(res.status).toBe(status);
	const body = await res.json();
	assertSchema(def, body);
	return body;
}

const snapshotOf = async (url: string, token: string) => json(await remoteGet(url, "/v1/snapshot", clientHeaders(token)), 200, "Snapshot");
const modelsOf = async (url: string, token: string) => json(await remoteGet(url, "/v1/models", clientHeaders(token)), 200, "ModelList");

describe("model and thinking level", () => {
	test("the snapshot names the session's model, its thinking levels and the current level", async () => {
		const { url, token } = await remote();
		const snapshot = await snapshotOf(url, token);
		expect(snapshot.model).toEqual({ provider: host!.faux.provider.id, id: "faux-1", name: "Faux One", thinkingLevels: REASONING_LEVELS });
		expect(snapshot.thinkingLevel).toBe(host!.session.thinkingLevel);
	});

	test("without enabledModels every model with credentials is offered", async () => {
		const { url, token } = await remote();
		const { models } = await modelsOf(url, token);
		expect(models.map((m: { id: string }) => m.id)).toEqual(["faux-1", "faux-2", "faux-3"]);
		expect(models[1]).toEqual({ provider: host!.faux.provider.id, id: "faux-2", name: "Faux Two", thinkingLevels: ["off"] });
	});

	test("with enabledModels only the scoped models are offered", async () => {
		const { url, token } = await remote({ scoped: ["faux-3", "faux-1"] });
		const { models } = await modelsOf(url, token);
		expect(models.map((m: { id: string }) => m.id)).toEqual(["faux-3", "faux-1"]);
	});

	test("a client switches the model; Pi uses it and every client hears of it", async () => {
		const { url, token } = await remote();
		const stream = await openEvents(url, token);
		const provider = host!.faux.provider.id;

		const body = await json(await remotePost(url, "/v1/model", token, { provider, id: "faux-3" }), 200, "ModelState");

		expect(host!.session.model?.id).toBe("faux-3");
		expect(body.model.id).toBe("faux-3");
		expect(body.thinkingLevel).toBe(host!.session.thinkingLevel);
		const event = await stream.waitForType("model");
		expect(event.data.model).toEqual(body.model);
		expect((await snapshotOf(url, token)).model.id).toBe("faux-3");
		stream.close();
	});

	test("switching to a model without thinking turns thinking off", async () => {
		const { url, token } = await remote();
		await remotePost(url, "/v1/thinking", token, { level: "high" });

		const body = await json(await remotePost(url, "/v1/model", token, { provider: host!.faux.provider.id, id: "faux-2" }), 200, "ModelState");

		expect(body).toEqual({ model: expect.objectContaining({ id: "faux-2", thinkingLevels: ["off"] }), thinkingLevel: "off" });
	});

	test("a model that is not offered, or a malformed body, is refused", async () => {
		const { url, token } = await remote({ scoped: ["faux-1", "faux-2"] });
		const provider = host!.faux.provider.id;

		const outOfScope = await json(await remotePost(url, "/v1/model", token, { provider, id: "faux-3" }), 404, "Error");
		expect(outOfScope.error.code).toBe("not_found");
		const unknown = await json(await remotePost(url, "/v1/model", token, { provider: "nobody", id: "faux-1" }), 404, "Error");
		expect(unknown.error.code).toBe("not_found");
		for (const bad of [undefined, {}, { provider }, { provider, id: 3 }, "faux-1"]) {
			const res = await json(await remotePost(url, "/v1/model", token, bad), 400, "Error");
			expect(res.error.code).toBe("bad_request");
		}
		expect(host!.session.model?.id).toBe("faux-1");
	});

	test("a client sets the thinking level; Pi uses it and every client hears of it", async () => {
		const { url, token } = await remote();
		const stream = await openEvents(url, token);

		const body = await json(await remotePost(url, "/v1/thinking", token, { level: "low" }), 200, "ModelState");

		expect(host!.session.thinkingLevel).toBe("low");
		expect(body.thinkingLevel).toBe("low");
		expect((await stream.waitForType("model")).data.thinkingLevel).toBe("low");
		expect((await snapshotOf(url, token)).thinkingLevel).toBe("low");
		stream.close();
	});

	test("a level the model does not support is clamped the way Pi clamps it", async () => {
		const { url, token } = await remote();

		const body = await json(await remotePost(url, "/v1/thinking", token, { level: "max" }), 200, "ModelState");

		expect(body.thinkingLevel).toBe("high");
		expect(host!.session.thinkingLevel).toBe("high");
	});

	test("an unknown thinking level is refused", async () => {
		const { url, token } = await remote();
		const before = host!.session.thinkingLevel;
		for (const bad of [undefined, {}, { level: "extreme" }, { level: 2 }]) {
			const res = await json(await remotePost(url, "/v1/thinking", token, bad), 400, "Error");
			expect(res.error.code).toBe("bad_request");
		}
		expect(host!.session.thinkingLevel).toBe(before);
	});

	test("a change made on the terminal reaches clients as a model event", async () => {
		const { url, token } = await remote();
		const stream = await openEvents(url, token);

		await host!.session.setModel(host!.faux.getModel("faux-3")!);
		host!.session.setThinkingLevel("minimal");

		await stream.waitFor(2);
		const models = stream.events.filter((e) => e.event === "model").map((e) => e.data);
		expect(models.at(-1)).toMatchObject({ model: { id: "faux-3" }, thinkingLevel: "minimal" });
		stream.close();
	});

	test("the model can be switched while Pi is working", async () => {
		const gate = gatedTool();
		host = await createHost({ models: MODELS, tools: [gate.tool] });
		host.faux.setResponses([callGate()]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);
		await remotePost(url, "/v1/prompt", token, { text: "start" });
		await stream.waitForType("tool_start");

		await json(await remotePost(url, "/v1/model", token, { provider: host.faux.provider.id, id: "faux-3" }), 200, "ModelState");

		expect(host.session.model?.id).toBe("faux-3");
		gate.release();
		stream.close();
	});
});
