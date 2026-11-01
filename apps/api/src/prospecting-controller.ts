import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  researchRequestSchema,
  reviewInputSchema,
  importCandidateSchema,
} from '@zutrade/contracts';
import {
  createResearch,
  listResearch,
  researchDetail,
  researchOptions,
  cancelResearch,
  reviewCandidate,
  importCandidate,
} from '@zutrade/domain';
import { loadConfig } from '@zutrade/config';
import { scoped, parse, uuid, queue } from './identity-controller.js';
const config = loadConfig();
const brave = {
  ...(config.BRAVE_SEARCH_API_KEY ? { key: config.BRAVE_SEARCH_API_KEY } : {}),
  storageRights: config.BRAVE_SEARCH_STORAGE_RIGHTS === 'confirmed',
  ...(config.BRAVE_SEARCH_RIGHTS_REFERENCE
    ? { rightsReference: config.BRAVE_SEARCH_RIGHTS_REFERENCE }
    : {}),
};
@Controller('api/workspaces/:workspaceId/prospecting')
export class ProspectingController {
  @Get('options') options(@Req() r: Request, @Param('workspaceId') w: string) {
    return scoped(r, w, async () => researchOptions(brave));
  }
  @Get('runs') list(@Req() r: Request, @Param('workspaceId') w: string) {
    return scoped(r, w, listResearch);
  }
  @Post('runs') create(@Req() r: Request, @Param('workspaceId') w: string, @Body() b: unknown) {
    return scoped(r, w, (c) => createResearch(c, queue, parse(researchRequestSchema, b), brave));
  }
  @Get('runs/:id') detail(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, (c) => researchDetail(c, uuid(id)));
  }
  @Post('runs/:id/cancel') cancel(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, (c) => cancelResearch(c, uuid(id)));
  }
  @Post('runs/:id/review') review(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => reviewCandidate(c, uuid(id), parse(reviewInputSchema, b)));
  }
  @Post('runs/:id/import') import(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => importCandidate(c, uuid(id), parse(importCandidateSchema, b)));
  }
}
