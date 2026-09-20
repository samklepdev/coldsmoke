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
