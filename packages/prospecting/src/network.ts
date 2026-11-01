import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ipaddr from 'ipaddr.js';
import { researchLimits } from '@zutrade/contracts';

export class ResearchNetworkError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export interface PageResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export interface SafePage {
  bodySha256?: string;
  sourceUrl: string;
  finalUrl: string;
  observedAt: string;
  body: string;
  contentType: string;
}
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;
export type Transport = (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
  headers: Record<string, string>,
  method: 'GET' | 'HEAD',
) => Promise<PageResponse>;
export interface RequestBudget {
  reserve(): Promise<{ deadline: number }>;
  guard(): Promise<void>;
  gate?<T>(host: string, run: () => Promise<T>): Promise<T>;
}

export function publicAddress(input: string): boolean {
  try {
    const address = ipaddr.parse(input);
    if (address.kind() === 'ipv6') {
      const a = address as ipaddr.IPv6;
      if (a.isIPv4MappedAddress()) return false;
      // Only global unicast, with the IANA special-purpose / documentation blocks excluded.
      if (!a.match(ipaddr.IPv6.parse('2000::'), 3)) return false;
      if (
        ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some((cidr) =>
          a.match(ipaddr.parseCIDR(cidr)),
        )
      )
        return false;
    }
    return address.range() === 'unicast';
  } catch {
    return false;
  }
}
export function publicUrl(input: string): URL {
  if (
    input.length > 2048 ||
    [...input].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === '\\')
  )
    throw new ResearchNetworkError('URL_REJECTED');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ResearchNetworkError('URL_REJECTED');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname ||
    url.hostname.endsWith('.') ||
    (!url.hostname.includes('.') && !url.hostname.includes(':'))
  )
    throw new ResearchNetworkError('URL_REJECTED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw new ResearchNetworkError('SSRF_ADDRESS_REJECTED');
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host))
    throw new ResearchNetworkError('SSRF_HOST_REJECTED');
  return url;
}
export const resolvePublic: Resolver = async (host) => {
  if (isIP(host)) return [{ address: host, family: isIP(host) as 4 | 6 }];
  const lookup = async (family: 4 | 6) => {
    try {
      return (await (family === 4 ? resolve4(host) : resolve6(host))).map((address) => ({
        address,
        family,
      }));
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['ENODATA', 'ENOTFOUND'].includes(String(error.code))
      )
        return [];
      throw new ResearchNetworkError('DNS_FAILED');
    }
  };
  return (await Promise.all([lookup(4), lookup(6)])).flat();
};
export async function checkedAddress(url: URL, resolver: Resolver): Promise<ResolvedAddress> {
  const addresses = await resolver(url.hostname.replace(/^\[|\]$/g, ''));
  if (
    !addresses.length ||
    addresses.some((a) => !publicAddress(a.address) || isIP(a.address) !== a.family)
  )
    throw new ResearchNetworkError('SSRF_DNS_REJECTED');
  return addresses[0]!;
}
function limitStream() {
  let count = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      callback(
        count > researchLimits.responseBytes
          ? new ResearchNetworkError('RESPONSE_TOO_LARGE')
          : null,
        chunk,
      );
    },
  });
}
export async function decodeBody(
  stream: Readable,
  encoding: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  const sink = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const inflater =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;
  if (encoding && !['identity', 'gzip', 'deflate', 'br'].includes(encoding))
    throw new ResearchNetworkError('ENCODING_UNSUPPORTED');
  if (inflater) await pipeline(stream, limitStream(), inflater, limitStream(), sink, { signal });
  else await pipeline(stream, limitStream(), sink, { signal });
  return Buffer.concat(chunks);
}
export const pinnedTransport: Transport = (url, address, signal, headers, method) =>
  new Promise((resolve, reject) => {
    // No proxy, cookie jar, shared agent or second DNS lookup. TLS verifies the URL hostname.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method,
        agent: false,
        signal,
        family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        ...(url.protocol === 'https:'
          ? { servername: isIP(host) ? '' : host, rejectUnauthorized: true }
          : {}),
        headers: { ...headers, Host: url.host },
      },
      (response) => {
        void (async () => {
          const normalized = Object.fromEntries(
            Object.entries(response.headers).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.join(',') : (v ?? ''),
            ]),
          );
          if (Number(normalized['content-length'] ?? 0) > researchLimits.responseBytes) {
            response.destroy();
            throw new ResearchNetworkError('RESPONSE_TOO_LARGE');
          }
          // Do not collect redirect/error bodies, nor forward any response cookies.
          if (method === 'HEAD' || (response.statusCode ?? 0) >= 300) {
            response.destroy();
            resolve({
              status: response.statusCode ?? 0,
              headers: normalized,
              body: new Uint8Array(),
            });
            return;
          }
          try {
            resolve({
              status: response.statusCode ?? 0,
              headers: normalized,
              body: await decodeBody(response, normalized['content-encoding'] ?? '', signal),
            });
          } catch (error) {
            response.destroy();
            throw error;
          }
        })().catch(reject);
      },
    );
    request.once('socket', (socket) =>
      socket.once('connect', () => {
        if (
          !socket.remoteAddress ||
          ipaddr.process(socket.remoteAddress).toString() !==
            ipaddr.process(address.address).toString()
        )
          request.destroy(new ResearchNetworkError('CONNECTION_ADDRESS_MISMATCH'));
      }),
    );
    request.once('error', reject);
    request.end();
  });
class Semaphore {
  private active = 0;
  private pending: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async use<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.pending.push(resolve));
    else this.active++;
    try {
      return await run();
    } finally {
      const next = this.pending.shift();
      if (next) next();
      else this.active--;
    }
  }
}
const total = new Semaphore(2);
const hosts = new Map<string, Semaphore>();
function hostLock(host: string) {
  let lock = hosts.get(host);
  if (!lock) {
    lock = new Semaphore(1);
    hosts.set(host, lock);
  }
  return lock;
}
export function networkCode(error: unknown): string {
  return error instanceof ResearchNetworkError
    ? error.code
    : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
      ? 'REQUEST_TIMEOUT'
      : 'NETWORK_FAILED';
}
export class SafeResearchHttp {
  constructor(
    private readonly budget: RequestBudget,
    private readonly resolver: Resolver = resolvePublic,
    private readonly transport: Transport = pinnedTransport,
  ) {}
  async get(
    input: string,
    options: { method?: 'GET' | 'HEAD'; searchKey?: string; sameOrigin?: boolean } = {},
  ): Promise<SafePage> {
    let target = input;
    for (let hop = 0; hop <= researchLimits.redirects; hop++) {
      const url = publicUrl(target);
      const execute = () =>
        hostLock(url.hostname).use(() =>
          total.use(async () => {
            const reservation = await this.budget.reserve();
            const timeout = Math.min(researchLimits.requestMs, reservation.deadline - Date.now());
            if (timeout <= 0) throw new ResearchNetworkError('RUN_DEADLINE');
            const controller = new AbortController();
            const signal = controller.signal;
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
              return await Promise.race([
                (async () => {
                  const address = await checkedAddress(url, this.resolver);
                  await this.budget.guard();
                  signal.throwIfAborted();
                  const headers: Record<string, string> = {
                    'User-Agent':
                      'ZuTradeResearch/1.0 (bounded public company research; no messaging)',
                    Accept: 'text/html,application/json,text/plain;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                  };
                  if (
                    options.searchKey &&
                    url.origin === 'https://api.search.brave.com' &&
                    url.pathname === '/res/v1/web/search'
                  )
                    headers['X-Subscription-Token'] = options.searchKey;
                  const result = await this.transport(
                    url,
                    address,
                    signal,
                    headers,
                    options.method ?? 'GET',
                  );
                  await this.budget.guard();
                  if (result.body.byteLength > researchLimits.responseBytes)
                    throw new ResearchNetworkError('RESPONSE_TOO_LARGE');
                  return result;
                })(),
                new Promise<never>((_resolve, reject) =>
                  signal.addEventListener(
                    'abort',
                    () => reject(new ResearchNetworkError('REQUEST_TIMEOUT')),
                    { once: true },
                  ),
                ),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }),
        );
      const response = await (this.budget.gate
        ? this.budget.gate(url.hostname, execute)
        : execute());
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (options.searchKey) throw new ResearchNetworkError('SEARCH_REDIRECT_REJECTED');
        if (hop === researchLimits.redirects || !response.headers.location)
          throw new ResearchNetworkError('REDIRECT_LIMIT');
        const next = new URL(response.headers.location, url);
        if (options.sameOrigin && next.origin !== new URL(input).origin)
          throw new ResearchNetworkError('CROSS_ORIGIN_REDIRECT_REJECTED');
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new ResearchNetworkError('REDIRECT_DOWNGRADE');
        target = next.href;
        continue;
      }
      if (response.status === 429) {
        const retry = response.headers['retry-after'] ?? '';
        const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        throw new ResearchNetworkError(
          'HTTP_429',
          Number.isFinite(delay) ? Math.max(1000, delay) : 2000,
        );
      }
      if (response.status < 200 || response.status >= 300)
        throw new ResearchNetworkError(`HTTP_${response.status}`);
      const contentType = (response.headers['content-type'] ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase();
      if (
        ![
          'text/html',
          'application/xhtml+xml',
          'text/plain',
          'application/json',
          'application/sparql-results+json',
        ].includes(contentType)
      )
        throw new ResearchNetworkError('MIME_UNSUPPORTED');
      return {
        bodySha256: createHash('sha256').update(response.body).digest('hex'),
        sourceUrl: input,
        finalUrl: url.href,
        observedAt: new Date().toISOString(),
        body: new TextDecoder('utf-8', { fatal: true }).decode(response.body),
        contentType,
      };
    }
    throw new ResearchNetworkError('REDIRECT_LIMIT');
  }
  async retry(input: string, options: { searchKey?: string } = {}): Promise<SafePage> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.get(input, options);
      } catch (error) {
        const code = networkCode(error);
        if (
          attempt >= researchLimits.retries ||
          ![
            'HTTP_429',
            'HTTP_502',
            'HTTP_503',
            'HTTP_504',
            'NETWORK_FAILED',
            'REQUEST_TIMEOUT',
          ].includes(code)
        )
          throw error;
        await this.budget.guard();
        const ms = error instanceof ResearchNetworkError ? error.retryAfterMs : 0;
        // Long Retry-After is reported rather than sending an early retry or exceeding the run budget.
        if (ms > 10000) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.max(ms, 250 * 2 ** attempt)));
      }
    }
  }
}
