import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import * as path from 'path';
import * as fs from 'fs-extra';
import { HASH_FILE_NAME, LAST_STATE_FILE } from './constants';
import { HashFileData } from './types';

export async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', (err) => { stream.destroy(); reject(err); });
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('end', () => { stream.destroy(); resolve(hash.digest('hex')); });
  });
}

export function computeHashFileHash(hashData: HashFileData): string {
  const canonical = JSON.stringify({ files: hashData.files, dirs: hashData.dirs });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function readHashFile(dirPath: string): Promise<HashFileData | null> {
  const hashFilePath = path.join(dirPath, HASH_FILE_NAME);
  try {
    const raw = await fs.readFile(hashFilePath, 'utf8');
    return JSON.parse(raw) as HashFileData;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeHashFile(
  dirPath: string,
  data: Pick<HashFileData, 'files' | 'dirs'>
): Promise<HashFileData> {
  const full = data as HashFileData;
  full.hash = computeHashFileHash(full);
  full.updated = new Date().toISOString();
  const hashFilePath = path.join(dirPath, HASH_FILE_NAME);
  await fs.writeFile(hashFilePath, JSON.stringify(full, null, 2), 'utf8');
  return full;
}

export async function buildHashFile(dirPath: string): Promise<HashFileData> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  const files: Record<string, string> = {};
  const dirs: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.name === HASH_FILE_NAME) continue;
    if (entry.name === LAST_STATE_FILE) continue;
    if (entry.name.startsWith('sync-conflict-server.')) continue;
    if (entry.name.startsWith('.deleted.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isFile()) {
      files[entry.name] = await computeFileHash(fullPath);
    } else if (entry.isDirectory()) {
      const childHash = await readHashFile(fullPath);
      dirs[entry.name] = childHash ? childHash.hash : '';
    }
  }

  return writeHashFile(dirPath, { files, dirs });
}

export async function updateHashChain(changedPath: string, rootPath: string): Promise<void> {
  let dir: string;
  try {
    dir = (await fs.lstat(changedPath)).isDirectory() ? changedPath : path.dirname(changedPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      dir = path.dirname(changedPath);
    } else {
      throw err;
    }
  }

  const dirsToUpdate: string[] = [];
  let current = dir;
  while (true) {
    dirsToUpdate.push(current);
    if (path.resolve(current) === path.resolve(rootPath)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const d of dirsToUpdate) {
    await buildHashFile(d);
  }
}

export async function buildAllHashFiles(
  rootPath: string,
  onProgress?: (dirPath: string, count: number) => void,
  _count = { value: 0 }
): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === HASH_FILE_NAME) continue;
    if (entry.name === LAST_STATE_FILE) continue;
    if (entry.isDirectory()) {
      await buildAllHashFiles(path.join(rootPath, entry.name), onProgress, _count);
    }
  }

  await buildHashFile(rootPath);
  _count.value += 1;
  onProgress?.(rootPath, _count.value);
}
