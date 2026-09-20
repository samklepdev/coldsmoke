import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = {
  title: "Choose a new password",
  description: "Set a new password for your Coldsmoke account.",
};

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  if (!token) {
    return (
      <ContentPage title="Choose a new password">
        <p>
          That link is missing its token.{" "}
          <Link href="/forgot-password">Ask for a new one</Link>.
        </p>
      </ContentPage>
    );
  }

  return (
    <ContentPage title="Choose a new password">
      <ResetForm token={token} />
    </ContentPage>
  );
}
