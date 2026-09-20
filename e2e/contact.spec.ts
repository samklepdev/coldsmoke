import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";

/**
 * A distinct client address for every run of this file.
 *
 * The contact form rate-limits on a hash of the client IP: five messages per
 * rolling hour. Each run of this suite spends one of those five, so without a
 * fresh address the sixth run within an hour failed on the limiter rather than
 * on a defect -- a green suite that goes red purely because you ran it too
 * often. Measured before this was added: runs one through five passed, run six
 * failed and stored nothing.
 *
 * Deliberately not fixed by raising the limit or resetting the table. The
 * limit is production behaviour and should not bend for tests, and reaching
 * into Postgres would give this suite a second way to talk to the app when
 * every other assertion here goes through the browser.
 *
 * 2001:db8::/32 is reserved for documentation (RFC 3849), so a generated
 * address can never collide with a real client.
 */
function documentationAddress(): string {
  const groups = Array.from({ length: 6 }, () =>
    randomBytes(2).toString("hex"),
  );
  return ["2001", "db8", ...groups].join(":");
}

test.use({ extraHTTPHeaders: { "x-forwarded-for": documentationAddress() } });

test("a visitor can send a contact message", async ({ page }) => {
  await page.goto("/contact");

  await page.getByLabel("Your email").fill("buyer@example.com");
  await page.getByLabel("Message").fill("Does this ship to Alaska?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("we have your message")).toBeVisible();
});

test("a short message is refused with a reason", async ({ page }) => {
  await page.goto("/contact");

  await page.getByLabel("Your email").fill("buyer@example.com");
  await page.getByLabel("Message").fill("hi");
  await page.getByRole("button", { name: "Send" }).click();

  // The point is that it says WHY. A silent no-op is the bug this project
  // already shipped once, on the cart quantity box.
  await expect(page.getByText("Tell us a little more.")).toBeVisible();
});

test("every page linked from the footer loads", async ({ page }) => {
  for (const path of [
    "/the-scent",
    "/about",
    "/faq",
    "/contact",
    "/shipping-returns",
    "/privacy",
    "/terms",
  ]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should not 404`).toBe(200);
  }
});
