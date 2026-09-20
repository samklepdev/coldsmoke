import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { products, inventory, productImages } from "./schema";

const SEED = [
  {
    slug: "coldsmoke-edt-50ml",
    name: "Coldsmoke Eau de Toilette",
    tagline: "Cold air. Dark spice.",
    description:
      "A crisp icy opening that burns down into spice, musk, and a wisp of smoke. Bergamot, iced spearmint, and black pepper over cardamom, clary sage, and lavender, settling into dark musk, amber, cedarwood, and smoky vetiver.",
    priceCents: 4500,
    sku: "CS-EDT-50",
    sortOrder: 0,
    onHand: 50,
    image: {
      url: "/images/coldsmoke-fallback-bottle.svg",
      alt: "The Coldsmoke 50 mL bottle, a dark flask with a brushed silver cap, lit from behind against near-black.",
    },
  },
  {
    slug: "coldsmoke-sample-2ml",
    name: "Coldsmoke Sample",
    tagline: "Two millilitres. Enough to decide.",
    description:
      "A 2 mL atomizer of Coldsmoke Eau de Toilette. Roughly twenty sprays — enough to wear it for a few days and learn how it dries down on your skin.",
    priceCents: 600,
    sku: "CS-SMP-2",
    sortOrder: 1,
    onHand: 200,
    image: {
      url: "/images/coldsmoke-fallback-brand.svg",
      alt: "The Coldsmoke brand card: the wordmark over the line “Cold air. Dark spice.”",
    },
  },
];

async function main() {
  for (const item of SEED) {
    const { onHand, image, ...product } = item;
    const [row] = await db
      .insert(products)
      .values(product)
      .onConflictDoUpdate({
        target: products.slug,
        set: { name: product.name, description: product.description },
      })
      .returning();

    await db
      .insert(inventory)
      .values({ productId: row.id, onHand, reserved: 0 })
      .onConflictDoNothing();

    // Replace rather than append. The seed is re-run routinely and
    // product_images has no unique constraint to conflict on, so inserting
    // would stack a duplicate row on every run.
    await db.delete(productImages).where(eq(productImages.productId, row.id));
    await db
      .insert(productImages)
      .values({ productId: row.id, url: image.url, alt: image.alt });

    console.log(`Seeded ${row.slug}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
