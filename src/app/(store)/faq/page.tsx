import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Shipping, returns, samples and tax for Coldsmoke Eau de Toilette.",
};

export default function FaqPage() {
  return (
    <ContentPage title="FAQ">
      <h2>How long does shipping take?</h2>
      <p>
        Orders leave within two business days. Fragrance ships ground only, so
        transit is three to six business days depending on distance. Shipping
        is $6, or free on orders over $50.
      </p>

      <h2>Do you ship outside the US?</h2>
      <p>
        Not yet. Fragrance is a flammable good and shipping it abroad requires
        dangerous-goods handling we do not have in place.
      </p>

      <h2>Can I return it?</h2>
      <p>
        Yes, within {BUSINESS.returnWindowDays} days, {BUSINESS.returnCondition}
        . An opened bottle cannot be resold, which is what the sample is for.
        See <Link href="/shipping-returns">Shipping &amp; Returns</Link>.
      </p>

      <h2>How much is the sample?</h2>
      <p>
        $6 for 2 mL — roughly twenty sprays. Enough to wear it for a few days
        and see how it dries down on your skin.
      </p>

      <h2>Will I be charged sales tax?</h2>
      <p>
        Tax is calculated at checkout based on your shipping address, and is
        only charged where we are registered to collect it.
      </p>

      <h2>What is in it?</h2>
      <p>
        The full note list is on <Link href="/the-scent">The Scent</Link>. A
        complete ingredient list is printed on the carton. If you have a
        specific allergen concern, ask before you order.
      </p>

      <h2>Where is my order?</h2>
      <p>
        Use <Link href="/order-lookup">Find an order</Link> with your order
        number and email.
      </p>
    </ContentPage>
  );
}
