import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug } from "@/lib/catalog";
import { MAX_LINE_QUANTITY } from "@/lib/cart";
import { Wordmark } from "@/components/ui/Wordmark";
import { Button } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { addToCartAction } from "../../actions";
import styles from "./page.module.css";

export async function generateMetadata({
  params,
}: PageProps<"/product/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  return { title: product?.name ?? "Not found" };
}

export default async function ProductPage({
  params,
}: PageProps<"/product/[slug]">) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const soldOut = product.available <= 0;
  const image = product.images[0];

  return (
    <div className={styles.page}>
      <div className={styles.visual}>
        {image ? (
          <Image
            src={image.url}
            alt={image.alt}
            // fill, not width/height: the URL comes from the database, so the
            // intrinsic size is not known at build time.
            fill
            className={styles.image}
            sizes="(max-width: 640px) 100vw, 45vw"
            priority
          />
        ) : (
          <Wordmark size={24} />
        )}
      </div>

      <div>
        <h1 className={styles.name}>{product.name}</h1>
        {product.tagline && <p className={styles.tagline}>{product.tagline}</p>}
        <p className={styles.price}>
          <Price cents={product.priceCents} />
        </p>
        <p className={styles.description}>{product.description}</p>

        <form action={addToCartAction} className={styles.form}>
          <input type="hidden" name="productId" value={product.id} />
          <label className="sr-only" htmlFor="quantity">
            Quantity
          </label>
          <input
            id="quantity"
            className={styles.qty}
            type="number"
            name="quantity"
            defaultValue={1}
            min={1}
            max={Math.min(Math.max(product.available, 1), MAX_LINE_QUANTITY)}
            disabled={soldOut}
          />
          <Button type="submit" variant="primary" disabled={soldOut}>
            {soldOut ? "Sold out" : "Add to cart"}
          </Button>
        </form>

        {!soldOut && product.available <= 10 && (
          <p className={styles.stock}>{product.available} left.</p>
        )}

        <p className={styles.legal}>
          Eau de Toilette Spray. Ships ground within the US only — fragrance
          cannot travel by air. For external use only.
        </p>
      </div>
    </div>
  );
}
