import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { ResendForm } from "./ResendForm";

export const metadata: Metadata = {
  title: "Confirm your email",
  description: "Confirm your address to finish setting up your account.",
};

export default async function VerifyEmailPage({
  searchParams,
}: PageProps<"/verify-email">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : undefined;

  return (
    <ContentPage
      title="Confirm your email"
      lede="Your account is not usable until the address is confirmed."
    >
      <p>
        We sent you a link. Opening it confirms the address and adds any orders
        you placed as a guest with it to your history.
      </p>
      <p>Lost it? Ask for another.</p>
      <ResendForm defaultEmail={email} />
    </ContentPage>
  );
}
