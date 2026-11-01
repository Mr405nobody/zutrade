import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { LocalPrivateObjectStore } from '../../packages/storage/src/index.js';

const fault = vi.hoisted(() => ({ interruptWrite: true }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (fault.interruptWrite && String(args[0]).includes('.pending-')) {
        const write = file.writeFile.bind(file);
        file.writeFile = async (bytes) => {
          await write(Buffer.from(bytes as Uint8Array).subarray(0, 3));
          throw new Error('INJECTED_PARTIAL_WRITE_FAILURE');
        };
      }
      return file;
    },
  };
});
test('partial write failure cannot publish a final key, and a later retry succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zutrade-atomic-failure-'));
  try {
    const store = new LocalPrivateObjectStore(join(root, 'private'));
    const bytes = Buffer.from('full immutable content after retry');
    const key = createHash('sha256').update(bytes).digest('hex');
    await expect(store.putImmutable(bytes)).rejects.toThrow('INJECTED_PARTIAL_WRITE_FAILURE');
    expect(await readdir(join(root, 'private', key.slice(0, 2)))).toEqual([]);
    fault.interruptWrite = false;
    const object = await store.putImmutable(bytes);
    expect(object.key).toBe(key);
    expect(Buffer.from(await store.readVerified(object))).toEqual(bytes);
    expect(await readdir(join(root, 'private', key.slice(0, 2)))).toEqual([key]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
