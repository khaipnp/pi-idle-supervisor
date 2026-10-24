import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROTOCOL_VERSION } from "../src/server.ts";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const sources = ["src", "test"].flatMap((dir) =>
	readdirSync(join(root, dir))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `${dir}/${name}`),
);

const isComment = (line: string) => /^\s*(\/\/|\/?\*)/.test(line);
/**
 * Code on the line with quoted strings and the trailing comment removed, so prose saying "as" doesn't
 * count. Template literals stay, because a cast can sit inside `${...}`.
 */
const code = (line: string) =>
	line
		.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""')
		.replace(/(^|\s)\/\/.*$/, "");
/** A type assertion (`x as T`), not `as const` or an `import { a as b }` rename. */
const hasCast = (line: string) =>
	!isComment(line) && !/^\s*(import|export)\b/.test(line) && /[\w)\]]\s+as\s+(?!const\b)[\w{([]/.test(code(line));

/**
 * A cast is covered by a `// SAFETY:` comment on its own line or in the comment block right above
 * it; one comment covers a run of consecutive lines that each cast.
 */
function uncoveredCasts(path: string): string[] {
	const lines = read(path).split("\n");
	const found: string[] = [];
	lines.forEach((line, index) => {
		if (!hasCast(line) || line.includes("// SAFETY:")) return;
		let above = index - 1;
		while (above >= 0 && hasCast(lines[above]) && !lines[above].includes("// SAFETY:")) above--;
		if (above >= 0 && lines[above].includes("// SAFETY:")) return;
		while (above >= 0 && isComment(lines[above])) {
			if (lines[above].includes("SAFETY:")) return;
			above--;
		}
		found.push(`${path}:${index + 1}: ${line.trim()}`);
	});
	return found;
}

describe("conventions", () => {
	test("every `as` cast says why it is safe in a `// SAFETY:` comment", () => {
		expect(sources.flatMap(uncoveredCasts)).toEqual([]);
	});

	test("the schema and protocol doc state the version the server speaks", () => {
		expect(read("schema/protocol.schema.json")).toContain(`"title": "pi-idle-supervisor remote control protocol ${PROTOCOL_VERSION}"`);
		const doc = read("docs/protocol.md");
		const stated = [
			...doc.matchAll(/Protocol version: \*\*([\d.]+)\*\*/g),
			...doc.matchAll(/Pi-Remote-Protocol: ([\d.]+)/g),
			...doc.matchAll(/"protocolVersion": "([\d.]+)"/g),
		].map((match) => match[1]);
		expect(stated).toHaveLength(3);
		expect(new Set(stated)).toEqual(new Set([PROTOCOL_VERSION]));
	});
});
