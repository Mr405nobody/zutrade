import { describe, expect, it } from 'vitest';
import { calculateQuote } from '@zutrade/domain';
const base = {
  unitCode: 'piece',
  currency: 'USD',
  rule: {
    qtyMin: '500',
    qtyMax: '1000',
    unitCode: 'piece',
    currency: 'USD',
    unitPrice: '2.40',
    setupFee: '30',
  },
  maxDiscountPercent: '5',
};
describe('QuoteCalculator decimal and boundaries', () => {
  it.each([
    ['500', '1230.00'],
    ['800', '1950.00'],
    ['999', '2427.60'],
  ])('calculates %s without float arithmetic', (quantity, total) =>
    expect(calculateQuote({ ...base, quantity }).totalAmount).toBe(total),
  );
  it.each(['499', '1000', '500.5', '0', 'NaN'])('rejects quantity %s', (quantity) =>
    expect(() => calculateQuote({ ...base, quantity })).toThrow(),
  );
  it('refuses currency and unit mismatch', () => {
    expect(() => calculateQuote({ ...base, quantity: '500', currency: 'EUR' })).toThrow();
    expect(() => calculateQuote({ ...base, quantity: '500', unitCode: 'carton' })).toThrow();
  });
  it('rounds each line half up then sums', () =>
    expect(
      calculateQuote({
        ...base,
        quantity: '500',
        rule: { ...base.rule, unitPrice: '0.00001', setupFee: '0.005' },
      }).totalAmount,
    ).toBe('0.02'));
  it('subtracts unsigned authorized product-only discount, retains boundary proposal', () => {
    const v = calculateQuote({
      ...base,
      quantity: '500',
      discount: { kind: 'percent', value: '5', reason: 'Published allowance' },
    });
    expect(v.totalAmount).toBe('1170.00');
    expect(v.lines[2]?.amount).toBe('60.00');
    expect(v.lines[2]?.description).not.toContain('Published allowance');
    expect(v.lines[2]?.unitPrice).toBe('60.000000');
    const over = calculateQuote({
      ...base,
      quantity: '500',
      discount: { kind: 'amount', value: '61', reason: 'Needs confirmation' },
    });
    expect(over.totalAmount).toBe('1230.00');
    expect(over.discountProposal).toBeTruthy();
  });
  it('does not let rounding hide a discount above the published exact boundary', () => {
    const tiny = {
      ...base,
      quantity: '500',
      rule: { ...base.rule, unitPrice: '0.0001', setupFee: '0' },
      maxDiscountPercent: '10',
      discount: { kind: 'percent' as const, value: '20', reason: 'Requires owner' },
    };
    expect(calculateQuote(tiny).discountProposal).toBeTruthy();
    expect(calculateQuote(tiny).totalAmount).toBe('0.05');
  });
});
