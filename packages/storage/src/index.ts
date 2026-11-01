import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface StoredObject {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}
// Authorization is a domain-service responsibility BEFORE calling this private port.
export interface PrivateObjectStore {
  putImmutable(bytes: Uint8Array): Promise<StoredObject>;
  readVerified(object: StoredObject): Promise<Uint8Array>;
}
function assertPrivateRoot(path: string) {
  if (!path.split(sep).includes('private') || path.split(sep).includes('public')) {
    throw new Error('Object storage must be in a private directory, outside public.');
  }
}
function isAlreadyExists(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export class LocalPrivateObjectStore implements PrivateObjectStore {
  private initializedRoot: Promise<string> | undefined;
  constructor(private readonly root: string) {
    assertPrivateRoot(resolve(root));
  }
  private privateRoot() {
    this.initializedRoot ??= (async () => {
      await mkdir(resolve(this.root), { recursive: true, mode: 0o700 });
      const canonicalRoot = await realpath(resolve(this.root));
      assertPrivateRoot(canonicalRoot);
      return canonicalRoot;
    })();
    return this.initializedRoot;
  }
  private async path(key: string, createDirectory = false) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid immutable object key.');
    const root = await this.privateRoot();
    const directory = resolve(root, key.slice(0, 2));
    if (createDirectory) await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    if (canonicalDirectory !== directory)
      throw new Error('Private object prefix must not be a symlink.');
    return resolve(directory, key);
  }

  async putImmutable(bytes: Uint8Array): Promise<StoredObject> {
    // Copy once so mutation of a caller-owned Uint8Array cannot change bytes after hashing.
    const content = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const object = { key: sha256, sha256, byteLength: content.byteLength };
    const path = await this.path(object.key, true);
    const temporary = resolve(dirname(path), `.pending-${randomUUID()}.tmp`);
    // Publish a complete, fsynced file with an atomic non-overwriting hard link. A crash
    // can leave only an unreferenced temporary file, never a partially written final key.
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      // EEXIST is reuse only if the existing immutable bytes are correct.
      await this.readVerified(object);
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return object;
    } finally {
      // Only this invocation's temporary name is removed; no history/object scavenging.
      await unlink(temporary);
    }
  }

  async readVerified(object: StoredObject): Promise<Uint8Array> {
    if (object.key !== object.sha256) throw new Error('Object identity mismatch.');
    const path = await this.path(object.key);
    // Reject a final-key symlink as well as symlinked prefix directories.
    if ((await realpath(path)) !== path) throw new Error('Private object must not be a symlink.');
    const bytes = await readFile(path);
    if (
      bytes.byteLength !== object.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== object.sha256
    ) {
      throw new Error('Private object integrity check failed.');
    }
    return bytes;
  }
}
