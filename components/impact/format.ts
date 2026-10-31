/** Kilos, euros and kg CO2e in the reader's language. */
export function formatters(locale: "en" | "fr") {
  const tag = locale === "fr" ? "fr-FR" : "en-GB";
  const kg = (n: number) =>
    n < 1
      ? `${new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(n * 1000)} g`
      : `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(n)} kg`;
  const eur = (n: number) =>
    new Intl.NumberFormat(tag, { style: "currency", currency: "EUR", maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);
  const co2e = (n: number) => `${kg(n)} CO₂e`;
  return { kg, eur, co2e };
}
