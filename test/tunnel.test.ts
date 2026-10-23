import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHost, type Host } from "./harness.ts";

let host: Host | undefined;
let dir: string;
const originalPath = process.env.PATH;

/** Puts a fake `ssh` first on PATH. It records its pid and arguments, then runs `body`. */
function fakeSsh(body: string) {
	writeFileSync(join(dir, "ssh"), `#!/bin/sh\necho $$ > "${dir}/pid"\necho "$@" > "${dir}/args"\n${body}\n`);
	chmodSync(join(dir, "ssh"), 0o755);
	process.env.PATH = `${dir}:${originalPath}`;
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const fakePid = () => Number(readFileSync(join(dir, "pid"), "utf8"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-fake-ssh-"));
});
afterEach(async () => {
	await host?.dispose();
	host = undefined;
	process.env.PATH = originalPath;
});

describe("--tunnel ssh (localhost.run)", () => {
	test("pairs with the URL ssh prints, forwards to the server port, and stop ends ssh", async () => {
		fakeSsh("echo 'tunneled: https://abc123.lhr.life'; exec sleep 30");
		host = await createHost();
		await host.type("/remote start --tunnel ssh");
		const message = host.notifications.at(-1)!.message;
		expect(message).toContain("pi-remote://pair?url=https%3A%2F%2Fabc123.lhr.life&token=");
		expect(message).toContain("can read it");
		expect(readFileSync(join(dir, "args"), "utf8")).toMatch(/-R 80:127\.0\.0\.1:\d+ nokey@localhost\.run/);
		const pid = fakePid();
		expect(alive(pid)).toBe(true);
		await host.type("/remote stop");
		await expect.poll(() => alive(pid)).toBe(false);
	});

	test("the remote.tunnel setting works, but an explicit publicUrl setting beats it", async () => {
		fakeSsh("echo https://fromsetting.lhr.life; exec sleep 30");
		host = await createHost({ remote: { tunnel: "ssh", publicUrl: "" } });
		await host.type("/remote start");
		expect(host.notifications.at(-1)!.message).toContain("fromsetting.lhr.life");
		await host.dispose();
		host = await createHost({ remote: { tunnel: "ssh", publicUrl: "https://explicit.test" } });
		await host.type("/remote start");
		expect(host.notifications.at(-1)!.message).toContain("explicit.test");
	});

	test("ssh ending before it gives a URL refuses to start and leaves nothing running", async () => {
		fakeSsh("echo 'Permission denied' >&2; exit 255");
		host = await createHost();
		await host.type("/remote start --tunnel ssh");
		const last = host.notifications.at(-1)!;
		expect(last).toMatchObject({ type: "error" });
		expect(last.message).toContain("Permission denied");
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toMatch(/off/);
	});

	test("a missing ssh binary is a clear error", async () => {
		process.env.PATH = dir; // no ssh here
		host = await createHost();
		await host.type("/remote start --tunnel ssh");
		expect(host.notifications.at(-1)!.message).toContain("`ssh` was not found");
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toMatch(/off/);
	});

	test("ssh dying after the URL turns remote off and says so", async () => {
		fakeSsh("echo https://abc123.lhr.life; sleep 0.3; exit 1");
		host = await createHost();
		await host.type("/remote start --tunnel ssh");
		await expect.poll(() => host!.notifications.at(-1)!.message).toContain("the tunnel ended");
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toMatch(/off/);
	});

	test("bad flag combinations are rejected before anything starts", async () => {
		host = await createHost();
		await host.type("/remote start --tunnel nope");
		expect(host.notifications.at(-1)).toMatchObject({ type: "error" });
		await host.type("/remote start --tunnel ssh --url https://x.test");
		expect(host.notifications.at(-1)).toMatchObject({ type: "error" });
		await host.type("/remote status");
		expect(host.notifications.at(-1)!.message).toMatch(/off/);
	});
});
