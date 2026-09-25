import Link from "next/link";
import { SignOutButton } from "./SignOutButton";
import { Wordmark } from "./ui/Wordmark";
import styles from "./SiteHeader.module.css";

export function SiteHeader({
  cartCount = 0,
  signedIn = false,
}: {
  cartCount?: number;
  signedIn?: boolean;
}) {
  return (
    <header className={styles.header}>
      <Link href="/" aria-label="Coldsmoke home">
        <Wordmark size={18} />
      </Link>

      <nav className={styles.nav} aria-label="Primary">
        <Link href="/shop">Shop</Link>
        <Link href="/the-scent">The Scent</Link>
        <Link href="/about">About</Link>
        <Link href={signedIn ? "/account/orders" : "/sign-in"}>
          {signedIn ? "Account" : "Sign in"}
        </Link>
        {signedIn ? <SignOutButton /> : null}
      </nav>

      <Link href="/cart" className={styles.cart}>
        Cart{cartCount > 0 ? ` (${cartCount})` : ""}
      </Link>
    </header>
  );
}
