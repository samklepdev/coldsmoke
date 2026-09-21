import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, orderStatus, type Order } from "@/lib/db/schema";

export const ADMIN_PAGE_SIZE = 50;

type OrderStatus = (typeof orderStatus.enumValues)[number];

function asStatus(value: string | undefined): OrderStatus | null {
  if (!value) return null;
  return (orderStatus.enumValues as readonly string[]).includes(value)
    ? (value as OrderStatus)
    : null;
}

/**
 * The admin orders list. Reads only -- no transition belongs in this file.
 *
 * Search matches the two things a customer quotes when they get in touch:
 * an order number, or their email address. An all-digit query is a number,
 * anything else is an email prefix. Splitting on shape rather than offering
 * two inputs keeps one box on the page and is unambiguous in practice, since
 * an email never begins with only digits.
 *
 * Both filters arrive from the URL and are therefore untrusted. An
 * unrecognised status means no filter rather than an error: a stale or
 * hand-edited link should show orders, not a crash.
 */
export async function listOrdersForAdmin(args: {
  query?: string;
  status?: string;
  page?: number;
}): Promise<{ rows: Order[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(args.page ?? 1));
  const query = args.query?.trim();
  const status = asStatus(args.status);

  const filters: SQL[] = [];

  if (status) {
    filters.push(eq(orders.status, status));
  }

  if (query) {
    if (/^\d+$/.test(query)) {
      filters.push(eq(orders.orderNumber, Number(query)));
    } else {
      filters.push(sql`${orders.email} ILIKE ${`${query}%`}`);
    }
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(ADMIN_PAGE_SIZE)
    .offset((page - 1) * ADMIN_PAGE_SIZE);

  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);

  return {
    rows,
    total: counted?.count ?? 0,
    page,
    pageSize: ADMIN_PAGE_SIZE,
  };
}
