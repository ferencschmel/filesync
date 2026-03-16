import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { HASH_FILE_NAME, LAST_STATE_FILE } from './constants';
import { HashFileData, SyncStats } from './types';
import { readHashFile, buildAllHashFiles } from './HashManager';
import BaseAdapter from './adapters/BaseAdapter';

interface SyncEngineOptions {
  log?: (msg: string) => void;
}

async function readLastState(localRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(localRoot, LAST_STATE_FILE), 'utf8');
    return (JSON.parse(raw).hashes as Record<string, string>) || {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeLastState(localRoot: string, hashes: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(localRoot, LAST_STATE_FILE),
    JSON.stringify({ syncedAt: new Date().toISOString(), hashes }, null, 2),
    'utf8'
  );
}

class SyncEngine {
  private adapter: BaseAdapter;
  private log: (msg: string) => void;
  private _newHashes: Record<string, string>;
  private _localChanged: boolean;
  private _processedDirs: Map<string, string>;
  private stats: SyncStats;

  constructor(adapter: BaseAdapter, options: SyncEngineOptions = {}) {
    this.adapter = adapter;
    this.log = options.log || (() => {});
    this._newHashes = {};
    this._localChanged = false;
    this._processedDirs = new Map();
    this.stats = this._emptyStats();
  }

  private _emptyStats(): SyncStats {
    return { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0, conflicts: [], dirs: 0 };
  }

  private _softDeleteName(name: string): string {
    const d = new Date();
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
               `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    return `.deleted.${ts}.${name}`;
  }

  async sync(localRoot: string): Promise<SyncStats> {
    this.stats = this._emptyStats();
    this._newHashes = {};
    this._localChanged = false;
    this._processedDirs = new Map();

    const localHash = await readHashFile(localRoot);
    if (!localHash) {
      throw new Error(`No ${HASH_FILE_NAME} found in "${localRoot}". Run "synctool init" first.`);
    }

    const serverHashRaw = await this.adapter.readFile(HASH_FILE_NAME);
    const serverHash: HashFileData | null = serverHashRaw
      ? (JSON.parse(serverHashRaw.toString('utf8')) as HashFileData)
      : null;

    const U = await readLastState(localRoot);

    if (serverHash && serverHash.hash === localHash.hash && serverHash.hash === U['']) {
      this.log('Nothing to sync - all hashes match.');
      return this.stats;
    }

    this._newHashes = { ...U };

    await this._syncDir(localRoot, '', localHash, serverHash, U);

    if (this._localChanged) {
      this.log('Rebuilding local hash files after downloads/deletions...');
      await buildAllHashFiles(localRoot);
    }

    for (const [localDir, remotePath] of this._processedDirs) {
      const freshHash = await readHashFile(localDir);
      if (freshHash) {
        await this._uploadHashData(freshHash, remotePath);
        const remoteDir = remotePath.endsWith('/' + HASH_FILE_NAME)
          ? remotePath.slice(0, -(HASH_FILE_NAME.length + 1))
          : '';
        this._newHashes[remoteDir] = freshHash.hash;
      }
    }

    await writeLastState(localRoot, this._newHashes);
    return this.stats;
  }

  private async _syncDir(
    localDir: string,
    remoteDir: string,
    localHash: HashFileData,
    serverHash: HashFileData | null,
    U: Record<string, string>
  ): Promise<void> {
    this.stats.dirs++;
    this.log(`Syncing dir: ${remoteDir || '/'}`);

    const sFiles = serverHash ? serverHash.files : {};
    const sDirs  = serverHash ? serverHash.dirs  : {};

    const allFiles = new Set([...Object.keys(localHash.files), ...Object.keys(sFiles)]);
    for (const name of allFiles) {
      const relPath = remoteDir ? `${remoteDir}/${name}` : name;
      const L = localHash.files[name];
      const S = sFiles[name];
      const Uf = U[relPath];
      await this._mergeFile(name, relPath, localDir, L, S, Uf);
    }

    const allDirs = new Set([...Object.keys(localHash.dirs), ...Object.keys(sDirs)]);
    for (const name of allDirs) {
      const relPath = remoteDir ? `${remoteDir}/${name}` : name;
      const L = localHash.dirs[name];
      const S = sDirs[name];
      const Ud = U[relPath];
      await this._mergeDir(name, relPath, localDir, remoteDir, L, S, Ud, U);
    }

    const hashPath = remoteDir ? `${remoteDir}/${HASH_FILE_NAME}` : HASH_FILE_NAME;
    this._processedDirs.set(localDir, hashPath);
  }

  private async _mergeFile(
    name: string,
    relPath: string,
    localDir: string,
    L: string | undefined,
    S: string | undefined,
    U: string | undefined
  ): Promise<void> {
    const localPath = path.join(localDir, name);

    if (L !== undefined && S !== undefined) {
      if (L === S) {
        this._newHashes[relPath] = L;
        this.stats.skipped++;
        return;
      }
      if (S === U) {
        this.log(`  Upload: ${relPath}`);
        await this.adapter.uploadFile(localPath, relPath);
        this._newHashes[relPath] = L;
        this.stats.uploaded++;
        return;
      }
      if (L === U) {
        this.log(`  Download: ${relPath}`);
        await this.adapter.downloadFile(relPath, localPath);
        this._newHashes[relPath] = S;
        this._localChanged = true;
        this.stats.downloaded++;
        return;
      }
      await this._handleFileConflict(name, relPath, localDir, localPath, S);
      return;
    }

    if (L !== undefined && S === undefined) {
      if (U === undefined) {
        this.log(`  Upload (new): ${relPath}`);
        await this.adapter.uploadFile(localPath, relPath);
        this._newHashes[relPath] = L;
        this.stats.uploaded++;
      } else if (L === U) {
        this.log(`  Delete locally (server removed): ${relPath}`);
        await fs.remove(localPath);
        delete this._newHashes[relPath];
        this._localChanged = true;
        this.stats.deleted++;
      } else {
        this.log(`  Conflict (local changed, server deleted) - uploading: ${relPath}`);
        await this.adapter.uploadFile(localPath, relPath);
        this._newHashes[relPath] = L;
        this.stats.conflicts.push(relPath);
        this.stats.uploaded++;
      }
      return;
    }

    if (L === undefined && S !== undefined) {
      if (U === undefined) {
        this.log(`  Download (new from server): ${relPath}`);
        await this.adapter.downloadFile(relPath, localPath);
        this._newHashes[relPath] = S;
        this._localChanged = true;
        this.stats.downloaded++;
      } else if (S === U) {
        const softName = this._softDeleteName(path.basename(relPath));
        const softRelPath = path.dirname(relPath) === '.' ? softName : `${path.dirname(relPath)}/${softName}`;
        this.log(`  Soft-delete from server (local removed): ${relPath} → ${softRelPath}`);
        await this.adapter.rename(relPath, softRelPath);
        delete this._newHashes[relPath];
        this.stats.deleted++;
      } else {
        this.log(`  Conflict (local deleted, server changed) - downloading: ${relPath}`);
        await this.adapter.downloadFile(relPath, localPath);
        this._newHashes[relPath] = S;
        this._localChanged = true;
        this.stats.conflicts.push(relPath);
        this.stats.downloaded++;
      }
    }
  }

  private async _handleFileConflict(
    _name: string,
    relPath: string,
    _localDir: string,
    localPath: string,
    S: string
  ): Promise<void> {
    this.log(`  CONFLICT: ${relPath} - keeping local, downloading server copy`);
    const conflictPath = path.join(path.dirname(localPath), 'sync-conflict-server.' + path.basename(localPath));
    await this.adapter.downloadFile(relPath, conflictPath);
    await this.adapter.uploadFile(localPath, relPath);
    this._newHashes[relPath] = S;
    this._localChanged = true;
    this.stats.conflicts.push(relPath);
    this.stats.uploaded++;
  }

  private async _mergeDir(
    name: string,
    relPath: string,
    localDir: string,
    _remoteDir: string,
    L: string | undefined,
    S: string | undefined,
    U: string | undefined,
    fullU: Record<string, string>
  ): Promise<void> {
    const localSubDir = path.join(localDir, name);

    if (L !== undefined && S !== undefined) {
      if (L === S) {
        this._newHashes[relPath] = L;
        this.stats.skipped++;
        return;
      }
      await this._recurseDir(localSubDir, relPath, fullU);
      return;
    }

    if (L !== undefined && S === undefined) {
      if (U === undefined) {
        await this.adapter.ensureDir(relPath);
        await this._recurseDir(localSubDir, relPath, fullU);
      } else if (L === U) {
        this.log(`  Delete local dir (server removed): ${relPath}`);
        await fs.remove(localSubDir);
        this._pruneHashPrefix(relPath);
        this._localChanged = true;
        this.stats.deleted++;
      } else {
        this.log(`  Conflict (dir: local changed, server deleted) - uploading: ${relPath}`);
        await this.adapter.ensureDir(relPath);
        await this._recurseDir(localSubDir, relPath, fullU);
        this.stats.conflicts.push(relPath + '/');
      }
      return;
    }

    if (L === undefined && S !== undefined) {
      if (U === undefined) {
        await this._downloadDir(relPath, localSubDir, fullU);
      } else if (S === U) {
        const softName = this._softDeleteName(path.basename(relPath));
        const softRelPath = path.dirname(relPath) === '.' ? softName : `${path.dirname(relPath)}/${softName}`;
        this.log(`  Soft-delete dir from server (local removed): ${relPath} → ${softRelPath}`);
        await this.adapter.rename(relPath, softRelPath);
        this._pruneHashPrefix(relPath);
        this.stats.deleted++;
      } else {
        this.log(`  Conflict (dir: local deleted, server changed) - downloading: ${relPath}`);
        await this._downloadDir(relPath, localSubDir, fullU);
        this.stats.conflicts.push(relPath + '/');
      }
    }
  }

  private async _recurseDir(
    localSubDir: string,
    relPath: string,
    U: Record<string, string>
  ): Promise<void> {
    const localSubHash = await readHashFile(localSubDir);
    if (!localSubHash) {
      this.log(`  Warning: missing .synchash in ${localSubDir}, skipping`);
      return;
    }
    const raw = await this.adapter.readFile(`${relPath}/${HASH_FILE_NAME}`);
    const serverSubHash: HashFileData | null = raw
      ? (JSON.parse(raw.toString('utf8')) as HashFileData)
      : null;
    await this.adapter.ensureDir(relPath);
    await this._syncDir(localSubDir, relPath, localSubHash, serverSubHash, U);
  }

  private async _downloadDir(
    remoteDir: string,
    localDir: string,
    U: Record<string, string>
  ): Promise<void> {
    await fs.ensureDir(localDir);
    const raw = await this.adapter.readFile(`${remoteDir}/${HASH_FILE_NAME}`);
    if (!raw) return;
    const serverHash = JSON.parse(raw.toString('utf8')) as HashFileData;
    this._newHashes[remoteDir] = serverHash.hash;
    for (const [name, fileHash] of Object.entries(serverHash.files) as [string, unknown][]) {
      const relPath = `${remoteDir}/${name}`;
      this.log(`  Download (new dir): ${relPath}`);
      await this.adapter.downloadFile(relPath, path.join(localDir, name));
      this._newHashes[relPath] = fileHash as string;
      this.stats.downloaded++;
    }
    for (const name of Object.keys(serverHash.dirs)) {
      await this._downloadDir(`${remoteDir}/${name}`, path.join(localDir, name), U);
    }
    this._localChanged = true;
  }

  private _pruneHashPrefix(relPath: string): void {
    const prefix = relPath + '/';
    for (const key of Object.keys(this._newHashes)) {
      if (key === relPath || key.startsWith(prefix)) {
        delete this._newHashes[key];
      }
    }
  }

  private async _uploadHashData(hashData: HashFileData, remoteHashPath: string): Promise<void> {
    const tmpPath = path.join(
      os.tmpdir(),
      `synchash_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    try {
      await fs.writeFile(tmpPath, JSON.stringify(hashData, null, 2), 'utf8');
      await this.adapter.uploadFile(tmpPath, remoteHashPath);
    } finally {
      await fs.remove(tmpPath).catch(() => {});
    }
  }
}

export default SyncEngine;
