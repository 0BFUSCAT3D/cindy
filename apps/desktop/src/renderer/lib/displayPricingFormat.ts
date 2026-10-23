import type { SummaryQuote } from '@cindy/model-providers';

/** Keep the quoted basis; do not convert mixed units or infer a model-wide starting price. */
export function displayPricingAmount(
  item: Pick<SummaryQuote, 'price' | 'maxPrice'>,
  currency: 'CNY' | 'USD',
  costDiscount: number | undefined,
  locale: string,
): { current: string; original?: string; free: boolean } {
  const discount =
    typeof costDiscount === 'number' &&
    Number.isFinite(costDiscount) &&
    costDiscount >= 0 &&
    costDiscount <= 1
      ? costDiscount
      : 0;
  const amount = item.price * (1 - discount);
  const number = new Intl.NumberFormat(locale, {
    maximumSignificantDigits: 8,
    useGrouping: false,
  });
  // Match existing model prices while preserving small per-unit amounts.
  const symbol = currency === 'CNY' ? '¥' : '$';
  const money = (value: number) => `${symbol}${number.format(value)}`;
  const upper = item.maxPrice ?? item.price;
  const range = (low: number, high: number) =>
    low === high ? money(low) : `${money(low)}–${money(high)}`;
  return {
    current: range(amount, upper * (1 - discount)),
    ...(discount > 0 && upper > 0 ? { original: range(item.price, upper) } : {}),
    free: upper === 0 || discount === 1,
  };
}

/** Quantity is a display denominator, never a conversion of the supplier's price. */
export function displayPricingQuantity(quantity: number, locale: string, million: string): string {
  if (quantity === 1) return '';
  if (quantity === 1_000_000) return million;
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 12 }).format(quantity);
}
