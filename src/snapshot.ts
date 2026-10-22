import type { Dialog } from "./dialogs.ts";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "./server.ts";

/** Max UTF-8 bytes of text kept per toolResult text block (docs/protocol.md, Block). */
const TOOL_TEXT_LIMIT = 16384;

type Block =
	| { type: "text"; text: string; truncated?: true; originalBytes?: number }
	| { type: "thinking"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	| { type: "image"; mimeType: string };

export interface Message {
	id: string;
	role: "user" | "assistant" | "toolResult";
	timestamp: number;
	content: Block[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export interface Snapshot {
	protocolVersion: string;
	seq: number;
	hostSession: { id: string; cwd: string; name?: string };
	status: "working" | "settled";
	messages: Message[];
	dialogs: Dialog[];
}

/** Body of GET /v1/snapshot; `seq` is the last event the state reflects. `dialogs` are those still waiting for an answer. */
export function toSnapshot(sm: ExtensionContext["sessionManager"], status: Snapshot["status"], seq: number, dialogs: Dialog[]): Snapshot {
	const name = sm.getSessionName();
	return {
		protocolVersion: PROTOCOL_VERSION,
		seq,
		hostSession: { id: sm.getSessionId(), cwd: sm.getCwd(), ...(name ? { name } : {}) },
		status,
		messages: toMessages(sm.getBranch()),
		dialogs,
	};
}

type PiContent = TextContent | ThinkingContent | ToolCall | ImageContent;
const PROTOCOL_ROLES = new Set(["user", "assistant", "toolResult"]);
type PiMessage = Extract<SessionEntry, { type: "message" }>["message"];

/**
 * Converts a Pi message into a protocol message, or undefined for roles the protocol does not carry.
 * Pi only assigns session entry ids after `message_end`, so the caller supplies the id (see `nextMessageId`).
 */
export function toMessage(m: PiMessage, id: string): Message | undefined {
	if (m.role === "user" || m.role === "assistant") {
		const parts: PiContent[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
		return { id, role: m.role, timestamp: m.timestamp, content: parts.map((p) => toBlock(p, false)) };
	}
	if (m.role === "toolResult") {
		return {
			id,
			role: "toolResult",
			timestamp: m.timestamp,
			content: m.content.map((p) => toBlock(p, true)),
			toolCallId: m.toolCallId,
			toolName: m.toolName,
			isError: m.isError,
		};
	}
	return undefined;
}

/** Message ids are the message's position in the active branch, so live events and snapshots agree. */
const messageId = (position: number) => `m-${position}`;

/** Id of the next message to be persisted on this branch. */
export function nextMessageId(branch: SessionEntry[]): string {
	return messageId(branch.filter((e) => e.type === "message" && PROTOCOL_ROLES.has(e.message.role)).length);
}

/** Concatenated text parts of a partial tool result, cut like snapshot tool results. */
export function toolUpdateText(partialResult: { content?: PiContent[] } | undefined) {
	const text = (partialResult?.content ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
	return truncateText(text);
}

/** The active branch as protocol messages (user, assistant and toolResult only). */
export function toMessages(branch: SessionEntry[]): Message[] {
	const messages: Message[] = [];
	for (const entry of branch) {
		const message = entry.type === "message" ? toMessage(entry.message, messageId(messages.length)) : undefined;
		if (message) messages.push(message);
	}
	return messages;
}

function toBlock(part: PiContent, truncate: boolean): Block {
	switch (part.type) {
		case "text":
			return { type: "text", ...(truncate ? truncateText(part.text) : { text: part.text }) };
		case "thinking":
			return { type: "thinking", text: part.thinking };
		case "toolCall":
			return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
		case "image":
			return { type: "image", mimeType: part.mimeType };
	}
}

/** Cuts text to TOOL_TEXT_LIMIT UTF-8 bytes without splitting a character. */
export function truncateText(text: string): { text: string; truncated?: true; originalBytes?: number } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= TOOL_TEXT_LIMIT) return { text };
	let end = TOOL_TEXT_LIMIT;
	// Step back over continuation bytes (10xxxxxx) so the cut lands on a character start.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true, originalBytes: bytes.length };
}
