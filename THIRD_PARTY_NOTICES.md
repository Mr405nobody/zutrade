# Third-party sources and licenses

Direct dependencies are pinned in package manifests and pnpm-lock.yaml. License files shipped with installed packages remain in node_modules. This records direct dependencies; transitive dependency metadata is retained in the lockfile/package distributions. No application business code was copied from CRM projects.

## Copied UI component

`packages/ui/src/index.tsx` adapts the shadcn/ui Button (MIT), replacing import paths and reducing variants for this stage. [Upstream source](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/button.tsx). Copyright (c) 2023 shadcn. Full notice: [licenses/shadcn-ui-MIT.txt](licenses/shadcn-ui-MIT.txt).

## Direct npm dependencies

| Package                  | Locked version | License    | Source                                                     |
| ------------------------ | -------------- | ---------- | ---------------------------------------------------------- |
| @eslint/js               | 10.0.1         | MIT        | https://github.com/eslint/eslint.git                       |
| @nestjs/common           | 12.3.2         | MIT        | https://github.com/nestjs/nest.git                         |
| @nestjs/core             | 12.3.2         | MIT        | https://github.com/nestjs/nest.git                         |
| @nestjs/platform-express | 12.3.2         | MIT        | https://github.com/nestjs/nest.git                         |
| @opentelemetry/api       | 1.9.0          | Apache-2.0 | open-telemetry/opentelemetry-js                            |
| @playwright/test         | 1.64.1         | Apache-2.0 | git+https://github.com/microsoft/playwright.git            |
| @radix-ui/react-slot     | 1.5.0          | MIT        | git+https://github.com/radix-ui/primitives.git             |
| @tailwindcss/vite        | 4.3.3          | MIT        | https://github.com/tailwindlabs/tailwindcss.git            |
| @tanstack/react-query    | 5.105.0        | MIT        | git+https://github.com/TanStack/query.git                  |
| @types/node              | 24.19.2        | MIT        | https://github.com/DefinitelyTyped/DefinitelyTyped.git     |
| @types/pg                | 8.23.1         | MIT        | https://github.com/DefinitelyTyped/DefinitelyTyped.git     |
| @types/react             | 19.3.0         | MIT        | https://github.com/DefinitelyTyped/DefinitelyTyped.git     |
| @types/react-dom         | 19.3.0         | MIT        | https://github.com/DefinitelyTyped/DefinitelyTyped.git     |
| @vitejs/plugin-react     | 6.1.2          | MIT        | git+https://github.com/vitejs/vite-plugin-react.git        |
| class-variance-authority | 0.7.1          | Apache-2.0 | https://github.com/joe-bell/cva.git                        |
| clsx                     | 2.1.1          | MIT        | lukeed/clsx                                                |
| drizzle-orm              | 0.45.4         | Apache-2.0 | git+https://github.com/drizzle-team/drizzle-orm.git        |
| eslint                   | 10.13.0        | MIT        | eslint/eslint                                              |
| lucide-react             | 1.63.0         | ISC        | https://github.com/lucide-icons/lucide.git                 |
| pg                       | 8.23.1         | MIT        | git://github.com/brianc/node-postgres.git                  |
| pg-boss                  | 12.38.0        | MIT        | git+https://github.com/timgit/pg-boss.git                  |
| prettier                 | 3.9.10         | MIT        | prettier/prettier                                          |
| react                    | 19.3.1         | MIT        | https://github.com/react/react.git                         |
| react-dom                | 19.3.1         | MIT        | https://github.com/react/react.git                         |
| reflect-metadata         | 0.2.2          | Apache-2.0 | https://github.com/rbuckton/reflect-metadata.git           |
| rxjs                     | 7.8.2          | Apache-2.0 | https://github.com/reactivex/rxjs.git                      |
| tailwind-merge           | 3.7.0          | MIT        | https://github.com/dcastil/tailwind-merge.git              |
| tailwindcss              | 4.3.3          | MIT        | https://github.com/tailwindlabs/tailwindcss.git            |
| typescript               | 6.0.2          | Apache-2.0 | https://github.com/microsoft/TypeScript.git                |
| typescript-eslint        | 8.72.1         | MIT        | https://github.com/typescript-eslint/typescript-eslint.git |
| vite                     | 8.3.5          | MIT        | git+https://github.com/vitejs/vite.git                     |
| vitest                   | 5.0.5          | MIT        | git+https://github.com/vitest-dev/vitest.git               |
| zod                      | 4.6.7          | MIT        | git+https://github.com/colinhacks/zod.git                  |

## Local infrastructure

Node.js 24.22.1: MIT and bundled third-party notices in the downloaded distribution. PostgreSQL 18.6: PostgreSQL License; Docker Official Image source: https://github.com/docker-library/postgres. Docker CLI and Compose: Apache-2.0; Colima/Lima: Apache-2.0. These tools are installed outside the Git repository.

## Stage A1 additions

| Package             | Locked version | License | Source                                                                       |
| ------------------- | -------------- | ------- | ---------------------------------------------------------------------------- |
| better-auth         | 1.7.14         | MIT     | https://github.com/better-auth/better-auth/tree/main/packages/better-auth    |
| auth (official CLI) | 1.7.14         | MIT     | https://github.com/better-auth/better-auth/tree/main/packages/cli            |
| drizzle-kit         | 0.31.11        | MIT     | https://github.com/drizzle-team/drizzle-orm                                  |
| @types/express      | 5.0.6          | MIT     | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/express |

The auth SQL is generated by the pinned official CLI; business mapping is generated from PostgreSQL catalogs. No third-party business implementation was copied. zod 4.6.7, already pinned, is now also a direct database package dependency.

## Stage B additions

| Package / asset          | Locked version   | License     | Source                                                                      |
| ------------------------ | ---------------- | ----------- | --------------------------------------------------------------------------- |
| decimal.js               | 10.6.0           | MIT         | https://github.com/MikeMcl/decimal.js                                       |
| pdfkit                   | 0.20.2           | MIT         | https://github.com/foliojs/pdfkit                                           |
| @types/pdfkit            | 0.17.7           | MIT         | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pdfkit |
| Noto Sans CJK SC Regular | repository asset | SIL OFL 1.1 | https://github.com/notofonts/noto-cjk                                       |

Noto font and its license are retained in `packages/domain/assets`; PDF embeds the font for Chinese seller names. Decimal calculation uses the pinned library's `ROUND_HALF_UP`; PDFKit renders only the explicitly selected frozen fields. Official API references: [decimal.js](https://mikemcl.github.io/decimal.js/), [PDFKit](https://pdfkit.org/docs/getting_started.html).

## Stage D1 additions

- Cheerio 1.2.0 (MIT): https://github.com/cheeriojs/cheerio ; static parsing only, no scripts/forms executed.
- ipaddr.js 2.2.0 (MIT): https://github.com/whitequark/ipaddr.js ; public-address classification with additional conservative IPv6 exclusions.
- Wikipedia category facts/links are attributed to Wikipedia under CC BY-SA 4.0; Wikidata structured facts use CC0. Attribution and source URLs travel with the evidence. No directory company list was copied into runtime configuration. Website excerpts and search results remain subject to their source rights; Brave stays disabled without local credentials and an explicit storage entitlement reference.
