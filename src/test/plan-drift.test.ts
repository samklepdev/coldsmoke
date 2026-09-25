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

/**
 * Every plan whose code blocks must still describe the shipped code.
 *
 * Add a plan here when its implementation lands. A plan left off this list is
 * unguarded, which is the state this file exists to prevent -- and the
 * omission is silent, because the suite stays green either way.
 */
const PLANS = [
  "docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md",
  "docs/superpowers/plans/2026-09-20-admin-orders.md",
  "docs/superpowers/plans/2026-09-23-railway-reservation-cron.md",
  "docs/superpowers/plans/2026-09-20-customer-accounts.md",
  "docs/superpowers/plans/2026-09-20-cart-quantity-stepper.md",
  "docs/superpowers/plans/2026-09-20-marketing-and-legal-pages.md",
].map((p) => path.join(ROOT, p));

// Joined with blank lines: the block parser is anchored on "Create `path`:"
// headings, so concatenating cannot invent a heading that spans two documents.
const plan = PLANS.map((p) => readFileSync(p, "utf8")).join("\n\n");

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
      // Trailing whitespace only. `.trim()` also stripped the indentation from
      // the FIRST line, so an appended block that starts indented -- which a
      // fragment spliced into an existing file usually does -- could never
      // match the shipped line and was silently unverifiable.
      code: code.replace(/\s+$/, ""),
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

  it("parses every block the plan declares", () => {
    // A malformed heading — a stray backtick, a missing colon — makes the
    // parser skip the block silently, so the file it names stops being
    // checked while the suite stays green. That happened once: a trailing
    // backtick dropped cart/page.tsx from the guard, and because another
    // file was added in the same commit the total count did not move.
    //
    // So count the declarations independently of the parser and require
    // that every one produced a block.
    const declared = [...plan.matchAll(/^(?:Create|Append to) `([^`]+)`/gm)]
      .map((m) => m[1])
      .filter((p) => /\.(ts|tsx|css|json)$/.test(p));

    const parsed = blocks.map((b) => b.path);
    const unparsed = declared.filter((p, i) => {
      // Allow for the same path being declared more than once.
      const declaredBefore = declared.slice(0, i).filter((x) => x === p).length;
      const parsedCount = parsed.filter((x) => x === p).length;
      return declaredBefore >= parsedCount;
    });

    expect(unparsed, "declared in the plan but not parsed — check the heading syntax").toEqual([]);
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
