import { describe, expect, it } from 'vitest';
import { displayPricingAmount, displayPricingQuantity } from '../displayPricingFormat';
const row = { label: 'Output', price: 0.5, unit: 'second', quantity: 1 };
describe('display pricing amounts', () => {
  it('applies the provider discount once while retaining the quoted basis', () => {
    const result = displayPricingAmount(row, 'USD', 0.2, 'en');
    expect(result.current).toContain('0.4');
    expect(result.original).toContain('0.5');
    expect(result.current).toBe('$0.4');
    expect(result.original).toBe('$0.5');
    expect(row.price).toBe(0.5);
  });
  it('uses the existing yuan symbol without a currency code', () => {
    expect(displayPricingAmount(row, 'CNY', 0, 'zh-CN').current).toBe('¥0.5');
  });
  it('retains small nonzero amounts', () => {
    const result = displayPricingAmount({ ...row, price: 0.000000001 }, 'CNY', 0, 'en');
    expect(result.current).toBe('¥0.000000001');
    expect(result.free).toBe(false);
    expect(result.original).toBeUndefined();
  });
  it('keeps zero valid and distinguishes fully discounted prices', () => {
    expect(displayPricingAmount({ ...row, price: 0 }, 'USD', undefined, 'en').free).toBe(true);
    expect(displayPricingAmount(row, 'USD', 1, 'en')).toMatchObject({ free: true });
    expect(displayPricingAmount(row, 'USD', 1, 'en').original).toContain('0.5');
  });
});

// Unit contract: ranges must discount both endpoints once, including zero-to-paid ranges.
// Previous coverage only checked single amounts; minimum regression is { price: 6, maxPrice: 10 }.
it('discounts both range endpoints without marking a zero lower bound as free', () => {
  expect(displayPricingAmount({ price: 6, maxPrice: 10 }, 'CNY', 0.2, 'en'))
    .toEqual({ current: '¥4.8–¥8', original: '¥6–¥10', free: false });
  expect(displayPricingAmount({ price: 0, maxPrice: 10 }, 'USD', 0, 'en'))
    .toEqual({ current: '$0–$10', free: false });
  expect(displayPricingAmount({ price: 0, maxPrice: 10 }, 'USD', 1, 'en'))
    .toEqual({ current: '$0', original: '$0–$10', free: true });
});
// Unit contract: quantity 1 is omitted; million is localized; arbitrary values retain their basis.
it.each([
  [1, 'en', '1M', ''], [1000000, 'zh-CN', '百万', '百万'],
  [1000000, 'en', '1M', '1M'], [1234.5, 'en', '1M', '1,234.5'],
])('formats quantity %s in %s', (quantity, locale, million, expected) => {
  expect(displayPricingQuantity(quantity as number, locale as string, million as string)).toBe(expected);
});
