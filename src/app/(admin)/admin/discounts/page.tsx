import type { DiscountCode } from "@/lib/db/schema";
import { discountStatus } from "@/lib/discounts";
import { listDiscountCodes } from "@/lib/discounts/admin";
import { formatCents } from "@/lib/money";
import { zonedDateString } from "@/lib/time";
import { CreateDiscountForm, DeactivateButton } from "./DiscountForms";
import styles from "./discounts.module.css";

export const metadata = { title: "Discounts" };

function terms(code: DiscountCode) {
  const off =
    code.type === "percent"
      ? `${code.value}% off`
      : `${formatCents(code.value)} off`;

  return code.minSubtotalCents > 0
    ? `${off} over ${formatCents(code.minSubtotalCents)}`
    : off;
}

function dateRange(code: DiscountCode) {
  // Rendered in the shop's timezone, not UTC. A day now ends at 04:59Z the
  // FOLLOWING day, so slicing toISOString() would print the day after the one
  // the admin picked -- the list would disagree with the form that made it.
  const from = code.startsAt ? zonedDateString(code.startsAt) : "now";
  const to = code.endsAt ? zonedDateString(code.endsAt) : "no end";
  return `${from} → ${to}`;
}

export default async function AdminDiscountsPage() {
  const codes = await listDiscountCodes();

  return (
    <section>
      <h1 className={styles.heading}>Discounts</h1>

      <h2 className={styles.subheading}>New code</h2>
      <CreateDiscountForm />

      <h2 className={styles.subheading}>All codes</h2>
      {codes.length === 0 ? (
        <p>No codes yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Terms</th>
              <th className={styles.right}>Redeemed</th>
              <th>Window</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => {
              const status = discountStatus(code);

              return (
                <tr key={code.id}>
                  <td>{code.code}</td>
                  <td>{status}</td>
                  <td>{terms(code)}</td>
                  <td className={styles.right}>
                    {code.timesRedeemed} / {code.maxRedemptions ?? "∞"}
                  </td>
                  <td>{dateRange(code)}</td>
                  <td>
                    {(status === "live" || status === "scheduled") && (
                      <DeactivateButton id={code.id} code={code.code} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
