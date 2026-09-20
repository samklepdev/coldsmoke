import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Keeps the implementation plan honest about the code that actually shipped.
 *
 * Every review fix and accepted deviation used to be applied to the source and
 * silently not to the plan, so re-running it reproduced defects that had
 * already been found and fixed. This test makes that divergence fail loudly
 * instead of accumulating unnoticed.
 */

const ROOT = path.resolve(__dirname, "../..");
const PLAN = path.join(
  ROOT,
  "docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md",
);

const plan = readFileSync(PLAN, "utf8");

const PARTIAL_MARKER = /<!--\s*plan-drift:\s*partial\s*—\s*(.+?)\s*-->/;

type Block = {
  path: string;
  code: string;
  partialReason: string | null;
  kind: "create" | "append";
};

/**
 * Blocks are annotated in the plan as "Create `path`:" or "Append to `path`:"
 * followed by a fenced block. A `plan-drift: partial` comment on the line
 * before marks a block that is deliberately an intermediate state.
 */
function parseBlocks(): Block[] {
  const pattern =
    /(?:(<!--\s*plan-drift:[^>]*-->)\s*\n)?(Create|Append to) `([^`]+\.(?:ts|tsx|css|json))`[^\n]*:\s*\n+```[a-z]*\n([\s\S]*?)```/g;

  const blocks: Block[] = [];
  for (const m of plan.matchAll(pattern)) {
    const [, marker, verb, file, code] = m;
    const reason = marker?.match(PARTIAL_MARKER)?.[1] ?? null;
    blocks.push({
      path: file,
      code: code.trim(),
      partialReason: reason,
      kind: verb === "Create" ? "create" : "append",
    });
  }
  return blocks;
}

const blocks = parseBlocks();

/** Import statements move around as later tasks merge them; code does not. */
function codeLines(source: string): string[] {
  const withoutImports = source.replace(
    /^import\s[\s\S]*?from\s+["'][^"']+["'];\s*$/gm,
    "",
  );
  return withoutImports
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("// Add to the existing"));
}

/** Is `needle` an in-order subsequence of `haystack`? */
function isSubsequence(needle: string[], haystack: string[]): string | null {
  let i = 0;
  for (const line of haystack) {
    if (i < needle.length && line === needle[i]) i++;
  }
  return i === needle.length ? null : needle[i];
}

describe("the plan describes the code that shipped", () => {
  it("finds blocks to check", () => {
    expect(blocks.length).toBeGreaterThan(30);
  });

  it("references no file that does not exist", () => {
    const missing = blocks
      .map((b) => b.path)
      .filter((p) => !existsSync(path.join(ROOT, p)));
    expect([...new Set(missing)]).toEqual([]);
  });

  const full = blocks.filter((b) => b.kind === "create" && !b.partialReason);

  it.each(full.map((b) => [b.path, b] as const))(
    "%s matches the plan byte for byte",
    (_label, block) => {
      const shipped = readFileSync(path.join(ROOT, block.path), "utf8").trim();
      // If this fails, the source changed without the plan being updated.
      // Update the plan's code block to match, do not weaken this test.
      expect(block.code).toBe(shipped);
    },
  );

  const partials = blocks.filter((b) => b.partialReason || b.kind === "append");

  it.each(partials.map((b) => [`${b.kind} ${b.path}`, b] as const))(
    "%s still appears verbatim in the shipped file",
    (_label, block) => {
      // Intermediate and appended blocks cannot equal the final file, so the
      // rule is weaker: every line of code they contain must still be present,
      // in order. Imports are excluded because later tasks merge them.
      const shipped = readFileSync(path.join(ROOT, block.path), "utf8");
      const missing = isSubsequence(codeLines(block.code), codeLines(shipped));
      expect(missing, `line not found in ${block.path}`).toBeNull();
    },
  );

  it("keeps partial blocks rare and justified", () => {
    const marked = blocks.filter((b) => b.partialReason);
    // Each one is a hole in the byte-for-byte guarantee, so they need a stated
    // reason and should not multiply quietly.
    expect(marked.length).toBeLessThanOrEqual(3);
    for (const b of marked) {
      expect(b.partialReason!.length).toBeGreaterThan(20);
    }
  });
});
