import { describe, it, expect, vi, beforeEach } from "vitest";

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}));

const getSession = vi.fn();
vi.mock("./index", () => ({
  auth: { api: { getSession: () => getSession() } },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { requireAdminUser } = await import("./session");

function session(role: string | null) {
  return {
    user: {
      id: "u1",
      email: "a@example.com",
      name: "A",
      role,
      emailVerified: true,
    },
  };
}

beforeEach(() => {
  redirect.mockClear();
  notFound.mockClear();
  getSession.mockReset();
});

describe("requireAdminUser", () => {
  it("returns the user when they are an admin", async () => {
    getSession.mockResolvedValue(session("admin"));

    const user = await requireAdminUser("/admin/orders");

    expect(user.email).toBe("a@example.com");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer rather than admitting /admin exists", async () => {
    // A redirect would confirm the route is real. The store already refuses
    // to confirm whether an address has an account; this is the same rule.
    getSession.mockResolvedValue(session("customer"));

    await expect(requireAdminUser("/admin/orders")).rejects.toThrow("NOT_FOUND");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("404s a user whose role was never set", async () => {
    getSession.mockResolvedValue(session(null));

    await expect(requireAdminUser("/admin/orders")).rejects.toThrow("NOT_FOUND");
  });

  it("sends a signed-out visitor to sign-in, carrying the destination", async () => {
    getSession.mockResolvedValue(null);

    await expect(requireAdminUser("/admin/orders")).rejects.toThrow(
      "REDIRECT:/sign-in?next=%2Fadmin%2Forders",
    );
    expect(notFound).not.toHaveBeenCalled();
  });
});
