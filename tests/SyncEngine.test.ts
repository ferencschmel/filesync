import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import SyncEngine from '../src/SyncEngine';
import LocalAdapter from '../src/adapters/LocalAdapter';
import { buildAllHashFiles, updateHashChain } from '../src/HashManager';
import { SyncStats } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'synctool-se-test-'));
}

async function setupAndSync(
  localRoot: string,
  serverRoot: string
): Promise<SyncStats> {
  const adapter = new LocalAdapter(serverRoot);
  await adapter.connect();
  const engine = new SyncEngine(adapter, { log: () => {} });
  const stats = await engine.sync(localRoot);
  await adapter.disconnect();
  return stats;
}

// ---------------------------------------------------------------------------
// describe: initial sync
// ---------------------------------------------------------------------------

describe('initial sync', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('uploads all local files on first sync', async () => {
    await fs.writeFile(path.join(localDir, 'hello.txt'), 'hello');
    await fs.writeFile(path.join(localDir, 'world.txt'), 'world');
    await buildAllHashFiles(localDir);

    await setupAndSync(localDir, serverDir);

    expect(await fs.pathExists(path.join(serverDir, 'hello.txt'))).toBe(true);
    expect(await fs.pathExists(path.join(serverDir, 'world.txt'))).toBe(true);
  });

  it('uploads files in subdirectories', async () => {
    await fs.ensureDir(path.join(localDir, 'sub'));
    await fs.writeFile(path.join(localDir, 'sub', 'deep.txt'), 'deep content');
    await buildAllHashFiles(localDir);

    await setupAndSync(localDir, serverDir);

    expect(
      await fs.pathExists(path.join(serverDir, 'sub', 'deep.txt'))
    ).toBe(true);
  });

  it('creates server .synchash files', async () => {
    await fs.writeFile(path.join(localDir, 'file.txt'), 'data');
    await buildAllHashFiles(localDir);

    await setupAndSync(localDir, serverDir);

    // After sync the server should have a hash file at root
    const { HASH_FILE_NAME } = await import('../src/constants');
    expect(
      await fs.pathExists(path.join(serverDir, HASH_FILE_NAME))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe: L=A, U=A, S=A — no-op
// ---------------------------------------------------------------------------

describe('merge table: L=A, U=A, S=A', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('does nothing when all hashes match (fast path)', async () => {
    await fs.writeFile(path.join(localDir, 'stable.txt'), 'stable');
    await buildAllHashFiles(localDir);

    // First sync to bring server in sync
    await setupAndSync(localDir, serverDir);

    // Second sync: everything is the same
    const stats = await setupAndSync(localDir, serverDir);

    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
  });

  it('returns zero stats on no-op', async () => {
    await fs.writeFile(path.join(localDir, 'noop.txt'), 'noop');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    const stats = await setupAndSync(localDir, serverDir);

    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(stats.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describe: L=A, U=B, S=B — local changed, upload
// ---------------------------------------------------------------------------

describe('merge table: L=A, U=B, S=B — local changed, upload', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('uploads changed file to server', async () => {
    await fs.writeFile(path.join(localDir, 'change.txt'), 'version A');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Locally modify the file
    await fs.writeFile(path.join(localDir, 'change.txt'), 'version B');
    await updateHashChain(path.join(localDir, 'change.txt'), localDir);

    await setupAndSync(localDir, serverDir);

    const serverContent = await fs.readFile(
      path.join(serverDir, 'change.txt'),
      'utf8'
    );
    expect(serverContent).toBe('version B');
  });

  it('does not download or delete', async () => {
    await fs.writeFile(path.join(localDir, 'upload.txt'), 'original');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.writeFile(path.join(localDir, 'upload.txt'), 'changed locally');
    await updateHashChain(path.join(localDir, 'upload.txt'), localDir);

    const stats = await setupAndSync(localDir, serverDir);

    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(stats.uploaded).toBeGreaterThan(0);
  });

  it('subsequent sync is no-op', async () => {
    await fs.writeFile(path.join(localDir, 'seq.txt'), 'v1');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.writeFile(path.join(localDir, 'seq.txt'), 'v2');
    await updateHashChain(path.join(localDir, 'seq.txt'), localDir);
    await setupAndSync(localDir, serverDir);

    // Third sync should be a no-op
    const stats = await setupAndSync(localDir, serverDir);
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: L=A, U=A, S=B — server changed, download
// ---------------------------------------------------------------------------

describe('merge table: L=A, U=A, S=B — server changed, download', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('downloads changed file from server', async () => {
    await fs.writeFile(path.join(localDir, 'serverchange.txt'), 'v1');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Simulate server-side change
    await fs.writeFile(path.join(serverDir, 'serverchange.txt'), 'v2 from server');
    await buildAllHashFiles(serverDir);

    const stats = await setupAndSync(localDir, serverDir);

    expect(stats.downloaded).toBeGreaterThan(0);
  });

  it('local file content matches server after sync', async () => {
    await fs.writeFile(path.join(localDir, 'sync.txt'), 'initial');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.writeFile(path.join(serverDir, 'sync.txt'), 'server updated content');
    await buildAllHashFiles(serverDir);

    await setupAndSync(localDir, serverDir);

    const localContent = await fs.readFile(
      path.join(localDir, 'sync.txt'),
      'utf8'
    );
    expect(localContent).toBe('server updated content');
  });

  it('subsequent sync is no-op', async () => {
    await fs.writeFile(path.join(localDir, 'noop2.txt'), 'A');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.writeFile(path.join(serverDir, 'noop2.txt'), 'B from server');
    await buildAllHashFiles(serverDir);
    await setupAndSync(localDir, serverDir);

    const stats = await setupAndSync(localDir, serverDir);
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: L=A, U=B, S=C — conflict
// ---------------------------------------------------------------------------

describe('merge table: L=A, U=B, S=C — conflict', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  async function triggerConflict(fileName: string) {
    // 1. Initial state: both sides have version A
    await fs.writeFile(path.join(localDir, fileName), 'version A');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // 2. Both sides diverge independently
    await fs.writeFile(path.join(localDir, fileName), 'version B (local)');
    await updateHashChain(path.join(localDir, fileName), localDir);

    await fs.writeFile(path.join(serverDir, fileName), 'version C (server)');
    await buildAllHashFiles(serverDir);
  }

  it('creates a sync-conflict-server.<filename> file with server content', async () => {
    const fileName = 'conflict.txt';
    await triggerConflict(fileName);
    await setupAndSync(localDir, serverDir);

    const conflictFiles = (await fs.readdir(localDir)).filter((f) =>
      f.startsWith('sync-conflict-server.')
    );
    expect(conflictFiles.length).toBeGreaterThan(0);

    const conflictContent = await fs.readFile(
      path.join(localDir, conflictFiles[0]),
      'utf8'
    );
    expect(conflictContent).toBe('version C (server)');
  });

  it('keeps local file unchanged', async () => {
    const fileName = 'keep-local.txt';
    await triggerConflict(fileName);
    await setupAndSync(localDir, serverDir);

    const localContent = await fs.readFile(
      path.join(localDir, fileName),
      'utf8'
    );
    // Local version should be preserved (not overwritten by server)
    expect(localContent).toBe('version B (local)');
  });

  it('reports conflict in stats', async () => {
    const fileName = 'report.txt';
    await triggerConflict(fileName);
    const stats = await setupAndSync(localDir, serverDir);

    expect(stats.conflicts).toBeDefined();
    expect(stats.conflicts.length).toBeGreaterThan(0);
  });

  it('uploads local version to server', async () => {
    const fileName = 'upload-on-conflict.txt';
    await triggerConflict(fileName);
    await setupAndSync(localDir, serverDir);

    const serverContent = await fs.readFile(
      path.join(serverDir, fileName),
      'utf8'
    );
    // Server should now have the local version (local wins in conflict upload)
    expect(serverContent).toBe('version B (local)');
  });
});

// ---------------------------------------------------------------------------
// describe: file deletion: L=–, U=A, S=A — local deleted
// ---------------------------------------------------------------------------

describe('file deletion: L=–, U=A, S=A — local deleted', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('deletes file from server when local deletes it', async () => {
    await fs.writeFile(path.join(localDir, 'todelete.txt'), 'bye');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Locally delete
    await fs.remove(path.join(localDir, 'todelete.txt'));
    await updateHashChain(path.join(localDir, 'todelete.txt'), localDir);

    await setupAndSync(localDir, serverDir);

    expect(
      await fs.pathExists(path.join(serverDir, 'todelete.txt'))
    ).toBe(false);
  });

  it('subsequent sync is no-op after local delete', async () => {
    await fs.writeFile(path.join(localDir, 'gone.txt'), 'gone');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.remove(path.join(localDir, 'gone.txt'));
    await updateHashChain(path.join(localDir, 'gone.txt'), localDir);
    await setupAndSync(localDir, serverDir);

    const stats = await setupAndSync(localDir, serverDir);
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: file deletion: L=A, U=A, S=– — server deleted
// ---------------------------------------------------------------------------

describe('file deletion: L=A, U=A, S=– — server deleted', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('deletes local file when server deletes it', async () => {
    await fs.writeFile(path.join(localDir, 'serverkill.txt'), 'kill me');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Server deletes the file
    await fs.remove(path.join(serverDir, 'serverkill.txt'));
    await buildAllHashFiles(serverDir);

    await setupAndSync(localDir, serverDir);

    expect(
      await fs.pathExists(path.join(localDir, 'serverkill.txt'))
    ).toBe(false);
  });

  it('subsequent sync is no-op after server delete', async () => {
    await fs.writeFile(path.join(localDir, 'svrdel.txt'), 'data');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.remove(path.join(serverDir, 'svrdel.txt'));
    await buildAllHashFiles(serverDir);
    await setupAndSync(localDir, serverDir);

    const stats = await setupAndSync(localDir, serverDir);
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: new server file: L=–, U=–, S=A
// ---------------------------------------------------------------------------

describe('new server file: L=–, U=–, S=A', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('downloads new file from server to local', async () => {
    // Start with an initial sync to establish last state (empty)
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Server gets a new file
    await fs.writeFile(path.join(serverDir, 'newfile.txt'), 'brand new');
    await buildAllHashFiles(serverDir);

    await setupAndSync(localDir, serverDir);

    expect(
      await fs.pathExists(path.join(localDir, 'newfile.txt'))
    ).toBe(true);
    const content = await fs.readFile(path.join(localDir, 'newfile.txt'), 'utf8');
    expect(content).toBe('brand new');
  });

  it('subsequent sync is no-op after downloading new server file', async () => {
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.writeFile(path.join(serverDir, 'fresh.txt'), 'fresh');
    await buildAllHashFiles(serverDir);
    await setupAndSync(localDir, serverDir);

    const stats = await setupAndSync(localDir, serverDir);
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: directory operations
// ---------------------------------------------------------------------------

describe('directory operations', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('uploads new local directory to server', async () => {
    await fs.ensureDir(path.join(localDir, 'newdir'));
    await fs.writeFile(path.join(localDir, 'newdir', 'content.txt'), 'dir content');
    await buildAllHashFiles(localDir);

    await setupAndSync(localDir, serverDir);

    expect(
      await fs.pathExists(path.join(serverDir, 'newdir', 'content.txt'))
    ).toBe(true);
  });

  it('downloads new server directory to local', async () => {
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Server gets a new directory
    await fs.ensureDir(path.join(serverDir, 'serverdir'));
    await fs.writeFile(
      path.join(serverDir, 'serverdir', 'remote.txt'),
      'remote content'
    );
    await buildAllHashFiles(serverDir);

    await setupAndSync(localDir, serverDir);

    expect(
      await fs.pathExists(path.join(localDir, 'serverdir', 'remote.txt'))
    ).toBe(true);
  });

  it('deletes server directory when local deletes it', async () => {
    await fs.ensureDir(path.join(localDir, 'deldir'));
    await fs.writeFile(path.join(localDir, 'deldir', 'file.txt'), 'to delete');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Locally remove the directory
    await fs.remove(path.join(localDir, 'deldir'));
    await buildAllHashFiles(localDir);

    await setupAndSync(localDir, serverDir);

    expect(await fs.pathExists(path.join(serverDir, 'deldir'))).toBe(false);
  });

  it('subsequent sync after dir download is no-op', async () => {
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.ensureDir(path.join(serverDir, 'dldir'));
    await fs.writeFile(path.join(serverDir, 'dldir', 'x.txt'), 'x');
    await buildAllHashFiles(serverDir);
    await setupAndSync(localDir, serverDir);

    const stats = await setupAndSync(localDir, serverDir);
    expect(stats.uploaded).toBe(0);
    expect(stats.downloaded).toBe(0);
    expect(stats.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: nested directory handling
// ---------------------------------------------------------------------------

describe('nested directory handling', () => {
  let localDir: string;
  let serverDir: string;

  beforeEach(async () => {
    localDir = await makeTempDir();
    serverDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.remove(localDir);
    await fs.remove(serverDir);
  });

  it('syncs changes in nested subdirectories', async () => {
    await fs.ensureDir(path.join(localDir, 'a', 'b', 'c'));
    await fs.writeFile(path.join(localDir, 'a', 'b', 'c', 'deep.txt'), 'deep v1');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    // Modify the deep file
    await fs.writeFile(path.join(localDir, 'a', 'b', 'c', 'deep.txt'), 'deep v2');
    await updateHashChain(path.join(localDir, 'a', 'b', 'c', 'deep.txt'), localDir);

    await setupAndSync(localDir, serverDir);

    const serverContent = await fs.readFile(
      path.join(serverDir, 'a', 'b', 'c', 'deep.txt'),
      'utf8'
    );
    expect(serverContent).toBe('deep v2');
  });

  it('skips unchanged subdirectories (no unnecessary uploads)', async () => {
    // Two sibling dirs: only one changes
    await fs.ensureDir(path.join(localDir, 'unchanged'));
    await fs.ensureDir(path.join(localDir, 'changed'));
    await fs.writeFile(
      path.join(localDir, 'unchanged', 'static.txt'),
      'static'
    );
    await fs.writeFile(path.join(localDir, 'changed', 'dynamic.txt'), 'v1');
    await buildAllHashFiles(localDir);
    await setupAndSync(localDir, serverDir);

    await fs.writeFile(path.join(localDir, 'changed', 'dynamic.txt'), 'v2');
    await updateHashChain(path.join(localDir, 'changed', 'dynamic.txt'), localDir);

    const stats = await setupAndSync(localDir, serverDir);

    // Only the changed file should be uploaded
    expect(stats.uploaded).toBe(1);

    const serverContent = await fs.readFile(
      path.join(serverDir, 'changed', 'dynamic.txt'),
      'utf8'
    );
    expect(serverContent).toBe('v2');
  });
});
