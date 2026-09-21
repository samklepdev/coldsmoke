import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { auth } from "./index";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string | null;
  emailVerified: boolean;
};

/**
 * The signed-in customer, or null. Safe to call while rendering a Server
 * Component: it only reads headers.
 *
 * Every page reads the session through here rather than calling
 * auth.api.getSession directly, so the shape a page depends on is declared in
 * one place and Plan C's admin checks have somewhere to hang.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role ?? null,
    emailVerified: session.user.emailVerified,
  };
}

/**
 * The signed-in customer, or a redirect to sign-in.
 *
 * `next` is carried through the redirect so a customer who lands on a
 * deep-linked account page returns to it after signing in instead of being
 * dumped on a generic page and left to navigate back.
 */
export async function requireSessionUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    const target = next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in";
    redirect(target);
  }
  return user;
}

/**
 * The signed-in admin, or no return at all.
 *
 * A non-admin gets `notFound()`, not a redirect or a 403. A redirect would
 * confirm that /admin is a real route; the 404 makes it indistinguishable
 * from a path that was never registered. That matches how the sign-up and
 * resend-verification forms already refuse to confirm anything about an
 * address.
 *
 * Signed out is different from signed in without the role: the first is a
 * missing credential and is worth sending to sign-in, the second is a
 * credential that will never be enough.
 */
export async function requireAdminUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    const target = next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in";
    redirect(target);
  }
  if (user.role !== "admin") {
    notFound();
  }
  return user;
}
