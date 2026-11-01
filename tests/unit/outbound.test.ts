import { describe, expect, test } from 'vitest';
import { outboundInputSchema, outboundQueries, researchRequestSchema } from '@zutrade/contracts';
import {
  buildDueDiligence,
  extractOutboundPage,
  normalizeOutboundUrls,
  OutboundManualProvider,
  emptyCheckpoint,
  SafeResearchHttp,
} from '@zutrade/prospecting';
const page = {
  sourceUrl: 'https://example.com/',
  finalUrl: 'https://example.com/',
  observedAt: '2026-11-01T01:00:00.000Z',
  contentType: 'text/html',
  body: `<html><head><title>Offline test only</title><script type="application/ld+json">{"@type":"Organization","name":"Fictional Fixture Parts","address":{"streetAddress":"123 Test Lane","addressCountry":"United States"}}</script><meta name="description" content="Industrial fasteners distributor"></head><body><p>Industrial fasteners distributor with nuts and bolts for industrial use. Public website self description only.</p><a href="/about">About Us</a><a href="http://169.254.169.254/">Contact</a><a href="/contact">Contact</a></body></html>`,
};
function candidate(): import('@zutrade/contracts').ResearchCandidate {
  return {
    key: 'a'.repeat(64),
    name: 'example.com',
    sourceUrl: page.sourceUrl,
    website: page.finalUrl,
    domain: 'example.com',
    country: null,
    description: '',
    publicEmails: [],
    evidence: [],
    score: 0,
    rulesVersion: 'd1-fit-v1',
    reasons: [],
    unknownFields: [],
  };
}
describe('Outbound rules and explicit source boundaries', () => {
  test('normalizes domain paths, www and tracking; rejects private URL', () => {
    expect(
      normalizeOutboundUrls([
        'https://WWW.Example.com/about?utm_source=x',
        'https://example.com/products',
      ]),
    ).toEqual(['https://www.example.com/']);
    expect(() => normalizeOutboundUrls(['http://127.0.0.1/'])).toThrow();
  });
  test('permission and strict shape required for manual import', () => {
    const base = {
      commandId: crypto.randomUUID(),
      factoryId: crypto.randomUUID(),
      product: 'Industrial Fasteners',
      country: 'US',
      buyerType: 'Distributor',
      mode: 'manual',
      websiteUrls: ['https://example.com/'],
    };
    expect(outboundInputSchema.safeParse(base).success).toBe(false);
    expect(outboundInputSchema.parse({ ...base, permissionAcknowledged: true }).limit).toBe(20);
    expect(
      outboundInputSchema.safeParse({
        ...base,
        permissionAcknowledged: true,
        reviewed_by: 'attacker',
      }).success,
    ).toBe(false);
  });
  test('queries use deterministic words and no model', () =>
    expect(outboundQueries('Industrial Fasteners', 'US', 'Distributor')).toContain(
      'bolts nuts distributors United States',
    ));
  test('extracts explicit structured identity and literal matches, rejects unsafe links', () => {
    const info = extractOutboundPage(page, 'Industrial Fasteners');
    expect(info.profile.country?.value).toBe('US');
    expect(info.profile.name?.value).toBe('Fictional Fixture Parts');
    expect(info.profile.buyerType?.value).toBe('Distributor');
    expect(info.links).toEqual(['https://example.com/about', 'https://example.com/contact']);
  });
  test('target market never fills unknown identity or credit and failures do not become fraud', () => {
    const c = candidate();
    const r = buildDueDiligence(c, { country: 'US', buyerType: 'Distributor' });
    expect(r.facts.find((f) => f.label.startsWith('国家'))?.value).toBe('未知');
    expect(r.risks).toEqual([]);
    expect(r.unknowns).toContain('未进行独立注册核验');
    expect(r.generator).toBe('rules');
    expect(r).not.toHaveProperty('creditScore');
  });
  test('auto unavailable never calls HTTP', async () => {
    const cp = emptyCheckpoint();
    await expect(
      new OutboundManualProvider().run({
        request: researchRequestSchema.parse({
          commandId: crypto.randomUUID(),
          factoryId: crypto.randomUUID(),
          provider: 'outbound_unavailable',
        }),
        checkpoint: cp,
        guard: async () => {},
        save: async () => {},
        http: {
          get: async () => {
            throw Error('must not fetch');
          },
        } as unknown as SafeResearchHttp,
      }),
    ).rejects.toThrow('AUTOMATIC_SEARCH_UNAVAILABLE');
  });
  test('a cross-origin redirect is refused before fetching its target', async () => {
    let calls = 0;
    const http = new SafeResearchHttp(
      { reserve: async () => ({ deadline: Date.now() + 10000 }), guard: async () => {} },
      async () => [{ address: '8.8.8.8', family: 4 }],
      async () => {
        calls++;
        return {
          status: 302,
          headers: { location: 'https://other.example.com/' },
          body: Buffer.from(''),
        };
      },
    );
    await expect(http.get(page.sourceUrl, { sameOrigin: true })).rejects.toThrow(
      'CROSS_ORIGIN_REDIRECT_REJECTED',
    );
    expect(calls).toBe(1);
  });
});
