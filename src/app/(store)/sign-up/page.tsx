import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Keep your order history and addresses in one place.",
};

export default function SignUpPage() {
  return (
    <ContentPage
      title="Create an account"
      lede="Your past guest orders join your history once you confirm your address."
    >
      <SignUpForm />
    </ContentPage>
  );
}
