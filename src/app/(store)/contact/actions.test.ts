import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@/lib/email/client", () => ({
  getResend: () => ({ emails: { send: sendMock } }),
  EMAIL_FROM: "Coldsmoke <orders@example-verified.test>",
}));

vi.mock("@/lib/contact", () => ({
  hashIp: () => "hash",
  isRateLimited: async () => false,
  recordMessage: async () => ({ id: "msg_1" }),
  markDelivered: vi.fn(async () => {}),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const { sendContactMessage } = await import("./actions");

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const VALID = {
  email: "buyer@example.com",
  // An untouched input still posts "", which is what the real form sends.
  orderNumber: "",
  message: "My order has not arrived yet, can you check?",
};

describe("contact sender address", () => {
  /**
   * The defect this covers: the sender was hardcoded to a wearcoldsmoke.com
   * address while every other send read EMAIL_FROM. Resend rejects any domain
   * that is not verified, so pointing EMAIL_FROM at a different domain fixed
   * auth and order mail while leaving this form failing -- and failing
   * quietly, because the message is stored before the send and the customer
   * is told "sent" either way. That is the whole failure: a broken contact
   * form on a site that otherwise looks healthy.
   */
  it("sends from EMAIL_FROM rather than a hardcoded domain", async () => {
    await sendContactMessage({ status: "idle" }, form(VALID));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Coldsmoke <orders@example-verified.test>" }),
    );
  });

  it("still replies to the customer, not to the sender", async () => {
    // The From is ours so the domain stays verified; replyTo is what makes
    // hitting reply in the support inbox reach the customer.
    await sendContactMessage({ status: "idle" }, form(VALID));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ replyTo: "buyer@example.com" }),
    );
  });
});
