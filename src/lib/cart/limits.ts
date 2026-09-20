/**
 * Cart limits, kept free of server-only imports.
 *
 * `@/lib/cart` pulls in next/headers and the Postgres client, so a Client
 * Component importing a constant from it drags fs/net/tls and the database
 * driver into the browser bundle and the build fails. Same reason
 * `src/lib/cookies.ts` exists.
 */

/**
 * Per-line ceiling shared by the quantity controls and the actions that write
 * them. cart_items.quantity is int4 with no CHECK constraint, so an unbounded
 * value would eventually overflow on the `quantity + n` upsert in addItem.
 */
export const MAX_LINE_QUANTITY = 99;
