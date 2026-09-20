import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { products, inventory } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { getActiveProducts, getProductBySlug, getCatalogProductById } =
  await import("./index");

async function addProduct(
  slug: string,
  opts: { active?: boolean; sortOrder?: number } = {},
) {
  const [row] = await ctx.db
    .insert(products)
    .values({
      slug,
      name: `Product ${slug}`,
      description: "d",
      priceCents: 4500,
      sku: `SKU-${slug}`,
      active: opts.active ?? true,
      sortOrder: opts.sortOrder ?? 0,
    })
    .returning();
  return row;
}

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

/**
 * The availability expression is shared by all three reads and relies on a
 * specific Postgres behaviour: GREATEST ignores NULL arguments unless every
 * argument is NULL. A product with no inventory row leftJoins to NULLs, so
 * `GREATEST(NULL - NULL, 0)` must come back as 0, not NULL. The callers
 * dropped their `?? 0` coalesce on the strength of that, so it needs pinning.
 */
describe("availability with no inventory row", () => {
  it("reports 0 from getActiveProducts", async () => {
    await addProduct("no-stock-row");

    const [found] = await getActiveProducts();

    expect(found.available).toBe(0);
    expect(found.available).not.toBeNull();
  });

  it("reports 0 from getProductBySlug", async () => {
    await addProduct("no-stock-row");

    const found = await getProductBySlug("no-stock-row");

    expect(found?.available).toBe(0);
  });

  it("reports 0 from getCatalogProductById", async () => {
    const product = await addProduct("no-stock-row");

    const found = await getCatalogProductById(product.id);

    expect(found?.available).toBe(0);
  });
});

describe("availability arithmetic", () => {
  it("is onHand minus reserved", async () => {
    const product = await addProduct("partly-reserved");
    await ctx.db
      .insert(inventory)
      .values({ productId: product.id, onHand: 10, reserved: 3 });

    const found = await getProductBySlug("partly-reserved");

    expect(found?.available).toBe(7);
  });

  it("floors at zero when more is reserved than held", async () => {
    // Should not be reachable, but the floor is what stops a negative
    // availability from rendering as "-2 left".
    const product = await addProduct("oversold");
    await ctx.db
      .insert(inventory)
      .values({ productId: product.id, onHand: 1, reserved: 3 });

    const found = await getProductBySlug("oversold");

    expect(found?.available).toBe(0);
  });

  it("returns a number, not a string", async () => {
    // postgres-js can hand back int8/numeric as strings; int4 arithmetic must
    // stay a real JS number or the comparisons against it silently misbehave.
    const product = await addProduct("typed");
    await ctx.db
      .insert(inventory)
      .values({ productId: product.id, onHand: 5, reserved: 1 });

    const found = await getProductBySlug("typed");

    expect(typeof found?.available).toBe("number");
    expect(Number.isNaN(found?.available)).toBe(false);
  });

  it("agrees across all three reads for the same product", async () => {
    const product = await addProduct("consistent");
    await ctx.db
      .insert(inventory)
      .values({ productId: product.id, onHand: 9, reserved: 4 });

    const [fromList] = await getActiveProducts();
    const bySlug = await getProductBySlug("consistent");
    const byId = await getCatalogProductById(product.id);

    expect(fromList.available).toBe(5);
    expect(bySlug?.available).toBe(5);
    expect(byId?.available).toBe(5);
  });
});

describe("active filtering", () => {
  it("hides inactive products from the shop list", async () => {
    await addProduct("live", { sortOrder: 1 });
    await addProduct("retired", { active: false, sortOrder: 2 });

    const found = await getActiveProducts();

    expect(found.map((p) => p.slug)).toEqual(["live"]);
  });

  it("does not resolve an inactive product by slug", async () => {
    await addProduct("retired", { active: false });

    expect(await getProductBySlug("retired")).toBeNull();
  });

  it("still resolves an inactive product by id", async () => {
    // Deliberate: checkout needs to name a product that was deactivated
    // mid-session, rather than report a generic failure.
    const product = await addProduct("retired", { active: false });

    const found = await getCatalogProductById(product.id);

    expect(found?.slug).toBe("retired");
  });
});
