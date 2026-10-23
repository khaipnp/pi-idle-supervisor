import { afterEach, describe, expect, test, vi } from "vitest";
import { lanAddress } from "../src/pairing.ts";
import { clientHeaders, createHost, type Host, remoteGet } from "./harness.ts";

// The real probe depends on whether Tailscale runs on this machine; each test picks the answer.
const tailscale = vi.hoisted(() => ({ url: undefined as string | undefined }));
vi.mock("../src/pairing.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/pairing.ts")>()),
	probeTailscale: async () => tailscale.url,
}));

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
	tailscale.url = undefined;
});

/** Types `/remote`, waits for the picker and picks the option starting with `label`. */
async function pick(h: Host, label: string | undefined) {
	const typed = h.type("/remote");
	await expect.poll(() => h.terminalDialogs.length).toBe(1);
	const dialog = h.terminalDialogs[0]!;
	expect(dialog).toMatchObject({ kind: "select", title: "Turn remote on. How will your phone connect?" });
	expect(dialog.options?.map((option) => option.split(":")[0])).toEqual(["LAN", "Tailscale", "Tunnel"]);
	dialog.answer(label === undefined ? undefined : dialog.options!.find((option) => option.startsWith(`${label}:`)));
	await typed;
}

function pairingUrl(h: Host): string | undefined {
	const pairing = h.notifications.map((n) => n.message.match(/pi-remote:\/\/pair\?\S+/)?.[0]).findLast(Boolean);
	return pairing ? new URL(pairing).searchParams.get("url")! : undefined;
}

describe("LAN address", () => {
	const entry = (address: string, internal = false) => ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as const;

	test("picks the first private IPv4, skipping loopback and public addresses", () => {
		expect(lanAddress({ lo0: [entry("127.0.0.1", true)], en0: [entry("8.8.8.8"), entry("192.168.1.20")] })).toBe("192.168.1.20");
		expect(lanAddress({ en0: [entry("10.0.0.5")] })).toBe("10.0.0.5");
		expect(lanAddress({ en0: [entry("172.20.1.1")] })).toBe("172.20.1.1");
		expect(lanAddress({ en0: [entry("172.32.1.1"), entry("100.64.0.1")] })).toBeUndefined();
		expect(lanAddress({})).toBeUndefined();
	});
});

describe("/remote picker", () => {
	test("cancelling the picker leaves remote off", async () => {
		host = await createHost();
		await pick(host, undefined);
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toBe("Remote is off");
	});

	test("/remote while remote is on shows the status instead of the picker", async () => {
		host = await createHost();
		const { publicUrl } = await host.startRemote();
		await host.type("/remote");
		expect(host.terminalDialogs).toHaveLength(0);
		expect(host.notifications.at(-1)!.message).toContain(`Remote is on at ${publicUrl}`);
	});

	test.skipIf(!lanAddress())("LAN listens on the private address and pairs with plain http", async () => {
		host = await createHost();
		await pick(host, "LAN");
		const pairing = new URL(host.notifications.map((n) => n.message.match(/pi-remote:\/\/pair\?\S+/)?.[0]).findLast(Boolean)!);
		const url = pairing.searchParams.get("url")!;
		const token = pairing.searchParams.get("token")!;
		expect(url).toMatch(new RegExp(`^http://${lanAddress()!.replaceAll(".", "\\.")}:\\d+$`));
		expect(host.notifications.at(-1)!.message).toContain("plain http");
		expect((await remoteGet(url, "/v1/snapshot", clientHeaders(token))).status).toBe(200);
		// Not on loopback: LAN mode binds only the private address.
		await expect(remoteGet(`http://127.0.0.1:${new URL(url).port}`, "/v1/snapshot", clientHeaders(token))).rejects.toThrow();
	});

	test("Tailscale pairs with the MagicDNS address", async () => {
		tailscale.url = "https://mac.tail1234.ts.net";
		host = await createHost();
		await pick(host, "Tailscale");
		expect(pairingUrl(host)).toBe("https://mac.tail1234.ts.net");
	});

	test("Tailscale that is not running is an error and leaves remote off", async () => {
		host = await createHost();
		await pick(host, "Tailscale");
		expect(host.notifications.at(-1)).toMatchObject({ type: "error" });
		expect(host.notifications.at(-1)!.message).toContain("Tailscale is not installed or not running");
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toBe("Remote is off");
	});
});

describe("/remote start flags", () => {
	test("--tailscale skips the publicUrl setting", async () => {
		tailscale.url = "https://mac.tail1234.ts.net";
		host = await createHost();
		await host.type("/remote start --tailscale");
		expect(pairingUrl(host)).toBe("https://mac.tail1234.ts.net");
	});

	test("more than one way to connect is an error", async () => {
		host = await createHost();
		await host.type("/remote start --lan --tunnel ssh");
		expect(host.notifications.at(-1)).toMatchObject({ type: "error", message: "Use only one of --tunnel, --lan" });
		await host.type("/remote start --tailscale --url https://x.test");
		expect(host.notifications.at(-1)).toMatchObject({ type: "error", message: "Use only one of --url, --tailscale" });
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toBe("Remote is off");
	});
});
