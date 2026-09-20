import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { ForgotForm } from "./ForgotForm";

export const metadata: Metadata = {
  title: "Forgot your password",
  description: "Get a link to choose a new password.",
};

export default function ForgotPasswordPage() {
  return (
    <ContentPage title="Forgot your password">
      <ForgotForm />
    </ContentPage>
  );
}
