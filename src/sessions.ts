import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Most sessions GET /v1/sessions lists, newest first. */
export const MAX_SESSIONS = 50;
const MAX_TITLE = 120;

/** A host session a client may switch to, as GET /v1/sessions lists it. Never carries a file path. */
export interface SessionSummary {
	id: string;
	/** The name given with /name, if any. */
	name?: string;
	/** The name, or else the start of the first prompt. */
	title: string;
	/** ISO 8601. */
	modified: string;
	messageCount: number;
	/** The session the host has open. */
	current: boolean;
}

type Manager = Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId">;

/** Pi's sessions for the open session's working directory, newest first, with their files. */
async function listed(manager: Manager) {
	const dir = manager.getSessionDir();
	const sessions = await SessionManager.list(manager.getCwd(), dir || undefined);
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** The sessions a client may switch to: those in the open session's working directory, newest first. */
export async function sessionSummaries(manager: Manager): Promise<SessionSummary[]> {
	const current = manager.getSessionId();
	return (await listed(manager)).slice(0, MAX_SESSIONS).map((s) => {
		const first = s.firstMessage.replace(/\s+/g, " ").trim();
		const title = s.name?.trim() || (first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1)}…` : first) || "Untitled session";
		return {
			id: s.id,
			...(s.name ? { name: s.name } : {}),
			title,
			modified: s.modified.toISOString(),
			messageCount: s.messageCount,
			current: s.id === current,
		};
	});
}

/** The file of session `id` in the open session's working directory; undefined when there is none. */
export async function sessionPath(manager: Manager, id: string): Promise<string | undefined> {
	return (await listed(manager)).find((s) => s.id === id)?.path;
}
