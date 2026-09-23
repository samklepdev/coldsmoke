import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function createDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  // postgres.js rather than the Neon HTTP driver: inventory reservation needs
  // real multi-statement transactions, which the HTTP driver does not support.
  const client = postgres(connectionString, { max: 10 });

  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let instance: Db | null = null;

function getDb(): Db {
  instance ??= createDb();
  return instance;
}

/**
 * The shared connection pool, created on first use rather than on import.
 *
 * `next build` imports the module graph of every route to collect its config,
 * so anything read at module scope must be present at build time. Deferring
 * the DATABASE_URL read to the first query keeps it a request-time value: the
 * build needs no database, and a single image can be promoted between
 * environments. A missing url still throws, just on first use rather than on
 * import.
 *
 * The proxy exists so call sites stay `db.select()`. Methods are bound to the
 * real instance so drizzle never sees the proxy as its `this`.
 */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const target = getDb();
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
