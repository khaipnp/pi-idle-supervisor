import { type ChildProcess, spawn } from "node:child_process";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.lhr\.life/g;
const OUTPUT_TAIL_CHARS = 400;
// localhost.run follows the address with a QR code made of colour escape codes.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** A public https address that forwards to the local server, held open by a child process. */
export interface Tunnel {
	url: string;
	/**
	 * Why the tunnel stopped serving `url` on its own: the child process ended, or localhost.run moved it to another
	 * address while ssh stayed connected. Undefined while it serves `url` and after `stop()`.
	 */
	closedReason?: string;
	/** Called once when `closedReason` is set. The extension sets it again after a session replacement. */
	onClose?: (reason: string) => void;
	stop(): void;
}

/**
 * Opens a localhost.run tunnel with the system `ssh`: no install, no account. localhost.run ends TLS,
 * so it can read the traffic; the URL changes every run and after a few hours. When it changes, ssh
 * stays connected and prints the new address, while the old one answers 502 "no tunnel": that counts
 * as the tunnel closing, since paired phones only know the old address. The `ssh` binary is found on
 * PATH, the same way `probeTailscale` finds `tailscale`.
 */
export function startSshTunnel(options: { port: number; timeoutMs?: number }): Promise<Tunnel> {
	const { port, timeoutMs = 20_000 } = options;
	return new Promise((resolve, reject) => {
		// BatchMode: never wait for a password. ExitOnForwardFailure: end instead of idling without a tunnel.
		const args = [
			"-o", "BatchMode=yes",
			"-o", "ExitOnForwardFailure=yes",
			"-o", "ServerAliveInterval=30",
			"-o", "StrictHostKeyChecking=accept-new",
			"-R", `80:127.0.0.1:${port}`,
			"nokey@localhost.run",
		];
		// stdin stays an open pipe that nothing writes to: a closed stdin could make ssh end the session.
		const child: ChildProcess = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		child.stdin?.on("error", () => {});
		let output = "";
		let settled = false;
		let stopped = false;

		const tail = () => output.replace(ANSI_PATTERN, "").trim().slice(-OUTPUT_TAIL_CHARS) || "no output";
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			reject(new Error(message));
		};
		const timer = setTimeout(() => fail(`no tunnel URL after ${timeoutMs / 1000} seconds. ssh said: ${tail()}`), timeoutMs);

		const tunnel: Tunnel = {
			url: "",
			stop() {
				stopped = true;
				child.kill();
			},
		};
		const close = (reason: string) => {
			if (stopped || tunnel.closedReason) return;
			tunnel.closedReason = reason;
			tunnel.onClose?.(reason);
		};
		const onData = (chunk: Buffer) => {
			// Look for addresses before trimming: one chunk can hold the address followed by a long QR code.
			const combined = output + chunk.toString();
			const urls = combined.match(URL_PATTERN) ?? [];
			// Only the tail is kept: enough for an address split across chunks, and for the error message.
			output = combined.slice(-OUTPUT_TAIL_CHARS * 4);
			if (settled) {
				const moved = urls.find((url) => url !== tunnel.url);
				if (moved) close(`localhost.run moved it to ${moved}`);
				return;
			}
			const url = urls[0];
			if (!url) return;
			settled = true;
			clearTimeout(timer);
			tunnel.url = url;
			resolve(tunnel);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (error: NodeJS.ErrnoException) =>
			fail(error.code === "ENOENT" ? "`ssh` was not found on PATH; install OpenSSH or use --url" : error.message),
		);
		child.on("exit", (code, signal) => {
			if (!settled) return fail(`ssh ended (${signal ?? `code ${code}`}) before giving a URL. ssh said: ${tail()}`);
			if (!tunnel.url) return;
			close(`ssh ended (${signal ?? `code ${code}`})`);
		});
	});
}
