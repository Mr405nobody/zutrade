import { Body, Controller, Get, Post, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  demoContactSchema,
  saveBatchSchema,
  freezeBatchSchema,
  batchDecisionSchema,
  followupSchema,
} from '@zutrade/contracts';
import { LocalPrivateObjectStore } from '@zutrade/storage';
import { loadConfig } from '@zutrade/config';
import {
  createSimulationContact,
  saveBatchDraft,
  freezeBatch,
  decideBatch,
  saveFollowup,
  cancelFollowup,
  d2Workspace,
  setOutboundPause,
  setSimulationPermission,
  completeManualFollowup,
  retryInboundReceipt,
} from '@zutrade/domain';
import { scoped, queue, uuid, parse } from './identity-controller.js';
const store = new LocalPrivateObjectStore(loadConfig().privateDataDir);
const version = z.object({ expectedVersion: z.string().regex(/^[1-9]\d*$/) }).strict();
@Controller('api/workspaces/:workspaceId/outreach')
export class OutreachController {
  @Get() workspace(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Query('threadId') t?: string,
  ) {
    return scoped(r, w, (c) => d2Workspace(c, t ? uuid(t) : undefined));
  }
  @Post('contacts') contact(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => createSimulationContact(c, parse(demoContactSchema, b)));
  }
  @Post('drafts') draft(@Req() r: Request, @Param('workspaceId') w: string, @Body() b: unknown) {
    return scoped(r, w, (c) => saveBatchDraft(c, parse(saveBatchSchema, b)));
  }
  @Post('batches/:id/freeze') freeze(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => freezeBatch(c, uuid(id), parse(freezeBatchSchema, b), store));
  }
  @Post('batches/:id/decision') decision(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) =>
      decideBatch(c, queue, uuid(id), parse(batchDecisionSchema, b), store),
    );
  }
  @Post('followups') followup(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => saveFollowup(c, queue, parse(followupSchema, b), store));
  }
  @Post('followups/:id/cancel') cancel(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => cancelFollowup(c, uuid(id), parse(version, b).expectedVersion));
  }
  @Post('followups/:id/complete') complete(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) =>
      completeManualFollowup(c, uuid(id), parse(version, b).expectedVersion),
    );
  }
  @Post('receipts/:id/retry') retry(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const i = parse(z.object({ commandId: z.uuid() }).strict(), b);
    return scoped(r, w, (c) => retryInboundReceipt(c, queue, uuid(id), i.commandId));
  }
  @Post('threads/:id/pause') pause(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const i = parse(version.extend({ paused: z.boolean() }), b);
    return scoped(r, w, (c) => setOutboundPause(c, uuid(id), i.expectedVersion, i.paused));
  }
  @Post('points/:id/permission') permission(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const i = parse(z.object({ allowed: z.boolean() }).strict(), b);
    return scoped(r, w, (c) => setSimulationPermission(c, uuid(id), i.allowed));
  }
}
