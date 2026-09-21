import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { user } from "./schema";

/**
 * Promotes one account to admin, by email.
 *
 * Deliberately separate from db:seed. Seeding writes product rows and is the
 * kind of script that gets run casually; granting access to every order and
 * every customer's address is not. Keeping them apart means no one can grant
 * admin by re-seeding.
 *
 * There is no bootstrap path that promotes automatically. On a public
 * storefront "the first account becomes admin" is a race a stranger can win.
 * Holding the database credentials is the authorisation.
 */
async function main(): Promise<void> {
  const email = process.argv[2]?.trim();

  if (!email) {
    console.error("Usage: npm run db:promote-admin -- <email>");
    process.exitCode = 1;
    return;
  }

  const [existing] = await db
    .select()
    .from(user)
    .where(sql`LOWER(${user.email}) = LOWER(${email})`)
    .limit(1);

  if (!existing) {
    console.error(
      `No account for ${email}. Sign up with that address first, then run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  if (existing.role === "admin") {
    console.log(`${existing.email} is already an admin. Nothing to do.`);
    return;
  }

  await db.update(user).set({ role: "admin" }).where(eq(user.id, existing.id));

  console.log(
    `Promoted ${existing.email}: ${existing.role ?? "customer"} -> admin`,
  );
}

main()
  .catch((error) => {
    console.error("[promote-admin] failed", error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
