import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { researchLimits } from '@zutrade/contracts';
import type {
  ResearchCandidate,
  ResearchEvidence,
  ResearchRequest,
  ResearchSnapshot,
} from '@zutrade/contracts';
import { networkCode, publicUrl, ResearchNetworkError, SafeResearchHttp } from './network.js';
import type { SafePage } from './network.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const directoryConfigs = [
  {
    id: 'wikimedia-events-sg',
    label: 'Wikimedia · 新加坡活动公司',
    country: 'SG',
    category: 'Event management companies of Singapore',
    coverage: '新加坡活动管理公司百科分类；覆盖有限，不代表完整行业名录',
    source: 'https://en.wikipedia.org/wiki/Category:Event_management_companies_of_Singapore',
    license: '分类事实/链接署名 Wikipedia CC BY-SA 4.0；实体结构化字段 Wikidata CC0',
  },
  {
    id: 'wikimedia-events-gb',
    label: 'Wikimedia · 英国活动公司',
    country: 'GB',
    category: 'Event management companies of the United Kingdom',
    coverage: '英国活动管理公司百科分类；不覆盖全部礼品代理或促销品分销商',
    source:
      'https://en.wikipedia.org/wiki/Category:Event_management_companies_of_the_United_Kingdom',
    license: '分类事实/链接署名 Wikipedia CC BY-SA 4.0；实体结构化字段 Wikidata CC0',
  },
  {
    id: 'wikimedia-events-au',
    label: 'Wikimedia · 澳大利亚活动公司',
    country: 'AU',
    category: 'Event management companies of Australia',
    coverage: '澳大利亚活动管理公司百科分类；覆盖有限，需人工确认法人身份',
    source: 'https://en.wikipedia.org/wiki/Category:Event_management_companies_of_Australia',
    license: '分类事实/链接署名 Wikipedia CC BY-SA 4.0；实体结构化字段 Wikidata CC0',
  },
] as const;
export interface Discovery {
  name: string;
  url: string;
  entity: string | null;
  directoryEvidence: ResearchEvidence;
}
export interface ResearchCheckpoint {
  pendingDirectory?: string | null;
  directoryPages: number;
  next: string | null;
  discoveries: Discovery[];
  cursor: number;
  snapshot: ResearchSnapshot;
}
export const emptyCheckpoint = (): ResearchCheckpoint => ({
  directoryPages: 0,
  next: null,
  discoveries: [],
  cursor: 0,
  snapshot: { candidates: [], errors: [], truncationReason: null },
});
export interface ProviderContext {
  request: ResearchRequest;
  http: SafeResearchHttp;
  checkpoint: ResearchCheckpoint;
  save(checkpoint: ResearchCheckpoint): Promise<void>;
  guard(): Promise<void>;
}
export interface ResearchProvider {
  readonly origin: 'live_network' | 'offline_fixture';
  readonly version: string;
  run(context: ProviderContext): Promise<ResearchSnapshot>;
}
export function canonicalCompanyUrl(input: string): string {
  const url = publicUrl(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}
function evidence(
  page: SafePage,
  kind: ResearchEvidence['kind'],
  title: string,
  fields: string[],
  chain: string[],
  excerpts: string[],
  attribution: string,
  fieldBasis: Record<string, string> = {},
): ResearchEvidence {
  return {
    id: sha(page.sourceUrl),
    sourceUrl: page.sourceUrl,
    finalUrl: page.finalUrl,
    observedAt: page.observedAt,
    kind,
    status: 'read',
    title: title.slice(0, 240),
    excerpts: excerpts.slice(0, 3).map((s) => s.slice(0, 500)),
    fields,
    fieldBasis,
    sha256: page.bodySha256 ?? sha(page.body),
    hashScope: 'decoded_response_body',
    extractorVersion: 'd1-static-v1',
    discoveryChain: chain,
    error: null,
    attribution,
  };
}
function failedEvidence(
  url: string,
  chain: string[],
  code: string,
  kind: ResearchEvidence['kind'],
): ResearchEvidence {
  return {
    id: sha(url),
    sourceUrl: url,
    finalUrl: null,
    observedAt: new Date().toISOString(),
    kind,
    status: /REJECTED|403|429|ROBOTS/.test(code)
      ? 'blocked'
      : /UNSUPPORTED/.test(code)
        ? 'unsupported'
        : 'failed',
    title: '',
    excerpts: [],
    fields: [],
    sha256: null,
    hashScope: null,
    extractorVersion: 'd1-static-v1',
    discoveryChain: chain,
    error: code,
    attribution: '',
  };
}
export function matchCandidate(
  candidate: ResearchCandidate,
  request: ResearchRequest,
): ResearchCandidate {
  const reasons: ResearchCandidate['reasons'] = [];
  const regionEvidence = candidate.evidence.find(
    (e) => e.status === 'read' && e.fields.includes('country'),
  );
  if (candidate.country && regionEvidence)
    reasons.push({
      rule: 'explicit_country',
      points: candidate.country === request.country ? 30 : -30,
      evidenceId: regionEvidence.id,
      detail: `来源明确国家 ${candidate.country}；目标 ${request.country}`,
    });
  for (const [kind, words, points] of [
    ['business_keyword', [...request.keywords, request.buyerType], 10],
    ['exclusion', request.exclusions, -50],
  ] as const) {
    for (const term of [...new Set(words.map((s) => s.toLowerCase()))]) {
      const found = candidate.evidence.find(
        (e) => e.status === 'read' && e.excerpts.some((s) => s.toLowerCase().includes(term)),
      );
      if (found)
        reasons.push({ rule: kind, points, evidenceId: found.id, detail: `来源包含“${term}”` });
    }
  }
  return {
    ...candidate,
    score: reasons.reduce((sum, r) => sum + r.points, 0),
    reasons: reasons.slice(0, 24),
    rulesVersion: 'd1-fit-v1',
  };
}
export function boundedSnapshot(input: ResearchSnapshot): ResearchSnapshot {
  const result = structuredClone(input);
  while (
    Buffer.byteLength(JSON.stringify(result)) > researchLimits.snapshotBytes - 65536 &&
    result.candidates.length
  ) {
    result.candidates.pop();
    result.truncationReason = 'SNAPSHOT_BYTE_LIMIT';
  }
  return result;
}
function json(page: SafePage): Record<string, unknown> {
  try {
    return JSON.parse(page.body) as Record<string, unknown>;
  } catch {
    throw new ResearchNetworkError('JSON_UNSUPPORTED');
  }
}
function object(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
function firstString(input: unknown): string | null {
  const value = object(input).value;
  return typeof value === 'string' ? value : null;
}
function claim(entity: Record<string, unknown>, key: string): unknown {
  const values = object(entity.claims)[key];
  if (!Array.isArray(values)) return null;
  const item = values.find((v: unknown) => object(v).rank !== 'deprecated');
  return object(object(object(item).mainsnak).datavalue).value;
}
function pageUrl(config: (typeof directoryConfigs)[number], continuation: string | null): string {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    generator: 'categorymembers',
    gcmtitle: `Category:${config.category}`,
    gcmtype: 'page',
    gcmlimit: '50',
    prop: 'pageprops|info',
    inprop: 'url',
    ppprop: 'wikibase_item',
    format: 'json',
    formatversion: '2',
    maxlag: '5',
    ...(continuation ? { gcmcontinue: continuation } : {}),
  }).toString();
  return url.href;
}
export class PublicDirectoryProvider implements ResearchProvider {
  readonly origin = 'live_network' as const;
  readonly version = 'wikimedia-directory-v1';
  async run(context: ProviderContext): Promise<ResearchSnapshot> {
    const { request, http, checkpoint: cp } = context;
    const config = directoryConfigs.find((c) => c.id === request.directoryId)!;
    if (config.country !== request.country)
      throw new ResearchNetworkError('DIRECTORY_REGION_MISMATCH');
    do {
      if (cp.directoryPages > 0 && cp.next === null && !cp.pendingDirectory) break;
      if (
        (cp.directoryPages >= researchLimits.directoryPages && !cp.pendingDirectory) ||
        cp.discoveries.length >= request.limit
      )
        break;
      await context.guard();
      const url = cp.pendingDirectory ?? pageUrl(config, cp.next);
      // Page count is persisted before network, so a crash never grants extra directory pages.
      if (!cp.pendingDirectory) cp.directoryPages++;
      cp.pendingDirectory = url;
      await context.save(cp);
      const page = await http.retry(url);
      const body = json(page);
      if (body.error) throw new ResearchNetworkError('DIRECTORY_API_ERROR');
      const pages = object(body.query).pages;
      if (pages !== undefined && !Array.isArray(pages))
        throw new ResearchNetworkError('DIRECTORY_FORMAT_CHANGED');
      for (const raw of Array.isArray(pages) ? pages : []) {
        const item = object(raw);
        if (typeof item.title !== 'string' || typeof item.fullurl !== 'string') continue;
        try {
          publicUrl(item.fullurl);
        } catch {
          continue;
        }
        if (!item.fullurl.startsWith('https://en.wikipedia.org/wiki/')) continue;
        const entity = object(item.pageprops).wikibase_item;
        const d: Discovery = {
          name: item.title.slice(0, 240),
          url: item.fullurl,
          entity: typeof entity === 'string' && /^Q\d+$/.test(entity) ? entity : null,
          directoryEvidence: evidence(
            page,
            'directory',
            config.category,
            ['name', 'directory_membership'],
            [config.source, url, item.fullurl],
            [`${item.title} — ${config.category}`],
            'Wikipedia category membership; CC BY-SA 4.0; https://en.wikipedia.org/wiki/Wikipedia:Copyrights',
            {
              name: `query.pages[fullurl=${item.fullurl}].title`,
              directory_membership: `generator=categorymembers; gcmtitle=Category:${config.category}`,
            },
          ),
        };
        if (!cp.discoveries.some((v) => v.url === d.url) && cp.discoveries.length < request.limit)
          cp.discoveries.push(d);
      }
      const continuation = object(body.continue).gcmcontinue;
      cp.next = typeof continuation === 'string' ? continuation : null;
      cp.pendingDirectory = null;
      await context.save(cp);
    } while (cp.next);
    while (cp.cursor < cp.discoveries.length) {
      await context.guard();
      const d = cp.discoveries[cp.cursor]!;
      const candidate: ResearchCandidate = {
        key: sha(canonicalCompanyUrl(d.url)),
        name: d.name,
        sourceUrl: d.url,
        website: null,
        domain: null,
        country: null,
        description: '',
        publicEmails: [],
        evidence: [d.directoryEvidence],
        score: 0,
        rulesVersion: 'd1-fit-v1',
        reasons: [],
        unknownFields: [
          'contact_person',
          'public_email',
          'purchase_intent',
          'marketing_permission',
          'country',
        ],
      };
      if (d.entity) {
        const url = `https://www.wikidata.org/wiki/Special:EntityData/${d.entity}.json`;
        try {
          const page = await http.retry(url);
          const entity = object(object(json(page).entities)[d.entity]);
          if (!Object.keys(entity).length) throw new ResearchNetworkError('ENTITY_FORMAT_CHANGED');
          candidate.name = (firstString(object(entity.labels).en) ?? d.name).slice(0, 240);
          candidate.description = (firstString(object(entity.descriptions).en) ?? '').slice(0, 500);
          const country = object(claim(entity, 'P17')).id;
          candidate.country =
            ({ Q145: 'GB', Q408: 'AU', Q334: 'SG' } as Record<string, string>)[String(country)] ??
            null;
          const website = claim(entity, 'P856');
          if (typeof website === 'string') {
            try {
              candidate.website = publicUrl(website).href;
              candidate.domain = new URL(candidate.website).hostname
                .replace(/^www\./, '')
                .toLowerCase();
            } catch {
              /* unsafe published URLs stay unknown */
            }
          }
          if (candidate.country)
            candidate.unknownFields = candidate.unknownFields.filter((v) => v !== 'country');
          candidate.evidence.push(
            evidence(
              page,
              'directory',
              candidate.name,
              [
                'name',
                'description',
                ...(candidate.country ? ['country'] : []),
                ...(candidate.website ? ['website'] : []),
              ],
              [...d.directoryEvidence.discoveryChain, url],
              [
                `${candidate.name}; ${candidate.description}; country=${candidate.country ?? 'unknown'}; website=${candidate.website ?? 'unknown'}`,
              ],
              'Wikidata structured data CC0; https://www.wikidata.org/wiki/Wikidata:Licensing',
              {
                name: `entities.${d.entity}.labels.en.value`,
                description: `entities.${d.entity}.descriptions.en.value`,
                country: `entities.${d.entity}.claims.P17[].mainsnak.datavalue.value.id`,
                website: `entities.${d.entity}.claims.P856[].mainsnak.datavalue.value`,
              },
            ),
          );
        } catch (error) {
          const code = networkCode(error);
          cp.snapshot.errors.push({ url, code });
          candidate.evidence.push(failedEvidence(url, [d.url, url], code, 'directory'));
        }
      }
      // One entity page plus robots and the website: at most three page resources.
      // A failed/denied read preserves its status and never becomes a successful proof.
      await readWebsite(context, candidate, 'official_website');
      cp.snapshot.candidates.push(matchCandidate(candidate, request));
      cp.cursor++;
      cp.snapshot = boundedSnapshot(cp.snapshot);
      await context.save(cp);
    }
    return cp.snapshot;
  }
}
export function extractStaticPage(page: SafePage): {
  title: string;
  text: string;
  emails: string[];
} {
  const $ = load(page.body);
  $('script,style,noscript,iframe,form,svg').remove();
  const title = $('title').text().replace(/\s+/g, ' ').trim().slice(0, 240);
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const emails = [
    ...new Set(
      $('a[href^="mailto:"]')
        .toArray()
        .map((a) => ($(a).attr('href') ?? '').slice(7).split('?')[0]!)
        .filter((v) => /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v)),
    ),
  ].slice(0, 5);
  return { title, text, emails };
}
export function robotsAllowed(body: string, path: string): boolean {
  if (body.length > 128000 || body.split('\n').length > 2000) return false;
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: { agents: string[]; rules: { allow: boolean; pattern: string }[] } | null = null;
  let seenRule = false;
  for (const raw of body.split(/\r?\n/)) {
    if (raw.length > 2048) return false;
    const line = raw.replace(/#.*/, '').trim();
    const split = line.indexOf(':');
    if (split < 0) continue;
    const key = line.slice(0, split).trim().toLowerCase(),
      value = line.slice(split + 1).trim();
    if (key === 'user-agent') {
      if (!current || seenRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        seenRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      seenRule = true;
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== '*' && 'zutraderesearch'.includes(a)),
  );
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const matching = applicable
    .flatMap((g) => g.rules)
    .filter((r) => {
      // Ordered literal segments avoid executing untrusted patterns as regexes.
      const anchored = r.pattern.endsWith('$');
      const pattern = anchored ? r.pattern.slice(0, -1) : r.pattern;
      const parts = pattern.split('*');
      if (parts.length === 1) return anchored ? path === pattern : path.startsWith(pattern);
      const first = parts.shift()!;
      if (!path.startsWith(first)) return false;
      let position = first.length;
      const last = parts.pop()!;
      for (const part of parts) {
        const next = path.indexOf(part, position);
        if (next < 0) return false;
        position = next + part.length;
      }
      return anchored
        ? path.endsWith(last) && path.length - last.length >= position
        : path.indexOf(last, position) >= 0;
    })
    .sort((a, b) => b.pattern.length - a.pattern.length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}
export async function readWebsite(
  context: ProviderContext,
  candidate: ResearchCandidate,
  kind: ResearchEvidence['kind'],
): Promise<void> {
  if (!candidate.website) return;
  const url = publicUrl(candidate.website),
    robots = new URL('/robots.txt', url).href;
  try {
    try {
      const rules = await context.http.retry(robots);
      if (!robotsAllowed(rules.body, url.pathname + url.search))
        throw new ResearchNetworkError('ROBOTS_DISALLOWED');
    } catch (e) {
      if (networkCode(e) !== 'HTTP_404') throw e;
    }
    const page = await context.http.retry(url.href);
    if (!['text/html', 'application/xhtml+xml'].includes(page.contentType))
      throw new ResearchNetworkError('MIME_UNSUPPORTED');
    const parsed = extractStaticPage(page);
    if (parsed.text.length < 40 || /captcha|access denied|verify you are human/i.test(parsed.title))
      throw new ResearchNetworkError('PAGE_UNSUPPORTED');
    candidate.publicEmails = parsed.emails;
    const excerpts = [
      parsed.text.slice(0, 500),
      ...(parsed.emails.length
        ? [`Public addresses (unverified; permission unknown): ${parsed.emails.join(', ')}`]
        : []),
    ];
    candidate.evidence.push(
      evidence(
        page,
        kind,
        parsed.title,
        ['website_content', ...(parsed.emails.length ? ['publicEmails'] : [])],
        [candidate.sourceUrl, robots, url.href],
        excerpts,
        'Public page: only necessary factual excerpts; no marketing permission inferred',
        {
          website_content: 'body text excluding script/style/noscript/iframe/form/svg',
          publicEmails: 'a[href^="mailto:"]',
        },
      ),
    );
    if (parsed.emails.length)
      candidate.unknownFields = candidate.unknownFields.filter((v) => v !== 'public_email');
  } catch (e) {
    const code = networkCode(e);
    candidate.evidence.push(
      failedEvidence(url.href, [candidate.sourceUrl, robots, url.href], code, kind),
    );
    context.checkpoint.snapshot.errors.push({ url: url.href, code });
  }
}
export interface BraveConfig {
  key?: string;
  storageRights: boolean;
  rightsReference?: string;
}
export function braveReady(config: BraveConfig): boolean {
  return Boolean(config.key && config.storageRights && config.rightsReference?.trim());
}
export class BraveSearchProvider implements ResearchProvider {
  readonly origin = 'live_network' as const;
  readonly version = 'brave-web-v1';
  constructor(private readonly config: BraveConfig) {}
  async run(context: ProviderContext): Promise<ResearchSnapshot> {
    if (!braveReady(this.config))
      throw new ResearchNetworkError('BRAVE_NOT_CONFIGURED_OR_NO_STORAGE_RIGHTS');
    const { checkpoint: cp, request, http } = context;
    while (
      (cp.pendingDirectory || cp.directoryPages < Math.ceil(request.limit / 20)) &&
      cp.discoveries.length < request.limit
    ) {
      const url = new URL(cp.pendingDirectory ?? 'https://api.search.brave.com/res/v1/web/search');
      if (!cp.pendingDirectory)
        url.search = new URLSearchParams({
          q: `${request.buyerType} ${request.keywords.join(' ')} ${request.country} ${request.exclusions.map((s) => '-' + s).join(' ')}`.slice(
            0,
            600,
          ),
          country: request.country,
          count: '20',
          offset: String(cp.directoryPages),
          result_filter: 'web',
          text_decorations: 'false',
          search_lang: 'en',
        }).toString();
      if (!cp.pendingDirectory) cp.directoryPages++;
      cp.pendingDirectory = url.href;
      await context.save(cp);
      const page = await http.retry(url.href, { searchKey: this.config.key! });
      const results = object(json(page).web).results;
      if (!Array.isArray(results)) {
        cp.pendingDirectory = null;
        await context.save(cp);
        break;
      }
      for (const raw of results) {
        const item = object(raw);
        if (typeof item.url !== 'string' || typeof item.title !== 'string') continue;
        try {
          publicUrl(item.url);
        } catch {
          continue;
        }
        if (
          cp.discoveries.length >= request.limit ||
          cp.discoveries.some((v) => v.url === item.url)
        )
          continue;
        cp.discoveries.push({
          name: item.title.slice(0, 240),
          url: item.url,
          entity: null,
          directoryEvidence: evidence(
            page,
            'search_summary',
            item.title,
            ['candidate_name', 'search_snippet'],
            [url.href, item.url],
            [String(item.description ?? '').slice(0, 500)],
            'Brave Search API; storage entitlement configured locally',
            {
              candidate_name: `web.results[url=${item.url}].title`,
              search_snippet: `web.results[url=${item.url}].description`,
            },
          ),
        });
      }
      cp.pendingDirectory = null;
      await context.save(cp);
      if (results.length < 20) break;
    }
    while (cp.cursor < cp.discoveries.length) {
      await context.guard();
      const d = cp.discoveries[cp.cursor]!;
      const candidate: ResearchCandidate = {
        key: sha(canonicalCompanyUrl(d.url)),
        name: d.name,
        sourceUrl: d.url,
        website: d.url,
        domain: new URL(d.url).hostname.replace(/^www\./, ''),
        country: null,
        description: '',
        publicEmails: [],
        evidence: [d.directoryEvidence],
        score: 0,
        reasons: [],
        rulesVersion: 'd1-fit-v1',
        unknownFields: [
          'company_identity',
          'country',
          'contact_person',
          'purchase_intent',
          'marketing_permission',
        ],
      };
      // A search hit has no verified official identity. Its public page is separate
      // from the search summary and remains directory-level until human confirmation.
      await readWebsite(context, candidate, 'directory');
      cp.snapshot.candidates.push(matchCandidate(candidate, request));
      cp.cursor++;
      cp.snapshot = boundedSnapshot(cp.snapshot);
      await context.save(cp);
    }
    return cp.snapshot;
  }
}
export class FixtureResearchProvider implements ResearchProvider {
  readonly origin = 'offline_fixture' as const;
  readonly version = 'fixture-test-v1';
  constructor(
    private readonly runFixture: (context: ProviderContext) => Promise<ResearchSnapshot>,
  ) {
    if (process.env.NODE_ENV !== 'test') throw new Error('FixtureResearchProvider is test-only');
  }
  run(context: ProviderContext) {
    return this.runFixture(context);
  }
}
