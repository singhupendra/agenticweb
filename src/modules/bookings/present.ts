/** Presentation helper (pure). Renders a slot start in the organization's timezone. */
export function formatSlotStart(isoUtc: string, timeZone: string, locale = "en-IN"): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(isoUtc));
}
