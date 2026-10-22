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
	dialogs: never[];
}

/** Body of GET /v1/snapshot. `seq` stays 0 until the event log lands (#3); dialogs arrive with #5. */
export function toSnapshot(sm: ExtensionContext["sessionManager"], status: Snapshot["status"]): Snapshot {
	const name = sm.getSessionName();
	return {
		protocolVersion: PROTOCOL_VERSION,
		seq: 0,
		hostSession: { id: sm.getSessionId(), cwd: sm.getCwd(), ...(name ? { name } : {}) },
		status,
		messages: toMessages(sm.getBranch()),
		dialogs: [],
	};
}

type PiContent = TextContent | ThinkingContent | ToolCall | ImageContent;

/**
 * Converts the active branch into protocol messages. Only user, assistant and toolResult
 * messages are sent; the session entry id is the stable message id.
 */
export function toMessages(branch: SessionEntry[]): Message[] {
	const messages: Message[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role === "user" || m.role === "assistant") {
			const parts: PiContent[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
			messages.push({ id: entry.id, role: m.role, timestamp: m.timestamp, content: parts.map((p) => toBlock(p, false)) });
		} else if (m.role === "toolResult") {
			messages.push({
				id: entry.id,
				role: "toolResult",
				timestamp: m.timestamp,
				content: m.content.map((p) => toBlock(p, true)),
				toolCallId: m.toolCallId,
				toolName: m.toolName,
				isError: m.isError,
			});
		}
	}
	return messages;
}

function toBlock(part: PiContent, truncate: boolean): Block {
	switch (part.type) {
		case "text":
			return truncate ? truncateText(part.text) : { type: "text", text: part.text };
		case "thinking":
			return { type: "thinking", text: part.thinking };
		case "toolCall":
			return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
		case "image":
			return { type: "image", mimeType: part.mimeType };
	}
}

/** Cuts text to TOOL_TEXT_LIMIT UTF-8 bytes without splitting a character. */
function truncateText(text: string): Block {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= TOOL_TEXT_LIMIT) return { type: "text", text };
	let end = TOOL_TEXT_LIMIT;
	// Step back over continuation bytes (10xxxxxx) so the cut lands on a character start.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { type: "text", text: bytes.subarray(0, end).toString("utf8"), truncated: true, originalBytes: bytes.length };
}
