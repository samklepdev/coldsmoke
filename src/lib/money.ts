const formatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Formats integer cents for display. This is the only place cents become a
 * decimal string — never do money arithmetic on the result.
 */
export function formatCents(cents: number): string {
  return formatter.format(cents / 100);
}
