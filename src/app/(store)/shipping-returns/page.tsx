import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "Shipping & Returns",
  description: "US ground shipping, $6 flat or free over $50. Returns within 30 days.",
};

// Drafted as a starting point for review by a lawyer. Not final, and not
// legal advice.
export default function ShippingReturnsPage() {
  return (
    <ContentPage title="Shipping &amp; Returns">
      <h2>Where we ship</h2>
      <p>
        The United States only, including Alaska and Hawaii. Fragrance is
        classed as a flammable liquid and travels by ground, never by air, which
        is also why we cannot ship internationally.
      </p>

      <h2>Cost and timing</h2>
      <p>
        $6 flat, or free on orders over $50 after any discount. Orders leave
        within two business days; ground transit is typically three to six
        business days.
      </p>

      <h2>Returns</h2>
      <p>
        Within {BUSINESS.returnWindowDays} days of delivery, {BUSINESS.returnCondition}.
        Email {BUSINESS.supportEmail} with your order number and we will send
        return instructions. Refunds go back to the original payment method
        once the return arrives.
      </p>
      <p>
        An opened bottle cannot be returned. This is not a restocking policy —
        a used fragrance is not resalable. Buy the 2 mL sample first if you are
        unsure.
      </p>

      <h2>Damaged in transit</h2>
      <p>
        Tell us within seven days of delivery and we will replace it. Photographs
        of the carton and the bottle help, but are not required.
      </p>

      <h2>Questions</h2>
      <p>
        <Link href="/contact">Contact us</Link>, or look up an existing order
        with <Link href="/order-lookup">Find an order</Link>.
      </p>
    </ContentPage>
  );
}
