/** Presentation helpers for the human UI (pure, tested). Not used by REST/MCP. */
export function formatPrice(priceMinor: number, currency: string, locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(priceMinor / 100);
}
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}
