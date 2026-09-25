import { signOutAction } from "@/lib/auth/signOut";

/**
 * A form, not a link. Sign-out is a state change, so it must be a POST --
 * a GET link would be triggered by link prefetching and by anything that
 * fetches URLs on the page, signing people out at random.
 *
 * No "use client": a Server Component can pass a Server Action straight to
 * `form action`, so this works with JavaScript disabled and ships no JS.
 *
 * The wrapping form is styled `display: contents` by its callers, so the
 * button sits directly in their flex row rather than being boxed by the form.
 */
export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button type="submit">Sign out</button>
    </form>
  );
}
