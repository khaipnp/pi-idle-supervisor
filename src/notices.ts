import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** The `type` of `ctx.ui.notify`, sent to clients as a notice's `level`. */
export type NoticeLevel = "info" | "warning" | "error";

const wrapped = new WeakSet<object>();

/**
 * Replaces `notify` on the shared `ctx.ui` (ADR-0001) so every notification still shows on the
 * terminal and is also passed to `onNotify`. Returns false, leaving `ui` untouched, when `notify`
 * is not the plain writable method this relies on.
 */
export function wrapNotify(ui: ExtensionUIContext, onNotify: (message: string, level: NoticeLevel) => void): boolean {
	if (wrapped.has(ui)) return true;
	const descriptor = Object.getOwnPropertyDescriptor(ui, "notify");
	if (typeof descriptor?.value !== "function" || descriptor.writable !== true) return false;
	const { notify } = ui;
	ui.notify = (message, type) => {
		notify.call(ui, message, type);
		onNotify(message, type ?? "info");
	};
	wrapped.add(ui);
	return true;
}
