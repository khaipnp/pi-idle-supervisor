import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertSchema, clientHeaders, createHost, type Host, openEvents, remotePost } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const upload = (url: string, token: string, name: string, type: string, body: Uint8Array) =>
	fetch(`${url}/v1/files?name=${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { ...clientHeaders(token), "Content-Type": type },
		body: Buffer.from(body),
	});

/** The text parts of the first user message in the host session. */
// SAFETY: user messages in these tests carry an array of content parts.
const firstUserContent = (h: Host) => (h.session.messages.find((m) => m.role === "user") as { content: Array<{ type: string; text?: string; mimeType?: string }> } | undefined)?.content;

// A valid 1x1 PNG: Pi resizes images it receives, so a fake header would be dropped.
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function expectError(res: Response, status: number, code: string): Promise<void> {
	expect(res.status).toBe(status);
	const body = await res.json();
	assertSchema("Error", body);
	expect(body.error.code).toBe(code);
}

describe("uploads", () => {
	test("a file is stored on the host and its path is added to the prompt text", async () => {
		host = await createHost();
		host.faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);

		const res = await upload(url, token, "../../notes.txt", "text/plain", Buffer.from("hello file"));
		expect(res.status).toBe(201);
		const file = await res.json();
		assertSchema("UploadResponse", file);
		expect(file).toMatchObject({ name: "notes.txt", mimeType: "text/plain", size: 10 });

		expect((await remotePost(url, "/v1/prompt", token, { text: "read it", attachments: [file.id] })).status).toBe(202);
		await stream.waitForType("settled");

		const text = firstUserContent(host)![0].text!;
		const path = text.match(/- (\S+notes\.txt) \(text\/plain, 10 bytes\)/)![1];
		expect(text.startsWith("read it\n\nAttached files:")).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("hello file");
		stream.close();
	});

	test("an image goes to Pi as image content and a prompt may be only attachments", async () => {
		host = await createHost();
		host.faux.setResponses([fauxAssistantMessage(fauxText("seen"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);

		const file = await (await upload(url, token, "shot.png", "image/png", PNG_1X1)).json();
		expect((await remotePost(url, "/v1/prompt", token, { attachments: [file.id] })).status).toBe(202);
		await stream.waitForType("settled");

		// Pi may add an empty text part ahead of the image.
		expect(firstUserContent(host)).toContainEqual({ type: "image", mimeType: "image/png", data: PNG_1X1.toString("base64") });
		stream.close();
	});

	test("an image in the conversation can be fetched by message and position", async () => {
		host = await createHost();
		host.faux.setResponses([fauxAssistantMessage(fauxText("seen"))]);
		const { url, token } = await host.startRemote();
		const stream = await openEvents(url, token);

		const file = await (await upload(url, token, "shot.png", "image/png", PNG_1X1)).json();
		expect((await remotePost(url, "/v1/prompt", token, { text: "look", attachments: [file.id] })).status).toBe(202);
		await stream.waitForType("settled");

		const snapshot = await (await fetch(`${url}/v1/snapshot`, { headers: clientHeaders(token) })).json();
		const user = snapshot.messages.find((m: { role: string }) => m.role === "user");
		const res = await fetch(`${url}/v1/messages/${user.id}/images/0`, { headers: clientHeaders(token) });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_1X1);

		await expectError(await fetch(`${url}/v1/messages/${user.id}/images/1`, { headers: clientHeaders(token) }), 404, "not_found");
		await expectError(await fetch(`${url}/v1/messages/m-99/images/0`, { headers: clientHeaders(token) }), 404, "not_found");
		await expectError(await fetch(`${url}/v1/messages/nonsense/images/0`, { headers: clientHeaders(token) }), 404, "not_found");
		expect((await fetch(`${url}/v1/messages/${user.id}/images/0`)).status).toBe(401);
		stream.close();
	});

	test("bad uploads and bad attachment lists are refused", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();

		await expectError(await fetch(`${url}/v1/files`, { method: "POST", headers: { ...clientHeaders(token), "Content-Type": "text/plain" }, body: "x" }), 400, "bad_request");
		await expectError(await upload(url, token, "a.txt", "text/plain", new Uint8Array(0)), 400, "bad_request");
		await expectError(await upload(url, token, "big.bin", "application/octet-stream", new Uint8Array(12_000_001)), 400, "bad_request");

		const id = (await (await upload(url, token, "a.txt", "text/plain", Buffer.from("a"))).json()).id;
		await expectError(await remotePost(url, "/v1/prompt", token, { text: "x", attachments: ["nope"] }), 404, "not_found");
		await expectError(await remotePost(url, "/v1/prompt", token, { text: "x", attachments: [id, id] }), 400, "bad_request");
		await expectError(await remotePost(url, "/v1/prompt", token, { text: "x", attachments: [1] }), 400, "bad_request");
		await expectError(await remotePost(url, "/v1/prompt", token, { text: "x", attachments: [id, id + "1", "c", "d", "e"] }), 400, "bad_request");
		await expectError(await remotePost(url, "/v1/prompt", token, { text: "", attachments: [] }), 400, "bad_request");
		expect(host.session.messages).toHaveLength(0);
	});

	test("uploads need the access token, and turning remote off deletes the files", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		const file = await (await upload(url, token, "a.txt", "text/plain", Buffer.from("a"))).json();
		const unauthorised = await fetch(`${url}/v1/files?name=a.txt`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "a" });
		await expectError(unauthorised, 401, "unauthorized");

		host.faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		await remotePost(url, "/v1/prompt", token, { text: "x", attachments: [file.id] });
		await vi.waitFor(() => expect(firstUserContent(host!)).toBeDefined());
		const path = firstUserContent(host)![0].text!.match(/- (\S+a\.txt)/)![1];
		expect(existsSync(path)).toBe(true);
		await host.type("/remote stop");
		expect(existsSync(path)).toBe(false);
	});
});
