import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// postgres.js rather than the Neon HTTP driver: inventory reservation needs
// real multi-statement transactions, which the HTTP driver does not support.
const client = postgres(connectionString, { max: 10 });

export const db = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
