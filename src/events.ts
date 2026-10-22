/** How many recent events a reconnecting client can replay (docs/protocol.md, GET /v1/events). */
const REPLAY_LIMIT = 5000;

/** An event body as sent on the wire, without its `seq`. */
export type EventBody = { type: string } & Record<string, unknown>;
export type StoredEvent = EventBody & { seq: number };

/**
 * Numbers events, keeps the most recent ones for replay and fans new ones out to live streams.
 * `seq` starts at 1 and is never reused for the lifetime of the buffer.
 */
export class EventBuffer {
	private events: StoredEvent[] = [];
	private subscribers = new Set<(event: StoredEvent) => void>();
	private seq = 0;

	/** Seq of the newest event, or 0 when nothing has happened yet. */
	get lastSeq(): number {
		return this.seq;
	}

	append(body: EventBody): void {
		const event: StoredEvent = { ...body, seq: ++this.seq };
		this.events.push(event);
		if (this.events.length > REPLAY_LIMIT) this.events.shift();
		for (const subscriber of this.subscribers) {
			try {
				subscriber(event);
			} catch {
				// A broken stream must not stop delivery to other clients or break the Pi handler; its close handler cleans up.
			}
		}
	}

	/** Events with seq greater than `after`, or "resync" when the client cannot be caught up from the buffer. */
	replay(after: number): StoredEvent[] | "resync" {
		const oldestKept = this.events[0]?.seq ?? this.seq + 1;
		if (after > this.seq || after + 1 < oldestKept) return "resync";
		return this.events.slice(after + 1 - oldestKept);
	}

	/** Calls `listener` for every future event. Returns the unsubscribe function. */
	subscribe(listener: (event: StoredEvent) => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}
}
