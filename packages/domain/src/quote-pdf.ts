import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { BoundaryError } from '@zutrade/db';
import type { Context } from '@zutrade/db';
import type { PrivateObjectStore } from '@zutrade/storage';
import type { QuoteSnapshot } from '@zutrade/contracts';
import { requireQuoteVersion } from './quoting.js';

export const QUOTE_PDF_TEMPLATE_VERSION = 'quote-pdf.v1';
const fontPath = fileURLToPath(new URL('../assets/NotoSansCJKsc-Regular.otf', import.meta.url));

export interface QuotePdfManifest {
  id: string;
  quote_version_id: string;
  snapshot_sha256: string;
  template_version: string;
  state: 'pending' | 'ready' | 'failed';
  object_key: string | null;
  object_version: string | null;
  pdf_sha256: string | null;
  content_type: 'application/pdf';
  byte_length: string | null;
  error_code: string | null;
}

/** Buyer-facing fields are explicitly enumerated; evidence and internal metadata never serialize. */
export async function renderQuotePdf(snapshot: QuoteSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 46,
    bufferPages: true,
    info: {
      Title: `${snapshot.quoteNumber} v${snapshot.version}`,
      Author: 'ZuTrade',
      CreationDate: new Date(snapshot.createdAt),
      ModDate: new Date(snapshot.createdAt),
    },
  });
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  try {
    doc.registerFont('CJK', fontPath).font('CJK');
    const width = doc.page.width - 92;
    function space(height = 16) {
      if (doc.y + height > doc.page.height - 68) doc.addPage();
    }
    function paragraph(text: string, size = 10) {
      space(24);
      doc.fontSize(size).fillColor('#263648').text(text, 46, doc.y, { width, lineGap: 3 });
      doc.moveDown(0.5);
    }
    function heading(text: string) {
      space(48);
      doc.moveDown(0.4);
      doc.fontSize(12).fillColor('#136b66').text(text, 46, doc.y, { width });
      doc.moveDown(0.45);
    }
    doc.fontSize(23).fillColor('#123e43').text('QUOTATION', 46, 42);
    paragraph('SIMULATION - INTERNAL PREVIEW - NOT APPROVED FOR SENDING', 9);
    paragraph(`${snapshot.quoteNumber}  |  Version ${snapshot.version}  |  Product-only quote`);
    const date = (value: string) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: snapshot.timeZone,
        dateStyle: 'medium',
        timeStyle: 'short',
        hourCycle: 'h23',
      }).format(new Date(value));
    paragraph(`Issued: ${date(snapshot.createdAt)} (${snapshot.timeZone})`);
    paragraph(`Valid until: ${date(snapshot.validUntil)} (${snapshot.timeZone})`);
    heading('Seller and recipient');
    paragraph(`Seller: ${snapshot.seller.name}`);
    paragraph(
      `Sales agent: ${snapshot.seller.agent}. The factory is the contracting, payment and fulfillment party.`,
    );
    paragraph(
      `Buyer: ${snapshot.buyer.name}\nRecipient: ${snapshot.buyer.contactName}\nAccount: ${snapshot.buyer.channelIdentity}`,
    );
    heading('Product and requirements');
    // Requirements are rendered via a fixed field list below, never JSON.stringify.
    paragraph(
      `Product: ${snapshot.lines.find((line) => line.kind === 'product')?.description ?? snapshot.requirements.productId}\nSpecifications: ${snapshot.requirements.specifications.fabric}; ${snapshot.requirements.specifications.dimensions}; ${snapshot.requirements.specifications.color}\nPrint: ${snapshot.requirements.specifications.printing}`,
    );
    paragraph(
      `Quantity: ${snapshot.requirements.quantity} ${snapshot.requirements.unitCode}\nDestination: ${snapshot.requirements.destination || 'To be confirmed'}\nUse: ${snapshot.requirements.purpose || 'To be confirmed'}`,
    );
    if (snapshot.requirements.requestedTiming)
      paragraph(
        `Buyer timing request (not a commitment): ${snapshot.requirements.requestedTiming}`,
      );
    heading(`Price breakdown (${snapshot.currency})`);
    for (const line of snapshot.lines) {
      const label = `${line.description}\n${line.quantity} ${line.unitCode} x ${snapshot.currency} ${line.unitPrice}`;
      doc.fontSize(10);
      const height = Math.max(doc.heightOfString(label, { width: width - 140 }), 30) + 16;
      space(height);
      const y = doc.y;
      doc.fillColor('#edf5f3').rect(46, y, width, height).fill();
      doc.fillColor('#263648').text(label, 55, y + 7, { width: width - 150, lineGap: 2 });
      doc.text(`${line.kind === 'discount' ? '- ' : ''}${line.amount}`, 46 + width - 125, y + 8, {
        width: 115,
        align: 'right',
      });
      doc.y = y + height + 5;
    }
    paragraph(`TOTAL: ${snapshot.currency} ${snapshot.totalAmount}`, 16);
    paragraph(
      `Rounding: ${snapshot.roundingPolicy}; calculator: ${snapshot.calculationVersion}.`,
      8,
    );
    heading('Production and commercial terms');
    paragraph(
      `Production: ${snapshot.production.days} ${snapshot.production.dayKind} days.\nStarts after: ${snapshot.production.startConditions}`,
    );
    paragraph(
      'Arrival date: not committed. Production lead time is not a delivery or arrival promise.',
    );
    paragraph(
      `Payment: ${snapshot.paymentTerms ?? 'To be confirmed; no payment ratio or bank details committed.'}`,
    );
    paragraph(`Samples: ${snapshot.sampleTerms}`);
    heading('Scope and exclusions');
    for (const item of snapshot.exclusions) paragraph(`- ${item}`);
    if (snapshot.pendingItems.length) {
      heading('Items requiring confirmation');
      for (const item of snapshot.pendingItems) paragraph(`- ${item}`);
    }
    if (snapshot.validityReasons.length) {
      heading('Validity basis');
      for (const item of snapshot.validityReasons) paragraph(`- ${item}`);
    }
    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
      doc.switchToPage(page);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .fontSize(8)
        .fillColor('#536573')
        .text(
          `SIMULATION | ${snapshot.quoteNumber} v${snapshot.version} | ${page + 1}/${range.count}`,
          46,
          doc.page.height - 42,
          { width, lineBreak: false, align: 'center' },
        );
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  } catch (error) {
    doc.destroy();
    throw error;
  }
  return complete;
}

async function manifest(context: Context, versionId: string, lock = false) {
  return (
    await context.client.query<QuotePdfManifest>(
      `SELECT * FROM app.quote_pdf_artifacts WHERE workspace_id=$1 AND quote_version_id=$2 AND template_version=$3 ${lock ? 'FOR UPDATE' : ''}`,
      [context.member.workspace_id, versionId, QUOTE_PDF_TEMPLATE_VERSION],
    )
  ).rows[0];
}
export async function quotePdfStatus(
  context: Context,
  versionId: string,
  store: PrivateObjectStore,
) {
  await requireQuoteVersion(context, versionId);
  const artifact = await manifest(context, versionId);
  if (!artifact) return { state: 'pending' as const, template_version: QUOTE_PDF_TEMPLATE_VERSION };
  if (artifact.state === 'ready') {
    try {
      await readArtifact(artifact, store);
    } catch {
      return {
        ...artifact,
        state: 'failed' as const,
        error_code: 'PDF_OBJECT_UNAVAILABLE',
        persisted_state: 'ready' as const,
      };
    }
  }
  return artifact;
}

/** Call in a separate workspace transaction after the quote freeze commits. Failure is a committed state. */
export async function generateQuotePdf(
  context: Context,
  versionId: string,
  store: PrivateObjectStore,
) {
  const version = await requireQuoteVersion(context, versionId);
  await context.client.query(
    `INSERT INTO app.quote_pdf_artifacts(workspace_id,factory_id,quote_version_id,snapshot_sha256,template_version,created_by_member_id)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,quote_version_id,template_version) DO NOTHING`,
    [
      context.member.workspace_id,
      version.factory_id,
      versionId,
      version.snapshot_sha256,
      QUOTE_PDF_TEMPLATE_VERSION,
      context.member.id,
    ],
  );
  const existing = await manifest(context, versionId, true);
  if (!existing) throw new BoundaryError(409, 'PDF 产物索引未建立');
  if (existing.state === 'ready') {
    // Never report a missing/corrupt immutable object as ready and never silently replace it.
    await readArtifact(existing, store);
    return existing;
  }
  await context.client.query(
    `UPDATE app.quote_pdf_artifacts SET state='pending',error_code=NULL,updated_at=now() WHERE id=$1`,
    [existing.id],
  );
  try {
    const bytes = await renderQuotePdf(version.snapshot);
    const object = await store.putImmutable(bytes);
    await store.readVerified(object);
    await context.client.query(
      `UPDATE app.quote_pdf_artifacts SET state='ready',object_key=$2,object_version=$3,pdf_sha256=$3,content_type='application/pdf',byte_length=$4,error_code=NULL,updated_at=now() WHERE id=$1 AND state='pending'`,
      [existing.id, object.key, object.sha256, object.byteLength],
    );
  } catch {
    // Do not persist arbitrary exception strings: disk paths/connection strings can be sensitive.
    await context.client.query(
      `UPDATE app.quote_pdf_artifacts SET state='failed',error_code='PDF_GENERATION_FAILED',updated_at=now() WHERE id=$1 AND state='pending'`,
      [existing.id],
    );
  }
  return (await manifest(context, versionId))!;
}
async function readArtifact(artifact: QuotePdfManifest, store: PrivateObjectStore) {
  if (
    artifact.state !== 'ready' ||
    !artifact.object_key ||
    !artifact.pdf_sha256 ||
    !artifact.byte_length
  ) {
    throw new BoundaryError(
      409,
      artifact.state === 'failed' ? 'PDF 生成失败，请显式重试' : 'PDF 尚未生成完成',
    );
  }
  try {
    const bytes = await store.readVerified({
      key: artifact.object_key,
      sha256: artifact.pdf_sha256,
      byteLength: Number(artifact.byte_length),
    });
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.pdf_sha256)
      throw new Error('integrity');
    return bytes;
  } catch {
    throw new BoundaryError(409, '已发布 PDF 文件缺失或损坏；历史产物不会自动重建替换');
  }
}
export async function downloadQuotePdf(
  context: Context,
  versionId: string,
  store: PrivateObjectStore,
) {
  const version = await requireQuoteVersion(context, versionId);
  const artifact = await manifest(context, versionId);
  if (!artifact) throw new BoundaryError(409, 'PDF 尚未生成');
  return {
    bytes: await readArtifact(artifact, store),
    manifest: artifact,
    filename: `${version.snapshot.quoteNumber}-v${version.snapshot.version}.pdf`,
  };
}
