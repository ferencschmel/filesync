import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import LocalAdapter from '../../src/adapters/LocalAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'synctool-la-test-'));
}

// ---------------------------------------------------------------------------
// describe: LocalAdapter
// ---------------------------------------------------------------------------

describe('LocalAdapter', () => {
  let serverRoot: string;
  let localRoot: string;
  let adapter: LocalAdapter;

  beforeEach(async () => {
    serverRoot = await makeTempDir();
    localRoot = await makeTempDir();
    adapter = new LocalAdapter(serverRoot);
  });

  afterEach(async () => {
    await adapter.disconnect();
    await fs.remove(serverRoot);
    await fs.remove(localRoot);
  });

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  it('connect creates server root directory if missing', async () => {
    const nonExistentRoot = path.join(os.tmpdir(), `synctool-new-${Date.now()}`);
    const freshAdapter = new LocalAdapter(nonExistentRoot);
    try {
      await freshAdapter.connect();
      const exists = await fs.pathExists(nonExistentRoot);
      expect(exists).toBe(true);
    } finally {
      await freshAdapter.disconnect();
      await fs.remove(nonExistentRoot);
    }
  });

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------

  it('readFile returns Buffer for existing file', async () => {
    await adapter.connect();
    const content = 'hello from server';
    await fs.writeFile(path.join(serverRoot, 'read-me.txt'), content);

    const result = await adapter.readFile('read-me.txt');

    expect(result).not.toBeNull();
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result!.toString('utf8')).toBe(content);
  });

  it('readFile returns null for missing file', async () => {
    await adapter.connect();
    const result = await adapter.readFile('does-not-exist.txt');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // uploadFile
  // -------------------------------------------------------------------------

  it('uploadFile copies file to server', async () => {
    await adapter.connect();
    const localFile = path.join(localRoot, 'upload.txt');
    await fs.writeFile(localFile, 'upload content');

    await adapter.uploadFile(localFile, 'upload.txt');

    const serverFile = path.join(serverRoot, 'upload.txt');
    expect(await fs.pathExists(serverFile)).toBe(true);
    const serverContent = await fs.readFile(serverFile, 'utf8');
    expect(serverContent).toBe('upload content');
  });

  it('uploadFile creates parent directories on server', async () => {
    await adapter.connect();
    const localFile = path.join(localRoot, 'nested.txt');
    await fs.writeFile(localFile, 'nested content');

    await adapter.uploadFile(localFile, 'a/b/c/nested.txt');

    const serverFile = path.join(serverRoot, 'a', 'b', 'c', 'nested.txt');
    expect(await fs.pathExists(serverFile)).toBe(true);
    const serverContent = await fs.readFile(serverFile, 'utf8');
    expect(serverContent).toBe('nested content');
  });

  // -------------------------------------------------------------------------
  // downloadFile
  // -------------------------------------------------------------------------

  it('downloadFile copies file from server to local', async () => {
    await adapter.connect();
    await fs.writeFile(path.join(serverRoot, 'download.txt'), 'download content');

    const localDest = path.join(localRoot, 'download.txt');
    await adapter.downloadFile('download.txt', localDest);

    expect(await fs.pathExists(localDest)).toBe(true);
    const content = await fs.readFile(localDest, 'utf8');
    expect(content).toBe('download content');
  });

  it('downloadFile creates parent directories locally', async () => {
    await adapter.connect();
    await fs.ensureDir(path.join(serverRoot, 'deep', 'path'));
    await fs.writeFile(
      path.join(serverRoot, 'deep', 'path', 'file.txt'),
      'deep file'
    );

    const localDest = path.join(localRoot, 'deep', 'path', 'file.txt');
    await adapter.downloadFile('deep/path/file.txt', localDest);

    expect(await fs.pathExists(localDest)).toBe(true);
    const content = await fs.readFile(localDest, 'utf8');
    expect(content).toBe('deep file');
  });

  // -------------------------------------------------------------------------
  // deleteFile
  // -------------------------------------------------------------------------

  it('deleteFile removes file from server', async () => {
    await adapter.connect();
    const serverFile = path.join(serverRoot, 'remove-me.txt');
    await fs.writeFile(serverFile, 'to be removed');

    await adapter.deleteFile('remove-me.txt');

    expect(await fs.pathExists(serverFile)).toBe(false);
  });

  it('deleteFile does not throw for missing file', async () => {
    await adapter.connect();
    await expect(
      adapter.deleteFile('non-existent.txt')
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // deleteDir
  // -------------------------------------------------------------------------

  it('deleteDir removes directory recursively', async () => {
    await adapter.connect();
    const dirPath = path.join(serverRoot, 'removedir');
    await fs.ensureDir(path.join(dirPath, 'sub'));
    await fs.writeFile(path.join(dirPath, 'file.txt'), 'data');
    await fs.writeFile(path.join(dirPath, 'sub', 'nested.txt'), 'nested');

    await adapter.deleteDir('removedir');

    expect(await fs.pathExists(dirPath)).toBe(false);
  });

  it('deleteDir does not throw for missing directory', async () => {
    await adapter.connect();
    await expect(
      adapter.deleteDir('no-such-dir')
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // ensureDir
  // -------------------------------------------------------------------------

  it('ensureDir creates nested directories', async () => {
    await adapter.connect();
    await adapter.ensureDir('x/y/z');

    const dirPath = path.join(serverRoot, 'x', 'y', 'z');
    const stat = await fs.stat(dirPath);
    expect(stat.isDirectory()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // listDir
  // -------------------------------------------------------------------------

  it('listDir returns file and directory entries', async () => {
    await adapter.connect();
    await fs.writeFile(path.join(serverRoot, 'file1.txt'), 'f1');
    await fs.writeFile(path.join(serverRoot, 'file2.txt'), 'f2');
    await fs.ensureDir(path.join(serverRoot, 'subdir'));

    const entries = await adapter.listDir('');

    const names = entries.map((e: any) => (typeof e === 'string' ? e : e.name ?? e));
    expect(names).toContain('file1.txt');
    expect(names).toContain('file2.txt');
    expect(names).toContain('subdir');
  });

  it('listDir returns empty array for missing directory', async () => {
    await adapter.connect();
    const entries = await adapter.listDir('missing-subdir');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(0);
  });

  it('listDir reflects only direct children, not nested files', async () => {
    await adapter.connect();
    await fs.ensureDir(path.join(serverRoot, 'parent', 'child'));
    await fs.writeFile(path.join(serverRoot, 'parent', 'direct.txt'), 'd');
    await fs.writeFile(
      path.join(serverRoot, 'parent', 'child', 'nested.txt'),
      'n'
    );

    const entries = await adapter.listDir('parent');

    const names = entries.map((e: any) => (typeof e === 'string' ? e : e.name ?? e));
    expect(names).toContain('direct.txt');
    expect(names).toContain('child');
    expect(names).not.toContain('nested.txt');
  });
});
