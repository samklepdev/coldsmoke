import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "Terms of Sale",
  description: "The terms that apply when you buy from Coldsmoke.",
};

// Drafted as a starting point for review by a lawyer. Not final, and not
// legal advice.
export default function TermsPage() {
  return (
    <ContentPage title="Terms of Sale">
      <h2>Who you are buying from</h2>
      <p>
        {BUSINESS.legalName}, {BUSINESS.addressLine1}, {BUSINESS.addressLocality}.
      </p>

      <h2>Orders</h2>
      <p>
        An order is an offer to buy. It is accepted when we charge your card and
        confirm the order by email. If an item is unavailable after you order,
        we will cancel and refund it in full rather than substitute anything.
      </p>

      <h2>Prices</h2>
      <p>
        Prices are in US dollars and exclude sales tax, which is calculated at
        checkout. We may change prices, but never for an order already placed.
      </p>

      <h2>Cancellation and returns</h2>
      <p>
        Tell us before the order ships and we will cancel it. After it ships,
        the return terms on{" "}
        <Link href="/shipping-returns">Shipping &amp; Returns</Link> apply:
        {" "}{BUSINESS.returnWindowDays} days, {BUSINESS.returnCondition}.
      </p>

      <h2>Use of the product</h2>
      <p>
        Eau de Toilette, for external use only. Discontinue use if irritation
        occurs. Keep away from heat and flame, and keep out of reach of
        children.
      </p>

      <h2>Liability</h2>
      <p>
        Our liability for any order is limited to what you paid for it. Nothing
        here limits liability that cannot be limited by law.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the State of{" "}
        {BUSINESS.governingState}.
      </p>
    </ContentPage>
  );
}
