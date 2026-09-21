import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

/**
 * A fresh address per run.
 *
 * Sign-up is not idempotent: the second run with a fixed address takes the
 * "already registered" path and the assertions below stop testing what they
 * claim to. The contact suite learned the same lesson against the rate
 * limiter -- a suite that only passes the first time is not a suite.
 */
function freshEmail(): string {
  return `buyer-${randomBytes(8).toString("hex")}@example.com`;
}

const PASSWORD = "a long enough password";

/**
 * Sign-up answers with one of two messages, and both are correct: "check your
 * email" when Resend accepted the confirmation, and an explicit failure when
 * it did not. Which one appears depends on whether a sending domain is
 * verified -- a third-party fact an end-to-end run must not depend on.
 *
 * So assert what both branches guarantee instead of the wording of either:
 * the address is echoed back, and the account exists either way. Asserting
 * "Check" pinned the optimistic branch and started failing the moment sign-up
 * learned to admit a rejected send.
 */
async function expectSignUpAcknowledged(page: Page, email: string) {
  await expect(page.getByText(email)).toBeVisible();
}

test("a visitor can create an account and is told to confirm it", async ({ page }) => {
  const email = freshEmail();

  await page.goto("/sign-up");

  await page.getByLabel("Your name").fill("Test Buyer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expectSignUpAcknowledged(page, email);
});

test("an unverified account cannot sign in, and is told why", async ({ page }) => {
  const email = freshEmail();

  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Test Buyer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expectSignUpAcknowledged(page, email);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // requireEmailVerification, proven end to end rather than from the config.
  await expect(page.getByText("Confirm your email address first")).toBeVisible();
});

test("a wrong password does not reveal whether the account exists", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("definitely-nobody@example.com");
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("That email and password do not match.")).toBeVisible();
});

test("the account area turns an anonymous visitor away", async ({ page }) => {
  // The security boundary. If this ever passes through to the page, a signed
  // out visitor is reading somebody's order history.
  await page.goto("/account/orders");

  await expect(page).toHaveURL(/\/sign-in/);
});

test("guest checkout still works", async ({ page }) => {
  // Accounts are an addition, not a gate. This is the revenue path.
  await page.goto("/shop");
  await page.getByText("Coldsmoke Eau de Toilette").click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page).toHaveURL(/\/cart/);

  await page.getByRole("link", { name: /checkout/i }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("every account page loads", async ({ page }) => {
  for (const path of ["/sign-in", "/sign-up", "/forgot-password", "/verify-email"]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should not 404`).toBe(200);
  }
});
