export interface Requirements {
  productId: string;
  quantity: string;
  unitCode: 'piece';
  specifications: { fabric: string; dimensions: string; color: string; printing: string };
  destination: string;
  purpose: string;
  requestedTiming: string;
  language: string;
  pendingItems: string[];
  internalNote: string;
}
export interface QuoteLine {
  kind: 'product' | 'setup_fee' | 'discount';
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  amount: string;
}
export interface QuoteSnapshot {
  schemaVersion: 'b-quote-v1';
  quoteNumber: string;
  version: number;
  createdAt: string;
  simulation: true;
  seller: { name: string; agent: 'ZuTrade' };
  buyer: { name: string; contactName: string; channelIdentity: string };
  requirements: Omit<Requirements, 'internalNote'>;
  lines: QuoteLine[];
  currency: 'USD';
  currencyScale: 2;
  roundingPolicy: 'half_up_per_line';
  calculationVersion: 'b-calc-v1';
  totalAmount: string;
  discount?: { kind: 'percent' | 'amount'; value: string; basis: 'product_subtotal' } | null;
  scope: 'product_only';
  exclusions: string[];
  pendingItems: string[];
  production: { days: number; dayKind: 'business' | 'calendar'; startConditions: string };
  paymentTerms: string | null;
  sampleTerms: string;
  committedArrivalDate: null;
  validUntil: string;
  timeZone: string;
  validityReasons: string[];
  evidence: {
    factVersionId: string;
    priceRuleId: string;
    sourceVersionId: string;
    locator: string;
    excerpt: string;
    sourceSha256: string;
  }[];
}
