export function formatOrderNumber(orderNumber: number): string {
  return `CS-${orderNumber}`;
}

export function parseOrderNumber(input: string): number | null {
  const match = input.trim().toUpperCase().match(/^(?:CS-)?(\d+)$/);
  if (!match) return null;
  return Number(match[1]);
}
