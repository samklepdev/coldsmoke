import type { Metadata } from "next";
import { Suspense } from "react";
import { ContentPage } from "@/components/content/ContentPage";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to see your orders and saved addresses.",
};

export default function SignInPage() {
  return (
    <ContentPage title="Sign in">
      {/* useSearchParams needs a Suspense boundary to keep the rest of the
          page from opting into client-side rendering. */}
      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>
    </ContentPage>
  );
}
