import { createServer } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { magicDnsUrl, resolvePublicUrl } from "../src/pairing.ts";
import { createHost, type Host, openEvents } from "./harness.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("public URL resolution", () => {
	const tailscale = async () => "https://mac.tail1234.ts.net";
	const none = async () => undefined;

	test("--url beats the setting, which beats Tailscale, which beats localhost", async () => {
		const base = { port: 7878, tailscale };
		expect(await resolvePublicUrl({ ...base, flag: "https://flag.test/", setting: "https://setting.test" })).toEqual({ url: "https://flag.test", localOnly: false });
		expect(await resolvePublicUrl({ ...base, setting: "https://setting.test" })).toEqual({ url: "https://setting.test", localOnly: false });
		expect(await resolvePublicUrl(base)).toEqual({ url: "https://mac.tail1234.ts.net", localOnly: false, viaTailscale: true });
		expect(await resolvePublicUrl({ port: 7878, tailscale: none })).toEqual({ url: "http://127.0.0.1:7878", localOnly: true });
	});

	test("only https (or loopback http) is accepted; an empty setting counts as unset", async () => {
		await expect(resolvePublicUrl({ port: 1, flag: "ftp://x", tailscale: none })).rejects.toThrow(/not an https/);
		await expect(resolvePublicUrl({ port: 1, flag: "http://lan-host", tailscale: none })).rejects.toThrow(/not an https/);
		expect(await resolvePublicUrl({ port: 1, flag: "http://127.0.0.1:9", tailscale: none })).toMatchObject({ localOnly: true });
		expect(await resolvePublicUrl({ port: 5, setting: "", tailscale: none })).toMatchObject({ url: "http://127.0.0.1:5" });
		await expect(resolvePublicUrl({ port: 1, flag: "nonsense", tailscale: none })).rejects.toThrow();
	});
});

describe("Tailscale status", () => {
	const status = (BackendState: string, DNSName = "mac.tail1234.ts.net.") => JSON.stringify({ BackendState, Self: { DNSName } });

	test("uses the MagicDNS name only while Tailscale is running", () => {
		expect(magicDnsUrl(status("Running"))).toBe("https://mac.tail1234.ts.net");
		expect(magicDnsUrl(status("Stopped"))).toBeUndefined();
		expect(magicDnsUrl(status("NeedsLogin"))).toBeUndefined();
	});

	test("missing name or unreadable output gives no address", () => {
		expect(magicDnsUrl(status("Running", ""))).toBeUndefined();
		expect(magicDnsUrl(JSON.stringify({ BackendState: "Running" }))).toBeUndefined();
		expect(magicDnsUrl("not json")).toBeUndefined();
	});
});

describe("pairing UX", () => {
	test("start prints a QR and the pairing string for the --url", async () => {
		host = await createHost();
		await host.type("/remote start --url https://tunnel.test");
		const message = host.notifications.at(-1)!.message;
		expect(message).toContain("pi-remote://pair?url=https%3A%2F%2Ftunnel.test&token=");
		expect(message).toMatch(/[▀▄█]/); // QR block characters
		expect(message).not.toMatch(/Warning/);
	});

	test("a bare --url is an error, not a silent fallback", async () => {
		host = await createHost();
		await host.type("/remote start --url");
		expect(host.notifications.at(-1)).toMatchObject({ type: "error" });
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toMatch(/off/);
	});

	test("an invalid --url refuses to start and leaves nothing running", async () => {
		host = await createHost();
		await host.type("/remote start --url ftp://x");
		expect(host.notifications.at(-1)).toMatchObject({ type: "error" });
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toMatch(/off/);
	});

	test("a busy port is a clear error, not another port", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const port = (blocker.address() as { port: number }).port;
		try {
			host = await createHost({ remote: { port } });
			await host.type("/remote start");
			const last = host.notifications.at(-1)!;
			expect(last.type).toBe("error");
			expect(last.message).toContain(`port ${port} is already in use`);
		} finally {
			blocker.close();
		}
	});

	test("footer shows client count, updates on connect/disconnect, clears on stop", async () => {
		host = await createHost();
		const { url, token } = await host.startRemote();
		expect(host.statuses.get("remote")).toBe("📡 remote · 0 clients");
		const a = await openEvents(url, token);
		await expect.poll(() => host!.statuses.get("remote")).toBe("📡 remote · 1 client");
		const b = await openEvents(url, token);
		await expect.poll(() => host!.statuses.get("remote")).toBe("📡 remote · 2 clients");
		b.close();
		await expect.poll(() => host!.statuses.get("remote")).toBe("📡 remote · 1 client");
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toContain("1 client)");
		await host.type("/remote stop");
		expect(host.statuses.get("remote")).toBeUndefined();
		a.close();
	});
});
