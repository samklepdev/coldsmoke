import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { BUSINESS } from "@/lib/business";
import { ContactForm } from "./ContactForm";

export const metadata: Metadata = {
  title: "Contact",
  description: "Questions about an order, a return, or the scent itself.",
};

export default function ContactPage() {
  return (
    <ContentPage
      title="Contact"
      lede={`We reply within ${BUSINESS.supportResponseHours} hours on business days.`}
    >
      <p>
        Looking for an existing order?{" "}
        <Link href="/order-lookup">Find an order</Link> is faster — you will
        need the order number and the email you used.
      </p>

      <ContactForm />
    </ContentPage>
  );
}
