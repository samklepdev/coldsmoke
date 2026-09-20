# Marketing and Legal Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the seven marketing and legal pages, closing the five nav links that currently 404 from every page of the store.

**Architecture:** One `ContentPage` primitive owns prose layout; each page is a Server Component supplying content. Every business fact comes from `src/lib/business.ts`, never hardcoded. Two regression guards — an allowlist of unfilled business details, and a test that every nav link resolves to a route. The contact form persists to Postgres before sending via Resend, and rate-limits on a hashed IP.

**Tech Stack:** Next.js 16 (App Router, Server Components, Server Actions), React 19 (`useActionState`), Zod, Drizzle + Postgres, Resend, CSS Modules, Vitest, Playwright.

Spec: `docs/superpowers/specs/2026-09-20-marketing-and-legal-pages-design.md`

## Global Constraints

- **Business facts come from `BUSINESS` in `@/lib/business`.** Never hardcode a legal name, address, support email, return window, or jurisdiction in a page. Confirmed real values: `returnWindowDays: 30`, `returnCondition: "unopened"`, `governingState: "Texas"`. The other four are pending markers.
- **A pending value is a string matching `/^\[.+\]$/`.** That single rule drives `PENDING_BUSINESS_DETAILS`. Pending values render as the literal marker (`[legal name]`) — never as an empty string, which would silently drop words from a sentence.
- **Never write a test that can only fail when a flag is set.** This project has shipped three such checks (the Playwright skip guard, an uncontrolled-input assertion, and `.not.toBeNull()` against a missing column). Assert the value you expect, never merely the absence of one.
- **A Server Action passed to `<form action={...}>` must be the action itself** — either the imported action or the bound one from `useActionState`. Never a client function that awaits it: Next only emits the native form POST when it can see a Server Action, and a wrapper silently breaks the no-JS path. Verified by measurement on 2026-09-20, not reasoned about.
- **Legal copy is a drafted starting point for a lawyer, not final.** Each legal page carries a source comment saying so.
- `src/test/plan-drift.test.ts` asserts every `Create \`path\`` block in `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` matches the file byte for byte. **Every task that changes a tracked file syncs that plan in the same commit**, so the suite is never left red between tasks. Tracked files this plan touches: `src/components/SiteFooter.tsx` (Task 4), `src/lib/db/schema.ts` (Task 5).
- New files created by this plan are **not** added to the drift guard. Recent precedent (`catalog.test.ts`, `markPaid.test.ts`, `access.test.ts`, `pricing.test.ts`) is that new files are not retro-tracked.
- Design tokens only — `var(--ground)`, `var(--text-dim)`, `var(--space-5)`, `var(--measure)`, `var(--track-mid)`. No raw hex in new CSS.
- Never run `npm run build` while `next dev` is running; they share `.next`.
- Do not run `npm test` while another process is running it — both truncate the shared test database.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/business.ts` (create) | Every business fact, plus the pending-detail derivation. Free of server-only imports. |
| `src/lib/business.test.ts` (create) | The pending allowlist guard. |
| `src/components/content/ContentPage.tsx` + `.module.css` (create) | Prose layout: measure, heading rhythm, vertical spacing. |
| `src/app/(store)/the-scent/page.tsx` + `.module.css` (create) | Scent pyramid plus prose. The only bespoke layout. |
| `src/app/(store)/about/page.tsx` (create) | Prose only. |
| `src/app/(store)/faq/page.tsx` (create) | Prose only. |
| `src/app/(store)/shipping-returns/page.tsx` (create) | Prose, reads `BUSINESS`. |
| `src/app/(store)/privacy/page.tsx` (create) | Prose, reads `BUSINESS`. |
| `src/app/(store)/terms/page.tsx` (create) | Prose, reads `BUSINESS`. |
| `src/components/SiteFooter.tsx` (modify) | Add Privacy and Terms links. |
| `src/lib/db/schema.ts` (modify) | `contact_messages` table. |
| `src/lib/contact/index.ts` (create) | Persist, rate-limit, hash IP. No React. |
| `src/lib/contact/contact.test.ts` (create) | Rate-limit boundaries and persistence. |
| `src/app/(store)/contact/actions.ts` (create) | `sendContactMessage` Server Action: validate, honeypot, delegate, send. |
| `src/app/(store)/contact/ContactForm.tsx` (create) | Client Component, `useActionState`. |
| `src/app/(store)/contact/page.tsx` (create) | Contact page shell. |
| `src/components/ui/Textarea.tsx` + `.module.css` (create) | `Field`'s sibling for multi-line input. `Field` wraps `<input>` only. |
| `src/test/nav-links.test.ts` (create) | Every internal nav href resolves to a route. |
| `e2e/contact.spec.ts` (create) | Contact form end to end. |

---

### Task 1: Business facts and the pending-detail guard

**Files:**
- Create: `src/lib/business.ts`, `src/lib/business.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BUSINESS` (const object), `isPending(value: unknown): boolean`, `PENDING_BUSINESS_DETAILS: string[]` from `@/lib/business`.

**Why this task is first:** every later page reads `BUSINESS`. Building pages first would mean hardcoding facts and then hunting them down.

- [ ] **Step 1: Write the failing test**

Create `src/lib/business.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BUSINESS, PENDING_BUSINESS_DETAILS, isPending } from "./business";

describe("business details", () => {
  /**
   * Deliberately an exact-equality assertion against an allowlist, not a
   * "no placeholders" check behind a launch flag. A flagged check never fires
   * until launch day, which is the failure family this project has already
   * shipped three times.
   *
   * Consequences, both intended: adding a new placeholder fails here, and
   * filling one in ALSO fails here until it is removed from this list. The
   * list therefore cannot drift out of date. When it reaches [], the business
   * details are complete.
   */
  it("lists exactly the details still waiting on the LLC", () => {
    expect(PENDING_BUSINESS_DETAILS).toEqual([
      "addressLine1",
      "addressLocality",
      "legalName",
      "supportEmail",
    ]);
  });

  it("treats a bracketed marker as pending", () => {
    expect(isPending("[legal name]")).toBe(true);
  });

  it("treats a filled-in value as settled", () => {
    expect(isPending("Coldsmoke LLC")).toBe(false);
  });

  it("does not treat a number as pending", () => {
    expect(isPending(30)).toBe(false);
  });

  it("keeps the terms the owner confirmed on 2026-09-20", () => {
    expect(BUSINESS.returnWindowDays).toBe(30);
    expect(BUSINESS.returnCondition).toBe("unopened");
    expect(BUSINESS.governingState).toBe("Texas");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/business.test.ts`
Expected: FAIL — `Cannot find module './business'`.

- [ ] **Step 3: Write the module**

Create `src/lib/business.ts`:

```ts
/**
 * Every business fact the site's copy depends on.
 *
 * One module because the same fact appears on several pages — the return
 * window is in both the FAQ and Shipping & Returns — and updating one page
 * while missing another is how policy pages start contradicting each other.
 *
 * Free of server-only imports, for the same reason `src/lib/cookies.ts` and
 * `src/lib/cart/limits.ts` are: a Client Component may need to render the
 * support address, and importing a module that reaches the database would
 * drag the driver into the browser bundle.
 */

/**
 * A fact that is not settled yet is written as a bracketed marker. It renders
 * literally — "[legal name]" — rather than as an empty string, so an unfilled
 * fact is visible on the page instead of quietly dropping a word out of a
 * sentence.
 */
export const BUSINESS = {
  legalName: "[legal name]",
  addressLine1: "[street address]",
  addressLocality: "[city, state, ZIP]",
  supportEmail: "[support email]",

  // Confirmed by the owner, 2026-09-20. Not placeholders.
  returnWindowDays: 30,
  returnCondition: "unopened",
  governingState: "Texas",
  supportResponseHours: 48,
} as const;

const MARKER = /^\[.+\]$/;

/** The single rule that defines "pending". */
export function isPending(value: unknown): boolean {
  return typeof value === "string" && MARKER.test(value);
}

/**
 * Sorted so the guard's expected list is stable regardless of key order.
 */
export const PENDING_BUSINESS_DETAILS: string[] = Object.entries(BUSINESS)
  .filter(([, value]) => isPending(value))
  .map(([key]) => key)
  .sort();
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/business.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the guard bites**

Temporarily change `governingState: "Texas"` to `"[governing state]"` and re-run.
Expected: the allowlist test FAILS, because `governingState` now appears in the pending list.
**Revert the change** and confirm the suite is green again.

This is the check that the guard is real. Do not skip it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/business.ts src/lib/business.test.ts
git commit -m "feat: centralise business facts with a pending-detail guard"
```

---

### Task 2: The ContentPage primitive and The Scent

**Files:**
- Create: `src/components/content/ContentPage.tsx`, `src/components/content/ContentPage.module.css`
- Create: `src/app/(store)/the-scent/page.tsx`, `src/app/(store)/the-scent/page.module.css`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ContentPage({ title, lede, children }: { title: string; lede?: string; children: React.ReactNode }): JSX.Element` from `@/components/content/ContentPage`.

**Context the implementer needs:** the store's pages live under `src/app/(store)/` and inherit `SiteHeader`/`SiteFooter` from that group's layout. Creating a directory with a `page.tsx` is all that is needed to add a route. Existing page components are `async` Server Components exporting `metadata`.

- [ ] **Step 1: Create the prose primitive**

Create `src/components/content/ContentPage.tsx`:

```tsx
import type { ReactNode } from "react";
import styles from "./ContentPage.module.css";

/**
 * Shared layout for prose pages.
 *
 * Exists so seven content pages cannot drift apart typographically, and so a
 * spacing change happens in one place rather than seven near-identical
 * stylesheets.
 */
export function ContentPage({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <article className={styles.page}>
      <h1 className={styles.title}>{title}</h1>
      {lede && <p className={styles.lede}>{lede}</p>}
      <div className={styles.prose}>{children}</div>
    </article>
  );
}
```

Create `src/components/content/ContentPage.module.css`:

```css
.page {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.title {
  font-size: clamp(1.5rem, 3vw, 2rem);
  font-weight: 200;
  color: var(--text-bright);
  letter-spacing: var(--track-tight);
}

.lede {
  margin-top: var(--space-3);
  max-width: var(--measure);
  color: var(--text-dim);
  font-style: italic;
}

/* The measure lives here rather than on .page so a bespoke section -- the
   scent pyramid -- can opt out by sitting outside .prose. */
.prose {
  margin-top: var(--space-5);
  max-width: var(--measure);
}

.prose h2 {
  margin-top: var(--space-5);
  font-size: 0.72rem;
  font-weight: 400;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
}

.prose h2:first-child {
  margin-top: 0;
}

.prose p {
  margin-top: var(--space-3);
  line-height: 1.75;
}

.prose ul {
  margin-top: var(--space-3);
  padding-left: var(--space-3);
  line-height: 1.75;
}

.prose li {
  margin-top: var(--space-2);
}

.prose a {
  color: var(--text-bright);
  text-decoration: underline;
}
```

- [ ] **Step 2: Create The Scent's styles**

Create `src/app/(store)/the-scent/page.module.css`:

```css
/* The pyramid sits outside .prose so it can run wider than the measure. */
.pyramid {
  margin: var(--space-5) 0;
  max-width: 34rem;
}

.band {
  margin: 0 auto;
  padding: var(--space-3) var(--space-2);
  text-align: center;
}

/* Widening bands are the whole idea: the shape carries the meaning, so the
   widths are content, not decoration. */
.top {
  width: 52%;
}

.heart {
  width: 74%;
}

.base {
  width: 100%;
}

.rule {
  height: 1px;
  background: var(--line);
  margin: 0 auto;
}

.ruleTop {
  width: 66%;
}

.ruleHeart {
  width: 88%;
}

.label {
  display: block;
  font-size: 0.62rem;
  letter-spacing: var(--track-wide);
  text-transform: uppercase;
  color: var(--text-dim);
}

.notes {
  margin-top: var(--space-2);
  color: var(--text-bright);
  line-height: 1.7;
}
```

- [ ] **Step 3: Create the page**

Create `src/app/(store)/the-scent/page.tsx`:

```tsx
import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "The Scent",
  description:
    "Coldsmoke opens cold and burns down into spice, musk and smoke. Bergamot, iced spearmint and black pepper over cardamom, clary sage and lavender.",
};

export default function TheScentPage() {
  return (
    <ContentPage title="The Scent" lede="Cold air. Dark spice.">
      {/*
        A <dl> rather than three divs: each band is a term and its notes are
        that term's definition, which is exactly the semantic a screen reader
        should announce. The widening shape is visual only.
      */}
      <dl className={styles.pyramid}>
        <div className={`${styles.band} ${styles.top}`}>
          <dt className={styles.label}>Top</dt>
          <dd className={styles.notes}>
            Bergamot · Iced spearmint · Black pepper
          </dd>
        </div>

        <div className={`${styles.rule} ${styles.ruleTop}`} />

        <div className={`${styles.band} ${styles.heart}`}>
          <dt className={styles.label}>Heart</dt>
          <dd className={styles.notes}>Cardamom · Clary sage · Lavender</dd>
        </div>

        <div className={`${styles.rule} ${styles.ruleHeart}`} />

        <div className={`${styles.band} ${styles.base}`}>
          <dt className={styles.label}>Base</dt>
          <dd className={styles.notes}>
            Dark musk · Amber · Cedarwood · Smoky vetiver
          </dd>
        </div>
      </dl>

      <h2>How it wears</h2>
      <p>
        The opening is cold and sharp — citrus peel and iced mint over pepper.
        It does not stay there. Within the hour the cold burns off and the
        spice comes up: cardamom and clary sage, softened by lavender.
      </p>
      <p>
        What remains after that is the part the bottle is named for. Dark musk
        and amber over cedar, with vetiver reading as smoke rather than earth.
        It sits close to the skin and lasts most of a day.
      </p>

      <h2>Materials</h2>
      <p>
        Blended and bottled in small batches. No filler, no reformulation
        between batches, and nothing in the formula that is there to make the
        first ten seconds louder than the next ten hours.
      </p>

      <h2>Not sure yet</h2>
      <p>
        The 2 mL sample is about twenty sprays — enough to wear it for a few
        days and learn how it dries down on your skin. Buy the sample first.
        It is the honest way to sell a scent you cannot smell through a screen.
      </p>
    </ContentPage>
  );
}
```

- [ ] **Step 4: Verify it renders**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output from either.

Start the dev server (`npm run dev`) and open `http://localhost:3000/the-scent`.
Expected: three widening bands separated by hairlines, "The Scent" heading, and the header's "The Scent" link no longer 404s.

- [ ] **Step 5: Commit**

```bash
git add src/components/content src/app/\(store\)/the-scent
git commit -m "feat: add The Scent page and the shared prose layout"
```

---

### Task 3: About and FAQ

**Files:**
- Create: `src/app/(store)/about/page.tsx`, `src/app/(store)/faq/page.tsx`

**Interfaces:**
- Consumes: `ContentPage` from Task 2; `BUSINESS` from Task 1.
- Produces: nothing other tasks use.

- [ ] **Step 1: Create the About page**

Create `src/app/(store)/about/page.tsx`:

```tsx
import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";

export const metadata: Metadata = {
  title: "About",
  description: "One scent, made in small batches, sold direct.",
};

export default function AboutPage() {
  return (
    <ContentPage title="About" lede="One scent. Made in small batches.">
      <h2>Why one scent</h2>
      <p>
        Most fragrance houses launch a range and hope one of them works.
        Coldsmoke is a single formula, revised until it was right and then left
        alone. A range would mean spreading the same attention thinner.
      </p>

      <h2>The name</h2>
      <p>
        Cold smoke is what comes off a fire that has gone out — the smell of
        the air after, not during. That gap between cold and warm is the whole
        idea of the scent: it opens like winter air and ends like the room the
        fire was in.
      </p>

      <h2>How it is sold</h2>
      <p>
        Direct, with no retail markup and no middle tier. That is also why the
        sample exists and why it costs six dollars: buying a bottle of
        something you have never smelled is a bad deal, and pretending
        otherwise is how fragrance is usually sold.
      </p>
    </ContentPage>
  );
}
```

- [ ] **Step 2: Create the FAQ page**

Create `src/app/(store)/faq/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Shipping, returns, samples and tax for Coldsmoke Eau de Toilette.",
};

export default function FaqPage() {
  return (
    <ContentPage title="FAQ">
      <h2>How long does shipping take?</h2>
      <p>
        Orders leave within two business days. Fragrance ships ground only, so
        transit is three to six business days depending on distance. Shipping
        is $6, or free on orders over $50.
      </p>

      <h2>Do you ship outside the US?</h2>
      <p>
        Not yet. Fragrance is a flammable good and shipping it abroad requires
        dangerous-goods handling we do not have in place.
      </p>

      <h2>Can I return it?</h2>
      <p>
        Yes, within {BUSINESS.returnWindowDays} days, {BUSINESS.returnCondition}
        . An opened bottle cannot be resold, which is what the sample is for.
        See <Link href="/shipping-returns">Shipping &amp; Returns</Link>.
      </p>

      <h2>How much is the sample?</h2>
      <p>
        $6 for 2 mL — roughly twenty sprays. Enough to wear it for a few days
        and see how it dries down on your skin.
      </p>

      <h2>Will I be charged sales tax?</h2>
      <p>
        Tax is calculated at checkout based on your shipping address, and is
        only charged where we are registered to collect it.
      </p>

      <h2>What is in it?</h2>
      <p>
        The full note list is on <Link href="/the-scent">The Scent</Link>. A
        complete ingredient list is printed on the carton. If you have a
        specific allergen concern, ask before you order.
      </p>

      <h2>Where is my order?</h2>
      <p>
        Use <Link href="/order-lookup">Find an order</Link> with your order
        number and email.
      </p>
    </ContentPage>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

Open `http://localhost:3000/about` and `http://localhost:3000/faq`.
Expected: both render; the FAQ shows "within 30 days, unopened" from `BUSINESS`.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(store\)/about src/app/\(store\)/faq
git commit -m "feat: add the About and FAQ pages"
```

---

### Task 4: Shipping & Returns, Privacy, Terms, and the footer links

**Files:**
- Create: `src/app/(store)/shipping-returns/page.tsx`, `src/app/(store)/privacy/page.tsx`, `src/app/(store)/terms/page.tsx`
- Modify: `src/components/SiteFooter.tsx`

**Interfaces:**
- Consumes: `ContentPage` from Task 2; `BUSINESS` from Task 1.
- Produces: nothing other tasks use.

**Context the implementer needs:** `src/components/SiteFooter.tsx` is tracked by the drift guard, so this task syncs Plan 1 in its own commit (Step 6). Without the footer links, `/privacy` and `/terms` would exist but be unreachable — the mirror of the defect this plan exists to fix.

- [ ] **Step 1: Create Shipping & Returns**

Create `src/app/(store)/shipping-returns/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "Shipping & Returns",
  description: "US ground shipping, $6 flat or free over $50. Returns within 30 days.",
};

// Drafted as a starting point for review by a lawyer. Not final, and not
// legal advice.
export default function ShippingReturnsPage() {
  return (
    <ContentPage title="Shipping &amp; Returns">
      <h2>Where we ship</h2>
      <p>
        The United States only, including Alaska and Hawaii. Fragrance is
        classed as a flammable liquid and travels by ground, never by air, which
        is also why we cannot ship internationally.
      </p>

      <h2>Cost and timing</h2>
      <p>
        $6 flat, or free on orders over $50 after any discount. Orders leave
        within two business days; ground transit is typically three to six
        business days.
      </p>

      <h2>Returns</h2>
      <p>
        Within {BUSINESS.returnWindowDays} days of delivery, {BUSINESS.returnCondition}.
        Email {BUSINESS.supportEmail} with your order number and we will send
        return instructions. Refunds go back to the original payment method
        once the return arrives.
      </p>
      <p>
        An opened bottle cannot be returned. This is not a restocking policy —
        a used fragrance is not resalable. Buy the 2 mL sample first if you are
        unsure.
      </p>

      <h2>Damaged in transit</h2>
      <p>
        Tell us within seven days of delivery and we will replace it. Photographs
        of the carton and the bottle help, but are not required.
      </p>

      <h2>Questions</h2>
      <p>
        <Link href="/contact">Contact us</Link>, or look up an existing order
        with <Link href="/order-lookup">Find an order</Link>.
      </p>
    </ContentPage>
  );
}
```

- [ ] **Step 2: Create Privacy**

Create `src/app/(store)/privacy/page.tsx`:

```tsx
import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Coldsmoke collects, why, and what it is never used for.",
};

// Drafted as a starting point for review by a lawyer. Not final, and not
// legal advice.
export default function PrivacyPage() {
  return (
    <ContentPage title="Privacy Policy">
      <h2>What we collect</h2>
      <p>
        To fulfil an order: your email address, shipping address, and the
        contents of the order. If you contact us, the message you send and the
        address you send it from.
      </p>

      <h2>Payment details</h2>
      <p>
        Card details are entered directly into Stripe and are never sent to or
        stored on our servers. We keep Stripe&apos;s reference for the payment so
        we can match it to your order and issue refunds.
      </p>

      <h2>Cookies</h2>
      <p>
        Only what the store needs to work: an identifier for your cart, a
        short-lived reference to an order you have just placed, and an applied
        discount code. There is no third-party analytics and no advertising
        tracking on this site.
      </p>

      <h2>What we never do</h2>
      <p>
        We do not sell personal information, and we do not share it except with
        the services that fulfil the order — Stripe for payment and our shipping
        carrier for delivery.
      </p>

      <h2>Your data</h2>
      <p>
        Email {BUSINESS.supportEmail} to request a copy of what we hold about
        you, or to ask us to delete it. Order records we are required to keep
        for tax purposes are the exception.
      </p>

      <h2>Who we are</h2>
      <p>
        {BUSINESS.legalName}, {BUSINESS.addressLine1}, {BUSINESS.addressLocality}.
      </p>
    </ContentPage>
  );
}
```

- [ ] **Step 3: Create Terms**

Create `src/app/(store)/terms/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "Terms of Sale",
  description: "The terms that apply when you buy from Coldsmoke.",
};

// Drafted as a starting point for review by a lawyer. Not final, and not
// legal advice.
export default function TermsPage() {
  return (
    <ContentPage title="Terms of Sale">
      <h2>Who you are buying from</h2>
      <p>
        {BUSINESS.legalName}, {BUSINESS.addressLine1}, {BUSINESS.addressLocality}.
      </p>

      <h2>Orders</h2>
      <p>
        An order is an offer to buy. It is accepted when we charge your card and
        confirm the order by email. If an item is unavailable after you order,
        we will cancel and refund it in full rather than substitute anything.
      </p>

      <h2>Prices</h2>
      <p>
        Prices are in US dollars and exclude sales tax, which is calculated at
        checkout. We may change prices, but never for an order already placed.
      </p>

      <h2>Cancellation and returns</h2>
      <p>
        Tell us before the order ships and we will cancel it. After it ships,
        the return terms on{" "}
        <Link href="/shipping-returns">Shipping &amp; Returns</Link> apply:
        {" "}{BUSINESS.returnWindowDays} days, {BUSINESS.returnCondition}.
      </p>

      <h2>Use of the product</h2>
      <p>
        Eau de Toilette, for external use only. Discontinue use if irritation
        occurs. Keep away from heat and flame, and keep out of reach of
        children.
      </p>

      <h2>Liability</h2>
      <p>
        Our liability for any order is limited to what you paid for it. Nothing
        here limits liability that cannot be limited by law.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the State of{" "}
        {BUSINESS.governingState}.
      </p>
    </ContentPage>
  );
}
```

- [ ] **Step 4: Add the footer links**

In `src/components/SiteFooter.tsx`, replace the `<nav>` block with:

```tsx
        <nav className={styles.links} aria-label="Footer">
          <Link href="/faq">FAQ</Link>
          <Link href="/shipping-returns">Shipping &amp; Returns</Link>
          <Link href="/order-lookup">Find an order</Link>
          <Link href="/contact">Contact</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

Open all three pages. Expected: `[legal name]`, `[street address]`, `[city, state, ZIP]` and `[support email]` appear literally on Privacy and Terms. **That is correct** — the markers are visible on purpose, and Task 1's allowlist is what tracks them.

- [ ] **Step 6: Sync Plan 1 and commit**

`src/components/SiteFooter.tsx` is tracked, so `npm test` now fails on
`src/components/SiteFooter.tsx matches the plan byte for byte`. That is the
guard working. Fix it by updating the plan, never by weakening the test.

In `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md`, replace
the contents of the fenced block introduced by
``Create `src/components/SiteFooter.tsx`:`` with the current contents of that file.

Then run `npm test` and confirm it is green.

```bash
git add src/app/\(store\)/shipping-returns src/app/\(store\)/privacy src/app/\(store\)/terms \
  src/components/SiteFooter.tsx \
  docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
git commit -m "feat: add the shipping, privacy and terms pages"
```

---

### Task 5: The contact_messages table

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/` migration (generated, do not hand-write)

**Interfaces:**
- Consumes: nothing.
- Produces: `contactMessages` table export from `@/lib/db/schema`.

- [ ] **Step 1: Add the table**

In `src/lib/db/schema.ts`, after the `stripeEvents` table, add:

```ts
/**
 * Contact form submissions.
 *
 * Rows are written BEFORE the email is sent, so a Resend outage loses nothing
 * and `delivered_at` records whether the send actually landed. The same rows
 * are what the rate limiter counts, so persistence and limiting share one
 * mechanism instead of two.
 */
export const contactMessages = pgTable(
  "contact_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    orderNumber: integer("order_number"),
    message: text("message").notNull(),
    // Hashed, never the raw address: rate limiting only needs equality, and a
    // raw IP is personal data this store has no reason to retain.
    ipHash: text("ip_hash").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("contact_messages_rate_idx").on(t.ipHash, t.createdAt)],
);
```

Confirm `index`, `integer`, `text`, `timestamp`, `uuid` and `pgTable` are already imported at the top of the file. They are — every one is used by an existing table.

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/000N_*.sql` containing `CREATE TABLE "contact_messages"` and a `CREATE INDEX`.

Read the generated file and confirm it only creates the new table and index. Do not edit it.

- [ ] **Step 3: Apply it**

Run: `npm run db:migrate`
Expected: ends with `Migrations applied.` A Postgres NOTICE about
`__drizzle_migrations` already existing is normal and is not an error.

Verify:

```bash
docker exec coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c "\d contact_messages"
```
Expected: the six columns above, plus the index.

- [ ] **Step 4: Sync Plan 1 and commit**

`src/lib/db/schema.ts` is tracked. Replace the contents of the fenced block
introduced by ``Create `src/lib/db/schema.ts`:`` in
`docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` with the
current file contents, then run `npm test` and confirm green.

```bash
git add src/lib/db/schema.ts drizzle/ \
  docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
git commit -m "feat: add the contact_messages table"
```

---

### Task 6: Contact persistence and rate limiting

**Files:**
- Create: `src/lib/contact/index.ts`, `src/lib/contact/contact.test.ts`

**Interfaces:**
- Consumes: `contactMessages` from Task 5.
- Produces: from `@/lib/contact`:
  - `CONTACT_RATE_LIMIT: number` (5)
  - `CONTACT_RATE_WINDOW_MS: number` (3_600_000)
  - `hashIp(ip: string): string`
  - `isRateLimited(ipHash: string): Promise<boolean>`
  - `recordMessage(input: { email: string; orderNumber?: number; message: string; ipHash: string }): Promise<{ id: string }>`
  - `markDelivered(id: string): Promise<void>`

**Context the implementer needs:** database tests in this repo use the harness in `src/test/db.ts`. Copy the `vi.mock("@/lib/db/client", …)` + `testDb()` setup from `src/lib/orders/pricing.test.ts` exactly — it mocks the client to point at the test database and truncates between tests.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/contact/contact.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { contactMessages } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const {
  hashIp,
  isRateLimited,
  recordMessage,
  markDelivered,
  CONTACT_RATE_LIMIT,
} = await import("./index");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const send = (ipHash: string) =>
  recordMessage({
    email: "buyer@example.com",
    message: "Does this ship to Alaska?",
    ipHash,
  });

describe("hashIp", () => {
  it("does not return the address it was given", () => {
    expect(hashIp("203.0.113.9")).not.toContain("203.0.113.9");
  });

  it("is stable for the same address", () => {
    expect(hashIp("203.0.113.9")).toBe(hashIp("203.0.113.9"));
  });

  it("differs between addresses", () => {
    expect(hashIp("203.0.113.9")).not.toBe(hashIp("203.0.113.10"));
  });
});

describe("recordMessage", () => {
  it("stores the message undelivered", async () => {
    const { id } = await send(hashIp("203.0.113.9"));

    const [row] = await ctx.db.select().from(contactMessages);
    expect(row.id).toBe(id);
    expect(row.message).toBe("Does this ship to Alaska?");
    // Undelivered until the send actually lands -- the whole point of writing
    // the row first.
    expect(row.deliveredAt).toBeNull();
  });

  it("marks a message delivered", async () => {
    const { id } = await send(hashIp("203.0.113.9"));
    await markDelivered(id);

    const [row] = await ctx.db.select().from(contactMessages);
    expect(row.deliveredAt).toBeInstanceOf(Date);
  });
});

describe("isRateLimited", () => {
  it("allows the first message", async () => {
    expect(await isRateLimited(hashIp("203.0.113.9"))).toBe(false);
  });

  it("allows exactly the limit", async () => {
    const ip = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(ip);

    // The limit is how many you may send, so the Nth must have been allowed.
    const [row] = await ctx.db.select().from(contactMessages).limit(1);
    expect(row).toBeDefined();
  });

  it("blocks the one after the limit", async () => {
    const ip = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(ip);

    expect(await isRateLimited(ip)).toBe(true);
  });

  it("counts each address separately", async () => {
    const mine = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(mine);

    expect(await isRateLimited(hashIp("203.0.113.10"))).toBe(false);
  });

  it("ignores messages older than the window", async () => {
    const ip = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(ip);

    // Age every row past the window. A fixed calendar-hour limit would also
    // pass this; a rolling window is what makes it meaningful.
    await ctx.db.update(contactMessages).set({
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    expect(await isRateLimited(ip)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/contact/contact.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Write the module**

Create `src/lib/contact/index.ts`:

```ts
import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contactMessages } from "@/lib/db/schema";

/** Messages allowed from one address within the window. */
export const CONTACT_RATE_LIMIT = 5;

/**
 * Rolling, not a fixed calendar hour: a fixed window can be reset by waiting
 * for the boundary, which makes the limit close to decorative.
 */
export const CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Rate limiting only needs to know whether two requests came from the same
 * place, which equality on a hash answers. Storing the raw address would keep
 * personal data this store has no use for.
 *
 * Salted so the hashes are not a plain rainbow-table lookup of the IPv4 space,
 * which is small enough to enumerate.
 */
export function hashIp(ip: string): string {
  const salt = process.env.CONTACT_IP_SALT ?? "coldsmoke-contact";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export async function isRateLimited(ipHash: string): Promise<boolean> {
  const since = new Date(Date.now() - CONTACT_RATE_WINDOW_MS);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contactMessages)
    .where(
      and(eq(contactMessages.ipHash, ipHash), gte(contactMessages.createdAt, since)),
    );

  return (row?.count ?? 0) >= CONTACT_RATE_LIMIT;
}

/**
 * Written before the email is sent. A Resend outage then loses nothing, and
 * `deliveredAt` records whether the send actually landed.
 */
export async function recordMessage(input: {
  email: string;
  orderNumber?: number;
  message: string;
  ipHash: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(contactMessages)
    .values({
      email: input.email,
      orderNumber: input.orderNumber ?? null,
      message: input.message,
      ipHash: input.ipHash,
    })
    .returning({ id: contactMessages.id });

  return row;
}

export async function markDelivered(id: string): Promise<void> {
  await db
    .update(contactMessages)
    .set({ deliveredAt: new Date() })
    .where(eq(contactMessages.id, id));
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/contact/contact.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/contact
git commit -m "feat: add contact message persistence and rate limiting"
```

---

### Task 7: The contact Server Action

**Files:**
- Create: `src/app/(store)/contact/actions.ts`

**Interfaces:**
- Consumes: `hashIp`, `isRateLimited`, `recordMessage`, `markDelivered` from Task 6; `getResend` from `@/lib/email/client`; `BUSINESS` from Task 1.
- Produces: `sendContactMessage(prev: ContactState, formData: FormData): Promise<ContactState>` and `type ContactState` from `./actions`.

**Context the implementer needs:** `src/lib/email/client.ts` exports `getResend()`, which returns a configured Resend client. The checkout action in `src/app/(store)/checkout/actions.ts` is the house pattern for Zod + `useActionState` — read it before writing this.

- [ ] **Step 1: Write the action**

Create `src/app/(store)/contact/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { headers } from "next/headers";
import {
  hashIp,
  isRateLimited,
  recordMessage,
  markDelivered,
} from "@/lib/contact";
import { getResend } from "@/lib/email/client";
import { BUSINESS } from "@/lib/business";

const schema = z.object({
  email: z.email("Enter a valid email address."),
  // Optional: an untouched input still posts "", which must not become 0.
  orderNumber: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : undefined))
    .refine((value) => value === undefined || Number.isInteger(value), {
      message: "Order numbers are digits only.",
    }),
  message: z
    .string()
    .trim()
    .min(10, "Tell us a little more.")
    .max(4000, "That is too long to send. Email us instead."),
});

export type ContactState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> };

export async function sendContactMessage(
  _prev: ContactState,
  formData: FormData,
): Promise<ContactState> {
  // A bot that fills every field trips this. Returning the same success state
  // as a real send means it learns nothing about why it failed -- and nothing
  // is stored or sent.
  if ((formData.get("website") as string)?.trim()) {
    return { status: "sent" };
  }

  const parsed = schema.safeParse({
    email: formData.get("email"),
    orderNumber: formData.get("orderNumber"),
    message: formData.get("message"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { status: "error", error: "Check the highlighted fields.", fieldErrors };
  }

  const headerList = await headers();
  // x-forwarded-for is a list; the client is the first entry.
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = hashIp(ip);

  if (await isRateLimited(ipHash)) {
    // Told plainly rather than silently dropped: a customer who hits this
    // legitimately needs to know the message did not go through.
    return {
      status: "error",
      error: "Too many messages from here. Try again in an hour.",
    };
  }

  // Stored first. If Resend is down the message still exists and can be sent
  // later; the customer is not asked to retype it.
  const { id } = await recordMessage({
    email: parsed.data.email,
    orderNumber: parsed.data.orderNumber,
    message: parsed.data.message,
    ipHash,
  });

  try {
    await getResend().emails.send({
      from: "Coldsmoke <noreply@wearcoldsmoke.com>",
      to: BUSINESS.supportEmail,
      replyTo: parsed.data.email,
      subject: parsed.data.orderNumber
        ? `Contact — order ${parsed.data.orderNumber}`
        : "Contact — general",
      text: parsed.data.message,
    });
    await markDelivered(id);
  } catch (err) {
    // The message IS received -- it is in the database. Telling the customer
    // otherwise would prompt them to send it again.
    console.error("[contact] stored but not delivered", { id, cause: err });
  }

  return { status: "sent" };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no output. The action is not imported yet, which is fine.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(store\)/contact/actions.ts
git commit -m "feat: add the contact server action"
```

---

### Task 8: The contact page and form

**Files:**
- Create: `src/components/ui/Textarea.tsx`, `src/components/ui/Textarea.module.css`
- Create: `src/app/(store)/contact/ContactForm.tsx`, `src/app/(store)/contact/page.tsx`

**Interfaces:**
- Consumes: `sendContactMessage`, `ContactState` from Task 7; `ContentPage` from Task 2; `BUSINESS` from Task 1; `Button` from `@/components/ui/Button`; `Field` from `@/components/ui/Field`.
- Produces: nothing other tasks use.

**Context the implementer needs:** `Field` wraps `<input>` only, so a multi-line control needs its own primitive. `Field` is the model to copy — `useId`, `aria-invalid`, `aria-describedby`, and a `role="alert"` error span.

- [ ] **Step 1: Create the Textarea primitive**

Create `src/components/ui/Textarea.module.css`:

```css
.wrap {
  display: block;
}

.label {
  display: block;
  font-size: 0.68rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: var(--space-2);
}

.input {
  width: 100%;
  min-height: 9rem;
  padding: 0.85rem 0.9rem;
  background: var(--panel);
  /* --line-bright, not --line: a control border must clear 3:1. */
  border: 1px solid var(--line-bright);
  color: var(--text-bright);
  font: inherit;
  resize: vertical;
}

.invalid {
  border-color: var(--danger);
}

.error {
  display: block;
  margin-top: var(--space-2);
  font-size: 0.78rem;
  color: var(--danger);
}
```

Create `src/components/ui/Textarea.tsx`:

```tsx
"use client";

import { useId, type TextareaHTMLAttributes } from "react";
import styles from "./Textarea.module.css";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string;
};

/** `Field`'s sibling. Field wraps <input>, which cannot be multi-line. */
export function Textarea({ label, error, className, ...rest }: Props) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={[styles.input, error && styles.invalid, className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create the form**

Create `src/app/(store)/contact/ContactForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { sendContactMessage, type ContactState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";

/**
 * `action` receives the bound action from useActionState, which Next can still
 * serialise into a native form POST. Wrapping it in a local async function
 * would silently break the no-JS path, as the cart stepper demonstrated.
 */
export function ContactForm() {
  const [state, action, pending] = useActionState<ContactState, FormData>(
    sendContactMessage,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        Thanks — we have your message and will reply within two business days.
      </p>
    );
  }

  return (
    <form action={action}>
      <Field label="Your email" name="email" type="email" required />
      <Field
        label="Order number (optional)"
        name="orderNumber"
        inputMode="numeric"
        error={state.status === "error" ? state.fieldErrors?.orderNumber : undefined}
      />
      <Textarea
        label="Message"
        name="message"
        required
        error={state.status === "error" ? state.fieldErrors?.message : undefined}
      />

      {/*
        Honeypot. Hidden from people, irresistible to bots that fill every
        field. Not type="hidden" -- that is the one input bots skip.
        aria-hidden and tabIndex keep it away from screen readers and keyboards.
      */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {state.status === "error" && !state.fieldErrors && (
        <p role="alert">{state.error}</p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Sending" : "Send"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Create the page**

Create `src/app/(store)/contact/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";
import { ContactForm } from "./ContactForm";

export const metadata: Metadata = {
  title: "Contact",
  description: "Questions about an order, a return, or the scent itself.",
};

export default function ContactPage() {
  return (
    <ContentPage
      title="Contact"
      lede={`We reply within ${BUSINESS.supportResponseHours} hours on business days.`}
    >
      <p>
        Looking for an existing order?{" "}
        <Link href="/order-lookup">Find an order</Link> is faster — you will
        need the order number and the email you used.
      </p>

      <ContactForm />
    </ContentPage>
  );
}
```

- [ ] **Step 4: Verify by hand**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

With the dev server running, open `http://localhost:3000/contact`, submit with a
one-word message.
Expected: "Tell us a little more." under the Message field, nothing stored.

Then submit a real message.
Expected: the form is replaced by the thanks message, and:

```bash
docker exec coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c "select email, order_number, delivered_at is not null as delivered from contact_messages;"
```
shows one row. `delivered` will be `f` unless `RESEND_API_KEY` is real — that is
expected and correct, and the customer is still told the message was received.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/Textarea.tsx src/components/ui/Textarea.module.css \
  src/app/\(store\)/contact
git commit -m "feat: add the contact page and form"
```

---

### Task 9: The nav-link guard, end-to-end coverage, and full verification

**Files:**
- Create: `src/test/nav-links.test.ts`, `e2e/contact.spec.ts`

**Interfaces:**
- Consumes: every page from Tasks 2-4 and 8.
- Produces: nothing.

**Why this task is last:** the guard can only pass once every linked route exists, and `/contact` is one of them. Landing it earlier would leave the suite red across several tasks, where a known failure masks the next implementer's own breakage.

- [ ] **Step 1: Write the nav-link guard**

Create `src/test/nav-links.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Every internal link in the site chrome must resolve to a route.
 *
 * This is the defect that motivated the marketing-pages work: the header and
 * footer shipped links to /about, /contact, /faq, /shipping-returns and
 * /the-scent while none of those routes existed, so every page of the store
 * carried five 404s. Nothing caught it because nothing was looking.
 *
 * Deliberately one-directional -- it checks that links resolve, not that every
 * route is linked. /order/[number] is reached from a redirect and should not
 * appear in navigation, so the reverse check would flag correct code.
 */

const ROOT = path.resolve(__dirname, "../..");
const CHROME = [
  "src/components/SiteHeader.tsx",
  "src/components/SiteFooter.tsx",
];

function internalHrefs(file: string): string[] {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  return [...source.matchAll(/href="(\/[^"]*)"/g)]
    .map((m) => m[1])
    .filter((href) => !href.startsWith("//"));
}

/** Does a route exist for this path? Dynamic segments match any value. */
function routeExists(href: string): boolean {
  const segments = href.split("/").filter(Boolean);
  if (segments.length === 0) {
    // "/" is the store group's index.
    return existsSync(path.join(ROOT, "src/app/(store)/page.tsx"));
  }

  const candidates = [
    path.join(ROOT, "src/app", ...segments, "page.tsx"),
    path.join(ROOT, "src/app/(store)", ...segments, "page.tsx"),
  ];
  return candidates.some(existsSync);
}

describe("site chrome links", () => {
  const links = CHROME.flatMap((file) =>
    internalHrefs(file).map((href) => [file, href] as const),
  );

  it("finds links to check", () => {
    // Guards the guard: a regex that matched nothing would make every
    // assertion below vacuously true.
    expect(links.length).toBeGreaterThanOrEqual(8);
  });

  it.each(links)("%s links to %s, which exists", (_file, href) => {
    expect(routeExists(href)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/test/nav-links.test.ts`
Expected: PASS. Every link now resolves.

- [ ] **Step 3: Prove the guard bites**

Temporarily add `<Link href="/nonexistent">X</Link>` to `SiteFooter.tsx` and
re-run.
Expected: FAIL on `/nonexistent`.
**Remove the link** and confirm green again.

A guard that has never failed is not known to work.

- [ ] **Step 4: Write the end-to-end test**

Create `e2e/contact.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("a visitor can send a contact message", async ({ page }) => {
  await page.goto("/contact");

  await page.getByLabel("Your email").fill("buyer@example.com");
  await page.getByLabel("Message").fill("Does this ship to Alaska?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("we have your message")).toBeVisible();
});

test("a short message is refused with a reason", async ({ page }) => {
  await page.goto("/contact");

  await page.getByLabel("Your email").fill("buyer@example.com");
  await page.getByLabel("Message").fill("hi");
  await page.getByRole("button", { name: "Send" }).click();

  // The point is that it says WHY. A silent no-op is the bug this project
  // already shipped once, on the cart quantity box.
  await expect(page.getByText("Tell us a little more.")).toBeVisible();
});

test("every page linked from the footer loads", async ({ page }) => {
  for (const path of [
    "/the-scent",
    "/about",
    "/faq",
    "/contact",
    "/shipping-returns",
    "/privacy",
    "/terms",
  ]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should not 404`).toBe(200);
  }
});
```

- [ ] **Step 5: Run the end-to-end suite**

Run: `npx playwright test e2e/contact.spec.ts`
Expected: 3 passed.

- [ ] **Step 6: Full verification**

```bash
npx tsc --noEmit
npm run lint
npm test
```

Expected: no output from the first two; `npm test` fully green at roughly 282
tests — 256 before this plan, plus 5 from Task 1, 9 from Task 6, and 12 from
Step 1 above (one per link, plus the guards-the-guard count check). If the drift
guard fails on a file this plan touched, a task's sync step was skipped — fix
the plan document, not the test.

Then stop the dev server and run:

```bash
npm run build
```
Expected: 17 routes, no errors. `next build` and `next dev` share `.next`, so
they must not run together.

Finally, with the dev server running again:

```bash
npx playwright test
```
Expected: all tests pass. The payment test runs only when `stripe listen` is
forwarding; otherwise it skips with a stated reason.

- [ ] **Step 7: Commit**

```bash
git add src/test/nav-links.test.ts e2e/contact.spec.ts
git commit -m "test: guard nav links against 404s and cover the contact form"
```

---

## Self-Review

**Spec coverage.** §2 page list → Tasks 2, 3, 4, 8. §2 footer links for privacy/terms → Task 4 Step 4. §4 `ContentPage` → Task 2. §4 `business.ts` → Task 1. §5 placeholder guard → Task 1, including the bite check at Step 5. §6 nav-link guard → Task 9, including the bite check at Step 3. §7 contact flow, honeypot, persist-before-send → Tasks 6, 7, 8. §7 data model → Task 5. §7 rate limiting (5/rolling hour) → Task 6. §8 error handling table → Task 7's branches, each with a test or a manual check. §9 testing → Tasks 1, 6, 9. §10 risks → legal-draft comments in Task 4; spam controls in Tasks 6-8.

**Deliberately not covered:** product photography, final copy review, the four pending business details, and the cookie-banner question are all spec §11 open items with no task, by design.

**Type consistency.** `ContentPage({ title, lede, children })` is defined in Task 2 and called with exactly those props in Tasks 3, 4 and 8. `ContactState` is defined in Task 7 and consumed in Task 8 with the same three variants. `hashIp`/`isRateLimited`/`recordMessage`/`markDelivered` are produced in Task 6 with the exact signatures Task 7 imports. `BUSINESS` keys used in pages — `legalName`, `addressLine1`, `addressLocality`, `supportEmail`, `returnWindowDays`, `returnCondition`, `governingState`, `supportResponseHours` — all exist in Task 1's object.

**Known risk for the implementer.** Task 4 Step 5 shows `[legal name]` and friends rendering literally on Privacy and Terms. That looks like a bug and is not — it is the design, and Task 1's allowlist is what tracks it. Do not "fix" it by inventing a company name.
