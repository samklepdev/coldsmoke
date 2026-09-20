import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

/**
 * Connects to the throwaway Postgres from docker-compose.test.yml and applies
 * migrations. Integration tests need a real database — reservation races and
 * transaction rollback cannot be proven against a mock.
 */
export async function testDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set. Run npm run db:test:up");

  const client = postgres(url, { max: 5 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });

  return {
    db,
    async truncate() {
      await client`
        TRUNCATE order_items, orders, cart_items, carts, inventory_adjustments,
                 inventory, product_images, products, discount_codes, stripe_events,
                 contact_messages
        RESTART IDENTITY CASCADE`;
    },
    async close() {
      await client.end();
    },
  };
}
