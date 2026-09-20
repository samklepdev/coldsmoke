import Link from "next/link";
import type { Metadata } from "next";
import { getActiveProducts } from "@/lib/catalog";
import { Price } from "@/components/ui/Price";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Shop" };

export default async function ShopPage() {
  const products = await getActiveProducts();

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Shop</h1>

      <div className={styles.grid}>
        {products.map((product) => (
          <Link
            key={product.id}
            href={`/product/${product.slug}`}
            className={styles.card}
          >
            <div className={styles.name}>{product.name}</div>
            {product.tagline && (
              <div className={styles.tagline}>{product.tagline}</div>
            )}
            <div className={styles.meta}>
              <Price cents={product.priceCents} />
              {product.available <= 0 && (
                <span className={styles.soldOut}>Sold out</span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
