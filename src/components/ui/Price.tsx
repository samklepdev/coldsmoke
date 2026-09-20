import { formatCents } from "@/lib/money";

export function Price({ cents }: { cents: number }) {
  return <span>{formatCents(cents)}</span>;
}
