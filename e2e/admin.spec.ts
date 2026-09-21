import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/auth-schema";

/**
 * The /admin boundary.
 *
 * A signed-out visitor gets redirected to sign-in -- confirming the route
 * exists is fine before anyone is authenticated. A signed-in customer
 * instead has to get AdminLayout's notFound(), not a redirect: a redirect
 * would confirm /admin is real to anyone who tried it, and the whole point
 * of the 404 is that a customer cannot tell it apart from a path that was
 * never registered.
 *
 * That second case needs a genuinely authenticated, non-admin session, which
 * sign-up alone does not produce: with requireEmailVerification on, sign-up
 * does not set a session cookie, and Resend refuses every send in this
 * environment (no verified sending domain), so there is no inbox to click a
 * link from. The DB write below stands in for that click.
 *
 * It also means the customer-vs-signed-out cases cannot be told apart by
 * HTTP status alone. notFound() is thrown after an `await` (the session
 * lookup), and by the time it fires Next has already sent a 200 and is
 * streaming the not-found UI into the body -- see the "Status Codes" section
 * of node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md.
 * Confirmed with curl against both `next dev` and a production build: same
 * 200, same chunked body, in both. So this asserts what the boundary
 * actually guarantees -- no redirect, and the not-found UI renders instead
 * of the admin shell -- rather than a status code Next documents as
 * unreliable for exactly this case.
 */

test("sends a signed-out visitor to sign-in", async ({ page }) => {
  await page.goto("/admin/orders");

  await expect(page).toHaveURL(/\/sign-in\?next=/);
});

test("shows a signed-in customer the not-found page, not a redirect", async ({ page }) => {
  const email = `admin-guard-${Date.now()}@example.com`;

  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Guard Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status").or(page.getByRole("alert"))).toBeVisible();

  // The row can lag a beat behind the confirmation UI, so poll for it rather
  // than racing the insert.
  await expect
    .poll(async () => {
      const [row] = await db.select().from(user).where(eq(user.email, email));
      return row?.id;
    })
    .toBeTruthy();
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account\/orders$/);

  await page.goto("/admin/orders");

  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
});
