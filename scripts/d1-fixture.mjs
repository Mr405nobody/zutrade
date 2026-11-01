// Explicit offline transport injection for tests only; never imported by an app.
import {
  PublicDirectoryProvider,
  FixtureResearchProvider,
  SafeResearchHttp,
} from '@zutrade/prospecting';
export function fixtureHooks(mode = 'normal') {
  return {
    provider: new FixtureResearchProvider((c) => new PublicDirectoryProvider().run(c)),
    http: (budget) =>
      new SafeResearchHttp(
        budget,
        async () => [{ address: '8.8.8.8', family: 4 }],
        async (url) => {
          const out = (value, status = 200, type = 'application/json', headers = {}) => ({
            status,
            headers: { 'content-type': type, ...headers },
            body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
          });
          if (url.hostname === 'en.wikipedia.org') {
            if (mode === 'denied') return out('', 403);
            if (mode === 'rate') return out('', 429, 'text/plain', { 'retry-after': '600' });
            if (mode === 'zero') return out({ batchcomplete: true, query: { pages: [] } });
            return out({
              query: {
                pages: [1, 2, 3].map((n) => ({
                  title: `D1 Offline Events ${n} (fictional test)`,
                  fullurl: `https://en.wikipedia.org/wiki/D1_Offline_Events_${n}`,
                  pageprops: { wikibase_item: 'Q' + (90000 + n) },
                })),
              },
            });
          }
          if (url.hostname === 'www.wikidata.org') {
            const n = Number(url.pathname.match(/Q9000(\d)/)?.[1]);
            if (mode === 'partial' && n === 2) return out('', 403);
            const entity = {
              labels: { en: { value: `D1 Offline Events ${n} (fictional test)` } },
              descriptions: {
                en: {
                  value:
                    'Fictional event management and promotional merchandise company for offline tests',
                },
              },
              claims: {
                P17: [{ mainsnak: { datavalue: { value: { id: 'Q334' } } } }],
                P856: [
                  {
                    mainsnak: {
                      datavalue: { value: `https://d1-${n}.example.org/branch?company=${n}` },
                    },
                  },
                ],
              },
            };
            return out({ entities: { ['Q' + (90000 + n)]: entity } });
          }
          if (url.pathname === '/robots.txt')
            return out('User-agent: *\nAllow: /', 200, 'text/plain');
          return out(
            '<html><title>Fictional D1 Events</title><body>Fictional event management and promotional cotton bag products. No real company or contact. <a href="mailto:public@fictional.example">Public mailbox</a><script>fetch("http://127.0.0.1/")</script></body></html>',
            200,
            'text/html',
          );
        },
      ),
  };
}
