import { describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { researchRequestSchema, researchLimits } from '@zutrade/contracts';
import {
  publicAddress,
  pinnedTransport,
  publicUrl,
  SafeResearchHttp,
  ResearchNetworkError,
  decodeBody,
  robotsAllowed,
  extractStaticPage,
  canonicalCompanyUrl,
  FixtureResearchProvider,
  BraveSearchProvider,
  emptyCheckpoint,
  PublicDirectoryProvider,
} from '@zutrade/prospecting';
import type { Resolver, Transport, ProviderContext } from '@zutrade/prospecting';
const resolve: Resolver = async () => [{ address: '8.8.8.8', family: 4 }];
const page = (
  body = '<html><title>Company</title><body>Business events and branded promotional merchandise.</body></html>',
  status = 200,
  headers: Record<string, string> = {},
) => ({ status, headers: { 'content-type': 'text/html', ...headers }, body: Buffer.from(body) });
function budget(max = 80) {
  let count = 0;
  return {
    reserve: async () => {
      if (++count > max) throw new ResearchNetworkError('BUDGET');
      return { deadline: Date.now() + 180000 };
    },
    guard: async () => {},
    count: () => count,
  };
}
describe('D1 SSRF and bounded transport (offline injection)', () => {
  test.each([
    '127.0.0.1',
    '10.0.0.2',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
    '3fff::1',
  ])('rejects special address %s', (address) => expect(publicAddress(address)).toBe(false));
  test.each([
    'https://u:p@example.com/',
    'file:///etc/passwd',
    'ftp://example.com',
    'http://localhost/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'https://[::ffff:127.0.0.1]/',
    'https://example.com:8080/',
    'http://example.com\\@127.0.0.1/',
    'https://example.local/',
  ])('rejects URL %s', (url) => expect(() => publicUrl(url)).toThrow());
  test('accepts real public IPv4 and global IPv6', () => {
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });
  test('rejects mixed A/AAAA answers and does not connect', async () => {
    const transport = vi.fn<Transport>();
    const h = new SafeResearchHttp(
      budget(),
      async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '::1', family: 6 },
      ],
      transport,
    );
    await expect(h.get('https://example.com/')).rejects.toThrow('SSRF_DNS_REJECTED');
    expect(transport).not.toHaveBeenCalled();
  });
  test('pins selected address; rebinding on next hop is rejected', async () => {
    let dns = 0;
    const resolver: Resolver = async () =>
      ++dns === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    const calls: string[] = [];
    const h = new SafeResearchHttp(budget(), resolver, async (url, address) => {
      calls.push(address.address);
      expect(url.hostname).toBe('example.com');
      return page('', 302, { location: '/next' });
    });
    await expect(h.get('https://example.com/')).rejects.toThrow('SSRF_DNS_REJECTED');
    expect(calls).toEqual(['8.8.8.8']);
  });
  test('validates each redirect and counts all hops', async () => {
    const b = budget();
    const h = new SafeResearchHttp(b, resolve, async () => page('', 302, { location: '/next' }));
    await expect(h.get('https://example.com/')).rejects.toThrow('REDIRECT_LIMIT');
    expect(b.count()).toBe(4);
  });
  test('redirect to metadata denied before connection', async () => {
    let calls = 0;
    const h = new SafeResearchHttp(budget(), resolve, async () => {
      calls++;
      return page('', 302, { location: 'http://169.254.169.254/latest/meta-data/' });
    });
    await expect(h.get('https://example.com/')).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test('external page requests contain no cookies, auth or API key; fixed search only', async () => {
    const headers: Record<string, string>[] = [];
    const h = new SafeResearchHttp(budget(), resolve, async (_u, _a, _s, h) => {
      headers.push(h);
      return page();
    });
    await h.get('https://example.com/', { searchKey: 'private-test-key' });
    expect(headers[0]).not.toHaveProperty('X-Subscription-Token');
    expect(headers[0]).not.toHaveProperty('Cookie');
    expect(headers[0]).not.toHaveProperty('Authorization');
    await h.get('https://api.search.brave.com/res/v1/web/search?q=x', {
      searchKey: 'private-test-key',
    });
    expect(headers[1]?.['X-Subscription-Token']).toBe('private-test-key');
  });
  test('search credentials cannot follow redirects', async () => {
    const h = new SafeResearchHttp(budget(), resolve, async () =>
      page('', 302, { location: 'https://example.com/' }),
    );
    await expect(
      h.get('https://api.search.brave.com/res/v1/web/search?q=x', {
        searchKey: 'private-test-key',
      }),
    ).rejects.toThrow('SEARCH_REDIRECT_REJECTED');
  });
  test('HEAD and GET share request budget', async () => {
    const b = budget(2);
    const methods: string[] = [];
    const h = new SafeResearchHttp(b, resolve, async (_u, _a, _s, _h, m) => {
      methods.push(m);
      return page();
    });
    await h.get('https://example.com/', { method: 'HEAD' });
    await h.get('https://example.com/');
    await expect(h.get('https://example.com/')).rejects.toThrow('BUDGET');
    expect(methods).toEqual(['HEAD', 'GET']);
  });
  test('response MIME and inflated size are bounded', async () => {
    await expect(
      new SafeResearchHttp(budget(), resolve, async () =>
        page('pdf', 200, { 'content-type': 'application/pdf' }),
      ).get('https://example.com/'),
    ).rejects.toThrow('MIME_UNSUPPORTED');
    await expect(
      new SafeResearchHttp(budget(), resolve, async () =>
        page('x'.repeat(researchLimits.responseBytes + 1)),
      ).get('https://example.com/'),
    ).rejects.toThrow('RESPONSE_TOO_LARGE');
  });
  test.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('decompression bound %s', async (encoding, compress) => {
    const body = Buffer.from('x'.repeat(researchLimits.responseBytes + 1));
    await expect(
      decodeBody(Readable.from(compress(body)), encoding, AbortSignal.timeout(5000)),
    ).rejects.toThrow('RESPONSE_TOO_LARGE');
    const value = await decodeBody(
      Readable.from(compress(Buffer.from('safe'))),
      encoding,
      AbortSignal.timeout(5000),
    );
    expect(Buffer.from(value).toString()).toBe('safe');
  });
  test('10 second request deadline also bounds DNS/transport', async () => {
    vi.useFakeTimers();
    try {
      const h = new SafeResearchHttp(budget(), resolve, async () => new Promise(() => {}));
      const response = h.get('https://example.com/');
      const assertion = expect(response).rejects.toThrow('REQUEST_TIMEOUT');
      await vi.advanceTimersByTimeAsync(10001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  test('429 Retry-After does not trigger premature retry; max 2 retries', async () => {
    vi.useFakeTimers();
    try {
      const b = budget(),
        calls: number[] = [];
      const h = new SafeResearchHttp(b, resolve, async () => {
        calls.push(Date.now());
        return page('', 429, { 'retry-after': '2' });
      });
      const promise = h.retry('https://example.com/');
      const assertion = expect(promise).rejects.toThrow('HTTP_429');
      await vi.advanceTimersByTimeAsync(4001);
      await assertion;
      expect(b.count()).toBe(3);
      expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(2000);
    } finally {
      vi.useRealTimers();
    }
  });
  test('long Retry-After fails visibly within total budget', async () => {
    const b = budget();
    const h = new SafeResearchHttp(b, resolve, async () => page('', 429, { 'retry-after': '600' }));
    await expect(h.retry('https://example.com/')).rejects.toThrow('HTTP_429');
    expect(b.count()).toBe(1);
  });
  test('two global connections, at most one per host', async () => {
    let active = 0,
      max = 0,
      same = 0,
      maxSame = 0;
    const h = new SafeResearchHttp(budget(), resolve, async (u) => {
      active++;
      max = Math.max(max, active);
      if (u.hostname === 'example.com') {
        same++;
        maxSame = Math.max(same, maxSame);
      }
      await new Promise((r) => setTimeout(r, 10));
      active--;
      if (u.hostname === 'example.com') same--;
      return page();
    });
    await Promise.all(
      ['https://example.com/a', 'https://example.com/b', 'https://other.example.org/'].map((u) =>
        h.get(u),
      ),
    );
    expect(max).toBe(2);
    expect(maxSame).toBe(1);
  });
});
describe('D1 extraction and providers', () => {
  test('retains semantic URL paths/query, strips only known trackers', () =>
    expect(
      canonicalCompanyUrl('https://example.com/branch?entity=7&lang=en&utm_source=x#team'),
    ).toBe('https://example.com/branch?entity=7&lang=en'));
  test('static extraction never runs scripts or forms', () => {
    const result = extractStaticPage({
      sourceUrl: 'https://example.com',
      finalUrl: 'https://example.com',
      observedAt: new Date().toISOString(),
      contentType: 'text/html',
      body: '<title>Safe</title><script>throw new Error("run")</script><body><form>INTERNAL</form>Events <a href="mailto:public@example.com">Contact</a></body>',
    });
    expect(result.text).toContain('Events');
    expect(result.text).not.toContain('INTERNAL');
    expect(result.emails).toEqual(['public@example.com']);
  });
  test('robots groups and longest matching rule', () => {
    expect(
      robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/public', '/private/a'),
    ).toBe(false);
    expect(
      robotsAllowed(
        'User-agent: *\nDisallow: /private\nAllow: /private/public',
        '/private/public/a',
      ),
    ).toBe(true);
    expect(
      robotsAllowed(
        'User-agent: *\nDisallow: /\nUser-agent: ZuTradeResearch\nAllow: /wiki',
        '/wiki/foo',
      ),
    ).toBe(true);
  });
  test('Brave disabled without both credential and retention rights', async () => {
    const request = researchRequestSchema.parse({
      commandId: crypto.randomUUID(),
      factoryId: crypto.randomUUID(),
      provider: 'brave_search',
    });
    const context: ProviderContext = {
      request,
      http: new SafeResearchHttp(budget(), resolve, async () => page()),
      checkpoint: emptyCheckpoint(),
      save: async () => {},
      guard: async () => {},
    };
    await expect(
      new BraveSearchProvider({ key: 'test-key', storageRights: false }).run(context),
    ).rejects.toThrow('BRAVE_NOT_CONFIGURED');
  });
  test('no silent fixture fallback', async () => {
    const context: ProviderContext = {
      request: researchRequestSchema.parse({
        commandId: crypto.randomUUID(),
        factoryId: crypto.randomUUID(),
        provider: 'public_directory',
      }),
      http: new SafeResearchHttp(
        budget(),
        async () => [{ address: '198.18.0.1', family: 4 }],
        async () => page(),
      ),
      checkpoint: emptyCheckpoint(),
      save: async () => {},
      guard: async () => {},
    };
    await expect(new PublicDirectoryProvider().run(context)).rejects.toThrow('SSRF_DNS_REJECTED');
    expect(context.checkpoint.snapshot.candidates).toEqual([]);
  });
  test('fixture cannot be constructed outside explicit test environment', () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      expect(() => new FixtureResearchProvider(async (c) => c.checkpoint.snapshot)).toThrow(
        'test-only',
      );
    } finally {
      process.env.NODE_ENV = prior;
    }
  });
  test('rejects browser supplied candidate bodies and quantity overflow', () => {
    expect(
      researchRequestSchema.safeParse({
        commandId: crypto.randomUUID(),
        factoryId: crypto.randomUUID(),
        provider: 'public_directory',
        limit: 51,
      }).success,
    ).toBe(false);
  });
});

test('Brave正式 GET 参数、摘要与来源页面分别保留（离线 transport）', async () => {
  const headersSeen: Record<string, string>[] = [],
    urls: URL[] = [];
  const h = new SafeResearchHttp(budget(), resolve, async (url, _address, _signal, headers) => {
    urls.push(url);
    headersSeen.push(headers);
    if (url.hostname === 'api.search.brave.com')
      return page(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'Offline Search Company',
                url: 'https://company.example.org/unit?company=7',
                description: 'event management and promotional services',
              },
            ],
          },
        }),
        200,
        { 'content-type': 'application/json' },
      );
    if (url.pathname === '/robots.txt')
      return page('User-agent: *\nAllow: /', 200, { 'content-type': 'text/plain' });
    return page(
      '<html><title>Offline Search Company</title><body>Business event management and promotional merchandise solutions for events.</body></html>',
    );
  });
  const context: ProviderContext = {
    request: researchRequestSchema.parse({
      commandId: crypto.randomUUID(),
      factoryId: crypto.randomUUID(),
      provider: 'brave_search',
      limit: 3,
    }),
    http: h,
    checkpoint: emptyCheckpoint(),
    save: async () => {},
    guard: async () => {},
  };
  const result = await new BraveSearchProvider({
    key: 'offline-only-key',
    storageRights: true,
    rightsReference: 'offline-test-entitlement',
  }).run(context);
  expect(urls[0]?.origin).toBe('https://api.search.brave.com');
  expect(urls[0]?.pathname).toBe('/res/v1/web/search');
  expect(urls[0]?.searchParams.get('count')).toBe('20');
  expect(headersSeen[0]?.['X-Subscription-Token']).toBe('offline-only-key');
  expect(headersSeen.slice(1).every((h) => !h['X-Subscription-Token'])).toBe(true);
  const candidate = result.candidates[0]!;
  expect(candidate.country).toBeNull();
  expect(candidate.sourceUrl).toContain('?company=7');
  expect(candidate.evidence.map((e) => e.kind)).toEqual(['search_summary', 'directory']);
  expect(candidate.evidence.every((e) => e.status === 'read')).toBe(true);
});

test('原生 HTTPS transport 固定 lookup IP，保留 Host/SNI 与证书校验（离线检查原生调用参数）', async () => {
  let options: https.RequestOptions | undefined;
  const request = new EventEmitter() as EventEmitter & { end: () => void };
  request.end = () => {
    queueMicrotask(() =>
      request.emit('error', new ResearchNetworkError('OFFLINE_NATIVE_INSPECTION')),
    );
  };
  const spy = vi.spyOn(https, 'request').mockImplementation(((url: unknown, raw: unknown) => {
    expect(String(url)).toBe('https://example.com/branch?company=7');
    options = raw as https.RequestOptions;
    return request;
  }) as unknown as typeof https.request);
  try {
    await expect(
      pinnedTransport(
        new URL('https://example.com/branch?company=7'),
        { address: '8.8.8.8', family: 4 },
        new AbortController().signal,
        { 'User-Agent': 'offline-test' },
        'GET',
      ),
    ).rejects.toThrow('OFFLINE_NATIVE_INSPECTION');
    expect(options?.servername).toBe('example.com');
    expect(options?.rejectUnauthorized).toBe(true);
    expect(options?.agent).toBe(false);
    expect(options?.headers).toHaveProperty('Host', 'example.com');
    const lookup = options!.lookup as unknown as (
      host: string,
      opts: unknown,
      callback: (err: Error | null, address: string, family: number) => void,
    ) => void;
    let actual: unknown;
    lookup('example.com', {}, (error, address, family) => {
      expect(error).toBeNull();
      actual = { address, family };
    });
    expect(actual).toEqual({ address: '8.8.8.8', family: 4 });
  } finally {
    spy.mockRestore();
  }
});
