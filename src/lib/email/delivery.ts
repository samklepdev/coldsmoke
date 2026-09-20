/**
 * A one-request handoff for "did the verification email actually go out?".
 *
 * Better Auth calls the sendVerificationEmail hook from inside signUpEmail,
 * ignores its return value, and swallows anything it throws -- measured on
 * 2026-09-20: a hook that throws still resolves signUpEmail and still creates
 * the user. So the sign-up action has no way to learn that the send failed,
 * and it was telling every customer "check your email" for mail Resend had
 * rejected. That is how an unverified sending domain went unnoticed: the only
 * evidence was one line in a server log.
 *
 * Deliberately a small in-process map rather than a table or a cache service.
 * The hook runs inside the same request as the action that reads it, the
 * record is consumed on read, and losing one on a restart costs nothing --
 * the customer can always ask for another link. Anything durable here would
 * be storing state that stops being true within milliseconds.
 */

const results = new Map<string, boolean>();

function key(email: string): string {
  return email.trim().toLowerCase();
}

/** Called from the auth config's send hooks. */
export function recordDelivery(email: string, delivered: boolean): void {
  results.set(key(email), delivered);
}

/**
 * Reads and clears the recorded result.
 *
 * `undefined` means no send was attempted in this request, which callers must
 * treat differently from `false`: only a known failure is worth telling the
 * customer about.
 */
export function takeDelivery(email: string): boolean | undefined {
  const k = key(email);
  const value = results.get(k);
  results.delete(k);
  return value;
}
