import { describe, it, expect } from 'vitest';
import { resolveLocalTime, batchDraftSchema, followupSchema } from '@zutrade/contracts';
describe('D2 timezone and bounded commands', () => {
  it('converts Shanghai and handles New York DST gap/overlap explicitly', () => {
    expect(resolveLocalTime('2026-10-29T18:00', 'Asia/Shanghai')).toBe('2026-10-29T10:00:00.000Z');
    expect(() => resolveLocalTime('2027-03-14T02:30', 'America/New_York')).toThrow('不存在');
    expect(() => resolveLocalTime('2026-11-01T01:30', 'America/New_York')).toThrow('两次');
    expect(resolveLocalTime('2026-11-01T01:30', 'America/New_York', 'earlier')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(resolveLocalTime('2026-11-01T01:30', 'America/New_York', 'later')).toBe(
      '2026-11-01T06:30:00.000Z',
    );
  });
  it('rejects invalid calendar dates and zones, preserves half-hour timezone offsets', () => {
    expect(() => resolveLocalTime('2026-02-30T10:00', 'UTC')).toThrow();
    expect(() => resolveLocalTime('2026-10-29T10:00', 'MadeUp/Zone')).toThrow();
    expect(resolveLocalTime('2026-10-29T10:00', 'Asia/Kathmandu')).toBe('2026-10-29T04:15:00.000Z');
  });
  it('has no live-transport or silent timezone input fallback', () => {
    expect(batchDraftSchema.safeParse({ transport: 'live' }).success).toBe(false);
    expect(followupSchema.safeParse({ mode: 'live' }).success).toBe(false);
  });
});
