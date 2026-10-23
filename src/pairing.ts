import { execFile } from "node:child_process";
import { PROTOCOL_MAJOR } from "./server.ts";

export interface PublicUrl {
	url: string;
	/** True when only this machine can reach `url` (no tunnel configured or detected). */
	localOnly: boolean;
	/** True when the URL was guessed from MagicDNS: nothing checked that `tailscale serve` is running. */
	viaTailscale?: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TAILSCALE_TIMEOUT_MS = 3000;
const TAILSCALE_MAX_OUTPUT = 4_000_000;
/** `tailscale` on PATH, then the command line tool inside the macOS app, which does not put it on PATH. */
const TAILSCALE_COMMANDS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

export function clientsLabel(count: number): string {
	return `${count} ${count === 1 ? "client" : "clients"}`;
}

/** The access token travels in this URL's requests, so only https (or loopback http) is accepted. */
function normaliseUrl(value: string): { url: string; localOnly: boolean } | undefined {
	try {
		const parsed = new URL(value);
		const localOnly = LOOPBACK.has(parsed.hostname);
		const ok = parsed.protocol === "https:" || (parsed.protocol === "http:" && localOnly);
		return ok ? { url: parsed.href.replace(/\/+$/, ""), localOnly } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The https address for this machine's MagicDNS name, from `tailscale status --json` output.
 * Undefined unless Tailscale is running: a stopped node still reports its name, but nothing can reach it.
 */
export function magicDnsUrl(statusJson: string): string | undefined {
	try {
		const status = JSON.parse(statusJson) as { BackendState?: string; Self?: { DNSName?: string } };
		const dns = status.Self?.DNSName?.replace(/\.$/, "");
		return status.BackendState === "Running" && dns ? `https://${dns}` : undefined;
	} catch {
		return undefined;
	}
}

function tailscaleStatus(command: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(command, ["status", "--json"], { timeout: TAILSCALE_TIMEOUT_MS, maxBuffer: TAILSCALE_MAX_OUTPUT }, (error, stdout) =>
			resolve(error ? undefined : stdout),
		);
	});
}

/** MagicDNS address of this machine, or undefined when Tailscale is missing or not running. */
async function probeTailscale(): Promise<string | undefined> {
	for (const command of TAILSCALE_COMMANDS) {
		const output = await tailscaleStatus(command);
		if (output !== undefined) return magicDnsUrl(output);
	}
	return undefined;
}

/** `--url` flag, then `publicUrl` setting, then Tailscale MagicDNS, then the localhost address. */
export async function resolvePublicUrl(sources: {
	flag?: string;
	setting?: string;
	port: number;
	tailscale?: () => Promise<string | undefined>;
}): Promise<PublicUrl> {
	const explicit = sources.flag ?? (sources.setting || undefined);
	if (explicit !== undefined) {
		const normalised = normaliseUrl(explicit);
		if (!normalised) throw new Error(`"${explicit}" is not an https URL (http is allowed only for localhost)`);
		return normalised;
	}
	const magic = await (sources.tailscale ?? probeTailscale)();
	if (magic) return { url: magic, localOnly: false, viaTailscale: true };
	return { url: `http://127.0.0.1:${sources.port}`, localOnly: true };
}

export function pairingString(url: string, token: string): string {
	return `pi-remote://pair?url=${encodeURIComponent(url)}&token=${token}&v=${PROTOCOL_MAJOR}`;
}
