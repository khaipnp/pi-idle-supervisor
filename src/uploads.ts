import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Largest single upload. */
export const MAX_UPLOAD_BYTES = 12_000_000;
/** Most attachments one prompt may reference. */
export const MAX_ATTACHMENTS = 4;
/** Everything uploaded since remote turned on; the files stay until it turns off so Pi can read them. */
const MAX_STORE_BYTES = 200_000_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface Attachment {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	/** Absolute path on the host machine. */
	path: string;
}

/** Files uploaded by remote clients, kept in a private temp directory that is removed with the server. */
export class Uploads {
	private dir: Promise<string> | undefined;
	private readonly files = new Map<string, Attachment>();
	private total = 0;

	/** Stores `data`. Returns undefined when the store is full. */
	async save(rawName: string, mimeType: string, data: Buffer): Promise<Attachment | undefined> {
		if (this.total + data.length > MAX_STORE_BYTES) return undefined;
		this.total += data.length;
		const id = randomBytes(8).toString("hex");
		const name = safeName(rawName);
		const folder = join(await (this.dir ??= mkdtemp(join(tmpdir(), "pi-remote-uploads-"))), id);
		await mkdir(folder);
		const path = join(folder, name);
		await writeFile(path, data);
		const file = { id, name, mimeType, size: data.length, path };
		this.files.set(id, file);
		return file;
	}

	/** The files for `ids`, or undefined when any id is unknown. */
	find(ids: string[]): Attachment[] | undefined {
		const found = ids.map((id) => this.files.get(id));
		return found.every((f) => f !== undefined) ? (found as Attachment[]) : undefined;
	}

	async dispose(): Promise<void> {
		const dir = await this.dir;
		this.dir = undefined;
		this.files.clear();
		this.total = 0;
		if (dir) await rm(dir, { recursive: true, force: true });
	}
}

/** The name without any directory part or characters that are awkward in a path. */
function safeName(raw: string): string {
	const name = basename(raw.replaceAll("\\", "/"))
		.replace(/[^\w.\- ]/g, "_")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, 100);
	return name || "file";
}

/**
 * What Pi receives for a remote prompt: images travel as image content, every other file as its path on this
 * machine appended to the text, so the agent can read it with its own tools.
 */
export function userContent(text: string, attachments: Attachment[]): string | (TextContent | ImageContent)[] {
	if (attachments.length === 0) return text;
	const images = attachments.filter((a) => IMAGE_TYPES.has(a.mimeType));
	const others = attachments.filter((a) => !IMAGE_TYPES.has(a.mimeType));
	const listing = others.map((a) => `- ${a.path} (${a.mimeType}, ${a.size} bytes)`).join("\n");
	const body = [text, others.length > 0 ? `Attached files:\n${listing}` : ""].filter(Boolean).join("\n\n");
	const parts: (TextContent | ImageContent)[] = [];
	if (body) parts.push({ type: "text", text: body });
	for (const image of images) {
		parts.push({ type: "image", mimeType: image.mimeType, data: readFileSync(image.path).toString("base64") });
	}
	return parts;
}
