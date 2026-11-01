import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { renderQuotePdf } from '@zutrade/domain';
import { pdfFixture } from '../tests/fixtures/quote-snapshot.ts';

const root = new URL('../docs/build/evidence/b/pdf/', import.meta.url);
await mkdir(root, { recursive: true });
const short = await renderQuotePdf(pdfFixture);
const long = await renderQuotePdf({
  ...pdfFixture,
  quoteNumber: 'ZT-PDF-QA-LONG',
  pendingItems: Array.from(
    { length: 35 },
    (_, i) =>
      `Confirmation ${i + 1}: ${'Delivery remains subject to separate freight and import tax confirmation. '.repeat(5)}`,
  ),
});
await writeFile(new URL('quote-500.pdf', root), short);
await writeFile(new URL('quote-long.pdf', root), long);
await writeFile(
  new URL('expected.json', root),
  JSON.stringify(
    {
      expected: [
        '1230.00',
        '1200.00',
        '30.00',
        'CT-01',
        '模拟棉布袋工厂',
        'Arrival within six weeks',
        'not committed',
      ],
      forbidden: [
        'INTERNAL_COST_DO_NOT_EXPORT',
        'private_fact',
        'private_price',
        'private_source',
        'private_locator',
      ],
      hashes: {
        short: createHash('sha256').update(short).digest('hex'),
        long: createHash('sha256').update(long).digest('hex'),
      },
    },
    null,
    2,
  ),
);
console.log(
  'Generated frozen snapshot QA PDFs (short and long); render and inspect before recording success.',
);
