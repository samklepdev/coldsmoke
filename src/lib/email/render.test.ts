import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";

/**
 * Order confirmations are sent by handing Resend a React component, and
 * Resend renders it by `require`-ing `@react-email/render` from its OWN
 * location in node_modules.
 *
 * That package arrived only as a nested dependency of
 * `@react-email/components`, so it was never hoisted to the top level and
 * Resend could not see it. Every paid order failed to send a confirmation
 * with "Make sure to install `@react-email/render`" -- and nothing caught it,
 * because sendOrderConfirmation deliberately swallows send failures so a
 * broken email cannot fail a Stripe webhook. The e2e payment test stayed
 * green the whole time.
 *
 * These assert the dependency is declared and reachable from the place that
 * actually needs it, which is the thing that was broken.
 */

const ROOT = path.resolve(__dirname, "../../..");

describe("order confirmation rendering", () => {
  it("declares @react-email/render as a direct dependency", () => {
    // A transitive copy is not enough: npm may nest it where Resend cannot
    // reach it, which is exactly what happened.
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(pkg.dependencies ?? {})).toContain("@react-email/render");
  });

  it("lets Resend resolve the renderer from its own location", () => {
    const fromResend = createRequire(
      path.join(ROOT, "node_modules/resend/package.json"),
    );

    expect(() => fromResend.resolve("@react-email/render")).not.toThrow();
  });

  it("renders the order confirmation to HTML", async () => {
    const { render } = await import("@react-email/render");
    const { OrderConfirmation } = await import("./OrderConfirmation");

    const html = await render(
      OrderConfirmation({
        order: {
          id: "00000000-0000-0000-0000-000000000000",
          orderNumber: 1042,
          email: "buyer@example.com",
          status: "paid",
          subtotalCents: 4500,
          discountCents: 0,
          shippingCents: 600,
          taxCents: 0,
          totalCents: 5100,
          shippingAddress: {
            name: "Test Buyer",
            line1: "1 Powder Lane",
            city: "Bozeman",
            state: "MT",
            postalCode: "59715",
            country: "US",
          },
          items: [
            {
              id: "00000000-0000-0000-0000-000000000001",
              orderId: "00000000-0000-0000-0000-000000000000",
              productId: "00000000-0000-0000-0000-000000000002",
              name: "Coldsmoke Eau de Toilette",
              unitPriceCents: 4500,
              quantity: 1,
              totalCents: 4500,
            },
          ],
          // Fields the template does not read, present for the type.
        } as unknown as Parameters<typeof OrderConfirmation>[0]["order"],
      }),
    );

    expect(html).toContain("CS-1042");
    expect(html).toContain("Coldsmoke Eau de Toilette");
  });
});
