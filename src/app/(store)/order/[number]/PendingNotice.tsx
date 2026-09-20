"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

/**
 * The webhook usually lands within a second or two of the customer arriving
 * here, so refresh a few times before giving up rather than showing a
 * misleading "not paid" state.
 */
export function PendingNotice() {
  const router = useRouter();

  useEffect(() => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      router.refresh();
      if (attempts >= 5) clearInterval(timer);
    }, 2000);

    return () => clearInterval(timer);
  }, [router]);

  return (
    <p role="status" className={styles.pending}>
      Confirming your payment. This takes a moment.
    </p>
  );
}
