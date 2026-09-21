import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrderWithItems } from "@/lib/orders";

const sendMock = vi.fn();
vi.mock("./client", () => ({
  getResend: () => ({ emails: { send: sendMock } }),
  EMAIL_FROM: "Coldsmoke <orders@example-verified.test>",
}));

const { sendShippingConfirmation } = await import("./shipping");
const { ShippingConfirmation } = await import("./ShippingConfirmation");

beforeEach(() => {
  sendMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const ORDER = {
  id: "00000000-0000-0000-0000-000000000000",
  orderNumber: 1042,
  email: "buyer@example.com",
  status: "fulfilled",
  subtotalCents: 4500,
  discountCents: 0,
  shippingCents: 600,
  taxCents: 0,
  totalCents: 5100,
  carrier: "USPS",
  trackingNumber: "9400111899223197428490",
  shippingAddress: {
    name: "Test Buyer",
    line1: "1 Powder Lane",
    city: "Bozeman",
    state: "MT",
    postalCode: "59715",
    country: "US",
  },
  items: [],
} as unknown as OrderWithItems;

describe("ShippingConfirmation", () => {
  it("renders the carrier and the tracking number", async () => {
    const { render } = await import("@react-email/render");

    const html = await render(ShippingConfirmation({ order: ORDER }));

    expect(html).toContain("USPS");
    expect(html).toContain("9400111899223197428490");
    expect(html).toContain("CS-1042");
  });
});

describe("sendShippingConfirmation", () => {
  it("reports delivery when Resend accepts the message", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });

    expect(await sendShippingConfirmation(ORDER)).toEqual({ delivered: true });
  });

  it("reports failure when Resend returns an error instead of throwing", async () => {
    // The failure Resend actually produces for an unverified sending domain:
    // a 403 returned as a value, not raised. A bare try/catch calls this
    // success and the admin is told the customer was notified.
    sendMock.mockResolvedValue({
      data: null,
      error: { statusCode: 403, name: "validation_error", message: "not verified" },
    });

    expect(await sendShippingConfirmation(ORDER)).toEqual({ delivered: false });
  });

  it("reports failure when the call throws outright", async () => {
    sendMock.mockRejectedValue(new Error("socket hang up"));

    expect(await sendShippingConfirmation(ORDER)).toEqual({ delivered: false });
  });

  it("sends from EMAIL_FROM", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });

    await sendShippingConfirmation(ORDER);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Coldsmoke <orders@example-verified.test>",
        to: "buyer@example.com",
      }),
    );
  });
});
