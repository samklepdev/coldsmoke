import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Every internal link in the site chrome must resolve to a route.
 *
 * This is the defect that motivated the marketing-pages work: the header and
 * footer shipped links to /about, /contact, /faq, /shipping-returns and
 * /the-scent while none of those routes existed, so every page of the store
 * carried five 404s. Nothing caught it because nothing was looking.
 *
 * Deliberately one-directional -- it checks that links resolve, not that every
 * route is linked. /order/[number] is reached from a redirect and should not
 * appear in navigation, so the reverse check would flag correct code.
 */

const ROOT = path.resolve(__dirname, "../..");
const CHROME = [
  "src/components/SiteHeader.tsx",
  "src/components/SiteFooter.tsx",
];

function internalHrefs(file: string): string[] {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  return [...source.matchAll(/href="(\/[^"]*)"/g)]
    .map((m) => m[1])
    .filter((href) => !href.startsWith("//"));
}

/**
 * Paths that reach the chrome through a JSX expression rather than a literal
 * attribute -- `href={signedIn ? "/account/orders" : "/sign-in"}`.
 *
 * `internalHrefs` reads literal href="..." attributes only, so these are
 * invisible to it. Listing them by hand is not ideal; leaving a link
 * unchecked because it is written as a ternary is worse. The assertion below
 * checks both that the route exists AND that the header still mentions the
 * path, so deleting the link from the header fails here rather than silently
 * shrinking what is covered.
 */
const EXPRESSION_HREFS: [string, string][] = [
  ["src/components/SiteHeader.tsx", "/account/orders"],
  ["src/components/SiteHeader.tsx", "/sign-in"],
];

/** Does a route exist for this path? Dynamic segments match any value. */
function routeExists(href: string): boolean {
  const segments = href.split("/").filter(Boolean);
  if (segments.length === 0) {
    // "/" is the store group's index.
    return existsSync(path.join(ROOT, "src/app/(store)/page.tsx"));
  }

  const candidates = [
    path.join(ROOT, "src/app", ...segments, "page.tsx"),
    path.join(ROOT, "src/app/(store)", ...segments, "page.tsx"),
  ];
  return candidates.some(existsSync);
}

describe("site chrome links", () => {
  const links = CHROME.flatMap((file) =>
    internalHrefs(file).map((href) => [file, href] as const),
  );

  it("finds links to check", () => {
    // Guards the guard: a regex that matched nothing would make every
    // assertion below vacuously true.
    expect(links.length).toBeGreaterThanOrEqual(8);
  });

  it.each(links)("%s links to %s, which exists", (_file, href) => {
    expect(routeExists(href)).toBe(true);
  });

  it.each(EXPRESSION_HREFS)(
    "%s links to %s from an expression, which exists",
    (file, href) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source, `${file} no longer mentions ${href}`).toContain(`"${href}"`);
      expect(routeExists(href)).toBe(true);
    },
  );
});
