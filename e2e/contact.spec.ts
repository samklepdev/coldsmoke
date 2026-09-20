import { test, expect } from "@playwright/test";

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
