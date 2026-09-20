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
