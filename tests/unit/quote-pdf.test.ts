import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { pdfFixture } from '../fixtures/quote-snapshot.js';
import { renderQuotePdf } from '../../packages/domain/src/quote-pdf.js';
import { LocalPrivateObjectStore } from '../../packages/storage/src/index.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
test('renders a real PDF from frozen fields and preserves immutable stored download bytes', async () => {
  const bytes = await renderQuotePdf(pdfFixture);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const root = await mkdtemp(join(tmpdir(), 'zutrade-pdf-'));
  temporary.push(root);
  const store = new LocalPrivateObjectStore(join(root, 'private'));
  const object = await store.putImmutable(bytes);
  expect(
    Buffer.from(await new LocalPrivateObjectStore(join(root, 'private')).readVerified(object)),
  ).toEqual(bytes);
  expect(object.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  await writeFile(join(root, 'private', object.key.slice(0, 2), object.key), Buffer.from('broken'));
  await expect(store.readVerified(object)).rejects.toThrow('integrity');
});
test('CJK names and long commercial text paginate without render failure', async () => {
  const bytes = await renderQuotePdf({
    ...pdfFixture,
    pendingItems: Array.from(
      { length: 35 },
      (_, i) =>
        `Confirmation ${i + 1}: ${'Delivery remains subject to separate freight and import tax confirmation. '.repeat(5)}`,
    ),
  });
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(10000);
});
