import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { outboundInputSchema, outboundReviewSchema } from '@zutrade/contracts';
import {
  createOutbound,
  outboundDashboard,
  outboundCompanyDetail,
  reviewOutboundCompany,
} from '@zutrade/domain';
import { scoped, parse, uuid, queue } from './identity-controller.js';
@Controller('api/workspaces/:workspaceId/outbound')
export class OutboundController {
  @Get() list(@Req() r: Request, @Param('workspaceId') w: string) {
    return scoped(r, w, outboundDashboard);
  }
  @Post('runs') create(@Req() r: Request, @Param('workspaceId') w: string, @Body() b: unknown) {
    return scoped(r, w, (c) => createOutbound(c, queue, parse(outboundInputSchema, b)));
  }
  @Get('companies/:id') detail(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
  ) {
    return scoped(r, w, (c) => outboundCompanyDetail(c, uuid(id)));
  }
  @Post('companies/:id/review') review(
    @Req() r: Request,
    @Param('workspaceId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return scoped(r, w, (c) => reviewOutboundCompany(c, uuid(id), parse(outboundReviewSchema, b)));
  }
}
