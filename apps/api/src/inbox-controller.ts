import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  listThreads,
  threadDetail,
  threadMessages,
  markThreadRead,
  addTeamNote,
  changeThreadControl,
  setThreadOwner,
  assignIntake,
  inboxSnapshot,
  versionInput,
  readInput,
  noteInput,
  ownerInput,
  assignInput,
  injectSimulation,
  createReply,
  saveInternalDraft,
  replyTemplates,
} from '@zutrade/domain';
import { requireOwner } from '@zutrade/db';
import { scoped, queue, parse, uuid } from './identity-controller.js';

const simulationInput = z
  .object({
    eventId: z.string().min(1).max(160),
    providerMessageId: z.string().min(1).max(160),
    identity: z.string().min(1).max(160).nullable(),
    displayName: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(8000),
    occurredAt: z.iso.datetime(),
    factoryId: z.uuid().nullable().optional(),
  })
  .strict();
const replyInput = z
  .object({
    commandId: z.uuid(),
    templateId: z.enum(['quantity', 'use', 'destination']),
    contextRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  })
  .strict();
@Controller('api/workspaces/:workspaceId/inbox')
export class InboxController {
  @Get('threads')
  list(@Req() req: Request, @Param('workspaceId') ws: string, @Query('cursor') cursor?: string) {
    if (cursor) uuid(cursor);
    return scoped(req, ws, (c) => listThreads(c, cursor));
  }
  @Get('threads/:threadId')
  detail(@Req() req: Request, @Param('workspaceId') ws: string, @Param('threadId') id: string) {
    return scoped(req, ws, (c) => threadDetail(c, uuid(id)));
  }
  @Get('threads/:threadId/messages')
  messages(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
  ) {
    if (
      (before && (!/^[1-9][0-9]{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)) ||
      (after && (!/^[0-9]{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n)) ||
      (before && after)
    )
      throw new BadRequestException('消息游标不正确');
    return scoped(req, ws, (c) =>
      threadMessages(c, uuid(id), { ...(before ? { before } : {}), ...(after ? { after } : {}) }),
    );
  }
  @Post('threads/:threadId/read')
  read(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(readInput, body);
    return scoped(req, ws, (c) => markThreadRead(c, uuid(id), input.messageId));
  }
  @Post('threads/:threadId/notes')
  note(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(noteInput, body);
    return scoped(req, ws, (c) => addTeamNote(c, uuid(id), input));
  }
  @Post('threads/:threadId/claim')
  claim(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(versionInput, body);
    return scoped(req, ws, (c) => changeThreadControl(c, uuid(id), 'claim', input.expectedVersion));
  }
  @Post('threads/:threadId/takeover')
  takeover(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(versionInput, body);
    return scoped(req, ws, (c) =>
      changeThreadControl(c, uuid(id), 'takeover', input.expectedVersion),
    );
  }
  @Post('threads/:threadId/release')
  release(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(versionInput, body);
    return scoped(req, ws, (c) =>
      changeThreadControl(c, uuid(id), 'release', input.expectedVersion),
    );
  }
  @Post('threads/:threadId/owner')
  owner(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(ownerInput, body);
    return scoped(req, ws, (c) => setThreadOwner(c, uuid(id), input));
  }
  @Post('threads/:threadId/assign')
  assign(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(assignInput, body);
    return scoped(req, ws, (c) => assignIntake(c, uuid(id), input));
  }
  @Get('templates')
  templates(@Req() req: Request, @Param('workspaceId') ws: string) {
    return scoped(req, ws, async () => replyTemplates.map((t) => ({ ...t, body: t.bodyText })));
  }
  @Post('threads/:threadId/reply')
  reply(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(replyInput, body);
    return scoped(req, ws, (c) => createReply(c, queue, uuid(id), input));
  }
  @Post('threads/:threadId/drafts')
  draft(
    @Req() req: Request,
    @Param('workspaceId') ws: string,
    @Param('threadId') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(noteInput, body);
    return scoped(req, ws, (c) => saveInternalDraft(c, uuid(id), input));
  }
  @Post('simulation')
  inject(@Req() req: Request, @Param('workspaceId') ws: string, @Body() body: unknown) {
    const input = parse(simulationInput, body);
    return scoped(req, ws, async (c) => {
      const result = await injectSimulation(c, queue, input);
      return { ...result, id: result.receiptId, normalized_thread_id: result.threadId };
    });
  }
  @Get('simulation')
  receipts(@Req() req: Request, @Param('workspaceId') ws: string) {
    return scoped(req, ws, async (c) => {
      requireOwner(c);
      return (
        await c.client.query(
          `SELECT e.id,e.event_key,e.provider_message_id,e.state,e.attempt_count,e.last_error,e.normalized_thread_id,e.normalized_message_id,e.received_at,e.processed_at,j.state AS queue_state FROM app.inbound_events e LEFT JOIN app.outbox_events o ON o.workspace_id=e.workspace_id AND o.aggregate_id=e.id AND o.handler_key='a2.inbound' LEFT JOIN pgboss.job j ON j.id=o.pg_boss_job_id AND j.name=o.handler_key WHERE e.workspace_id=$1 ORDER BY e.received_at DESC,e.id LIMIT 10`,
          [c.member.workspace_id],
        )
      ).rows;
    });
  }
  @Get('events')
  async events(@Req() req: Request, @Res() res: Response, @Param('workspaceId') ws: string) {
    let previous = await scoped(req, ws, inboxSnapshot);
    let revision = createHash('sha256').update(JSON.stringify(previous)).digest('hex');
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: string, data: object) =>
      res.write(`event: ${event}\nid: ${revision}\ndata: ${JSON.stringify(data)}\n\n`);
    send('connected', { revision });
    let busy = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (busy || stopped) return;
      busy = true;
      void (async () => {
        try {
          const snapshot = await scoped(req, ws, inboxSnapshot);
          if (stopped) return;
          const ids = new Set(snapshot.map((r) => r.id));
          const lost = previous.some((r) => !ids.has(r.id));
          const next = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
          if (lost) {
            send('permission-lost', { reason: '会话授权已变更，请重新查询' });
          }
          if (next !== revision) {
            revision = next;
            send('change', { revision });
          } else res.write(': heartbeat\n\n');
          previous = snapshot;
        } catch (error) {
          if (stopped) return;
          const status =
            error && typeof error === 'object' && 'getStatus' in error
              ? (error as { getStatus: () => number }).getStatus()
              : 503;
          send(status === 401 || status === 403 ? 'permission-lost' : 'unavailable', {
            reason:
              status === 401 || status === 403
                ? '登录或工作区权限已失效'
                : '实时查询暂不可用，请重连后补查',
          });
          cleanup();
          res.end();
        } finally {
          busy = false;
        }
      })();
    }, 2000);
    const cleanup = () => {
      stopped = true;
      clearInterval(timer);
    };
    res.on('close', cleanup);
  }
}
