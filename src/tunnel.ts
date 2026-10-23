import { type ChildProcess, spawn } from "node:child_process";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.lhr\.life/;
const OUTPUT_TAIL_CHARS = 400;

/** A public https address that forwards to the local server, held open by a child process. */
export interface Tunnel {
	url: string;
	/** Why the child process ended on its own; undefined while it runs and after `stop()`. */
	closedReason?: string;
	/** Called once when the child process ends on its own. The extension sets it again after a session replacement. */
	onClose?: (reason: string) => void;
	stop(): void;
}

/**
 * Opens a localhost.run tunnel with the system `ssh`: no install, no account. localhost.run ends TLS,
 * so it can read the traffic; the URL changes every run and after a few hours. The `ssh` binary is
 * found on PATH, the same way `probeTailscale` finds `tailscale`.
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

		const tail = () => output.trim().slice(-OUTPUT_TAIL_CHARS) || "no output";
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
		const onData = (chunk: Buffer) => {
			if (settled) return;
			output += chunk.toString();
			const url = URL_PATTERN.exec(output)?.[0];
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
			if (stopped || !tunnel.url) return;
			tunnel.closedReason = `ssh ended (${signal ?? `code ${code}`})`;
			tunnel.onClose?.(tunnel.closedReason);
		});
	});
}
