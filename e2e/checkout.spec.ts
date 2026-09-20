import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

/** Where the app receives Stripe webhooks; `stripe listen` must forward here. */
const WEBHOOK_PATH = "/api/stripe/webhook";

/**
 * Why the payment test cannot run, or null if it can.
 *
 * Two things are required, and checking only the first is what made this test
 * fail rather than skip: paying needs a real test key (with the .env
 * placeholder the tax call fails and checkout never reaches the Payment
 * Element), and the final assertion — "Confirmed" — only appears once the
 * webhook marks the order paid, which needs `stripe listen` forwarding to this
 * process. With real keys and no listener the test used to run all the way
 * through the card form and then time out 30s later on an assertion about
 * something the code under test had no part in.
 *
 * Known limitation: this confirms a listener is forwarding to the right path,
 * not that the secret it printed matches STRIPE_WEBHOOK_SECRET in .env. A
 * mismatch still fails, loudly, at signature verification — which is the right
 * place for it to fail.
 */
function paymentSkipReason(): string | null {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (key.length <= 40 || key.includes("placeholder")) {
    return "Needs a real STRIPE_SECRET_KEY; .env holds a placeholder.";
  }

  // `ps` rather than pgrep: -a/-l differ between macOS and Linux, and a guard
  // that throws on one platform would skip everywhere for the wrong reason.
  let commands: string[] = [];
  try {
    commands = execFileSync("ps", ["-ax", "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
  } catch {
    return "Could not list processes to check for a `stripe listen` listener.";
  }

  const listeners = commands.filter((c) => /\bstripe\b.*\blisten\b/.test(c));
  if (listeners.length === 0) {
    return `No \`stripe listen\` is running; the webhook cannot reach ${WEBHOOK_PATH}, so the order never becomes "Confirmed".`;
  }
  if (!listeners.some((c) => c.includes(WEBHOOK_PATH))) {
    return `A \`stripe listen\` is running but none forwards to ${WEBHOOK_PATH} — check its --forward-to.`;
  }

  return null;
}

const PAYMENT_SKIP_REASON = paymentSkipReason();

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

  await page.getByRole("button", { name: /^One more / }).click();

  // Wait for the SERVER-rendered total before reloading, or the reload races
  // the re-render and reads the pre-update cart.
  //
  // Not the stepper's count: it is optimistic, so it shows 2 the instant the
  // button is clicked whether or not the action landed. Asserting it passes
  // either way, which is worse than not asserting at all.
  await expect(page.getByText("$90.00").first()).toBeVisible();

  await page.reload();
  // Still $90 after a round trip, and two bottles clears free shipping.
  await expect(page.getByText("$90.00").first()).toBeVisible();
  await expect(page.getByText("Free")).toBeVisible();
});

test("the stepper changes quantity and price without an update button", async ({
  page,
}) => {
  await addBottleToCart(page);

  const subtotal = async () =>
    (await page.locator("main").innerText()).match(/Subtotal\s*\$([0-9.,]+)/)?.[1];

  await expect(page.getByRole("button", { name: "Update" })).toHaveCount(0);
  expect(await subtotal()).toBe("45.00");

  await page.getByRole("button", { name: /^One more / }).click();
  // Two bottles is $90, which also clears the free-shipping threshold.
  await expect(page.getByText("$90.00").first()).toBeVisible();
  await expect(page.getByText("Free")).toBeVisible();

  await page.getByRole("button", { name: /^One fewer / }).click();
  // Not getByText("$45.00"): the unit price renders as "$45.00 each" and is
  // visible at every quantity, so that assertion passes before the server has
  // done anything and the subtotal read below races it. The subtotal is the
  // only figure here that actually moves.
  await expect.poll(subtotal).toBe("45.00");
});

test("the stepper cannot delete a line", async ({ page }) => {
  await addBottleToCart(page);

  // Removal is a separate, deliberate control, so one click past the end of a
  // decrement run must not empty the cart.
  await expect(page.getByRole("button", { name: /^One fewer / })).toBeDisabled();
  await expect(page.getByText("Your cart is empty.")).toHaveCount(0);
});

test("Remove clears the line", async ({ page }) => {
  await addBottleToCart(page);

  await page.getByRole("button", { name: /^Remove / }).click();

  await expect(page.getByText("Your cart is empty.")).toBeVisible();
});

test("an empty cart cannot reach checkout", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/checkout");
  await expect(page).toHaveURL(/\/cart/);
  await expect(page.getByText("Your cart is empty.")).toBeVisible();
});

test("a guest can buy a bottle", async ({ page }) => {
  test.skip(PAYMENT_SKIP_REASON !== null, PAYMENT_SKIP_REASON ?? "");

  await addBottleToCart(page);
  await expect(page.getByText("$45.00").first()).toBeVisible();

  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout/);

  for (const [label, value] of Object.entries(ADDRESS)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }

  await page.getByRole("button", { name: "Continue to payment" }).click();

  // The Payment Element renders in a Stripe-hosted iframe. Two iframes share
  // the title "Secure payment input frame", so disambiguate with .first()
  // rather than frameLocator, which is strict and would throw.
  const stripeFrame = page
    .locator("iframe[title='Secure payment input frame']")
    .first()
    .contentFrame();

  // The account has several payment methods enabled, so the Element opens on
  // a method picker and the card fields do not exist until Card is chosen.
  await stripeFrame.getByRole("button", { name: "Card", exact: true }).click();

  await stripeFrame
    .getByPlaceholder("1234 1234 1234 1234")
    .fill("4242424242424242");
  await stripeFrame
    .getByPlaceholder("MM / YY")
    .fill("12" + String(new Date().getFullYear() + 2).slice(-2));
  await stripeFrame.getByPlaceholder("CVC").fill("123");
  await stripeFrame.getByPlaceholder("12345").fill("59715");

  // Selecting Card expands the Element by ~570px, which pushes Pay far below
  // the fold. Playwright's auto-scroll races that reflow and the click lands
  // on nothing — silently, because a missed click is not an error. Scroll and
  // let it settle first.
  const pay = page.getByRole("button", { name: /^Pay / });
  await pay.scrollIntoViewIfNeeded();
  await expect(pay).toBeInViewport();
  await pay.click();

  await expect(page).toHaveURL(/\/order\/\d+/, { timeout: 30_000 });

  // getByText would also match Next's route announcer, which mirrors the
  // heading into an aria-live region.
  await expect(page.getByRole("heading", { name: /CS-\d+/ })).toBeVisible();

  // The order lands as "Awaiting payment" and only becomes "Confirmed" once
  // the webhook marks it paid, so this is the assertion that actually proves
  // the paid transition rather than just the redirect. Requires
  // `stripe listen` to be forwarding; PendingNotice polls for ~10s.
  await expect(page.getByText("Confirmed")).toBeVisible({ timeout: 30_000 });
});
