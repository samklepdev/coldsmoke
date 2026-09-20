import type { Metadata } from "next";
import { LookupForm } from "./LookupForm";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Find an order" };

export default function OrderLookupPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Find an order</h1>
      <LookupForm />
    </div>
  );
}
