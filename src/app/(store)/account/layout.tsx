import Link from "next/link";
import { requireSessionUser } from "@/lib/auth/session";
import { ContentPage } from "@/components/content/ContentPage";
import styles from "./account.module.css";

/**
 * The security boundary for every /account route.
 *
 * A server-side session check in the layout is the actual gate. Next.js 16's
 * proxy.ts could redirect unauthenticated requests a few milliseconds sooner,
 * but a proxy is an optimisation and not a boundary: it does not run for every
 * render path, and it cannot be relied on to protect data.
 */
export default async function AccountLayout({
  children,
}: LayoutProps<"/account">) {
  const user = await requireSessionUser("/account/orders");

  return (
    <ContentPage title="Your account" lede={user.email}>
      <nav className={styles.tabs} aria-label="Account">
        <Link href="/account/orders">Orders</Link>
        <Link href="/account/addresses">Addresses</Link>
      </nav>
      {children}
    </ContentPage>
  );
}
