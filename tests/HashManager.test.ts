import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import {
  computeFileHash,
  computeHashFileHash,
  readHashFile,
  writeHashFile,
  buildHashFile,
  buildAllHashFiles,
  updateHashChain,
} from '../src/HashManager';
import { HASH_FILE_NAME, LAST_STATE_FILE } from '../src/constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synctool-hm-test-'));
  return dir;
}

// ---------------------------------------------------------------------------
// computeFileHash
// ---------------------------------------------------------------------------

describe('computeFileHash', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns a hex string', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world');
    const hash = await computeFileHash(filePath);
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash.length).toBeGreaterThan(0);
  });

  it('returns the same hash for the same content', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fs.writeFile(fileA, 'identical content');
    await fs.writeFile(fileB, 'identical content');
    const hashA = await computeFileHash(fileA);
    const hashB = await computeFileHash(fileB);
    expect(hashA).toBe(hashB);
  });

  it('returns different hashes for different content', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fs.writeFile(fileA, 'content A');
    await fs.writeFile(fileB, 'content B');
    const hashA = await computeFileHash(fileA);
    const hashB = await computeFileHash(fileB);
    expect(hashA).not.toBe(hashB);
  });

  it('handles empty files', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(filePath, '');
    const hash = await computeFileHash(filePath);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('handles binary content', async () => {
    const filePath = path.join(tmpDir, 'binary.bin');
    const buf = Buffer.from([0x00, 0xff, 0x10, 0x20, 0xab]);
    await fs.writeFile(filePath, buf);
    const hash = await computeFileHash(filePath);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// computeHashFileHash
// ---------------------------------------------------------------------------

describe('computeHashFileHash', () => {
  const baseData = {
    files: { 'a.txt': 'aaa', 'b.txt': 'bbb' },
    dirs: { subdir: 'ccc' },
    hash: '',
    updated: '2024-01-01T00:00:00.000Z',
  };

  it('returns a non-empty string', () => {
    const h = computeHashFileHash(baseData);
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });

  it('is deterministic – same input produces same hash', () => {
    const h1 = computeHashFileHash(baseData);
    const h2 = computeHashFileHash(baseData);
    expect(h1).toBe(h2);
  });

  it('changes when files change', () => {
    const h1 = computeHashFileHash(baseData);
    const modified = {
      ...baseData,
      files: { 'a.txt': 'DIFFERENT', 'b.txt': 'bbb' },
    };
    const h2 = computeHashFileHash(modified);
    expect(h1).not.toBe(h2);
  });

  it('changes when dirs change', () => {
    const h1 = computeHashFileHash(baseData);
    const modified = {
      ...baseData,
      dirs: { subdir: 'DIFFERENT_HASH' },
    };
    const h2 = computeHashFileHash(modified);
    expect(h1).not.toBe(h2);
  });

  it('changes when a file is added', () => {
    const h1 = computeHashFileHash(baseData);
    const modified = {
      ...baseData,
      files: { ...baseData.files, 'c.txt': 'ccc' },
    };
    const h2 = computeHashFileHash(modified);
    expect(h1).not.toBe(h2);
  });

  it('changes when a dir entry is removed', () => {
    const h1 = computeHashFileHash(baseData);
    const modified = { ...baseData, dirs: {} };
    const h2 = computeHashFileHash(modified);
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// readHashFile
// ---------------------------------------------------------------------------

describe('readHashFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns null when the hash file does not exist', async () => {
    const result = await readHashFile(tmpDir);
    expect(result).toBeNull();
  });

  it('parses a valid hash file and returns its data', async () => {
    const data = {
      files: { 'foo.txt': 'abc123' },
      dirs: {},
      hash: 'deadbeef',
      updated: '2024-06-01T12:00:00.000Z',
    };
    await fs.writeFile(
      path.join(tmpDir, HASH_FILE_NAME),
      JSON.stringify(data),
      'utf8'
    );
    const result = await readHashFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.files).toEqual(data.files);
    expect(result!.dirs).toEqual(data.dirs);
    expect(result!.hash).toBe(data.hash);
    expect(result!.updated).toBe(data.updated);
  });

  it('throws on a malformed hash file', async () => {
    await fs.writeFile(
      path.join(tmpDir, HASH_FILE_NAME),
      'NOT VALID JSON',
      'utf8'
    );
    await expect(readHashFile(tmpDir)).rejects.toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// writeHashFile
// ---------------------------------------------------------------------------

describe('writeHashFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('creates the hash file in the given directory', async () => {
    await writeHashFile(tmpDir, { files: {}, dirs: {} });
    const exists = await fs.pathExists(path.join(tmpDir, HASH_FILE_NAME));
    expect(exists).toBe(true);
  });

  it('returns a HashFileData object with a hash field set', async () => {
    const result = await writeHashFile(tmpDir, { files: { 'a.txt': 'aaa' }, dirs: {} });
    expect(result.hash).toBeDefined();
    expect(typeof result.hash).toBe('string');
    expect(result.hash.length).toBeGreaterThan(0);
  });

  it('sets the updated field to an ISO date string', async () => {
    const before = new Date().toISOString();
    const result = await writeHashFile(tmpDir, { files: {}, dirs: {} });
    const after = new Date().toISOString();
    expect(result.updated).toBeDefined();
    expect(result.updated >= before).toBe(true);
    expect(result.updated <= after).toBe(true);
  });

  it('persists files and dirs in the written file', async () => {
    const payload = { files: { 'z.txt': 'zzz' }, dirs: { sub: 'sss' } };
    await writeHashFile(tmpDir, payload);
    const raw = await fs.readFile(path.join(tmpDir, HASH_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.files).toEqual(payload.files);
    expect(parsed.dirs).toEqual(payload.dirs);
  });

  it('overwrites an existing hash file', async () => {
    await writeHashFile(tmpDir, { files: { 'old.txt': 'old' }, dirs: {} });
    await writeHashFile(tmpDir, { files: { 'new.txt': 'new' }, dirs: {} });
    const raw = await fs.readFile(path.join(tmpDir, HASH_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.files['new.txt']).toBe('new');
    expect(parsed.files['old.txt']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildHashFile
// ---------------------------------------------------------------------------

describe('buildHashFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('includes regular files in the files map', async () => {
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'content alpha');
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'content beta');
    const result = await buildHashFile(tmpDir);
    expect(result.files['alpha.txt']).toBeDefined();
    expect(result.files['beta.txt']).toBeDefined();
  });

  it('includes subdirectory entries in the dirs map', async () => {
    await fs.ensureDir(path.join(tmpDir, 'subA'));
    await fs.writeFile(path.join(tmpDir, 'subA', 'file.txt'), 'data');
    const result = await buildHashFile(tmpDir);
    expect(result.dirs['subA']).toBeDefined();
  });

  it('excludes the HASH_FILE_NAME from files', async () => {
    await fs.writeFile(path.join(tmpDir, 'real.txt'), 'hello');
    await fs.writeFile(path.join(tmpDir, HASH_FILE_NAME), '{"files":{},"dirs":{},"hash":"x","updated":"y"}');
    const result = await buildHashFile(tmpDir);
    expect(result.files[HASH_FILE_NAME]).toBeUndefined();
  });

  it('excludes the LAST_STATE_FILE from files', async () => {
    await fs.writeFile(path.join(tmpDir, 'real.txt'), 'hello');
    await fs.writeFile(path.join(tmpDir, LAST_STATE_FILE), '{}');
    const result = await buildHashFile(tmpDir);
    expect(result.files[LAST_STATE_FILE]).toBeUndefined();
  });

  it('handles an empty directory', async () => {
    const result = await buildHashFile(tmpDir);
    expect(result.files).toEqual({});
    expect(result.dirs).toEqual({});
  });

  it('returns a HashFileData with a non-empty hash', async () => {
    await fs.writeFile(path.join(tmpDir, 'x.txt'), 'x');
    const result = await buildHashFile(tmpDir);
    expect(result.hash).toBeDefined();
    expect(result.hash.length).toBeGreaterThan(0);
  });

  it('file hashes differ for different content', async () => {
    await fs.writeFile(path.join(tmpDir, 'one.txt'), 'aaaa');
    await fs.writeFile(path.join(tmpDir, 'two.txt'), 'bbbb');
    const result = await buildHashFile(tmpDir);
    expect(result.files['one.txt']).not.toBe(result.files['two.txt']);
  });
});

// ---------------------------------------------------------------------------
// buildAllHashFiles
// ---------------------------------------------------------------------------

describe('buildAllHashFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('creates a hash file in the root directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'root.txt'), 'root content');
    await buildAllHashFiles(tmpDir);
    const exists = await fs.pathExists(path.join(tmpDir, HASH_FILE_NAME));
    expect(exists).toBe(true);
  });

  it('creates hash files recursively in subdirectories', async () => {
    await fs.ensureDir(path.join(tmpDir, 'child'));
    await fs.writeFile(path.join(tmpDir, 'child', 'file.txt'), 'data');
    await buildAllHashFiles(tmpDir);
    const childHashExists = await fs.pathExists(
      path.join(tmpDir, 'child', HASH_FILE_NAME)
    );
    expect(childHashExists).toBe(true);
  });

  it('builds bottom-up: child hash appears in parent dirs entry', async () => {
    await fs.ensureDir(path.join(tmpDir, 'sub'));
    await fs.writeFile(path.join(tmpDir, 'sub', 'item.txt'), 'item');
    await buildAllHashFiles(tmpDir);

    const childHash = await readHashFile(path.join(tmpDir, 'sub'));
    expect(childHash).not.toBeNull();

    const parentHash = await readHashFile(tmpDir);
    expect(parentHash).not.toBeNull();
    expect(parentHash!.dirs['sub']).toBe(childHash!.hash);
  });

  it('handles nested directories multiple levels deep', async () => {
    await fs.ensureDir(path.join(tmpDir, 'a', 'b', 'c'));
    await fs.writeFile(path.join(tmpDir, 'a', 'b', 'c', 'deep.txt'), 'deep');
    await buildAllHashFiles(tmpDir);

    const deepHash = await readHashFile(path.join(tmpDir, 'a', 'b', 'c'));
    const midHash = await readHashFile(path.join(tmpDir, 'a', 'b'));
    const aHash = await readHashFile(path.join(tmpDir, 'a'));
    const rootHash = await readHashFile(tmpDir);

    expect(deepHash).not.toBeNull();
    expect(midHash).not.toBeNull();
    expect(aHash).not.toBeNull();
    expect(rootHash).not.toBeNull();

    expect(midHash!.dirs['c']).toBe(deepHash!.hash);
    expect(aHash!.dirs['b']).toBe(midHash!.hash);
    expect(rootHash!.dirs['a']).toBe(aHash!.hash);
  });

  it('works on an empty root directory', async () => {
    await expect(buildAllHashFiles(tmpDir)).resolves.not.toThrow();
    const exists = await fs.pathExists(path.join(tmpDir, HASH_FILE_NAME));
    expect(exists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateHashChain
// ---------------------------------------------------------------------------

describe('updateHashChain', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('updates the hash of the parent directory up to root', async () => {
    // Setup: root/sub/file.txt
    await fs.ensureDir(path.join(tmpDir, 'sub'));
    await fs.writeFile(path.join(tmpDir, 'sub', 'file.txt'), 'original');
    await buildAllHashFiles(tmpDir);

    const rootHashBefore = await readHashFile(tmpDir);
    expect(rootHashBefore).not.toBeNull();

    // Modify the file and update chain
    await fs.writeFile(path.join(tmpDir, 'sub', 'file.txt'), 'modified');
    await updateHashChain(path.join(tmpDir, 'sub', 'file.txt'), tmpDir);

    const rootHashAfter = await readHashFile(tmpDir);
    expect(rootHashAfter).not.toBeNull();
    expect(rootHashAfter!.hash).not.toBe(rootHashBefore!.hash);
  });

  it('updates the intermediate directory hash', async () => {
    await fs.ensureDir(path.join(tmpDir, 'sub'));
    await fs.writeFile(path.join(tmpDir, 'sub', 'file.txt'), 'v1');
    await buildAllHashFiles(tmpDir);

    const subHashBefore = await readHashFile(path.join(tmpDir, 'sub'));

    await fs.writeFile(path.join(tmpDir, 'sub', 'file.txt'), 'v2');
    await updateHashChain(path.join(tmpDir, 'sub', 'file.txt'), tmpDir);

    const subHashAfter = await readHashFile(path.join(tmpDir, 'sub'));
    expect(subHashAfter!.hash).not.toBe(subHashBefore!.hash);
  });

  it('handles deleted files (ENOENT) gracefully', async () => {
    await fs.ensureDir(path.join(tmpDir, 'sub'));
    await fs.writeFile(path.join(tmpDir, 'sub', 'file.txt'), 'to be deleted');
    await buildAllHashFiles(tmpDir);

    // Delete the file then update hash chain
    await fs.remove(path.join(tmpDir, 'sub', 'file.txt'));
    await expect(
      updateHashChain(path.join(tmpDir, 'sub', 'file.txt'), tmpDir)
    ).resolves.not.toThrow();
  });

  it('does not modify sibling directories', async () => {
    await fs.ensureDir(path.join(tmpDir, 'siblingA'));
    await fs.ensureDir(path.join(tmpDir, 'siblingB'));
    await fs.writeFile(path.join(tmpDir, 'siblingA', 'a.txt'), 'aaaa');
    await fs.writeFile(path.join(tmpDir, 'siblingB', 'b.txt'), 'bbbb');
    await buildAllHashFiles(tmpDir);

    const siblingBHashBefore = await readHashFile(path.join(tmpDir, 'siblingB'));

    // Modify siblingA only
    await fs.writeFile(path.join(tmpDir, 'siblingA', 'a.txt'), 'changed');
    await updateHashChain(path.join(tmpDir, 'siblingA', 'a.txt'), tmpDir);

    const siblingBHashAfter = await readHashFile(path.join(tmpDir, 'siblingB'));
    expect(siblingBHashAfter!.hash).toBe(siblingBHashBefore!.hash);
  });

  it('updates all ancestors in a deeply nested structure', async () => {
    await fs.ensureDir(path.join(tmpDir, 'a', 'b', 'c'));
    await fs.writeFile(path.join(tmpDir, 'a', 'b', 'c', 'deep.txt'), 'initial');
    await buildAllHashFiles(tmpDir);

    const rootBefore = await readHashFile(tmpDir);
    const aBefore = await readHashFile(path.join(tmpDir, 'a'));
    const bBefore = await readHashFile(path.join(tmpDir, 'a', 'b'));

    await fs.writeFile(path.join(tmpDir, 'a', 'b', 'c', 'deep.txt'), 'updated');
    await updateHashChain(path.join(tmpDir, 'a', 'b', 'c', 'deep.txt'), tmpDir);

    const rootAfter = await readHashFile(tmpDir);
    const aAfter = await readHashFile(path.join(tmpDir, 'a'));
    const bAfter = await readHashFile(path.join(tmpDir, 'a', 'b'));

    expect(rootAfter!.hash).not.toBe(rootBefore!.hash);
    expect(aAfter!.hash).not.toBe(aBefore!.hash);
    expect(bAfter!.hash).not.toBe(bBefore!.hash);
  });
});
