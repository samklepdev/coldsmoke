import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Coldsmoke collects, why, and what it is never used for.",
};

// Drafted as a starting point for review by a lawyer. Not final, and not
// legal advice.
export default function PrivacyPage() {
  return (
    <ContentPage title="Privacy Policy">
      <h2>What we collect</h2>
      <p>
        To fulfil an order: your email address, shipping address, and the
        contents of the order. If you contact us, the message you send and the
        address you send it from.
      </p>

      <h2>Payment details</h2>
      <p>
        Card details are entered directly into Stripe and are never sent to or
        stored on our servers. We keep Stripe&apos;s reference for the payment so
        we can match it to your order and issue refunds.
      </p>

      <h2>Cookies</h2>
      <p>
        Only what the store needs to work: an identifier for your cart, a
        short-lived reference to an order you have just placed, and an applied
        discount code. There is no third-party analytics and no advertising
        tracking on this site.
      </p>

      <h2>What we never do</h2>
      <p>
        We do not sell personal information, and we do not share it except with
        the services that fulfil the order — Stripe for payment and our shipping
        carrier for delivery.
      </p>

      <h2>Your data</h2>
      <p>
        Email {BUSINESS.supportEmail} to request a copy of what we hold about
        you, or to ask us to delete it. Order records we are required to keep
        for tax purposes are the exception.
      </p>

      <h2>Who we are</h2>
      <p>
        {BUSINESS.legalName}, {BUSINESS.addressLine1}, {BUSINESS.addressLocality}.
      </p>
    </ContentPage>
  );
}
