import { LocalPrivateObjectStore } from '@zutrade/storage';
import { loadConfig } from '@zutrade/config';
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  aiWorkspace,
  startAIRun,
  cancelAIRun,
  decideAISuggestion,
  reviewFAQPolicy,
} from '@zutrade/domain';
import { startAIInput, decideAIInput } from '@zutrade/contracts';
import { scoped, queue, uuid, parse } from './identity-controller.js';
const store = new LocalPrivateObjectStore(loadConfig().privateDataDir);
@Controller('api/workspaces/:workspaceId/ai')
export class AIController {
  @Get('threads/:threadId') list(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
  ) {
    return scoped(req, ws, (c) => aiWorkspace(c, uuid(id)));
  }
  @Post('threads/:threadId/runs') start(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const p = parse(startAIInput, body);
    return scoped(req, ws, (c) => startAIRun(c, queue, uuid(id), p));
  }
  @Post('runs/:runId/cancel') cancel(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('runId') id: string,
  ) {
    return scoped(req, ws, (c) => cancelAIRun(c, uuid(id)));
  }
  @Post('runs/:runId/decision') decide(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('runId') id: string,
    @Body() body: unknown,
  ) {
    const p = parse(decideAIInput, body);
    return scoped(req, ws, (c) => decideAISuggestion(c, uuid(id), p, { boss: queue, store }));
  }
  @Post('faq-policy') review(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Body() body: unknown,
  ) {
    const p = parse(z.object({ enabled: z.boolean() }).strict(), body);
    return scoped(req, ws, (c) => reviewFAQPolicy(c, p.enabled));
  }
}
