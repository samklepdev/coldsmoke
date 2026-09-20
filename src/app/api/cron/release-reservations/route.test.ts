import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const releaseExpiredReservations = vi.fn(async () => 3);
vi.mock("@/lib/inventory", () => ({ releaseExpiredReservations }));

const { GET } = await import("./route");

function get(authorization?: string): Promise<Response> {
  return GET(
    new Request("http://localhost/api/cron/release-reservations", {
      headers: authorization ? { authorization } : {},
    }),
  );
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  releaseExpiredReservations.mockClear();
  process.env.CRON_SECRET = "s3cret-value";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("GET /api/cron/release-reservations", () => {
  it("runs the sweep and reports how many it released", async () => {
    const response = await get("Bearer s3cret-value");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ released: 3 });
    expect(releaseExpiredReservations).toHaveBeenCalledTimes(1);
  });

  it("401s without an authorization header", async () => {
    const response = await get();

    expect(response.status).toBe(401);
    expect(releaseExpiredReservations).not.toHaveBeenCalled();
  });

  it("401s on a wrong secret", async () => {
    const response = await get("Bearer not-the-secret");

    expect(response.status).toBe(401);
    expect(releaseExpiredReservations).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    // Without an explicit guard the comparison is against the literal string
    // "Bearer undefined", which anyone could send.
    delete process.env.CRON_SECRET;

    const response = await get("Bearer undefined");

    expect(response.status).toBe(401);
    expect(releaseExpiredReservations).not.toHaveBeenCalled();
  });

  it("401s when the header is a prefix of the expected value", async () => {
    const response = await get("Bearer s3cret");

    expect(response.status).toBe(401);
    expect(releaseExpiredReservations).not.toHaveBeenCalled();
  });
});
