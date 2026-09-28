# Product & Inventory Admin — Design

**Date:** 2026-09-28
**Status:** Approved, ready for an implementation plan

## 1. Why

The admin panel handles orders and nothing else. `/admin` redirects straight to
`/admin/orders`, with a comment saying there is no dashboard.

So changing a price, fixing a typo in a product description, adding a product,
or correcting a stock count all mean `npm run db:seed` or hand-written SQL. In
production there is no public Postgres endpoint, so it means `railway ssh` into
a live database. You cannot run the shop without a terminal.

The restock work (PR #14) made one narrow stock movement possible from the UI —
returning refunded units — and became the first writer to the
`inventory_adjustments` ledger, which had sat unused since Plan 1. This feature
is the general case that ledger was built for.

## 2. Scope

### In scope

- Creating and editing products: name, slug, tagline, description, price, SKU,
  active, sort order
- Uploading product images, with alt text and ordering
- Adjusting stock by a delta, with a reason, recorded in
  `inventory_adjustments`

### Out of scope

- Deleting products. `order_items.product_id` references them with no
  `onDelete`, so a delete would break historical orders. Deactivating is the
  supported way to retire one.
- Variants, categories, collections, bulk import, image cropping or resizing.
- Reporting on stock history. The ledger will finally hold enough to build it;
  building it is separate.
- Low-stock alerting.

## 3. Decisions

**Stock changes by delta, never by absolute value.** The admin enters `+12
received` or `-1 damaged` with a reason. Applied as `on_hand = on_hand + n`
inside the `UPDATE`, so it is concurrency-safe by construction: two admins
adjusting at once both land, where two absolute "set to" writes would silently
overwrite each other and a count taken five minutes ago would clobber a sale
made since. It also makes the ledger honest — a delta is what
`inventory_adjustments.delta` actually means, where an absolute set would have
to reverse-engineer one.

This is the same shape as `restockOrderItems` and `reserveStock`: the guard and
the arithmetic live in the statement, not in application code that reads first.

**No absolute "stock take" mode**, despite it matching how counting a shelf
feels. It would be a second write path with weaker safety properties, and the
one that reads as the obvious default. A stock-take is expressible as a delta
(`-3 recount`), which also leaves a better record of what changed.

**Images are stored in Postgres and served by a route.** Uploads have to
survive a Railway redeploy, and the container filesystem does not. The
alternatives were a Railway bucket (whose ability to serve public asset URLs is
unverified — it is declared in the IaC today only as Postgres' PITR backup
store) and external object storage (a new vendor, new credentials, and a
provisioning story that belongs in `.railway/railway.ts`).

Storing bytes in the database is the unfashionable choice and the right one at
this size: no new vendor, no credentials, survives redeploys, and works
regardless of replica count. The honest cost is binaries in the database and no
CDN. For a catalogue of a few product shots that is nothing; at hundreds of
images it would be wrong, and §7 says so.

**Products are never deleted, only deactivated.** `products.active` already
exists and the storefront already filters on it.

## 4. Data model

One new table. Everything else already exists.

```
product_image_files
  id          uuid primary key
  bytes       bytea       not null
  content_type text       not null
  byte_size   integer     not null
  created_at  timestamptz not null default now()
```

`product_images.url` then holds `/api/images/<id>`, which is a normal URL — the
storefront, the seed's existing `/images/*.svg` paths, and any future external
URL all keep working unchanged. **No migration to `product_images` itself.**

`products`, `product_images` and `inventory` are otherwise untouched.
`inventory_adjustments` (`product_id`, `delta`, `reason`, `admin_user_id`,
`created_at`) is used as-is — this feature becomes its second writer.

## 5. Interface

New module `src/lib/products/admin.ts`:

```ts
createProduct(input: ProductInput): Promise<Product>
updateProduct(id: string, input: ProductInput): Promise<Product>
setProductActive(id: string, active: boolean): Promise<void>
```

New module `src/lib/inventory/adjust.ts`:

```ts
adjustStock(args: {
  productId: string;
  delta: number;          // non-zero integer
  reason: string;         // free text, required
  adminUserId: string;
}): Promise<void>
```

`adjustStock` applies the delta and writes the ledger row in one transaction —
neither can exist without the other. It refuses:

- a delta of zero, or a non-integer (Postgres **rounds** on assignment to an
  `integer` column, so `1.5` would silently become 2)
- an empty reason. The reason is the entire point of the ledger; a blank one
  makes the row useless later.
- **a delta that would drive `on_hand` below zero.** Enforced in the `UPDATE`'s
  `WHERE` (`on_hand + delta >= 0`), not by reading first, with zero rows
  returned meaning refusal. Negative stock is not a state the storefront can
  represent.

`reserved` is never touched. Adjustments are about physical units; reservations
belong to live carts and orders.

New module `src/lib/products/images.ts`:

```ts
storeProductImage(args: {
  productId: string;
  bytes: Buffer;
  contentType: string;
  alt: string;
}): Promise<void>
```

- Accepts only `image/jpeg`, `image/png`, `image/webp`, `image/svg+xml`
- Rejects anything over 2 MB — a guard against filling the database by accident,
  not a security boundary
- Requires non-empty `alt` text. Every product image is content, and the
  storefront renders it; an empty alt is a silent accessibility regression.

## 6. Flow and UI

Two new routes, added to the admin nav beside Orders:

**`/admin/products`** — list of every product, active and inactive: name, SKU,
price, current `on_hand`, active state. Links to the editor. An Add product
button.

**`/admin/products/[id]`** — the editor, in three sections:

1. **Details.** Name, slug, tagline, description, price, SKU, sort order, and
   an active toggle. Slug is editable but warned about: it is the product's
   public URL, and changing it breaks existing links.
2. **Images.** Current images with alt text and order, an upload control, and
   removal. Removing detaches the `product_images` row; the stored bytes are
   left (see §7).
3. **Stock.** Current `on_hand`, a signed delta field, a required reason, and
   the recent adjustment history for that product read from
   `inventory_adjustments` — so the page that changes stock is also the page
   that explains it.

**`/api/images/[id]`** serves bytes with the stored content type and a long
`Cache-Control` (`public, max-age=31536000, immutable`). Ids are opaque and
content-addressed by row, so a cached URL never goes stale.

Forms follow `FulfillForm.tsx`; actions follow `refundAction`, including
`requireAdminUser()` as the first statement and `revalidatePath` after writes —
including `revalidatePath("/shop")` and the product page, since these edits
change what customers see.

## 7. What this does not fix

- **Images in Postgres do not scale.** This is right for a few product shots
  and wrong for hundreds: no CDN, and every image adds to database size and
  backup time. The `url` indirection means moving to object storage later is a
  backfill plus a writer change, not a schema redesign — `product_images.url`
  already accepts any URL.
- **Removing an image leaves its bytes behind.** Deliberate: an orphan row is
  cheap and a delete that runs while a page still references the URL is not.
  Reclaiming them is a cleanup job nobody needs yet.
- **No image resizing or format conversion.** A 2 MB upload is served at 2 MB.
  `next/image` will resize on render, but the bytes still cross the wire once.
- **No audit trail for product edits.** Stock movements get a ledger; changing
  a price leaves no record of what it was. If that matters, it is the same
  bookkeeping instinct as issues #12 and #15.
- **Nothing reconciles `on_hand` against reality.** The ledger records what was
  claimed, not what is on the shelf.

## 8. Testing

Real Postgres, no mocking of the unit under test, following the existing suites.

`adjustStock`:

- a positive delta raises `on_hand` and writes one ledger row with the delta,
  reason and admin id
- a negative delta lowers it
- a delta that would go below zero is refused, and **no ledger row is written** —
  the two move together or not at all
- zero, non-integer and empty-reason inputs are refused
- `reserved` is untouched
- **the below-zero guard is mutation-tested:** removing `on_hand + delta >= 0`
  from the `WHERE` must fail a test. This project has shipped a test that looked
  like proof and was not; the guard gets demonstrated, not asserted.

`createProduct` / `updateProduct`:

- persist every field
- a duplicate slug returns a friendly error from the unique-index violation,
  not a raw constraint error, and inserts nothing
- `setProductActive(false)` hides the product from the storefront listing —
  asserted against the real storefront query, not just the column

`storeProductImage`:

- persists bytes and content type, and links a `product_images` row whose `url`
  resolves to the new id
- rejects an unsupported content type and one over the size limit
- rejects empty alt text

`/api/images/[id]`:

- returns the bytes with the right content type and cache header
- returns 404 for an unknown id

The server actions:

- **require an admin, asserted explicitly.** The session module is mocked
  wholesale, so without an explicit assertion, deleting `requireAdminUser()`
  leaves every other test green. That gap was caught late in the restock work;
  it gets written up front here.

## 9. Success criteria

- An admin can add a product, upload an image for it, and see it on the
  storefront, without touching SQL or committing a file.
- An admin can correct a stock count, and later find out why it changed.
- Stock can never be driven negative, under any sequence of adjustments.
- Uploaded images survive a Railway redeploy.
- Deactivating a product removes it from the storefront while leaving every
  historical order intact.
