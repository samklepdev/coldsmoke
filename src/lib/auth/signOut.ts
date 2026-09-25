"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./index";

/**
 * Ends the session and returns the visitor to the storefront.
 *
 * Lives here rather than in `(store)/sign-in/actions.ts`, where it started,
 * because the site header calls it on every page. A component rendered
 * everywhere should not import from one route's internals -- the same reason
 * `lib/cookies.ts` and `lib/cart/limits.ts` exist.
 *
 * A Server Action, so the browser sends a POST. Sign-out must never be
 * reachable by GET: a link would be followed by link prefetching and by
 * anything that fetches URLs on a page, signing people out at random.
 *
 * The cart is deliberately left alone. Its cookie is independent of the
 * session, so a customer who signs out mid-shop keeps their basket. The
 * trade-off is that `getCartId` matches on the cookie alone, so on a shared
 * computer the next person still sees that cart.
 */
export async function signOutAction(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
  redirect("/");
}
