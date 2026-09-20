import { eq, and, inArray, asc, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  products,
  productImages,
  inventory,
  type Product,
  type ProductImage,
} from "@/lib/db/schema";

export type CatalogProduct = Product & {
  images: ProductImage[];
  /** onHand minus reserved — what a new customer can actually buy. */
  available: number;
};

export async function getActiveProducts(): Promise<CatalogProduct[]> {
  const rows = await db
    .select({
      product: products,
      available: sql<number>`GREATEST(${inventory.onHand} - ${inventory.reserved}, 0)`,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(eq(products.active, true))
    .orderBy(asc(products.sortOrder));

  if (rows.length === 0) return [];

  const images = await db
    .select()
    .from(productImages)
    .where(
      inArray(
        productImages.productId,
        rows.map((r) => r.product.id),
      ),
    )
    .orderBy(asc(productImages.sortOrder));

  return rows.map((row) => ({
    ...row.product,
    available: Number(row.available ?? 0),
    images: images.filter((image) => image.productId === row.product.id),
  }));
}

export async function getProductBySlug(
  slug: string,
): Promise<CatalogProduct | null> {
  const [row] = await db
    .select({
      product: products,
      available: sql<number>`GREATEST(${inventory.onHand} - ${inventory.reserved}, 0)`,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(and(eq(products.slug, slug), eq(products.active, true)))
    .limit(1);

  if (!row) return null;

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, row.product.id))
    .orderBy(asc(productImages.sortOrder));

  return {
    ...row.product,
    available: Number(row.available ?? 0),
    images,
  };
}

/**
 * Availability-aware lookup by id. Used by checkout to report exactly how many
 * of a product remain when a reservation fails, so the customer is told which
 * line to fix rather than a generic "something sold out".
 */
export async function getCatalogProductById(
  id: string,
): Promise<CatalogProduct | null> {
  const [row] = await db
    .select({
      product: products,
      available: sql<number>`GREATEST(${inventory.onHand} - ${inventory.reserved}, 0)`,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(eq(products.id, id))
    .limit(1);

  if (!row) return null;

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, row.product.id))
    .orderBy(asc(productImages.sortOrder));

  return { ...row.product, available: Number(row.available ?? 0), images };
}

/** Used to resolve live prices for cart lines. */
export async function getProductsByIds(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  return db.select().from(products).where(inArray(products.id, ids));
}
