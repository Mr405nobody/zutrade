import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { ResearchCandidate, DueDiligenceReport } from '@zutrade/contracts';
import { publicUrl, networkCode, ResearchNetworkError } from './network.js';
import type { SafePage } from './network.js';
import { boundedSnapshot, robotsAllowed, extractStaticPage } from './providers.js';
import type { ResearchProvider, ProviderContext } from './providers.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export function outboundDomain(input: string): string {
  return publicUrl(input)
    .hostname.toLowerCase()
    .replace(/^www\./, '');
}
export function normalizeOutboundUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  return urls
    .map((s) => publicUrl(s))
    .filter((u) => {
      const domain = outboundDomain(u.href);
      if (seen.has(domain)) return false;
      seen.add(domain);
      return true;
    })
    .map((u) => u.origin + '/');
}
const countryCodes: Record<string, string> = {
  US: 'US',
  USA: 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  GB: 'GB',
  UK: 'GB',
  'UNITED KINGDOM': 'GB',
  AU: 'AU',
  AUSTRALIA: 'AU',
  SG: 'SG',
  SINGAPORE: 'SG',
  DE: 'DE',
  GERMANY: 'DE',
  CA: 'CA',
  CANADA: 'CA',
};
function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function clean(v: unknown, limit = 500): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}
export function extractOutboundPage(page: SafePage, product: string) {
  const $ = load(page.body);
  const nodes: Record<string, unknown>[] = [];
  function visit(v: unknown, depth = 0) {
    if (depth > 4 || nodes.length >= 80) return;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 80)) visit(item, depth + 1);
      return;
    }
    const o = object(v);
    if (!Object.keys(o).length) return;
    nodes.push(o);
    if (o['@graph']) visit(o['@graph'], depth + 1);
  }
  for (const script of $('script[type="application/ld+json"]').toArray().slice(0, 10)) {
    try {
      visit(JSON.parse($(script).text()));
    } catch {
      /* malformed structured data is ignored */
    }
  }
  const org =
    nodes.find((n) =>
      [n['@type']]
        .flat()
        .some(
          (t) =>
            typeof t === 'string' &&
            /^(Organization|Corporation|LocalBusiness|WholesaleStore|Store)$/.test(t),
        ),
    ) ?? {};
  const a = object(org.address),
    c = object(a.addressCountry);
  const rawCountry = clean(
    typeof a.addressCountry === 'string' ? a.addressCountry : c.name,
    100,
  ).toUpperCase();
  const name =
    clean(org.name, 240) || clean($('meta[property="og:site_name"]').attr('content'), 240);
  const address = [
    a.streetAddress,
    a.addressLocality,
    a.addressRegion,
    a.postalCode,
    a.addressCountry,
  ]
    .map((v) => clean(v, 150))
    .filter(Boolean)
    .join(', ')
    .slice(0, 500);
  const parsed = extractStaticPage(page);
  const terms = [product, ...(/fastener/i.test(product) ? ['fastener', 'bolts', 'nuts'] : [])];
  const matches = terms.filter((t) =>
    t === product
      ? parsed.text.toLowerCase().includes(t.toLowerCase())
      : new RegExp(`\\b${t}\\b`, 'i').test(parsed.text),
  );
  const buyer = ['Importer', 'Distributor', 'Wholesaler'].filter((t) =>
    new RegExp(`\\b${t}(?:s)?\\b`, 'i').test(parsed.text),
  );
  const profile: NonNullable<ResearchCandidate['profile']> = {};
  function fact(key: string, value: string) {
    if (value) profile[key] = { value, sourceUrl: page.finalUrl };
  }
  fact('name', name);
  fact('country', countryCodes[rawCountry] ?? (/^[A-Z]{2}$/.test(rawCountry) ? rawCountry : ''));
  fact('address', address);
  if (/contact/i.test(new URL(page.finalUrl).pathname))
    fact('publicContact', '官网公开联系页面（未验证联系人）');
  fact('buyerType', buyer.join(' / '));
  fact('products', matches.join(', '));
  fact('business', clean($('meta[name="description"]').attr('content')));
  const snippets = [parsed.text.slice(0, 500)];
  for (const term of [...matches, ...buyer]) {
    const at = parsed.text.toLowerCase().indexOf(term.toLowerCase());
    if (at >= 0) snippets.push(parsed.text.slice(Math.max(0, at - 100), at + 350));
  }
  const links = $('a[href]')
    .toArray()
    .filter((a) =>
      /about|company|contact|products|catalog/i.test($(a).text() + ' ' + ($(a).attr('href') ?? '')),
    )
    .map((a) => {
      try {
        const u = publicUrl(new URL($(a).attr('href')!, page.finalUrl).href);
        u.hash = '';
        return u.origin === new URL(page.finalUrl).origin &&
          !/\.(pdf|jpe?g|png|zip)$/i.test(u.pathname)
          ? u.href
          : null;
      } catch {
        return null;
      }
    })
    .filter((v): v is string => v !== null);
  return {
    profile,
    parsed,
    snippets: [...new Set(snippets)].slice(0, 3),
    links: [...new Set(links)].slice(0, 3),
    matches,
  };
}
export class OutboundManualProvider implements ResearchProvider {
  readonly origin = 'live_network' as const;
  readonly version = 'outbound-static-v1';
  async run(context: ProviderContext) {
    const { request, checkpoint: cp, http } = context;
    if (request.provider === 'outbound_unavailable')
      throw new ResearchNetworkError('AUTOMATIC_SEARCH_UNAVAILABLE');
    const urls = normalizeOutboundUrls(request.websiteUrls).slice(0, request.limit);
    while (cp.cursor < urls.length) {
      await context.guard();
      const homepage = urls[cp.cursor]!,
        domain = outboundDomain(homepage);
      const candidate: ResearchCandidate = {
        key: sha(domain),
        name: domain,
        sourceUrl: homepage,
        website: homepage,
        domain,
        country: null,
        description: '',
        publicEmails: [],
        evidence: [],
        score: 0,
        rulesVersion: 'd1-fit-v1',
        reasons: [],
        unknownFields: [
          'company_identity',
          'country',
          'purchase_intent',
          'marketing_permission',
          'registration',
        ],
        profile: {},
      };
      const robots = new URL('/robots.txt', homepage).href;
      let rules = '',
        delay = 1000;
      try {
        try {
          const page = await http.get(robots, { sameOrigin: true });
          if (page.contentType !== 'text/plain' || page.body.length > 128000)
            throw new ResearchNetworkError('ROBOTS_UNSUPPORTED');
          rules = page.body;
        } catch (e) {
          if (networkCode(e) !== 'HTTP_404') throw e;
        }
        const delays = [...rules.matchAll(/^\s*crawl-delay\s*:\s*([\d.]+)/gim)].map(
          (m) => Number(m[1]) * 1000,
        );
        delay = Math.max(1000, ...delays);
        if (!Number.isFinite(delay) || delay > 5000)
          throw new ResearchNetworkError('ROBOTS_CRAWL_DELAY_UNSUPPORTED');
        const pending = [homepage];
        for (let i = 0; i < pending.length && i < 4; i++) {
          const url = pending[i]!;
          await context.guard();
          if (!robotsAllowed(rules, new URL(url).pathname + new URL(url).search)) {
            cp.snapshot.errors.push({ url, code: 'ROBOTS_DISALLOWED' });
            continue;
          }
          await new Promise((r) => setTimeout(r, delay));
          try {
            const page = await http.get(url, { sameOrigin: true });
            if (!['text/html', 'application/xhtml+xml'].includes(page.contentType))
              throw new ResearchNetworkError('MIME_UNSUPPORTED');
            const info = extractOutboundPage(page, request.keywords[0] ?? '');
            if (
              info.parsed.text.length < 40 ||
              /captcha|access denied|verify you are human/i.test(info.parsed.title)
            )
              throw new ResearchNetworkError('PAGE_UNSUPPORTED');
            candidate.evidence.push({
              id: sha(page.finalUrl),
              sourceUrl: url,
              finalUrl: page.finalUrl,
              kind: 'official_website',
              status: 'read',
              observedAt: page.observedAt,
              title: info.parsed.title,
              excerpts: info.snippets,
              fields: ['website_content', ...Object.keys(info.profile)],
              fieldBasis: {
                website_content:
                  'static visible body; name/address/country from Organization JSON-LD or og:site_name; product/type from literal body matches',
              },
              sha256: page.bodySha256 ?? sha(page.body),
              hashScope: 'decoded_response_body',
              extractorVersion: 'd1-static-v1',
              discoveryChain: [homepage, robots, url],
              error: null,
              attribution:
                'Public website self-description; permission acknowledged by submitting member; necessary factual excerpts only; identity not independently verified',
            });
            for (const [k, v] of Object.entries(info.profile)) {
              const old = candidate.profile![k];
              if (old && old.value !== v.value && ['name', 'address', 'country'].includes(k)) {
                candidate.profile![`inconsistency_${k}`] = {
                  value: `官网页面自述不同：${old.value} / ${v.value}`.slice(0, 500),
                  sourceUrl: v.sourceUrl,
                };
              } else if (!old) candidate.profile![k] = v;
            }
            if (i === 0) pending.push(...info.links.filter((s) => !pending.includes(s)));
          } catch (e) {
            cp.snapshot.errors.push({ url, code: networkCode(e) });
          }
        }
        candidate.name = candidate.profile?.name?.value ?? domain;
        candidate.country = candidate.profile?.country?.value ?? null;
        candidate.description = candidate.profile?.business?.value ?? '';
        const texts = candidate.evidence
          .flatMap((e) => e.excerpts)
          .join(' ')
          .toLowerCase();
        if (!candidate.evidence.length) {
          /* failures remain task errors, never fraud signals */
        } else if (candidate.country && candidate.country !== request.country)
          cp.snapshot.errors.push({ url: homepage, code: 'EXCLUDED_EXPLICIT_COUNTRY_MISMATCH' });
        else if (request.exclusions.some((s) => texts.includes(s.toLowerCase())))
          cp.snapshot.errors.push({ url: homepage, code: 'EXCLUDED_KEYWORD' });
        else if (!candidate.profile?.products)
          cp.snapshot.errors.push({ url: homepage, code: 'PRODUCT_NOT_CONFIRMED' });
        else {
          candidate.unknownFields = candidate.unknownFields.filter(
            (s) => s !== 'country' || !candidate.country,
          );
          cp.snapshot.candidates.push(candidate);
        }
      } catch (e) {
        cp.snapshot.errors.push({ url: homepage, code: networkCode(e) });
      }
      cp.snapshot.errors = cp.snapshot.errors.slice(0, 80);
      cp.cursor++;
      cp.snapshot = boundedSnapshot(cp.snapshot);
      await context.save(cp);
    }
    if (cp.snapshot.candidates.length < request.limit)
      cp.snapshot.truncationReason =
        '仅返回已取得产品依据的官网；数量不足不补齐。失败、未知和不匹配见任务记录。';
    return cp.snapshot;
  }
}
export function buildDueDiligence(
  candidate: ResearchCandidate,
  target: { country: string; buyerType: string },
): DueDiligenceReport {
  const p = candidate.profile ?? {};
  const fact = (label: string, key: string) => ({
    label,
    value: p[key]?.value ?? '未知',
    sourceUrl: p[key]?.sourceUrl ?? null,
  });
  const productMatch = p.products
    ? '官网文本包含目标产品或词汇扩展；仅为规则匹配'
    : '未知：未取得官网产品依据';
  const buyerMatch = p.buyerType?.value.toLowerCase().includes(target.buyerType.toLowerCase())
    ? '官网自述包含目标买家类型'
    : '未知：未取得目标买家类型依据';
  return {
    generator: 'rules',
    version: 'outbound-rules-v1',
    investigatedAt: candidate.evidence.at(-1)?.observedAt ?? null,
    facts: [
      fact('公司名称（网站自述）', 'name'),
      {
        label: '公司官网（人工提交，主体待核实）',
        value: candidate.website ?? '未知',
        sourceUrl: candidate.website,
      },
      fact('国家或地区（网站自述）', 'country'),
      fact('公开地址', 'address'),
      fact('公开联系资料', 'publicContact'),
      fact('主营业务（网站自述）', 'business'),
      fact('企业类型（文本命中）', 'buyerType'),
      fact('相关产品（文本命中）', 'products'),
      {
        label: '官网可访问',
        value: candidate.evidence.some((e) => e.status === 'read' && e.kind === 'official_website')
          ? '采集时可访问'
          : '未读取成功',
        sourceUrl: candidate.website,
      },
    ],
    productMatch,
    buyerMatch,
    marketMatch: p.country
      ? p.country.value === target.country
        ? '官网自述国家与目标一致'
        : '官网自述国家与目标不一致'
      : '目标市场未知，不能按输入国家补全',
    inferences: p.products
      ? ['可能适合了解其产品分销或供货合作；经营相关产品不代表当前有采购需求。']
      : ['潜在采购价值未知，需要补充官网资料。'],
    risks: Object.entries(p)
      .filter(([k]) => k.startsWith('inconsistency_'))
      .map(([, v]) => `${v.value}；来源 ${v.sourceUrl}`),
    unknowns: [
      '未进行独立注册核验',
      '企业主体真实性与持续经营状态未知 / 未核实',
      '偿付能力、信用评级、付款记录未知 / 未核实',
      '实际控制人、诉讼情况未知 / 未核实',
      '未执行制裁名单筛查',
      '当前采购需求、采购负责人和联系许可未知 / 未核实',
      '只检查公开官网少量页面，未执行全面商业信用尽调',
    ],
    recommendation:
      '人工核对来源与主体身份后决定是否保留；规则报告不提供信用分。网页读取失败或资料缺失不构成欺诈判断。',
  };
}
