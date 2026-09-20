import { cookies } from "next/headers";
import { ORDER_ACCESS_COOKIE } from "@/lib/cookies";

/**
 * How many recent orders a browser keeps access to. A customer who orders
 * repeatedly should not silently lose the confirmation page for the previous
 * one, but the cookie must not grow without bound either.
 */
const MAX_REMEMBERED_ORDERS = 10;

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function parse(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_REMEMBERED_ORDERS);
}

/**
 * Order ids this browser may view. Safe to call while rendering a Server
 * Component — it only reads.
 *
 * These ids are untrusted input: anything could be in the cookie. They are
 * only ever used as an equality filter against a specific order number, so a
 * forged value has to be a correct UUID guess to grant anything.
 */
export async function readGrantedOrderIds(): Promise<string[]> {
  const jar = await cookies();
  return parse(jar.get(ORDER_ACCESS_COOKIE)?.value);
}

/**
 * Remembers that this browser may view an order. Most recent first, so the
 * cap evicts the oldest.
 *
 * WRITES A COOKIE — callable only from a Server Action or Route Handler.
 */
export async function grantOrderAccess(orderId: string): Promise<void> {
  const jar = await cookies();
  const existing = parse(jar.get(ORDER_ACCESS_COOKIE)?.value);

  const next = [orderId, ...existing.filter((id) => id !== orderId)].slice(
    0,
    MAX_REMEMBERED_ORDERS,
  );

  jar.set(ORDER_ACCESS_COOKIE, next.join(","), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}
