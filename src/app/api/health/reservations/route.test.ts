import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const where = vi.fn(async () => [{ count: 0 }]);
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));
vi.mock("@/lib/db/client", () => ({ db: { select } }));

const { GET } = await import("./route");

function get(authorization?: string): Promise<Response> {
  return GET(
    new Request("http://localhost/api/health/reservations", {
      headers: authorization ? { authorization } : {},
    }),
  );
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  select.mockClear();
  where.mockResolvedValue([{ count: 0 }]);
  process.env.CRON_SECRET = "s3cret-value";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("GET /api/health/reservations", () => {
  it("reports ok when nothing is overdue", async () => {
    const res = await get("Bearer s3cret-value");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, stale: 0 });
  });

  /**
   * The whole point: the cron failing is silent, so the monitor has to notice
   * the consequence. A non-2xx means a status-code-only checker still alerts.
   */
  it("returns 503 when the sweep has fallen behind", async () => {
    where.mockResolvedValue([{ count: 4 }]);
    const res = await get("Bearer s3cret-value");
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, stale: 4 });
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    const res = await get("Bearer wrong-value-xx");
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get("Bearer anything");
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });
});
