import { randomBytes } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Attachment } from "./uploads.ts";

/** What Pi receives for a prompt: plain text, or text and images. */
export type PromptContent = string | (TextContent | ImageContent)[];

/** A remote follow-up waiting for the run to settle, as clients see it in the snapshot and `queue` events. */
export interface FollowUp {
	id: string;
	/** The text as the client sent it, before attachments were added to it. */
	text: string;
	attachments: { name: string; mimeType: string }[];
}

/**
 * Remote follow-ups the extension holds itself instead of handing them to Pi's queue, which an extension
 * can neither read nor change (ADR-0006). Until the run settles a client can still steer or cancel each one.
 * `onChange` gets the whole queue after every change.
 */
export class FollowUpQueue {
	private items: { prompt: FollowUp; content: PromptContent }[] = [];

	constructor(private readonly onChange: (queue: FollowUp[]) => void) {}

	/** Waiting follow-ups, oldest first. */
	list(): FollowUp[] {
		return this.items.map((item) => item.prompt);
	}

	/** Queues a follow-up at the end. */
	add(text: string, attachments: Attachment[], content: PromptContent): FollowUp {
		const prompt: FollowUp = {
			id: randomBytes(8).toString("hex"),
			text,
			attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })),
		};
		this.items.push({ prompt, content });
		this.changed();
		return prompt;
	}

	/** Removes the follow-up `id` and returns what Pi should receive for it; undefined when it is not waiting. */
	take(id: string): PromptContent | undefined {
		const index = this.items.findIndex((item) => item.prompt.id === id);
		if (index < 0) return undefined;
		const [item] = this.items.splice(index, 1);
		this.changed();
		return item.content;
	}

	/** Removes the oldest follow-up and returns what Pi should receive for it. */
	next(): PromptContent | undefined {
		const item = this.items.shift();
		if (item) this.changed();
		return item?.content;
	}

	/** Drops every waiting follow-up. */
	clear(): void {
		if (this.items.length === 0) return;
		this.items = [];
		this.changed();
	}

	private changed(): void {
		this.onChange(this.list());
	}
}
