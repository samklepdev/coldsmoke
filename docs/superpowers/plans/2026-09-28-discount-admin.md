# Discount Code Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create and deactivate discount codes, so the redemption path that already works can actually be fed without hand-written SQL.

**Architecture:** A `discountStatus` derivation beside the existing `validateDiscount`, a thin `src/lib/discounts/admin.ts` for the two writes, two Server Actions, and one page at `/admin/discounts` holding both the list and the create form.

**Tech Stack:** Next.js 16.3.5 (App Router, Server Components, Server Actions), React 19.2, Drizzle ORM, Postgres, vitest 5 (node environment), zod 4.

**Spec:** `docs/superpowers/specs/2026-09-28-discount-admin-design.md`

## Global Constraints

- **No migration.** `discount_codes` already has every column: `code`, `type`, `value`, `min_subtotal_cents`, `max_redemptions`, `times_redeemed`, `starts_at`, `ends_at`, `active`, a unique index on `code`, and `CHECK (code = lower(code))`.
- **Create and deactivate only. No editing, no deletion.** A code is a promise made to customers, and `orders.discount_code_id` references it forever.
- **Status is derived, never stored,** and shares the checks — same conditions, same order — with `validateDiscount`, so the admin list cannot disagree with what a customer experiences at the cart.
- **`below_minimum` is never a status.** It describes a cart, not a code.
- **An end date is required by the application** even though the column is nullable. Do not make the column non-null; existing rows and the redemption path must be untouched.
- **Codes are lowercased before insert.** The `CHECK` constraint would otherwise reject mixed case as an opaque database error.
- **A duplicate code is caught from the unique-index violation, not a pre-read.** A read-then-insert can lose the race; the constraint cannot.
- **Server Actions repeat `requireAdminUser()`**, and the tests assert it. The session module is mocked wholesale, so without an explicit assertion, deleting the check leaves every other test green.
- Verification commands: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run test:e2e`.
- DB-backed tests need Postgres: `npm run db:test:up` first.

---

### Task 1: Derive a code's status

**Files:**
- Modify: `src/lib/discounts/validate.ts`
- Test: `src/lib/discounts/validate.test.ts` (**append** if it exists; create if not — check first with `ls src/lib/discounts/`)

**Interfaces:**
- Consumes: nothing.
- Produces: `type DiscountStatus = "live" | "scheduled" | "expired" | "exhausted" | "off"` and `discountStatus(code: DiscountCode, now?: Date): DiscountStatus`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/discounts/validate.test.ts`:

```ts
describe("discountStatus", () => {
  const base = {
    id: "00000000-0000-0000-0000-000000000001",
    code: "spring",
    type: "percent" as const,
    value: 15,
    minSubtotalCents: 0,
    maxRedemptions: null as number | null,
    timesRedeemed: 0,
    startsAt: null as Date | null,
    endsAt: null as Date | null,
    active: true,
  };

  const now = new Date("2026-06-15T12:00:00Z");

  it("is live when nothing stands in the way", () => {
    expect(discountStatus(base, now)).toBe("live");
  });

  it("is off when deactivated", () => {
    expect(discountStatus({ ...base, active: false }, now)).toBe("off");
  });

  it("is scheduled before its start date", () => {
    expect(
      discountStatus({ ...base, startsAt: new Date("2026-07-01T00:00:00Z") }, now),
    ).toBe("scheduled");
  });

  it("is expired after its end date", () => {
    expect(
      discountStatus({ ...base, endsAt: new Date("2026-06-01T00:00:00Z") }, now),
    ).toBe("expired");
  });

  it("is exhausted once the cap is reached", () => {
    expect(
      discountStatus({ ...base, maxRedemptions: 5, timesRedeemed: 5 }, now),
    ).toBe("exhausted");
  });

  it("reports expired rather than live for a code still flagged active", () => {
    // The whole reason this derivation exists: `active` is not the same
    // question as "can a customer use this right now".
    const code = { ...base, active: true, endsAt: new Date("2026-01-01T00:00:00Z") };

    expect(code.active).toBe(true);
    expect(discountStatus(code, now)).toBe("expired");
  });

  it("ignores the minimum subtotal, which is a property of a cart", () => {
    // validateDiscount can fail with below_minimum; that says nothing about
    // whether the code itself is usable, so it must not appear here.
    expect(discountStatus({ ...base, minSubtotalCents: 50_000 }, now)).toBe("live");
  });
});
```

If `src/lib/discounts/validate.test.ts` does not exist, create it with this content preceded by:

```ts
import { describe, it, expect } from "vitest";
import { discountStatus } from "./validate";
```

Otherwise add `discountStatus` to the file's existing import from `./validate` and keep every existing test byte-for-byte.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/discounts/validate.test.ts`
Expected: FAIL — `discountStatus is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/lib/discounts/validate.ts`:

```ts
export type DiscountStatus =
  | "live"
  | "scheduled"
  | "expired"
  | "exhausted"
  | "off";

/**
 * Whether a code is usable right now, for the admin list.
 *
 * Deliberately mirrors validateDiscount's checks in the same order, so the
 * list cannot tell an admin a code is live while the cart tells a customer it
 * is not. If you change one, change the other.
 *
 * `below_minimum` has no counterpart here on purpose: it describes a
 * particular cart, not the code. A code requiring $50 is not broken, it is
 * waiting for a big enough basket.
 */
export function discountStatus(
  code: DiscountCode,
  now: Date = new Date(),
): DiscountStatus {
  if (!code.active) return "off";
  if (code.startsAt && code.startsAt > now) return "scheduled";
  if (code.endsAt && code.endsAt < now) return "expired";
  if (code.maxRedemptions !== null && code.timesRedeemed >= code.maxRedemptions) {
    return "exhausted";
  }
  return "live";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/discounts/validate.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/discounts/validate.ts src/lib/discounts/validate.test.ts
git commit -m "feat: derive whether a discount code is usable right now

Shares its checks with validateDiscount so the admin list cannot disagree with
what a customer sees at the cart. The minimum subtotal is deliberately absent:
that describes a cart, not the code."
```

---

### Task 2: Create and deactivate

**Files:**
- Create: `src/lib/discounts/admin.ts`
- Test: `src/lib/discounts/admin.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `class DiscountInputError extends Error` — every refusal, with a message safe to show an admin
  - `type CreateDiscountInput`
  - `createDiscountCode(input: CreateDiscountInput): Promise<DiscountCode>`
  - `deactivateDiscountCode(id: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/discounts/admin.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { discountCodes } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;

// admin.ts imports `db` at module scope, so without this the suite would talk
// to the dev database instead of the test one. The dynamic import below is
// what keeps the module load after the mock is registered.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const { createDiscountCode, deactivateDiscountCode, DiscountInputError } =
  await import("./admin");

const VALID = {
  code: "spring15",
  type: "percent" as const,
  value: 15,
  minSubtotalCents: 0,
  maxRedemptions: null,
  startsAt: null,
  endsAt: new Date("2099-01-01T00:00:00Z"),
};

async function rows() {
  return ctx.db.select().from(discountCodes);
}

describe("createDiscountCode", () => {
  it("persists every field", async () => {
    const created = await createDiscountCode({
      ...VALID,
      code: "spring15",
      minSubtotalCents: 5000,
      maxRedemptions: 100,
      startsAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(created.code).toBe("spring15");
    expect(created.type).toBe("percent");
    expect(created.value).toBe(15);
    expect(created.minSubtotalCents).toBe(5000);
    expect(created.maxRedemptions).toBe(100);
    expect(created.timesRedeemed).toBe(0);
    expect(created.active).toBe(true);
    expect(created.endsAt).not.toBeNull();
  });

  it("lowercases the code", async () => {
    // There is a CHECK (code = lower(code)) constraint, so a mixed-case
    // insert would otherwise fail as an opaque database error.
    const created = await createDiscountCode({ ...VALID, code: "SPRING15" });

    expect(created.code).toBe("spring15");
  });

  it("refuses a code with no end date", async () => {
    await expect(
      // @ts-expect-error - the type forbids it; this guards the runtime too,
      // because form input arrives untyped.
      createDiscountCode({ ...VALID, endsAt: null }),
    ).rejects.toThrow(DiscountInputError);

    expect(await rows()).toHaveLength(0);
  });

  it("refuses a percentage outside 1-100", async () => {
    await expect(
      createDiscountCode({ ...VALID, value: 0 }),
    ).rejects.toThrow(DiscountInputError);
    await expect(
      createDiscountCode({ ...VALID, value: 101 }),
    ).rejects.toThrow(DiscountInputError);

    expect(await rows()).toHaveLength(0);
  });

  it("refuses an end date before the start date", async () => {
    await expect(
      createDiscountCode({
        ...VALID,
        startsAt: new Date("2030-01-01T00:00:00Z"),
        endsAt: new Date("2029-01-01T00:00:00Z"),
      }),
    ).rejects.toThrow(DiscountInputError);
  });

  it("reports a duplicate code as a friendly error and inserts nothing", async () => {
    await createDiscountCode(VALID);

    await expect(createDiscountCode(VALID)).rejects.toThrow(DiscountInputError);

    expect(await rows()).toHaveLength(1);
  });
});

describe("deactivateDiscountCode", () => {
  it("switches the code off and changes nothing else", async () => {
    const created = await createDiscountCode({
      ...VALID,
      maxRedemptions: 10,
      minSubtotalCents: 2500,
    });
    await ctx.db
      .update(discountCodes)
      .set({ timesRedeemed: 3 })
      .where(eq(discountCodes.id, created.id));

    await deactivateDiscountCode(created.id);

    const [after] = await ctx.db
      .select()
      .from(discountCodes)
      .where(eq(discountCodes.id, created.id));

    expect(after.active).toBe(false);
    // A deactivate that quietly rewrote terms would corrupt what past orders
    // reference, so assert the rest is untouched rather than only the flag.
    expect(after.timesRedeemed).toBe(3);
    expect(after.maxRedemptions).toBe(10);
    expect(after.minSubtotalCents).toBe(2500);
    expect(after.value).toBe(created.value);
    expect(after.endsAt).toEqual(created.endsAt);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/discounts/admin.test.ts`
Expected: FAIL — cannot resolve `./admin`.

- [ ] **Step 3: Implement it**

Create `src/lib/discounts/admin.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { discountCodes, type DiscountCode } from "@/lib/db/schema";

export class DiscountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscountInputError";
  }
}

export type CreateDiscountInput = {
  code: string;
  type: "percent" | "fixed";
  /** 1-100 for percent, cents for fixed. */
  value: number;
  minSubtotalCents: number;
  maxRedemptions: number | null;
  startsAt: Date | null;
  /** Required here even though the column is nullable -- see below. */
  endsAt: Date;
};

/** Postgres unique-violation. */
function isDuplicate(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

/**
 * Creates a code the existing redemption path can use.
 *
 * An end date is required, though the column is nullable and stays that way.
 * A promotion with no expiry and no cap is unbounded liability whose only
 * stopping mechanism is somebody noticing; being stricter than the schema is
 * the point. Existing rows and the customer-facing path are untouched.
 */
export async function createDiscountCode(
  input: CreateDiscountInput,
): Promise<DiscountCode> {
  const code = input.code.trim().toLowerCase();

  if (!code) {
    throw new DiscountInputError("Enter a code.");
  }
  if (!/^[a-z0-9-]+$/.test(code)) {
    throw new DiscountInputError(
      "Codes can use letters, numbers and hyphens only.",
    );
  }
  if (!input.endsAt) {
    throw new DiscountInputError("Give the code an end date.");
  }
  if (input.startsAt && input.startsAt >= input.endsAt) {
    throw new DiscountInputError("The end date must be after the start date.");
  }
  if (!Number.isInteger(input.value) || input.value <= 0) {
    throw new DiscountInputError("Enter a whole amount above zero.");
  }
  if (input.type === "percent" && input.value > 100) {
    throw new DiscountInputError("A percentage cannot be above 100.");
  }
  if (!Number.isInteger(input.minSubtotalCents) || input.minSubtotalCents < 0) {
    throw new DiscountInputError("The minimum cannot be negative.");
  }
  if (
    input.maxRedemptions !== null &&
    (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)
  ) {
    throw new DiscountInputError("A redemption cap must be at least 1.");
  }

  try {
    const [row] = await db
      .insert(discountCodes)
      .values({
        code,
        type: input.type,
        value: input.value,
        minSubtotalCents: input.minSubtotalCents,
        maxRedemptions: input.maxRedemptions,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      })
      .returning();

    return row;
  } catch (error) {
    // Caught from the unique index rather than a pre-read: a read-then-insert
    // can lose the race, the constraint cannot.
    if (isDuplicate(error)) {
      throw new DiscountInputError("That code already exists.");
    }
    throw error;
  }
}

/**
 * Switches a code off. Never deletes: orders.discount_code_id references it
 * forever, and a deleted row would orphan the record of what a customer was
 * actually charged.
 */
export async function deactivateDiscountCode(id: string): Promise<void> {
  await db
    .update(discountCodes)
    .set({ active: false })
    .where(eq(discountCodes.id, id));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/discounts/admin.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/discounts/admin.ts src/lib/discounts/admin.test.ts
git commit -m "feat: create and deactivate discount codes

The redemption path has worked since Plan 1; nothing could feed it. Duplicates
are caught from the unique index rather than a pre-read, because a
read-then-insert can lose the race."
```

---

### Task 3: Server actions

**Files:**
- Create: `src/app/(admin)/admin/discounts/actions.ts`
- Test: `src/app/(admin)/admin/discounts/actions.test.ts`

**Interfaces:**
- Consumes: `createDiscountCode`, `deactivateDiscountCode`, `DiscountInputError` from Task 2.
- Produces: `createDiscountAction`, `deactivateDiscountAction`, `type DiscountAdminState` for Task 4's forms.

Read `src/app/(admin)/admin/orders/[id]/actions.ts` and its tests first: they are the pattern for `requireAdminUser()`, zod parsing, `revalidatePath`, catching a domain error and rethrowing the rest, and for how the session module is mocked.

- [ ] **Step 1: Write the failing test**

Add a new file at `src/app/(admin)/admin/discounts/actions.test.ts`, using the same harness as `src/lib/discounts/admin.test.ts` (Task 2, Step 1) — the `vi.mock` of `@/lib/db/client`, `beforeAll`/`afterAll`/`beforeEach` — plus the `requireAdminUser` mock copied from `src/app/(admin)/admin/orders/[id]/actions.test.ts`. Make that mock a `vi.fn` so the gate can be asserted.

The tests:

```ts
function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const VALID_FIELDS = {
  code: "spring15",
  type: "percent",
  value: "15",
  minSubtotal: "0",
  maxRedemptions: "",
  startsAt: "",
  endsAt: "2099-01-01",
};

describe("createDiscountAction", () => {
  it("creates a code from form input", async () => {
    const state = await createDiscountAction({ status: "idle" }, form(VALID_FIELDS));

    expect(state).toEqual({ status: "created", code: "spring15" });
    const rows = await ctx.db.select().from(discountCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(15);
  });

  it("reports a refusal instead of throwing", async () => {
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, value: "150" }),
    );

    expect(state.status).toBe("error");
    expect(await ctx.db.select().from(discountCodes)).toHaveLength(0);
  });

  it("converts a fixed amount from dollars to cents", async () => {
    await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, code: "tenoff", type: "fixed", value: "10" }),
    );

    const [row] = await ctx.db.select().from(discountCodes);
    expect(row.value).toBe(1000);
  });

  it("rejects rather than reporting a friendly error when something unexpected fails", async () => {
    // A genuine bug must surface, not be flattened into a message an admin
    // reads as normal.
    const boom = vi
      .spyOn(adminModule, "createDiscountCode")
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      createDiscountAction({ status: "idle" }, form(VALID_FIELDS)),
    ).rejects.toThrow("connection reset");

    boom.mockRestore();
  });
});

describe("deactivateDiscountAction", () => {
  it("switches the code off", async () => {
    const created = await createDiscountCode({
      code: "spring15",
      type: "percent",
      value: 15,
      minSubtotalCents: 0,
      maxRedemptions: null,
      startsAt: null,
      endsAt: new Date("2099-01-01T00:00:00Z"),
    });

    const state = await deactivateDiscountAction(
      { status: "idle" },
      form({ id: created.id }),
    );

    expect(state).toEqual({ status: "deactivated" });
    const [row] = await ctx.db.select().from(discountCodes);
    expect(row.active).toBe(false);
  });
});

describe("the admin gate", () => {
  // The session module is mocked wholesale, so without these assertions
  // deleting requireAdminUser() from an action leaves every other test green.
  it("is called by createDiscountAction", async () => {
    requireAdminUser.mockClear();
    await createDiscountAction({ status: "idle" }, form(VALID_FIELDS));
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });

  it("is called by deactivateDiscountAction", async () => {
    requireAdminUser.mockClear();
    await deactivateDiscountAction({ status: "idle" }, form({ id: crypto.randomUUID() }));
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });
});
```

For the spy in the fourth test, import the module namespace: `import * as adminModule from "@/lib/discounts/admin";` and have `actions.ts` call it through that module so the spy applies — or, if that proves awkward with the dynamic-import harness, mock `@/lib/discounts/admin` with `vi.mock` spreading `...actual` and wrapping the two functions in `vi.fn`, the way `restockAction.test.ts` does. Say which you used.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/(admin)/admin/discounts/actions.test.ts"`
Expected: FAIL — cannot resolve `./actions`.

- [ ] **Step 3: Implement the actions**

Create `src/app/(admin)/admin/discounts/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminUser } from "@/lib/auth/session";
import {
  createDiscountCode,
  deactivateDiscountCode,
  DiscountInputError,
} from "@/lib/discounts/admin";

export type DiscountAdminState =
  | { status: "idle" }
  | { status: "created"; code: string }
  | { status: "deactivated" }
  | { status: "error"; error: string };

/**
 * A date input submits "2099-01-01" with no timezone. Parsed as UTC midnight
 * so the same form produces the same instant wherever the admin happens to be.
 */
function parseDate(value: FormDataEntryValue | null): Date | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseOptionalInt(value: FormDataEntryValue | null): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export async function createDiscountAction(
  _prev: DiscountAdminState,
  formData: FormData,
): Promise<DiscountAdminState> {
  await requireAdminUser();

  const type = formData.get("type") === "fixed" ? "fixed" : "percent";
  const rawValue = Number(String(formData.get("value") ?? "").trim());

  if (!Number.isFinite(rawValue)) {
    return { status: "error", error: "Enter an amount." };
  }

  // Percent is entered as a whole number; fixed is entered in dollars and
  // stored in cents, like every other money column in this schema.
  const value = type === "fixed" ? Math.round(rawValue * 100) : rawValue;

  const minSubtotalDollars = Number(
    String(formData.get("minSubtotal") ?? "0").trim() || "0",
  );
  if (!Number.isFinite(minSubtotalDollars) || minSubtotalDollars < 0) {
    return { status: "error", error: "Enter a minimum of zero or more." };
  }

  const endsAt = parseDate(formData.get("endsAt"));
  if (!endsAt) {
    return { status: "error", error: "Give the code an end date." };
  }

  try {
    const created = await createDiscountCode({
      code: String(formData.get("code") ?? ""),
      type,
      value,
      minSubtotalCents: Math.round(minSubtotalDollars * 100),
      maxRedemptions: parseOptionalInt(formData.get("maxRedemptions")),
      startsAt: parseDate(formData.get("startsAt")),
      endsAt,
    });

    revalidatePath("/admin/discounts");
    return { status: "created", code: created.code };
  } catch (error) {
    if (error instanceof DiscountInputError) {
      return { status: "error", error: error.message };
    }
    throw error;
  }
}

export async function deactivateDiscountAction(
  _prev: DiscountAdminState,
  formData: FormData,
): Promise<DiscountAdminState> {
  await requireAdminUser();

  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) {
    return { status: "error", error: "Unknown code." };
  }

  await deactivateDiscountCode(id.data);

  revalidatePath("/admin/discounts");
  return { status: "deactivated" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/(admin)/admin/discounts/actions.test.ts"`
Expected: PASS.

- [ ] **Step 5: Prove the admin gate assertion is load-bearing**

Delete the `await requireAdminUser();` line from `createDiscountAction`.

Run: `npx vitest run "src/app/(admin)/admin/discounts/actions.test.ts"`
Expected: FAIL — "is called by createDiscountAction" only.

Restore the line and confirm green. Report both results. If the suite stayed green with the call deleted, the assertion is not protecting the constraint and must be fixed before moving on.

- [ ] **Step 6: Verify types and lint, then commit**

Run: `npx tsc --noEmit && npm run lint`

```bash
git add "src/app/(admin)/admin/discounts/actions.ts" "src/app/(admin)/admin/discounts/actions.test.ts"
git commit -m "feat: admin actions to create and deactivate discount codes"
```

---

### Task 4: The discounts page

**Files:**
- Create: `src/app/(admin)/admin/discounts/page.tsx`
- Create: `src/app/(admin)/admin/discounts/DiscountForms.tsx`
- Create: `src/app/(admin)/admin/discounts/discounts.module.css`
- Modify: `src/app/(admin)/admin/layout.tsx` (add the nav link)

**Interfaces:**
- Consumes: `discountStatus` (Task 1), the actions and `DiscountAdminState` (Task 3).
- Produces: nothing.

- [ ] **Step 1: Add the nav link**

In `src/app/(admin)/admin/layout.tsx`, the nav currently holds one link. Replace that `<nav>` block with:

```tsx
        <nav className={styles.nav} aria-label="Admin">
          <Link href="/admin/orders">Orders</Link>
          <Link href="/admin/discounts">Discounts</Link>
        </nav>
```

- [ ] **Step 2: Build the forms**

Create `src/app/(admin)/admin/discounts/DiscountForms.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import {
  createDiscountAction,
  deactivateDiscountAction,
  type DiscountAdminState,
} from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./discounts.module.css";

/**
 * Create a code.
 *
 * The value field's label follows the selected type. One input that silently
 * means either 15% or 15 cents is a mis-set promotion waiting to happen.
 */
export function CreateDiscountForm() {
  const [type, setType] = useState<"percent" | "fixed">("percent");
  const [state, action, pending] = useActionState<DiscountAdminState, FormData>(
    createDiscountAction,
    { status: "idle" },
  );

  return (
    <form action={action} className={styles.create}>
      <Field label="Code" name="code" required autoComplete="off" />

      <label className={styles.typeLabel}>
        Type
        <select
          name="type"
          value={type}
          onChange={(event) =>
            setType(event.target.value === "fixed" ? "fixed" : "percent")
          }
        >
          <option value="percent">Percent off</option>
          <option value="fixed">Amount off</option>
        </select>
      </label>

      <Field
        label={type === "percent" ? "Percent off" : "Amount off ($)"}
        name="value"
        type="number"
        min={type === "percent" ? 1 : 0.01}
        max={type === "percent" ? 100 : undefined}
        step={type === "percent" ? 1 : 0.01}
        required
      />

      <Field
        label="Minimum order ($)"
        name="minSubtotal"
        type="number"
        min={0}
        step={0.01}
        defaultValue="0"
      />

      <Field
        label="Max redemptions (blank for unlimited)"
        name="maxRedemptions"
        type="number"
        min={1}
        step={1}
      />

      <Field label="Starts (optional)" name="startsAt" type="date" />
      <Field label="Ends" name="endsAt" type="date" required />

      {state.status === "error" && <p role="alert">{state.error}</p>}
      {state.status === "created" && (
        <p role="status">Created {state.code}.</p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating" : "Create code"}
      </Button>
    </form>
  );
}

export function DeactivateButton({ id, code }: { id: string; code: string }) {
  const [state, action, pending] = useActionState<DiscountAdminState, FormData>(
    deactivateDiscountAction,
    { status: "idle" },
  );

  if (state.status === "deactivated") {
    return <span role="status">Off</span>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      {state.status === "error" && <span role="alert">{state.error}</span>}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving" : `Deactivate ${code}`}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Build the page**

Create `src/app/(admin)/admin/discounts/page.tsx`:

```tsx
import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { discountCodes } from "@/lib/db/schema";
import { discountStatus } from "@/lib/discounts";
import { formatCents } from "@/lib/money";
import { CreateDiscountForm, DeactivateButton } from "./DiscountForms";
import styles from "./discounts.module.css";

export const metadata = { title: "Discounts" };

function terms(code: typeof discountCodes.$inferSelect) {
  const off =
    code.type === "percent"
      ? `${code.value}% off`
      : `${formatCents(code.value)} off`;

  return code.minSubtotalCents > 0
    ? `${off} over ${formatCents(code.minSubtotalCents)}`
    : off;
}

function window(code: typeof discountCodes.$inferSelect) {
  const from = code.startsAt?.toISOString().slice(0, 10) ?? "now";
  const to = code.endsAt?.toISOString().slice(0, 10) ?? "no end";
  return `${from} → ${to}`;
}

export default async function AdminDiscountsPage() {
  // Newest first: the code you just made is the one you are looking for.
  const codes = await db
    .select()
    .from(discountCodes)
    .orderBy(desc(discountCodes.id));

  return (
    <section>
      <h1 className={styles.heading}>Discounts</h1>

      <h2 className={styles.subheading}>New code</h2>
      <CreateDiscountForm />

      <h2 className={styles.subheading}>All codes</h2>
      {codes.length === 0 ? (
        <p>No codes yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Terms</th>
              <th className={styles.right}>Redeemed</th>
              <th>Window</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => {
              const status = discountStatus(code);

              return (
                <tr key={code.id}>
                  <td>{code.code}</td>
                  <td>{status}</td>
                  <td>{terms(code)}</td>
                  <td className={styles.right}>
                    {code.timesRedeemed} / {code.maxRedemptions ?? "∞"}
                  </td>
                  <td>{window(code)}</td>
                  <td>
                    {(status === "live" || status === "scheduled") && (
                      <DeactivateButton id={code.id} code={code.code} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Add the stylesheet**

Create `src/app/(admin)/admin/discounts/discounts.module.css`:

```css
.heading {
  font-size: 1.5rem;
  margin-bottom: 1.5rem;
}

.subheading {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
  margin: 2rem 0 0.75rem;
}

.create {
  display: grid;
  gap: 0.75rem;
  max-width: 28rem;
}

.typeLabel {
  display: grid;
  gap: 0.35rem;
  font-size: 0.875rem;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  text-align: left;
  padding: 0.75rem 0;
  border-bottom: 1px solid rgb(255 255 255 / 0.1);
}

.right {
  text-align: right;
}
```

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean. If `discountStatus` does not resolve from `@/lib/discounts`, check that `src/lib/discounts/index.ts` still has its `export * from "./validate"`.

- [ ] **Step 6: Check it in the running app**

This step is the controller's, not the implementer's — it needs an authenticated admin session. **Skip it and say so in your report.**

- [ ] **Step 7: Commit**

```bash
git add "src/app/(admin)/admin/discounts" "src/app/(admin)/admin/layout.tsx"
git commit -m "feat: create and deactivate discount codes from the admin panel"
```

---

### Task 5: Tie the halves together and verify

**Files:**
- Test: `src/lib/discounts/roundtrip.test.ts` (create)
- Modify: `src/test/plan-drift.test.ts` (the `PLANS` array)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Write the round-trip test**

This is the seam where a created code could satisfy the form and still be unusable at the cart, and nothing else would notice.

Add a new file at `src/lib/discounts/roundtrip.test.ts` using the same harness as `src/lib/discounts/admin.test.ts` (Task 2, Step 1), plus:

```ts
const { createDiscountCode } = await import("./admin");
const { lookupDiscount, validateDiscount, redeemDiscount } = await import("./index");

describe("a created code is redeemable", () => {
  it("validates and redeems through the customer path", async () => {
    await createDiscountCode({
      code: "ROUNDTRIP10",
      type: "percent",
      value: 10,
      minSubtotalCents: 0,
      maxRedemptions: 5,
      startsAt: null,
      endsAt: new Date("2099-01-01T00:00:00Z"),
    });

    // The customer types it in any case; lookup normalises.
    const found = await lookupDiscount("RoundTrip10");
    expect(found).not.toBeNull();

    const result = validateDiscount(found, 5000);
    expect(result.ok).toBe(true);

    await ctx.db.transaction(async (tx) => {
      expect(await redeemDiscount(tx, found!.id)).toBe(true);
    });

    const [after] = await ctx.db.select().from(discountCodes);
    expect(after.timesRedeemed).toBe(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/discounts/roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 3: Register this plan with the drift guard**

`src/test/plan-drift.test.ts` compares every `Create` block in a registered plan byte for byte against the shipped file. An unregistered plan is silently unguarded.

Append to `src/test/plan-drift.test.ts`:

```ts
  "docs/superpowers/plans/2026-09-28-discount-admin.md",
```

- [ ] **Step 4: Run the guard and reconcile**

Run: `npx vitest run src/test/plan-drift.test.ts`

Expected: it may FAIL, naming the files this plan creates. For each, decide which side is right: if the shipped code is correct, update this plan's code block to match it. **Do not weaken the test and do not add `plan-drift: partial` markers to dodge a comparison.**

Re-run until it passes.

- [ ] **Step 5: Full verification**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e`
Expected: all green.

The payment e2e (`a guest can buy a bottle`) self-skips unless a `stripe listen` is forwarding. **A skip means it did not run.** To exercise it:

```bash
STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,charge.refunded \
  --forward-to localhost:3000/api/stripe/webhook
```

Pass the key via `STRIPE_API_KEY` in the environment rather than `--api-key`, so it stays out of `ps` — the e2e's skip guard reads `ps -ax -o args=`. CLI 1.51 requires `--events`; a bare `stripe listen` exits 1.

Report which of the two happened.

- [ ] **Step 6: Commit**

```bash
git add src/lib/discounts/roundtrip.test.ts src/test/plan-drift.test.ts docs/superpowers/plans
git commit -m "test: prove a created discount code redeems, and guard this plan"
```

---

## Success criteria

- An admin can create a working discount code without touching SQL, and a customer can redeem it immediately.
- The list reports whether each code is usable right now, using the same rules the cart uses.
- Deactivating a code stops new redemptions and changes nothing else about it.
- No code can be created without an end date, with a duplicate code, or with a percentage outside 1-100.
- Deleting `requireAdminUser()` from either action fails a test.
- `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run test:e2e` are green, with this plan registered in the drift guard.
