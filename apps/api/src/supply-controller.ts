import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { BoundaryError } from '@zutrade/db';
import { loadConfig } from '@zutrade/config';
import { LocalPrivateObjectStore } from '@zutrade/storage';
import {
  createProduct,
  createSource,
  createFactDraft,
  publishFact,
  publishPrice,
  withdrawFact,
  withdrawSource,
  requireSource,
  listProducts,
  productDetail,
  productInput,
  factDraftInput,
  priceInput,
  withdrawInput,
  saveRequirementsSchema,
  generateQuoteSchema,
  saveRequirements,
  generateQuote,
  quotingWorkspace,
  quoteVersionDetail,
  generateQuotePdf,
  downloadQuotePdf,
  quotePdfStatus,
} from '@zutrade/domain';
import { scoped, uuid, parse } from './identity-controller.js';
const store = new LocalPrivateObjectStore(loadConfig().privateDataDir);
const uploadInput = z
  .object({
    title: z.string().trim().min(1).max(1000),
    contentBase64: z.string().min(1).max(7_000_000),
    validUntil: z.iso.datetime({ offset: true }),
    sourceDocumentId: z.uuid().optional(),
    expectedVersion: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
  })
  .strict();
function uploadBytes(encoded: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    throw new BoundaryError(400, '上传文件编码无效');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024)
    throw new BoundaryError(413, '文件须为 1 字节至 5 MiB');
  let type: string;
  if (
    bytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
    bytes.subarray(-1024).includes(Buffer.from('%%EOF'))
  )
    type = 'application/pdf';
  else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    type = 'image/png';
  else if (
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    type = 'image/jpeg';
  else {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (
        Array.from(text).some((char) => {
          const code = char.charCodeAt(0);
          return code < 32 && ![9, 10, 13].includes(code);
        }) ||
        /^\s*</.test(text)
      )
        throw new Error();
      type = 'text/plain';
    } catch {
      throw new BoundaryError(415, '仅支持有效的 PDF、PNG、JPEG 或 UTF-8 文本');
    }
  }
  return { bytes, type };
}
@Controller('api/workspaces/:workspaceId/supply')
export class SupplyController {
  @Get('products') list(@Req() r: Request, @Param('workspaceId') w: string) {
    return scoped(r, w, listProducts);
  }
  @Get('products/:id') detail(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, (c) => productDetail(c, uuid(id)));
  }
  @Post('products') create(@Req() r: Request, @Param('workspaceId') w: string, @Body() b: unknown) {
    return scoped(r, w, (c) => createProduct(c, parse(productInput, b)));
  }
  @Post('products/:id/sources') upload(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const i = parse(uploadInput, b);
    return scoped(r, w, async (c) => {
      await productDetail(c, uuid(id));
      const { bytes, type } = uploadBytes(i.contentBase64);
      const object = await store.putImmutable(bytes);
      return createSource(c, id, {
        title: i.title,
        kind: 'file',
        contentSha256: object.sha256,
        contentType: type,
        contentSize: object.byteLength,
        objectKey: object.key,
        extractedSnapshot: { manualEntryRequired: true, simulation: true },
        validUntil: i.validUntil,
        ...(i.sourceDocumentId ? { sourceDocumentId: i.sourceDocumentId } : {}),
        ...(i.expectedVersion ? { expectedVersion: i.expectedVersion } : {}),
      });
    });
  }
  @Post('products/:id/facts') draft(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => createFactDraft(c, uuid(id), parse(factDraftInput, b)));
  }
  @Post('facts/:id/publish') publish(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, (c) => publishFact(c, uuid(id)));
  }
  @Post('products/:id/prices') price(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => publishPrice(c, uuid(id), parse(priceInput, b)));
  }
  @Post('facts/:id/withdraw') withdrawFact(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const i = parse(withdrawInput, b);
    return scoped(r, w, (c) => withdrawFact(c, uuid(id), i.reason));
  }
  @Post('sources/:id/withdraw') withdrawSource(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const i = parse(withdrawInput, b);
    return scoped(r, w, (c) => withdrawSource(c, uuid(id), i.reason));
  }
  @Get('sources/:id/file') async file(
    @Req() r: Request,
    @Res() res: Response,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    const file = await scoped(r, w, async (c) => {
      const s = await requireSource(c, uuid(id));
      if (!s.object_key || !s.content_size) throw new BoundaryError(404, '来源没有文件产物');
      try {
        return {
          bytes: await store.readVerified({
            key: s.object_key,
            sha256: s.content_sha256,
            byteLength: Number(s.content_size),
          }),
          type: s.content_type,
        };
      } catch {
        throw new BoundaryError(409, '来源文件缺失或摘要不一致');
      }
    });
    res.setHeader('Content-Type', file.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment; filename="source"');
    res.send(Buffer.from(file.bytes));
  }
}
@Controller('api/workspaces/:workspaceId/quoting')
export class QuotingController {
  @Get('threads/:thread') workspace(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('thread') t: string,
  ) {
    return scoped(r, w, (c) => quotingWorkspace(c, uuid(t)));
  }
  @Post('threads/:thread/opportunities/:id/requirements') save(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('thread') t: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) =>
      saveRequirements(c, uuid(t), uuid(id), parse(saveRequirementsSchema, b)),
    );
  }
  @Post('threads/:thread/opportunities/:id/versions') generate(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('thread') t: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => generateQuote(c, uuid(t), uuid(id), parse(generateQuoteSchema, b)));
  }
  @Get('versions/:id') detail(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, async (c) => ({
      ...(await quoteVersionDetail(c, uuid(id))),
      pdf: await quotePdfStatus(c, id, store),
    }));
  }
  @Post('versions/:id/pdf') pdf(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, (c) => generateQuotePdf(c, uuid(id), store));
  }
  @Get('versions/:id/pdf') async download(
    @Req() r: Request,
    @Res() res: Response,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    const file = await scoped(r, w, (c) => downloadQuotePdf(c, uuid(id), store));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Content-SHA256', file.manifest.pdf_sha256!);
    res.send(Buffer.from(file.bytes));
  }
}
