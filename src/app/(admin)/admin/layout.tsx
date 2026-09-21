import Link from "next/link";
import { requireAdminUser } from "@/lib/auth/session";
import styles from "./admin.module.css";

/**
 * The security boundary for every /admin route.
 *
 * The check is here, in the layout, for the same reason the account layout
 * puts it here: a layout runs on every render path for the segment, and a
 * proxy does not. Next.js 16's proxy.ts could redirect a few milliseconds
 * sooner, but an optimisation is not a boundary.
 *
 * Admin deliberately does not inherit the store layout. Storefront chrome --
 * cart link, marketing nav, footer -- is wrong here and would invite
 * navigating back into the shop mid-task.
 */
export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const user = await requireAdminUser("/admin/orders");

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <Link href="/admin/orders" className={styles.wordmark}>
          COLDSMOKE
        </Link>
        <nav className={styles.nav} aria-label="Admin">
          <Link href="/admin/orders">Orders</Link>
        </nav>
        <span className={styles.who}>{user.email}</span>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
