# Cart Quantity Stepper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cart page's number input and "Update" button with a −/＋ stepper that applies each change immediately.

**Architecture:** One new Client Component renders the per-line controls as submit buttons carrying their target quantity, so the form still works without JavaScript. `useOptimistic` moves the displayed count instantly; every money figure continues to come from `quote()` on the server after `revalidatePath`. The Server Action is untouched.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19 (`useOptimistic`), CSS Modules, Vitest, Playwright.

Spec: `docs/superpowers/specs/2026-09-20-cart-quantity-stepper-design.md`

## Global Constraints

- Money is computed **only** in `src/lib/pricing/quote.ts`. No price arithmetic in any client component. Optimism covers the integer count and nothing else.
- The cart must remain usable with JavaScript disabled. Controls are `<button type="submit">` inside a form posting to a Server Action — never `onClick`-only handlers.
- `MAX_LINE_QUANTITY` (99) is imported from **`@/lib/cart/limits`**, never from `@/lib/cart`, and never hardcoded. `@/lib/cart` pulls in `next/headers` and the Postgres client; importing it from a Client Component drags `fs`/`net`/`tls` and the DB driver into the browser bundle and the build fails with *"Module not found: Can't resolve 'fs'"*. Task 1 creates that module. This was verified by building it and watching it break, not assumed.
- Control borders use `--line-bright`, not `--line`. `--line` is 1.70:1 on `--panel` and fails WCAG 1.4.11; `--line-bright` is 3.13:1 and passes.
- `setQuantityAction(formData: FormData): Promise<void>` in `src/app/(store)/actions.ts` is **not** modified by this plan.
- `src/test/plan-drift.test.ts` asserts every `Create \`path\`` block in `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` matches the file byte for byte. Touching `cart/page.tsx` or adding a tracked file fails `npm test` until that plan and `.superpowers/sdd/task-13-brief.md` are synced. Task 5 does this.
- Run the dev server and `stripe listen` separately; never run `npm run build` while `next dev` is running — they share `.next`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/cart/limits.ts` (create) | `MAX_LINE_QUANTITY`, free of server-only imports so a Client Component can read it. Same reason `src/lib/cookies.ts` exists. |
| `src/lib/cart/index.ts` (modify) | Re-export the constant from `./limits` instead of declaring it, so existing importers are untouched. |
| `src/app/(store)/cart/QuantityStepper.tsx` (create) | Client Component. Renders −/count/＋/Remove for one line. Owns the optimistic count. Knows nothing about money. |
| `src/app/(store)/cart/page.module.css` (modify) | Styles for the stepper; drop the now-unused `.qty` input rule. |
| `src/app/(store)/cart/page.tsx` (modify) | Swap the input + Update button for `<QuantityStepper />`. Nothing else changes. |
| `e2e/checkout.spec.ts` (modify) | Replace the free-text-box test with stepper coverage. |
| `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` (modify) | Sync so the drift guard passes. |
| `.superpowers/sdd/task-13-brief.md` (modify) | Same sync. |

---

### Task 1: Make the quantity cap importable from a Client Component

**Files:**
- Create: `src/lib/cart/limits.ts`
- Modify: `src/lib/cart/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_LINE_QUANTITY: number` from `@/lib/cart/limits`, still re-exported from `@/lib/cart`.

**Why this task exists:** `src/lib/cart/index.ts` imports `next/headers` and `@/lib/db/client`. A Client Component that imports anything from it — even a plain number — pulls that whole graph into the browser bundle, and the build fails with `Module not found: Can't resolve 'fs'`. The constant has to live somewhere server-free first. This is the same problem `src/lib/cookies.ts` was created to solve.

- [ ] **Step 1: Create the limits module**

Create `src/lib/cart/limits.ts`:

```ts
/**
 * Cart limits, kept free of server-only imports.
 *
 * `@/lib/cart` pulls in next/headers and the Postgres client, so a Client
 * Component importing a constant from it drags fs/net/tls and the database
 * driver into the browser bundle and the build fails. Same reason
 * `src/lib/cookies.ts` exists.
 */

/**
 * Per-line ceiling shared by the quantity controls and the actions that write
 * them. cart_items.quantity is int4 with no CHECK constraint, so an unbounded
 * value would eventually overflow on the `quantity + n` upsert in addItem.
 */
export const MAX_LINE_QUANTITY = 99;
```

- [ ] **Step 2: Re-export it from the cart barrel**

In `src/lib/cart/index.ts`, delete the `MAX_LINE_QUANTITY` doc comment and its `export const` declaration, and put this single line in their place:

```ts
export { MAX_LINE_QUANTITY } from "./limits";
```

Leave every other export alone. Existing importers (`src/app/(store)/actions.ts`, `src/app/(store)/product/[slug]/page.tsx`) keep working unchanged.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; `Test Files 17 passed`, `Tests 236 passed`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/cart/limits.ts src/lib/cart/index.ts
git commit -m "refactor: move MAX_LINE_QUANTITY somewhere a client component can import"
```

---

### Task 2: The stepper component

**Files:**
- Create: `src/app/(store)/cart/QuantityStepper.tsx`
- Modify: `src/app/(store)/cart/page.module.css`

**Interfaces:**
- Consumes: `setQuantityAction(formData: FormData): Promise<void>` from `../actions`; `MAX_LINE_QUANTITY: number` from `@/lib/cart/limits`.
- Produces: `QuantityStepper({ productId, name, quantity }: { productId: string; name: string; quantity: number }): JSX.Element`

- [ ] **Step 1: Add the stepper styles**

Replace the `.qty` rule in `src/app/(store)/cart/page.module.css` (currently lines 40–47) with the following. Keep `.qtyForm` exactly as it is.

```css
.stepper {
  display: flex;
  align-items: center;
  /* --line-bright, not --line: this is a control border and must clear 3:1. */
  border: 1px solid var(--line-bright);
}

.stepButton {
  width: 2.25rem;
  height: 2.25rem;
  display: grid;
  place-items: center;
  background: var(--panel);
  color: var(--text-bright);
  border: 0;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.stepButton:hover:not(:disabled) {
  background: var(--panel-raised);
}

.stepButton:disabled {
  color: var(--text-faint);
  cursor: default;
}

.count {
  min-width: 2.5rem;
  text-align: center;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
}

/* Dim the row while the server catches up, without moving anything. */
.pending {
  opacity: 0.6;
}

.remove {
  background: none;
  border: 0;
  padding: 0;
  margin-left: var(--space-3);
  color: var(--text-dim);
  font-size: 0.78rem;
  text-decoration: underline;
  cursor: pointer;
}

.remove:hover {
  color: var(--text-bright);
}
```

- [ ] **Step 2: Create the component**

Create `src/app/(store)/cart/QuantityStepper.tsx`:

```tsx
"use client";

import { useOptimistic } from "react";
import { MAX_LINE_QUANTITY } from "@/lib/cart/limits";
import { setQuantityAction } from "../actions";
import styles from "./page.module.css";

/**
 * Per-line quantity control.
 *
 * Every control is a submit button carrying the quantity it would produce, so
 * the form still works with JavaScript disabled — the rest of the store is
 * built on Server Components and form actions, and this should not be the one
 * control that silently does nothing without JS.
 *
 * Optimism stops at the integer count. Line totals and the cart summary come
 * from quote() on the server, because a second money implementation on the
 * client can silently disagree with the first.
 */
export function QuantityStepper({
  productId,
  name,
  quantity,
}: {
  productId: string;
  name: string;
  quantity: number;
}) {
  const [optimisticQuantity, setOptimisticQuantity] = useOptimistic(quantity);

  // While an update is in flight the optimistic count is ahead of the prop;
  // once the server responds and the page re-renders they agree again.
  //
  // Do NOT use useTransition's isPending here. A form action already runs in a
  // transition, so the hook's flag reads false on every render — measured, not
  // assumed — and the dimming would never appear.
  const isPending = optimisticQuantity !== quantity;

  async function submit(formData: FormData) {
    // The clicked button supplies the target quantity. A form action is
    // already a transition, so the optimistic update needs no extra wrapping.
    const next = Number(formData.get("quantity"));
    if (Number.isInteger(next)) setOptimisticQuantity(next);
    await setQuantityAction(formData);
  }

  return (
    <form action={submit} className={styles.qtyForm}>
      <input type="hidden" name="productId" value={productId} />

      <div className={`${styles.stepper} ${isPending ? styles.pending : ""}`}>
        <button
          type="submit"
          name="quantity"
          value={quantity - 1}
          className={styles.stepButton}
          // Stops a fast decrement run from deleting the line. Removal is a
          // separate, deliberate control.
          disabled={quantity <= 1}
          aria-label={`One fewer ${name}`}
        >
          −
        </button>

        <span className={styles.count} aria-live="polite">
          {optimisticQuantity}
        </span>

        <button
          type="submit"
          name="quantity"
          value={quantity + 1}
          className={styles.stepButton}
          disabled={quantity >= MAX_LINE_QUANTITY}
          aria-label={`One more ${name}`}
        >
          +
        </button>
      </div>

      <button
        type="submit"
        name="quantity"
        value={0}
        className={styles.remove}
        aria-label={`Remove ${name}`}
      >
        Remove
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no output (the component is not yet imported, which is fine — it must still typecheck).

- [ ] **Step 4: Commit**

```bash
git add src/app/\(store\)/cart/QuantityStepper.tsx src/app/\(store\)/cart/page.module.css
git commit -m "feat: add the cart quantity stepper component"
```

---

### Task 3: Use the stepper on the cart page

**Files:**
- Modify: `src/app/(store)/cart/page.tsx`

**Interfaces:**
- Consumes: `QuantityStepper` from `./QuantityStepper`.
- Produces: nothing new.

- [ ] **Step 1: Replace the quantity control**

In `src/app/(store)/cart/page.tsx`, delete the entire `<form action={setQuantityAction} className={styles.qtyForm}>…</form>` block (the hidden input, the `sr-only` label, the explanatory comment about `required`, the number input, and the `Update` button) and put this in its place:

```tsx
          <QuantityStepper
            productId={line.productId}
            name={line.name}
            quantity={line.quantity}
          />
```

- [ ] **Step 2: Fix the imports**

`setQuantityAction`, `Button` and `MAX_LINE_QUANTITY` may no longer be used by this file. Set the import block to exactly:

```tsx
import type { Metadata } from "next";
import { getCartId, getCartLines } from "@/lib/cart";
import { quote, FREE_SHIPPING_THRESHOLD_CENTS } from "@/lib/pricing/quote";
import { formatCents } from "@/lib/money";
import { ButtonLink } from "@/components/ui/Button";
import { getActiveDiscount } from "../actions";
import { QuantityStepper } from "./QuantityStepper";
import styles from "./page.module.css";
```

`ButtonLink` stays — the empty-cart "Shop" link and the "Checkout" link both use it.

- [ ] **Step 3: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output from either. An unused-import error here means Step 2 was not applied exactly.

- [ ] **Step 4: See it in the real app**

Start the dev server (`npm run dev`), add a bottle, and open `http://localhost:3000/cart`.

Expected: a `− 1 +` control with `−` greyed out, a `Remove` link, and no `Update` button. Clicking `+` changes the count immediately and the subtotal follows a moment later. Two bottles ($90.00) flips Shipping to "Free".

- [ ] **Step 5: Commit**

```bash
git add src/app/\(store\)/cart/page.tsx
git commit -m "feat: auto-update the cart from a quantity stepper"
```

---

### Task 4: End-to-end coverage

**Files:**
- Modify: `e2e/checkout.spec.ts`

**Interfaces:**
- Consumes: the running app.
- Produces: nothing other tasks use.

**Context the implementer needs:** the existing test named `a rejected quantity says why instead of silently doing nothing` (starts at line 72) drives a free-text quantity box that no longer exists. Replace that one test. Leave the other four tests alone. `addBottleToCart(page)` is an existing helper at the top of the file that leaves the browser on `/cart` with one bottle.

- [ ] **Step 1: Replace the obsolete test**

Delete the whole `test("a rejected quantity says why instead of silently doing nothing", …)` block and put these in its place:

```ts
test("the stepper changes quantity and price without an update button", async ({
  page,
}) => {
  await addBottleToCart(page);

  const subtotal = async () =>
    (await page.locator("main").innerText()).match(/Subtotal\s*\$([0-9.,]+)/)?.[1];

  await expect(page.getByRole("button", { name: "Update" })).toHaveCount(0);
  expect(await subtotal()).toBe("45.00");

  await page.getByRole("button", { name: /^One more / }).click();
  // Two bottles is $90, which also clears the free-shipping threshold.
  await expect(page.getByText("$90.00").first()).toBeVisible();
  await expect(page.getByText("Free")).toBeVisible();

  await page.getByRole("button", { name: /^One fewer / }).click();
  await expect(page.getByText("$45.00").first()).toBeVisible();
  expect(await subtotal()).toBe("45.00");
});

test("the stepper cannot delete a line", async ({ page }) => {
  await addBottleToCart(page);

  // Removal is a separate, deliberate control, so one click past the end of a
  // decrement run must not empty the cart.
  await expect(page.getByRole("button", { name: /^One fewer / })).toBeDisabled();
  await expect(page.getByText("Your cart is empty.")).toHaveCount(0);
});

test("Remove clears the line", async ({ page }) => {
  await addBottleToCart(page);

  await page.getByRole("button", { name: /^Remove / }).click();

  await expect(page.getByText("Your cart is empty.")).toBeVisible();
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx playwright test -g "stepper|Remove clears"`
Expected: 3 passed.

- [ ] **Step 3: Run the whole e2e suite**

Run: `npx playwright test`
Expected: 6 passed, 1 skipped — or 7 passed if `stripe listen` is running and `STRIPE_SECRET_KEY` is real. The payment test skips itself without real keys.

- [ ] **Step 4: Commit**

```bash
git add e2e/checkout.spec.ts
git commit -m "test: cover the cart stepper and drop the obsolete input test"
```

---

### Task 5: Sync the plan so the drift guard passes

**Files:**
- Modify: `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md`
- Modify: `.superpowers/sdd/task-13-brief.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Context the implementer needs:** `src/test/plan-drift.test.ts` asserts that every ``Create `path`:`` block in the Plan 1 document matches the file on disk byte for byte. Task 3 changed `cart/page.tsx`, so that test is now failing. This is the guard working, not a bug — the fix is to update the plan, never to weaken the test.

- [ ] **Step 1: Confirm the guard is failing, and why**

Run: `npx vitest run src/test/plan-drift.test.ts`
Expected: FAIL on `src/app/(store)/cart/page.tsx matches the plan byte for byte`.

- [ ] **Step 2: Sync both documents**

For each of the two files, find the fenced block introduced by ``Create `src/app/(store)/cart/page.tsx`:`` and replace its entire contents with the current contents of that source file. Then add the new component to Plan 1's Task 13 and to the brief, directly after the cart page block:

````markdown
Create `src/app/(store)/cart/QuantityStepper.tsx`:

```tsx
<paste the full contents of src/app/(store)/cart/QuantityStepper.tsx>
```
````

Also update Task 13's **Files:** line in both documents so it reads:

```markdown
- Create: `src/app/(store)/cart/page.tsx` + `.module.css`, `src/app/(store)/cart/DiscountForm.tsx`, `src/app/(store)/cart/QuantityStepper.tsx`
```

And replace the `page.module.css` block in both documents with the current file contents, since Task 2 changed it.

- [ ] **Step 3: Verify the guard passes**

Run: `npx vitest run src/test/plan-drift.test.ts`
Expected: PASS. The count of checked files rises by one (`QuantityStepper.tsx` is now tracked).

- [ ] **Step 4: Full verification**

Run each of these and confirm the expected result:

```bash
npm test          # Test Files 17 passed, Tests 237+ passed
npx tsc --noEmit  # no output
npm run lint      # no output
```

Then stop the dev server and run `npm run build` — expected: 10 routes, no errors. (`next build` and `next dev` share `.next`; running both at once corrupts it.)

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md .superpowers/sdd/task-13-brief.md
git commit -m "docs: sync Plan 1 with the cart stepper"
```

---

### Task 6: Confirm the no-JS path still works

**Files:** none — this is a verification task.

**Interfaces:**
- Consumes: the running app.
- Produces: nothing.

**Context the implementer needs:** the whole reason the stepper uses submit buttons rather than `onClick` is that it must degrade. Nothing in the automated suite covers JavaScript being off, so this is checked by hand once and recorded.

- [ ] **Step 1: Load the cart with JavaScript disabled**

With the dev server running, launch a throwaway Chromium with JS off and drive it manually:

```bash
npx playwright open --device="Desktop Chrome" http://localhost:3000/shop
```

In the opened browser, use DevTools → Settings → Debugger → **Disable JavaScript**, then add a bottle to the cart and open `/cart`.

- [ ] **Step 2: Verify each control**

Expected with JavaScript disabled:
- `+` submits and the page reloads showing quantity 2 and Subtotal $90.00.
- `−` submits and the page reloads showing quantity 1 and Subtotal $45.00.
- `−` is unclickable at quantity 1.
- `Remove` empties the cart.

There is no optimistic update in this mode — each click is a full page round trip. That is the expected degraded behaviour, not a failure.

- [ ] **Step 3: Record the result**

Append to `.superpowers/sdd/progress.md`:

```markdown
## Cart quantity stepper (2026-09-20)

Replaced the cart's number input + Update button with a -/+ stepper.
- Optimistic count only; every money figure still comes from quote().
- Removal is a separate control, so no stepper click sequence can delete a
  line.
- Verified by hand with JavaScript disabled: +, -, and Remove all work via
  native form submission, with a full round trip and no optimism.
- The blank-quantity bug reported on 2026-09-20 is now structurally
  impossible rather than guarded — there is no free-text box to clear.
```

- [ ] **Step 4: Commit**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs: record the cart stepper's no-JS verification"
```

---

## Self-Review

**Spec coverage.** §3 component boundary → Tasks 2–3. §3 no-JS markup → Task 2 Step 2, verified in Task 6. §3 data flow and the money rule → Task 2 Step 2 plus Global Constraints. §4 bounds and removal → Task 2 Step 2 (`disabled` on both buttons, separate Remove), tested in Task 4. §5 error handling → the optimistic value reverting is inherent to `useOptimistic` re-rendering from the new prop; rapid clicking is covered by `startTransition`. §6 accessibility → `aria-label`s and `aria-live` in Task 2, asserted by name in Task 4. §7 testing → Task 4. §8 plan drift → Task 5. §9 success criteria → Task 5 Step 4 and Task 6.

**Deliberately not covered:** stock availability in the stepper, typing an exact quantity, and undo-after-removal are all out of scope per spec §2 and have no tasks.

**Type consistency.** `QuantityStepper` takes `{ productId: string; name: string; quantity: number }` in Task 2 and is called with exactly those three props in Task 3. `setQuantityAction(formData: FormData)` is used unchanged. `MAX_LINE_QUANTITY` is imported, never inlined.

**Known risk for the implementer.** `useOptimistic` must be called inside a component that re-renders with a fresh `quantity` prop, which it does because the cart page is a dynamic Server Component and `setQuantityAction` calls `revalidatePath("/cart")`. If the count appears to stick at its optimistic value after the server responds, the cause is a missing revalidate, not the hook.
