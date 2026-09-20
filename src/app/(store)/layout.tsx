import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { getCartId, getCartLines } from "@/lib/cart";
import { getSessionUser } from "@/lib/auth/session";

export default async function StoreLayout({ children }: LayoutProps<"/">) {
  // Read-only: a layout renders as a Server Component and may not set cookies.
  const cartId = await getCartId();
  const lines = cartId ? await getCartLines(cartId) : [];
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const user = await getSessionUser();

  return (
    <>
      <SiteHeader cartCount={count} signedIn={user !== null} />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
