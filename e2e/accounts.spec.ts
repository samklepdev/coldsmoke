import { test, expect } from "@playwright/test";
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

test("a visitor can create an account and is told to confirm it", async ({ page }) => {
  await page.goto("/sign-up");

  await page.getByLabel("Your name").fill("Test Buyer");
  await page.getByLabel("Email").fill(freshEmail());
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText("Check")).toBeVisible();
});

test("an unverified account cannot sign in, and is told why", async ({ page }) => {
  const email = freshEmail();

  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Test Buyer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check")).toBeVisible();

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
