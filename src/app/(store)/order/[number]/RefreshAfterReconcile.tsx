"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";

/**
 * Corrects the header's cart count after reconciliation emptied the cart.
 *
 * The page already redirects once reconciliation succeeds, which is enough for
 * a cold load: the browser makes a second request and the layout renders against
 * the empty cart. It is NOT enough when the customer arrived by client-side
 * navigation — from /order-lookup, say — because the App Router keeps the cached
 * layout for the same route segment, so the layout never re-runs and the badge
 * keeps the count it read before the cart was cleared. That left "Confirmed"
 * sitting next to "Cart (2)", which is the exact symptom reconciliation exists
 * to fix.
 *
 * router.refresh() re-fetches the whole route including layouts, so the badge
 * corrects itself. Then the marker is stripped from the URL with replaceState
 * rather than a router call, so no second navigation happens and a reload does
 * not refresh again.
 *
 * Progressive enhancement, deliberately: with JavaScript off nothing here runs,
 * the order itself is still correct (that happened server-side), and the badge
 * corrects on the customer's next page load.
 */
export function RefreshAfterReconcile() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    router.refresh();
    window.history.replaceState(null, "", pathname);
  }, [router, pathname]);

  return null;
}
