import { test, expect } from "@playwright/test";

/**
 * Paying requires a real Stripe test key. With the placeholder in .env the
 * tax call fails and checkout never reaches the Payment Element, so the
 * payment leg is skipped rather than left failing for a reason that has
 * nothing to do with the code under test.
 */
const STRIPE_KEYS_ARE_REAL =
  (process.env.STRIPE_SECRET_KEY ?? "").length > 40 &&
  !(process.env.STRIPE_SECRET_KEY ?? "").includes("placeholder");

const ADDRESS = {
  Email: "buyer@example.com",
  "Full name": "Test Buyer",
  Address: "1 Powder Lane",
  City: "Bozeman",
  State: "MT",
  ZIP: "59715",
};

async function addBottleToCart(page: import("@playwright/test").Page) {
  await page.goto("/shop");
  await expect(page.getByText("Coldsmoke Eau de Toilette")).toBeVisible();

  await page.getByText("Coldsmoke Eau de Toilette").click();
  await expect(page.getByRole("button", { name: "Add to cart" })).toBeVisible();
  await page.getByRole("button", { name: "Add to cart" }).click();

  await expect(page).toHaveURL(/\/cart/);
}

test("a guest can fill a cart and reach the checkout form", async ({ page }) => {
  await addBottleToCart(page);

  await expect(page.getByText("$45.00").first()).toBeVisible();
  // $45 is under the $50 free-shipping threshold.
  await expect(page.getByText("$6.00").first()).toBeVisible();

  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout/);

  for (const [label, value] of Object.entries(ADDRESS)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }

  await expect(
    page.getByRole("button", { name: "Continue to payment" }),
  ).toBeEnabled();
});

test("the cart survives a reload and totals recalculate", async ({ page }) => {
  await addBottleToCart(page);

  await page.getByLabel(/^Quantity of /).fill("2");
  await page.getByRole("button", { name: "Update" }).click();

  await page.reload();
  // Two bottles is $90, which clears the free-shipping threshold.
  await expect(page.getByText("$90.00").first()).toBeVisible();
  await expect(page.getByText("Free")).toBeVisible();
});

test("an empty cart cannot reach checkout", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/checkout");
  await expect(page).toHaveURL(/\/cart/);
  await expect(page.getByText("Your cart is empty.")).toBeVisible();
});

test("a guest can buy a bottle", async ({ page }) => {
  test.skip(
    !STRIPE_KEYS_ARE_REAL,
    "Needs a real STRIPE_SECRET_KEY; .env holds a placeholder.",
  );

  await addBottleToCart(page);
  await expect(page.getByText("$45.00").first()).toBeVisible();

  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout/);

  for (const [label, value] of Object.entries(ADDRESS)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }

  await page.getByRole("button", { name: "Continue to payment" }).click();

  // The Payment Element renders in a Stripe-hosted iframe.
  const stripeFrame = page.frameLocator("iframe[title*='payment']").first();
  await stripeFrame
    .getByPlaceholder("1234 1234 1234 1234")
    .fill("4242424242424242");
  await stripeFrame
    .getByPlaceholder("MM / YY")
    .fill("12" + String(new Date().getFullYear() + 2).slice(-2));
  await stripeFrame.getByPlaceholder("CVC").fill("123");
  await stripeFrame.getByPlaceholder("12345").fill("59715");

  await page.getByRole("button", { name: /^Pay / }).click();

  await expect(page).toHaveURL(/\/order\/\d+/, { timeout: 30_000 });
  await expect(page.getByText(/CS-\d+/)).toBeVisible();
});
