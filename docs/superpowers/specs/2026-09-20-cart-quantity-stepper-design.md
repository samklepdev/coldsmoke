# Cart Quantity Stepper — Design

**Date:** 2026-09-20
**Status:** Approved design, pending implementation plan

Replace the cart page's number input and "Update" button with a −/＋ stepper that
applies each change immediately.

---

## 1. Why

Two reasons, one of them a defect.

**The Update button is a hidden step.** A customer changes the number and the price
does not move until they find and press a second control. Every storefront convention
says the quantity control *is* the commit.

**The current control has a silent failure.** Clearing the box and submitting used to
change nothing, with no error and no update — reported from real use on 2026-09-20 and
fixed in `36f6b51` by adding `required` so constraint validation refuses blank input.
That fix guards the hole. A stepper removes it: there is no free-text box to clear, so
the class of input that produced the bug can no longer be entered.

This is worth stating precisely because it changes what "fixed" means. `36f6b51`
prevents a bad value from being submitted silently. This design prevents a bad value
from being *expressible*.

---

## 2. Scope

### In scope

- A client component replacing the per-line quantity input and Update button.
- Immediate application of each −/＋ click.
- An explicit Remove control, separate from the stepper.
- Optimistic display of the quantity only.
- Replacement e2e coverage for the control that ceases to exist.

### Out of scope

- **Stock availability in the stepper.** `getCartLines` returns `QuoteLine`, which has
  no availability field; adding one means a catalog join on every cart render. Checkout
  already reports out-of-stock by name and clamps the cart, and reservation happens
  there, not in the cart. Unchanged.
- **Typing an exact quantity.** The stepper is the only quantity control. Someone
  wanting 12 bottles clicks ＋ eleven times or, more realistically, does not exist for
  a two-SKU cologne shop. Revisit if the catalogue grows.
- **Undo after removal.** Removal is already deliberate — see §4.
- The discount form, totals markup, and checkout flow.

---

## 3. Architecture

### Component boundary

| Unit | Responsibility |
|---|---|
| `cart/page.tsx` (Server Component) | Loads lines, prices them via `quote()`, renders totals. Unchanged apart from swapping the control. |
| `cart/QuantityStepper.tsx` (Client Component, new) | Renders −/＋/Remove for one line, owns the optimistic count. Knows nothing about money. |
| `setQuantityAction` (Server Action) | Unchanged. Validates and writes. |

The stepper receives `productId`, `name`, and `quantity`. It returns no data; the page
re-renders from the server after the action.

### Markup — works without JavaScript

Each control is a submit button carrying the quantity it would produce:

```tsx
<button name="quantity" value={quantity - 1} aria-label={`One fewer ${name}`}>−</button>
<span aria-live="polite">{optimisticQuantity}</span>
<button name="quantity" value={quantity + 1} aria-label={`One more ${name}`}>＋</button>
```

With JavaScript disabled this submits natively and behaves exactly as the current
Update button does. This is not incidental — the rest of the store is built on Server
Components and form actions, and a stepper implemented purely with `onClick` would be
the only control on the site that silently does nothing without JS.

### Data flow

1. Click ＋. The form action reads the clicked button's `quantity` from `FormData`.
2. `useOptimistic` sets the displayed count; `useTransition` marks the row pending.
3. `setQuantityAction` writes and calls `revalidatePath("/cart")`.
4. The Server Component re-renders. Line total, subtotal, shipping and total come from
   `quote()`. The new `quantity` prop supersedes the optimistic value.

**Money is never computed on the client.** `lib/pricing/quote.ts` is the only place
money is calculated, and optimism stops at the integer count. For roughly 80ms the
count and the price disagree; that is the deliberate trade. Replicating the discount,
free-shipping threshold and rounding rules client-side would create a second money
implementation that can silently diverge from the server — which is the specific
failure the single-`quote()` rule exists to prevent.

---

## 4. Bounds and removal

- `−` is disabled at quantity 1.
- `＋` is disabled at `MAX_LINE_QUANTITY` (99), the existing cap that keeps the `int4`
  `quantity + n` upsert from overflowing.
- **Remove** is a separate control submitting `quantity=0`, the only path that deletes
  a line.

Removal is separated from the stepper because a stepper invites repeated clicking, and
one click past the end of a decrement run would otherwise delete the item outright.
Disabled `−` stops that run harmlessly.

---

## 5. Error handling

| Case | Behaviour |
|---|---|
| Action rejects the value | Cannot occur from the UI — values are generated, bounded, and integer. `parseQuantity` stays as defence against a hand-written request. |
| Action throws | The optimistic value reverts on re-render, so the count returns to its stored value rather than showing a change that did not happen. |
| Rapid clicking | Each click is a transition; React applies them in order. The optimistic count reflects the latest click, and the server converges. |
| JavaScript disabled | Native form submission; no optimism, full page round trip. |

---

## 6. Accessibility

- Buttons carry `aria-label`s naming the product ("One more Coldsmoke Eau de Toilette"),
  since "＋" alone is meaningless to a screen reader and a cart has one per line.
- The count sits in `aria-live="polite"` so the change is announced.
- Disabled states use the `disabled` attribute, so they are both unclickable and
  announced as unavailable.
- The existing `--line-bright` border token is reused for control borders; it clears
  the 3:1 non-text contrast floor at 3.13:1 on `--panel`.

---

## 7. Testing

**Replaced.** The e2e test `a rejected quantity says why instead of silently doing
nothing` exercises a free-text box that will not exist. It is replaced, not quietly
deleted — the behaviour it protected (a bad quantity never silently changing nothing)
is now structural rather than validated.

**New e2e coverage:**

- ＋ increments and the subtotal follows.
- − decrements and the subtotal follows.
- − is disabled at quantity 1.
- ＋ is disabled at 99.
- Remove clears the line and the cart reports empty.
- Two bottles ($90) flips shipping to Free, confirming totals still come from `quote()`.

**Unchanged:** the `setQuantityAction` unit tests, including the blank and
out-of-range cases. The action's contract has not changed, only who calls it.

---

## 8. Plan drift

`cart/page.tsx` is covered by `src/test/plan-drift.test.ts`, and `QuantityStepper.tsx`
will be a new tracked file. The plan and Task 13's brief must be updated in the same
commit or `npm test` fails — which is the guard working as intended.

---

## 9. Success criteria

- Changing quantity on the cart page updates the price with no second click.
- No sequence of stepper clicks can delete a line.
- No money is computed outside `quote()`.
- The cart remains usable with JavaScript disabled.
- `npm test`, `tsc`, `lint`, and the e2e suite are green, with the plan in sync.
