/**
 * Cookie names live here rather than beside the actions that read them.
 *
 * A `"use server"` module may export only async functions — Next.js rejects a
 * plain `const` export from a server-action file at build time — so any name
 * shared between an action and a Server Component needs a neutral home.
 */
export const CART_COOKIE = "cs_cart";
export const DISCOUNT_COOKIE = "cs_discount";
export const PENDING_ORDER_COOKIE = "cs_pending_order";

/**
 * Orders this browser is allowed to view, as a comma-separated list of order
 * ids. The id is a v4 UUID, so the cookie value IS the credential — a cookie
 * naming an order by its customer-facing number would be trivially forgeable,
 * since httpOnly stops page scripts but not a hand-written request.
 */
export const ORDER_ACCESS_COOKIE = "cs_order_access";
