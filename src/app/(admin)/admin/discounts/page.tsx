import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { discountCodes } from "@/lib/db/schema";
import { discountStatus } from "@/lib/discounts";
import { formatCents } from "@/lib/money";
import { CreateDiscountForm, DeactivateButton } from "./DiscountForms";
import styles from "./discounts.module.css";

export const metadata = { title: "Discounts" };

function terms(code: typeof discountCodes.$inferSelect) {
  const off =
    code.type === "percent"
      ? `${code.value}% off`
      : `${formatCents(code.value)} off`;

  return code.minSubtotalCents > 0
    ? `${off} over ${formatCents(code.minSubtotalCents)}`
    : off;
}

function dateRange(code: typeof discountCodes.$inferSelect) {
  const from = code.startsAt?.toISOString().slice(0, 10) ?? "now";
  const to = code.endsAt?.toISOString().slice(0, 10) ?? "no end";
  return `${from} → ${to}`;
}

export default async function AdminDiscountsPage() {
  // Newest first: the code you just made is the one you are looking for.
  const codes = await db
    .select()
    .from(discountCodes)
    .orderBy(desc(discountCodes.id));

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
