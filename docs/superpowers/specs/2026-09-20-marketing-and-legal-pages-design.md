# Marketing and Legal Pages — Design

Date: 2026-09-20
Status: approved, ready for an implementation plan
Parent spec: `docs/superpowers/specs/2026-09-19-coldsmoke-store-design.md` §7 (Page inventory)

---

## 1. Why this exists

`SiteHeader` and `SiteFooter` link to `/about`, `/contact`, `/faq`,
`/shipping-returns` and `/the-scent`. **None of those routes exist.** Every page
of the storefront currently carries five links that 404.

The parent spec listed these pages in scope; Plan 1 implemented only the
storefront-and-checkout slice. This sub-project closes that gap and adds the two
legal pages a payment-accepting store is expected to publish.

This is the first of three remaining sub-projects. The other two — customer
accounts, and the admin panel — are independent of this one and get their own
specs.

---

## 2. Scope

### In scope

Seven pages, all under `src/app/(store)/` so they inherit the existing shell:

| Route | Contains |
|---|---|
| `/the-scent` | Scent pyramid, materials story, longevity and sillage, how to wear |
| `/about` | Brand story, why cold smoke, who makes it |
| `/faq` | Shipping, returns, samples, tax, allergens, authenticity |
| `/contact` | Contact form, support address, pointer to Find-an-order |
| `/shipping-returns` | Ground-only rationale, US-only, $6 / free at $50, transit, returns |
| `/privacy` | What is collected, Stripe's role, cookies, rights |
| `/terms` | Terms of sale, pricing, cancellation, liability, governing law |

Plus:

- A shared `ContentPage` layout primitive.
- `src/lib/business.ts` as the single source of business facts.
- A contact form with persistence, rate limiting and spam protection.
- Two regression guards: unresolved nav links, and unfilled business details.
- **Footer links to `/privacy` and `/terms`.** Nothing currently links to either,
  so building them without this would leave both unreachable — the mirror image
  of the defect this sub-project exists to fix.

### Out of scope

- CMS, blog, journal, newsletter signup, live chat.
- Product photography (tracked as an open item in the parent spec).
- Customer accounts and admin — separate sub-projects.

### Non-goals

Legal copy here is **a drafted starting point for a lawyer to review, not final
legal advice.** The spec treats it as content to be replaced, and the placeholder
guard exists partly to make that replacement visible.

---

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| Copy source | Claude drafts, owner edits | Real prose in the brand voice is faster to react to than lorem ipsum. Legal pages flagged for review. |
| Business facts | One config module | The same fact appears on several pages; one source prevents updating one and missing another. |
| Page structure | Shared prose primitive + per-page TSX | Avoids seven near-identical CSS modules. Copy stays typechecked with no new toolchain, and stays inside the plan-drift guard's file types. |
| Scent pyramid | Literal widening pyramid | Chosen from three mockups. Instantly legible to anyone who reads fragrance notes. |
| Contact page | Real form, with protections | Owner chose this over a published address, accepting that it is roughly a task on its own. |
| Rate limit store | Postgres | In-memory counters do not survive serverless cold starts, so they would not actually limit anything. |

---

## 4. Architecture

### `ContentPage` primitive

`src/components/content/ContentPage.tsx` + `ContentPage.module.css`.

Owns the measure, heading rhythm and vertical spacing for prose pages. Takes a
title and children. Every page except The Scent is this primitive plus content;
The Scent composes it with one bespoke pyramid section.

Exists so the seven pages cannot drift apart typographically, and so a spacing
change happens once.

### `src/lib/business.ts`

Every business fact used by copy. Pending values are written as a marker string
(`"[legal name]"`) rather than a sentinel type, so a page that renders one shows
the marker rather than crashing or printing nothing:

```ts
export const BUSINESS = {
  legalName: "[legal name]",
  addressLine1: "[street address]",
  addressLocality: "[city, state, ZIP]",
  supportEmail: "[support email]",
  returnWindowDays: 30,
  returnCondition: "unopened",
  governingState: "Texas",
  supportResponseHours: 48,
} as const;
```

A value is "pending" exactly when it is a string matching `/^\[.+\]$/`. That is
the single rule `PENDING_BUSINESS_DETAILS` in §5 is derived from.

Confirmed by the owner on 2026-09-20: **30 days, unopened** and **Texas** are
real values, not placeholders. The four remaining entries are pending because
the LLC is not yet formed.

Free of server-only imports, for the same reason `src/lib/cookies.ts` and
`src/lib/cart/limits.ts` are: a client component may need to render the support
address.

---

## 5. The placeholder guard

The obvious implementation is a test that checks for placeholders only when a
launch flag is set. **That is a test that never fires** — the same failure family
as the payment-test skip guard and the `.not.toBeNull()` assertion, both of which
went green against nothing in this project during September.

Instead, `business.ts` computes the pending set at module load:

```ts
export const PENDING_BUSINESS_DETAILS: string[]  // sorted keys still unfilled
```

and the test asserts it **equals an explicit allowlist**:

```ts
expect(PENDING_BUSINESS_DETAILS).toEqual([
  "addressLine1",
  "addressLocality",
  "legalName",
  "supportEmail",
]);
```

Consequences, both deliberate:

- Adding a new placeholder fails the suite until it is acknowledged.
- Filling one in **also** fails the suite, until it is removed from the allowlist.

The list therefore cannot silently drift out of date, and nothing is skipped.
When the allowlist reaches `[]`, the business details are complete — that is the
launch signal, and it is a passing assertion rather than an absent one.

Pages render pending values as a visible marker (e.g. `[legal name]`) rather than
an empty string, so an unfilled fact is obvious on the page instead of silently
vanishing from a sentence.

---

## 6. The nav-link guard

`src/test/nav-links.test.ts` extracts every internal `href` from `SiteHeader` and
`SiteFooter` and asserts a corresponding route exists.

This is the defect that motivated the sub-project. Without the guard, nothing
prevents the next nav addition from shipping a 404. Dynamic routes are matched by
segment pattern; external and anchor links are ignored.

The guard checks links resolve to routes, **not** that every route is linked — a
deliberately one-directional check, since `/order/[number]` is reached from a
confirmation redirect and should not appear in navigation. Reachability of
`/privacy` and `/terms` is handled by adding the footer links in §2, not by
widening this test into one that would flag legitimate unlinked routes.

---

## 7. Contact form

### Flow

1. Form posts to a Server Action. **`action` receives the Server Action
   directly**, never a client wrapper — a wrapper silently breaks the no-JS path,
   as the cart stepper demonstrated on 2026-09-20.
2. Zod validates (same approach as checkout): email, optional order number,
   message with length bounds.
3. Honeypot field — a hidden input that real users leave empty. A filled
   honeypot returns the same success response as a genuine send, so a bot
   learns nothing, and stores nothing.
4. The message is **persisted first**, then sent via Resend.
5. Success and failure both re-render the page with a message.

### Why persist before sending

A Resend outage would otherwise discard a customer's message with no record. The
row is also what the rate limiter counts, so persistence and limiting share one
mechanism rather than two.

### Data model

```
contact_messages
  id            uuid pk
  email         text not null
  order_number  integer            -- nullable, for order-related enquiries
  message       text not null
  ip_hash       text not null      -- hashed, never the raw address
  delivered_at  timestamptz        -- null until Resend accepts it
  created_at    timestamptz not null default now()
```

Index on `(ip_hash, created_at)` for the rate-limit query.

The IP is stored **hashed**, not raw: rate limiting only needs equality, and a
raw address is personal data this store has no reason to retain.

### Rate limiting

Per `ip_hash`: **5 messages per rolling hour**. Exceeding it returns a clear
error rather than silently dropping, because a customer hitting the limit
legitimately needs to know why.

Five is high enough that no genuine customer reaches it and low enough to make
the endpoint useless for bulk relay. The window is rolling rather than fixed so
the limit cannot be reset by waiting for a clock boundary.

---

## 8. Error handling

| Case | Behaviour |
|---|---|
| Validation fails | Field errors, form re-rendered with input preserved |
| Honeypot filled | Generic success, nothing stored or sent |
| Rate limit exceeded | Explicit "too many messages, try later" error |
| Resend fails | Message stays stored with `delivered_at` null, user told it was received |
| Pending business fact | Rendered as a visible `[marker]`, never an empty string |

The Resend row is deliberate: the customer's message *has* been received, and
claiming otherwise would prompt them to send it again.

---

## 9. Testing

| Level | Covers |
|---|---|
| Unit | `PENDING_BUSINESS_DETAILS` allowlist; contact validation; rate-limit window boundaries; honeypot |
| Integration | Nav links all resolve; every page renders with a title |
| E2E | Contact form submits successfully; honeypot submission stores nothing |

Plan-drift applies: every new `.ts`/`.tsx`/`.css` file gets a `Create` block in
its own commit, per the existing convention.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Legal copy mistaken for legal advice | Marked as draft in the spec and in a comment on each legal page; the placeholder guard keeps the unfinished state visible |
| Contact form becomes a spam relay | Honeypot, per-IP rate limit, persistence-before-send, and no user-controlled recipient |
| Copy drafted in the wrong voice | Owner edits; the brand voice from the parent spec §7 is the reference |
| Seven pages of prose grow stale | Business facts centralised; only prose is per-page |

---

## 11. Open items

- Product photography, final About/FAQ copy, the brand typeface — all inherited
  from the parent spec §11 and not resolved here.
- The four pending business details, which the placeholder allowlist tracks.
- Whether `/privacy` needs a cookie banner depends on the analytics decision,
  which no sub-project has taken yet. This spec assumes no third-party analytics
  and therefore no banner.
