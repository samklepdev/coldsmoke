import { redirect } from "next/navigation";

/** There is no admin dashboard yet. Orders is the only section. */
export default function AdminIndexPage() {
  redirect("/admin/orders");
}
