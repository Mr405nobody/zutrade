import { Decimal as DecimalBase } from 'decimal.js';
const Decimal = DecimalBase.clone({ precision: 50 });
type Decimal = DecimalBase;
import { BoundaryError } from '@zutrade/db';
import type { QuoteLine } from '@zutrade/contracts';
export interface Discount {
  kind: 'percent' | 'amount';
  value: string;
  reason: string;
}
export interface CalculatorInput {
  quantity: string;
  unitCode: string;
  currency: string;
  rule: {
    qtyMin: string;
    qtyMax: string | null;
    unitCode: string;
    currency: string;
    unitPrice: string;
    setupFee: string;
  };
  maxDiscountPercent: string;
  discount?: Discount;
}
export function calculateQuote(input: CalculatorInput) {
  const { rule } = input;
  if (!/^\d{1,12}$/.test(input.quantity) || new Decimal(input.quantity).lte(0))
    throw new BoundaryError(422, '采购数量必须为正整数件数');
  const qty = new Decimal(input.quantity);
  if (
    input.currency !== 'USD' ||
    rule.currency !== input.currency ||
    input.unitCode !== 'piece' ||
    rule.unitCode !== input.unitCode
  )
    throw new BoundaryError(422, '币种或单位不适用，需要重新确认');
  if (qty.lt(rule.qtyMin) || (rule.qtyMax !== null && qty.gte(rule.qtyMax)))
    throw new BoundaryError(422, '数量超出已确认价阶，需要工厂重新确认');
  const money = (n: Decimal) => n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const unit = new Decimal(rule.unitPrice),
    setup = new Decimal(rule.setupFee);
  if (!unit.isFinite() || !setup.isFinite() || unit.lt(0) || setup.lt(0))
    throw new BoundaryError(422, '无效价格');
  const subtotal = new Decimal(money(unit.mul(qty)));
  const lines: QuoteLine[] = [
    {
      kind: 'product',
      description: 'CT-01 cotton bags',
      quantity: qty.toFixed(0),
      unitCode: 'piece',
      unitPrice: unit.toFixed(6),
      amount: money(subtotal),
    },
    {
      kind: 'setup_fee',
      description: 'One setup fee per quotation',
      quantity: '1',
      unitCode: 'quotation',
      unitPrice: setup.toFixed(6),
      amount: money(setup),
    },
  ];
  let reduction = new Decimal(0);
  let proposal: Discount | null = null;
  if (input.discount) {
    const d = input.discount;
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(d.value) || !d.reason.trim())
      throw new BoundaryError(422, '折扣金额与理由不完整');
    const value = new Decimal(d.value);
    reduction = new Decimal(money(d.kind === 'percent' ? subtotal.mul(value).div(100) : value));
    const exactReduction = d.kind === 'percent' ? subtotal.mul(value).div(100) : value;
    const exactBoundary = subtotal.mul(input.maxDiscountPercent).div(100);
    if (
      (d.kind === 'percent' && value.gt(input.maxDiscountPercent)) ||
      exactReduction.gt(exactBoundary)
    ) {
      proposal = d;
      reduction = new Decimal(0);
    } else if (reduction.gt(0))
      lines.push({
        kind: 'discount',
        description: 'Authorized discount on product subtotal',
        quantity: '1',
        unitCode: 'quotation',
        unitPrice: reduction.toFixed(6),
        amount: money(reduction),
      });
  }
  const total = subtotal.plus(money(setup)).minus(reduction);
  if (total.gt('99999999999999.99')) throw new BoundaryError(422, '报价金额超出数据库精度范围');
  if (total.lt(0)) throw new BoundaryError(422, '折扣不能导致负总额');
  return {
    lines,
    totalAmount: money(total),
    discountProposal: proposal,
    currencyScale: 2 as const,
    roundingPolicy: 'half_up_per_line' as const,
    calculationVersion: 'b-calc-v1' as const,
  };
}
