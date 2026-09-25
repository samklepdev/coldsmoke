/**
 * The states this store ships to, and the only values its address forms accept.
 *
 * One list doing two jobs: it populates the dropdown *and* it is the
 * server-side allowlist. Before this module the check was `/^[A-Za-z]{2}$/`,
 * which accepts "XX" -- not a state, but still handed to Stripe Tax as if it
 * were one, where it decides what tax to charge. A list used only by the UI
 * would leave that open, so both actions import US_STATE_CODES from here
 * rather than restating what a state is.
 *
 * Free of zod and of server-only imports, for the reason `lib/business.ts` and
 * `lib/cart/limits.ts` are free of the latter: a Client Component imports this
 * file. `@/lib/addresses` reaches the Postgres client, and zod is otherwise
 * confined to "use server" modules -- importing either here would drag it into
 * the browser bundle.
 *
 * Territories (PR, VI, GU, AS, MP) and military codes (AA, AE, AP) are
 * deliberately absent: the store ships ground within the US only.
 *
 * Sorted by name, which puts "District of Columbia" between Delaware and
 * Florida -- where someone scanning the list alphabetically will look for it.
 */
export const US_STATES = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
] as const;

/** A code from the list above -- not merely any two letters. */
export type StateCode = (typeof US_STATES)[number]["code"];

/**
 * `readonly` is load-bearing: it is what lets `z.enum(US_STATE_CODES)` infer
 * StateCode in the actions without a tuple cast at each call site. Verified
 * against zod 4.6.5.
 */
export const US_STATE_CODES: readonly StateCode[] = US_STATES.map((s) => s.code);
