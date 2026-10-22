import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { EventBody } from "./events.ts";

/** How many closed dialog ids are remembered, so a late answer gets 409 instead of 404. */
const CLOSED_MEMORY = 1000;

export interface Dialog {
	id: string;
	kind: "confirm" | "select" | "input";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	expiresAt?: number;
}

type DialogSpec = Omit<Dialog, "id" | "expiresAt">;
export type ClosedBy = "terminal" | "remote" | "timeout" | "cancelled";
export type DialogAnswerResult = "ok" | "unknown" | "closed" | "invalid";

interface Pending {
	dialog: Dialog;
	/** What the caller receives when the dialog is dismissed without an answer. */
	cancelValue: unknown;
	finish(closedBy: ClosedBy, value: unknown): void;
}

/**
 * Dialogs opened through the shared `ctx.ui` while remote is on (ADR-0001). Each one is shown in
 * the terminal and offered to remote clients; the first answer wins and the other side is dismissed.
 */
export class Dialogs {
	private readonly pending = new Map<string, Pending>();
	private readonly closed = new Set<string>();
	private nextId = 1;

	constructor(private readonly emit: (body: EventBody) => void) {}

	/** Dialogs still waiting for an answer, oldest first (the snapshot's `dialogs`). */
	list(): Dialog[] {
		return [...this.pending.values()].map((p) => p.dialog);
	}

	/**
	 * Shows the dialog on the terminal via `terminal` and to remote clients. `terminal` receives the
	 * caller's options with a signal that is aborted when anything else ends the dialog.
	 */
	ask<T>(
		spec: DialogSpec,
		opts: ExtensionUIDialogOptions | undefined,
		terminal: (opts: ExtensionUIDialogOptions) => Promise<T>,
		cancelValue: T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(cancelValue);
		const id = `d-${this.nextId++}`;
		const timeout = opts?.timeout;
		const expiresAt = timeout ? Date.now() + timeout : undefined;
		const dialog: Dialog = { id, ...spec, ...(expiresAt === undefined ? {} : { expiresAt }) };
		const terminalSignal = new AbortController();

		return new Promise<T>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onCallerAbort = () => finish("cancelled", cancelValue);
			const finish = (closedBy: ClosedBy, value: unknown) => {
				if (!this.pending.delete(id)) return; // someone else already won
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onCallerAbort);
				terminalSignal.abort(); // dismisses the terminal dialog when it is not the winner
				this.closed.add(id);
				if (this.closed.size > CLOSED_MEMORY) // SAFETY: the set is non-empty here, so the iterator has a first value.
				this.closed.delete(this.closed.values().next().value!);
				this.emit({ type: "dialog_closed", dialogId: id, closedBy });
				// SAFETY: `value` is the terminal's result, `cancelValue`, or a remote value checked against `spec` in answer().
				resolve(value as T);
			};

			this.pending.set(id, { dialog, cancelValue, finish });
			this.emit({ type: "dialog_open", dialog });
			opts?.signal?.addEventListener("abort", onCallerAbort, { once: true });
			if (timeout) timer = setTimeout(() => finish("timeout", cancelValue), timeout);
			// Only our timer enforces the timeout, so a terminal answer is never mislabelled as one.
			terminal({ signal: terminalSignal.signal }).then(
				(value) => finish("terminal", value),
				() => finish("terminal", cancelValue),
			);
		});
	}

	/** Dismisses every pending dialog, e.g. when remote goes off; the callers get their cancel value. */
	dispose(): void {
		for (const pending of [...this.pending.values()]) pending.finish("cancelled", pending.cancelValue);
	}

	/** Applies a remote client's answer: `{value}` or `{cancelled: true}`. */
	answer(id: string, body: unknown): DialogAnswerResult {
		const pending = this.pending.get(id);
		if (!pending) return this.closed.has(id) ? "closed" : "unknown";
		const fields = typeof body === "object" && body !== null ? (body as { value?: unknown; cancelled?: unknown }) : {};
		if (fields.cancelled === true) {
			pending.finish("remote", pending.cancelValue);
			return "ok";
		}
		if (!isValidValue(pending.dialog, fields.value)) return "invalid";
		pending.finish("remote", fields.value);
		return "ok";
	}
}

function isValidValue(dialog: Dialog, value: unknown): boolean {
	switch (dialog.kind) {
		case "confirm":
			return typeof value === "boolean";
		case "select":
			return typeof value === "string" && (dialog.options ?? []).includes(value);
		case "input":
			return typeof value === "string";
	}
}

const wrapped = new WeakSet<object>();
const METHODS = ["select", "confirm", "input"] as const;

/**
 * Replaces `select`/`confirm`/`input` on the shared `ctx.ui` with wrappers that route through the
 * current `Dialogs` while remote is on and call the original untouched otherwise. Relies on
 * unofficial behaviour (ADR-0001), so it first checks the shape it expects and returns false,
 * leaving `ui` untouched, when that does not hold.
 */
export function wrapDialogs(ui: ExtensionUIContext, current: () => Dialogs | undefined): boolean {
	if (wrapped.has(ui)) return true;
	const writable = METHODS.every((m) => {
		const descriptor = Object.getOwnPropertyDescriptor(ui, m);
		return typeof descriptor?.value === "function" && descriptor.writable === true;
	});
	if (!writable) return false;

	const { select, confirm, input } = ui;
	ui.select = (title, options, opts) => {
		const dialogs = current();
		if (!dialogs) return select.call(ui, title, options, opts);
		return dialogs.ask({ kind: "select", title, options }, opts, (o) => select.call(ui, title, options, o), undefined);
	};
	ui.confirm = (title, message, opts) => {
		const dialogs = current();
		if (!dialogs) return confirm.call(ui, title, message, opts);
		return dialogs.ask({ kind: "confirm", title, message }, opts, (o) => confirm.call(ui, title, message, o), false);
	};
	ui.input = (title, placeholder, opts) => {
		const dialogs = current();
		if (!dialogs) return input.call(ui, title, placeholder, opts);
		return dialogs.ask(
			{ kind: "input", title, ...(placeholder === undefined ? {} : { placeholder }) },
			opts,
			(o) => input.call(ui, title, placeholder, o),
			undefined,
		);
	};
	wrapped.add(ui);
	return true;
}
