import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LocalPrivateObjectStore } from '../../packages/storage/src/index.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'zutrade-stage0-'));
  temporary.push(root);
  const path = join(root, 'private');
  await mkdir(path, { mode: 0o700 });
  return { storage: new LocalPrivateObjectStore(path), path };
}
test('immutable writes preserve bytes and identity across adapter instances', async () => {
  const { storage, path } = await store();
  const bytes = Buffer.from('private-stage0-object');
  const object = await storage.putImmutable(bytes);
  expect(await storage.putImmutable(bytes)).toEqual(object);
  expect(Buffer.from(await new LocalPrivateObjectStore(path).readVerified(object))).toEqual(bytes);
});
test('tampered bytes cannot be read as the frozen object', async () => {
  const { storage, path } = await store();
  const object = await storage.putImmutable(Buffer.from('before'));
  await writeFile(join(path, object.key.slice(0, 2), object.key), 'after!');
  await expect(storage.readVerified(object)).rejects.toThrow('integrity');
});
test('traversal keys are rejected', async () => {
  const { storage } = await store();
  await expect(
    storage.readVerified({ key: '../.env', sha256: '../.env', byteLength: 1 }),
  ).rejects.toThrow('Invalid immutable object key');
});
test('public object directories are refused', () => {
  expect(() => new LocalPrivateObjectStore('/tmp/public/private')).toThrow('outside public');
});

test('parallel immutable publication reuses one final object and cleans only its own temporary files', async () => {
  const { storage, path } = await store();
  const bytes = Buffer.from('concurrent-atomic-object');
  const objects = await Promise.all(Array.from({ length: 8 }, () => storage.putImmutable(bytes)));
  expect(objects.every((object) => object.key === objects[0]!.key)).toBe(true);
  const object = objects[0]!;
  expect(await readdir(join(path, object.key.slice(0, 2)))).toEqual([object.key]);
  expect(Buffer.from(await storage.readVerified(object))).toEqual(bytes);
});
test('a crashed temporary write does not occupy or corrupt the final immutable key', async () => {
  const { storage, path } = await store();
  const object = await storage.putImmutable(Buffer.from('first historical object'));
  const prefix = join(path, object.key.slice(0, 2));
  const abandoned = join(prefix, '.pending-interrupted-process.tmp');
  await writeFile(abandoned, 'partial');
  await storage.putImmutable(Buffer.from('first historical object'));
  expect(await readdir(prefix)).toEqual(
    expect.arrayContaining([object.key, '.pending-interrupted-process.tmp']),
  );
  expect(Buffer.from(await storage.readVerified(object)).toString()).toBe(
    'first historical object',
  );
});
test('a private lexical path cannot resolve into a public directory through a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zutrade-storage-symlink-'));
  temporary.push(root);
  const publicPath = join(root, 'public');
  await mkdir(publicPath);
  const privatePath = join(root, 'private');
  await symlink(publicPath, privatePath);
  await expect(
    new LocalPrivateObjectStore(privatePath).putImmutable(Buffer.from('secret')),
  ).rejects.toThrow('outside public');
  expect(await readdir(publicPath)).toEqual([]);
});
