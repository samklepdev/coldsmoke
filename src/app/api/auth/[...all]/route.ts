import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * Better Auth's own endpoints: sign-in, sign-out, verification links, reset
 * links. Our Server Actions call `auth.api.*` directly rather than posting
 * here, but the verification and reset emails link to these routes, so they
 * have to be mounted.
 */
export const { GET, POST } = toNextJsHandler(auth);
