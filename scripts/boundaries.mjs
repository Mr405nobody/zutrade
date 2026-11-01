import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifests = new Map();
for (const top of ['apps', 'packages']) {
  for (const dir of readdirSync(top)) {
    const manifest = JSON.parse(readFileSync(`${top}/${dir}/package.json`, 'utf8'));
    manifests.set(manifest.name, { path: `${top}/${dir}`, ...manifest });
  }
}
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
for (const [name, manifest] of manifests) {
  for (const path of files(`${manifest.path}/src`).filter((file) => /\.tsx?$/.test(file))) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      const target = match[1];
      if (target.includes('/apps/') || target.includes('/packages/'))
        throw new Error(`Cross-package relative import: ${path}`);
      if (!target.startsWith('@zutrade/')) continue;
      if (!manifest.dependencies?.[target])
        throw new Error(`Undeclared workspace dependency ${target}: ${path}`);
      if (!manifests.has(target))
        throw new Error(`Deep or missing workspace import ${target}: ${path}`);
      if (
        ['@zutrade/web', '@zutrade/ui'].includes(name) &&
        !['@zutrade/contracts', '@zutrade/ui'].includes(target)
      )
        throw new Error(`Browser/server dependency leak: ${path}`);
      if (manifest.path.startsWith('packages/') && manifests.get(target).path.startsWith('apps/'))
        throw new Error(`Shared package imports application: ${path}`);
    }
  }
}
const visited = new Set();
function visit(name, chain = []) {
  if (chain.includes(name)) throw new Error(`Dependency cycle: ${[...chain, name].join(' -> ')}`);
  if (visited.has(name)) return;
  for (const dependency of Object.keys(manifests.get(name).dependencies ?? {}).filter((dep) =>
    manifests.has(dep),
  ))
    visit(dependency, [...chain, name]);
  visited.add(name);
}
for (const name of manifests.keys()) visit(name);
console.log(
  `Dependency boundaries: ${manifests.size} packages, no cycles or browser/server leaks.`,
);
