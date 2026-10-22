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

export function clientsLabel(count: number): string {
	return `${count} ${count === 1 ? "client" : "clients"}`;
}

/** The access token travels in this URL's requests, so only https (or loopback http) is accepted. Returns it without a trailing slash. */
function normaliseUrl(value: string): string | undefined {
	try {
		const parsed = new URL(value);
		const ok = parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname));
		return ok ? parsed.href.replace(/\/+$/, "") : undefined;
	} catch {
		return undefined;
	}
}

/** MagicDNS name of this machine from `tailscale status --json`, or undefined when unavailable. */
export function probeTailscale(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("tailscale", ["status", "--json"], { timeout: TAILSCALE_TIMEOUT_MS, maxBuffer: TAILSCALE_MAX_OUTPUT }, (error, stdout) => {
			if (error) return resolve(undefined);
			try {
				const dns = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
				resolve(dns ? `https://${dns}` : undefined);
			} catch {
				resolve(undefined);
			}
		});
	});
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
		const url = normaliseUrl(explicit);
		if (!url) throw new Error(`"${explicit}" is not an https URL (http is allowed only for localhost)`);
		return { url, localOnly: LOOPBACK.has(new URL(url).hostname) };
	}
	const magic = await (sources.tailscale ?? probeTailscale)();
	if (magic) return { url: magic, localOnly: false, viaTailscale: true };
	return { url: `http://127.0.0.1:${sources.port}`, localOnly: true };
}

export function pairingString(url: string, token: string): string {
	return `pi-remote://pair?url=${encodeURIComponent(url)}&token=${token}&v=${PROTOCOL_MAJOR}`;
}
