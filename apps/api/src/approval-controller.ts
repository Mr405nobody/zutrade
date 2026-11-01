import { Body, Controller, Get, Post, Param, Req, Res, ConflictException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LocalPrivateObjectStore } from '@zutrade/storage';
import { loadConfig } from '@zutrade/config';
import {
  prepareOutbound,
  prepareOutboundInput,
  decisionInput,
  decideApproval,
  reconcileInput,
  requestReconciliation,
  outboundWorkspace,
  readOutbound,
  readPayload,
  requireQuoteVersion,
} from '@zutrade/domain';
import { scoped, queue, parse, uuid } from './identity-controller.js';
import { BoundaryError } from '@zutrade/db';
const store = new LocalPrivateObjectStore(loadConfig().privateDataDir);
@Controller('api/workspaces/:workspaceId/dispatch')
export class ApprovalController {
  @Get('threads/:id') thread(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, (c) => outboundWorkspace(c, uuid(id)));
  }
  @Get('tasks') tasks(@Req() r: Request, @Param('workspaceId') w: string) {
    return scoped(r, w, (c) => outboundWorkspace(c));
  }
  @Post('threads/:id/prepare') prepare(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => prepareOutbound(c, parse(prepareOutboundInput, b), uuid(id), store));
  }
  @Post('approvals/:id/decision') async decision(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const result = await scoped(r, w, (c) =>
      decideApproval(c, queue, uuid(id), parse(decisionInput, b), store),
    );
    if ('conflict' in result) throw new ConflictException(result.conflict);
    return result;
  }
  @Post('requests/:id/reconcile') reconcile(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => requestReconciliation(c, queue, uuid(id), parse(reconcileInput, b)));
  }
  @Get('requests/:id/payloads/:payloadId/pdf') async pdf(
    @Req() r: Request,
    @Res() res: Response,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Param('payloadId') pid: string,
  ) {
    const file = await scoped(r, w, async (c) => {
      const request = await readOutbound(c, uuid(id)),
        p = await readPayload(c, request, uuid(pid));
      if (p.quote_version_id) await requireQuoteVersion(c, p.quote_version_id);
      const a = p.attachment_manifest[0];
      if (!a || p.attachment_manifest.length !== 1)
        throw new BoundaryError(404, '此外发版本没有 PDF');
      try {
        return {
          bytes: await store.readVerified({
            key: a.objectKey,
            sha256: a.sha256,
            byteLength: a.byteLength,
          }),
          manifest: a,
        };
      } catch {
        throw new BoundaryError(409, '已保存 PDF 缺失或摘要不符，不能重新生成替换审批内容');
      }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.manifest.filename.replaceAll('"', '')}"`,
    );
    res.setHeader('X-Content-SHA256', file.manifest.sha256);
    res.send(Buffer.from(file.bytes));
  }
}
