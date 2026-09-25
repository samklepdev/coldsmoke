import { describe, it, expect, beforeEach, vi } from "vitest";

const signOut = vi.fn(async () => undefined);
vi.mock("./index", () => ({ auth: { api: { signOut } } }));

const requestHeaders = new Headers({ cookie: "better-auth.session=abc" });
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

// redirect() throws in Next to unwind rendering; mirror that so the action's
// control flow is exercised rather than silently continuing past it.
const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({ redirect }));

const { signOutAction } = await import("./signOut");

beforeEach(() => {
  signOut.mockClear();
  redirect.mockClear();
});

describe("signOutAction", () => {
  it("ends the session before redirecting", async () => {
    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT:/");

    expect(signOut).toHaveBeenCalledTimes(1);
    // Order matters: redirecting first would leave the session alive if the
    // sign-out call then failed.
    expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(
      redirect.mock.invocationCallOrder[0],
    );
  });

  /**
   * Better Auth reads the session from the incoming request's cookies. Calling
   * signOut without them revokes nothing and still redirects, which looks
   * exactly like success.
   */
  it("passes the request headers through", async () => {
    await expect(signOutAction()).rejects.toThrow();
    expect(signOut).toHaveBeenCalledWith({ headers: requestHeaders });
  });

  it("does not redirect if ending the session fails", async () => {
    signOut.mockRejectedValueOnce(new Error("upstream down"));
    await expect(signOutAction()).rejects.toThrow("upstream down");
    expect(redirect).not.toHaveBeenCalled();
  });
});
