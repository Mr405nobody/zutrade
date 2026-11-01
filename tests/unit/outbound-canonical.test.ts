import { describe, it, expect } from 'vitest';
import { normalizeOutbound, outboundCanonicalJSON, outboundHash } from '@zutrade/domain';
describe('c-outbound-v1 canonical bytes', () => {
  it('normalizes Unicode/newlines and key order before persistence and hashing', () => {
    const first = {
      z: 'cafe\u0301\r\nnext\rline',
      a: { b: null, a: '2.40' },
      recipients: ['first', 'second'],
    };
    const saved = normalizeOutbound(first);
    expect(saved.z).toBe('café\nnext\nline');
    expect(outboundCanonicalJSON(first)).toBe(outboundCanonicalJSON(saved));
    expect(outboundHash(first)).toBe(
      outboundHash({
        recipients: ['first', 'second'],
        a: { a: '2.40', b: null },
        z: 'café\nnext\nline',
      }),
    );
  });
  it('keeps explicit nulls, decimal spelling and ordered arrays distinct', () => {
    expect(outboundHash({ optional: null })).not.toBe(outboundHash({}));
    expect(outboundHash({ amount: '2.40' })).not.toBe(outboundHash({ amount: '2.4' }));
    expect(outboundHash(['first', 'second'])).not.toBe(outboundHash(['second', 'first']));
  });
  it('rejects unsupported/missing values, fractional JS numbers and normalized key collisions', () => {
    for (const value of [
      { x: undefined },
      { x: 0.1 },
      { x: NaN },
      { x: Infinity },
      { x: BigInt(1) },
      { é: 1, 'e\u0301': 2 },
    ])
      expect(() => outboundCanonicalJSON(value)).toThrow();
  });
});
