import { describe, it, expect, beforeEach, vi } from "vitest";

const execute = vi.fn(async () => undefined);
vi.mock("@/lib/db/client", () => ({ db: { execute } }));

const { GET } = await import("./route");

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue(undefined);
});

describe("GET /api/health", () => {
  it("reports healthy when the database answers", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  /**
   * The point of the whole route. A container that boots without a reachable
   * database must not be reported healthy, or Railway promotes it and every
   * page starts throwing -- which is the failure a bare 200 cannot see.
   */
  it("reports 503 when the database is unreachable", async () => {
    execute.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false });
  });

  it("does not leak the failure into the response body", async () => {
    execute.mockRejectedValue(new Error("password authentication failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET();
    expect(JSON.stringify(await res.json())).not.toContain("password");
  });

  it("touches no table, so a schema change cannot fail the check", async () => {
    await GET();
    const [query] = execute.mock.calls[0] as unknown as [{ queryChunks?: unknown }];
    expect(JSON.stringify(query)).toContain("select 1");
  });
});
