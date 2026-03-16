import * as path from 'path';
import * as fs from 'fs-extra';
import { AppConfig, SyncPairConfig, ServerConfig, PairStatus, InitStatus, ActiveConflict } from './types';
import BaseAdapter from './adapters/BaseAdapter';
import FileWatcher from './FileWatcher';
import LocalAdapter from './adapters/LocalAdapter';
import FtpAdapter from './adapters/FtpAdapter';
import SyncEngine from './SyncEngine';
import { buildAllHashFiles } from './HashManager';
import { HASH_FILE_NAME } from './constants';

interface SyncClientOptions {
  log?: (msg: string) => void;
}

class SyncClient {
  public config: AppConfig;
  public log: (msg: string) => void;
  private _watchers: FileWatcher[];
  private _pollTimers: NodeJS.Timeout[];
  private _lastServerHashes: Map<string, string>;
  private _activeConflicts: Map<string, ActiveConflict>;
  private _pairStatus: Map<string, PairStatus>;
  private _initStatus: Map<string, InitStatus>;

  constructor(config: AppConfig, options: SyncClientOptions = {}) {
    this.config = config;
    this.log = options.log || ((msg: string) => console.log(`[synctool] ${msg}`));
    this._watchers = [];
    this._pollTimers = [];
    this._lastServerHashes = new Map();
    this._activeConflicts = new Map();
    this._pairStatus = new Map(
      config.syncPairs.map(p => [
        p.name,
        {
          name: p.name,
          localPath: p.localPath,
          serverDesc: this._serverDesc(p.server),
          syncing: false,
          lastSyncAt: null,
          lastStats: null,
          lastError: null,
        },
      ])
    );
    this._initStatus = new Map(
      config.syncPairs.map(p => [
        p.name,
        { name: p.name, initializing: false, dirsProcessed: 0, currentDir: null, lastInitAt: null, lastError: null },
      ])
    );
  }

  getStatus(): PairStatus[] {
    return this.config.syncPairs.map(p => this._pairStatus.get(p.name)!);
  }

  getInitStatus(): InitStatus[] {
    return this.config.syncPairs.map(p => this._initStatus.get(p.name)!);
  }

  async init(pairName?: string, onProgress?: (dir: string, count: number) => void): Promise<void> {
    const pairs = pairName
      ? this.config.syncPairs.filter(p => p.name === pairName)
      : this.config.syncPairs;

    for (const pair of pairs) {
      const status = this._initStatus.get(pair.name)!;
      status.initializing = true;
      status.dirsProcessed = 0;
      status.currentDir = null;
      status.lastError = null;

      this.log(`Initialising hash files for: ${pair.name} (${pair.localPath})`);
      try {
        await buildAllHashFiles(pair.localPath, (dir, count) => {
          status.dirsProcessed = count;
          status.currentDir = dir;
          onProgress?.(dir, count);
        });
        status.lastInitAt = new Date().toISOString();
        status.currentDir = null;
        this.log(`Done: ${pair.name} (${status.dirsProcessed} dirs)`);
      } catch (err) {
        status.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        status.initializing = false;
      }
    }
  }

  async sync(pairName?: string): Promise<void> {
    const pairs = pairName
      ? this.config.syncPairs.filter(p => p.name === pairName)
      : this.config.syncPairs;

    if (pairs.length === 0) {
      throw new Error(`No sync pair found with name "${pairName}"`);
    }

    for (const pair of pairs) {
      await this._syncPair(pair);
    }
  }

  async watch(): Promise<void> {
    for (const pair of this.config.syncPairs) {
      const watcher = new FileWatcher(pair.localPath, {
        debounceMs: this.config.autoSyncDelay ?? 5000,
        log: this.log,
        onChange: async (_changedPath: string) => {
          if (this.config.autoSyncOnChange) {
            this.log(`Auto-syncing after change in: ${pair.name}`);
            await this._syncPair(pair).catch((err: Error) =>
              this.log(`Auto-sync error: ${err.message}`)
            );
          }
        },
      });
      watcher.start();
      this._watchers.push(watcher);
      // Show any pre-existing conflict files from previous sessions
      this._scanConflicts(pair).catch(() => {});
    }
    this.log('Watchers started. Press Ctrl+C to stop.');
  }

  stopWatching(): void {
    for (const w of this._watchers) w.stop();
    this._watchers = [];
  }

  startPolling(): void {
    const intervalMs = (this.config.pollInterval ?? 0) * 1000;
    if (intervalMs <= 0) return;

    this.log(`Server polling started (every ${this.config.pollInterval}s)`);

    for (const pair of this.config.syncPairs) {
      const poll = async () => {
        const status = this._pairStatus.get(pair.name)!;
        if (status.syncing) return;

        const adapter = this._createAdapter(pair.server);
        try {
          await adapter.connect();
          const raw = await adapter.readFile(HASH_FILE_NAME);
          const serverHash = raw ? (JSON.parse(raw.toString('utf8')) as { hash?: string }).hash : null;
          await adapter.disconnect();

          if (!serverHash) return;

          const lastHash = this._lastServerHashes.get(pair.name);
          if (lastHash === undefined) {
            // First poll — record the hash without syncing
            this._lastServerHashes.set(pair.name, serverHash);
            return;
          }

          if (serverHash !== lastHash) {
            this.log(`Server change detected for: ${pair.name} — syncing`);
            this._lastServerHashes.set(pair.name, serverHash);
            await this._syncPair(pair).catch((err: Error) =>
              this.log(`Poll sync error: ${err.message}`)
            );
          }
        } catch (err) {
          await adapter.disconnect().catch(() => {});
          this.log(`Poll check error (${pair.name}): ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // Run once immediately to seed the baseline hash
      poll();
      this._pollTimers.push(setInterval(poll, intervalMs));
    }
  }

  stopPolling(): void {
    for (const t of this._pollTimers) clearInterval(t);
    this._pollTimers = [];
  }

  async _syncPair(pair: SyncPairConfig): Promise<void> {
    const status = this._pairStatus.get(pair.name)!;
    status.syncing = true;
    status.lastError = null;

    this.log(`\nSyncing pair: ${pair.name}`);
    this.log(`  Local:  ${pair.localPath}`);

    const adapter = this._createAdapter(pair.server);

    try {
      await adapter.connect();
      const engine = new SyncEngine(adapter, { log: this.log });
      const stats = await engine.sync(pair.localPath);
      status.lastStats = stats;
      status.lastSyncAt = new Date().toISOString();
      this.log(
        `  Done - uploaded: ${stats.uploaded}, downloaded: ${stats.downloaded}, ` +
        `deleted: ${stats.deleted}, skipped: ${stats.skipped}, dirs: ${stats.dirs}`
      );
      if (stats.conflicts.length > 0) {
        this.log(`  Conflicts: ${stats.conflicts.join(', ')}`);
      }
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      status.syncing = false;
      await adapter.disconnect();
    }

    // Scan disk for conflict files — this persists across multiple syncs
    await this._scanConflicts(pair);
  }

  private async _scanConflicts(pair: SyncPairConfig): Promise<void> {
    const conflictFiles: string[] = [];
    await this._findConflictFiles(pair.localPath, conflictFiles);

    // Rebuild conflict map for this pair from what's actually on disk
    for (const key of [...this._activeConflicts.keys()]) {
      if (key.startsWith(`${pair.name}:`)) this._activeConflicts.delete(key);
    }
    for (const conflictPath of conflictFiles) {
      const originalBase = path.basename(conflictPath).replace(/^sync-conflict-server\./, '');
      const localFilePath = path.join(path.dirname(conflictPath), originalBase);
      const relPath = path.relative(pair.localPath, localFilePath).replace(/\\/g, '/');
      this._activeConflicts.set(`${pair.name}:${relPath}`, {
        pairName: pair.name,
        relPath,
        localPath: localFilePath,
        conflictPath,
      });
    }
  }

  private async _findConflictFiles(dir: string, result: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this._findConflictFiles(fullPath, result);
      } else if (entry.name.startsWith('sync-conflict-server.')) {
        result.push(fullPath);
      }
    }
  }

  getConflicts(): ActiveConflict[] {
    return [...this._activeConflicts.values()];
  }

  async resolveConflict(pairName: string, relPath: string, keep: 'local' | 'server'): Promise<void> {
    const key = `${pairName}:${relPath}`;
    const conflict = this._activeConflicts.get(key);
    if (!conflict) throw new Error(`No active conflict: ${pairName}:${relPath}`);

    const pair = this.config.syncPairs.find(p => p.name === pairName);
    if (!pair) throw new Error(`No sync pair: ${pairName}`);

    if (keep === 'server') {
      // Replace local file with server version, then re-upload so server is consistent
      await fs.copy(conflict.conflictPath, conflict.localPath, { overwrite: true });
      const adapter = this._createAdapter(pair.server);
      try {
        await adapter.connect();
        await adapter.uploadFile(conflict.localPath, relPath);
      } finally {
        await adapter.disconnect();
      }
    }
    // keep === 'local': server already has local version (uploaded during conflict handling)

    await fs.remove(conflict.conflictPath);
    this._activeConflicts.delete(key);

    // Rebuild local hashes and sync to ensure consistent state
    await buildAllHashFiles(pair.localPath);
    await this._syncPair(pair);
  }

  _createAdapter(serverConfig: ServerConfig): BaseAdapter {
    switch (serverConfig.type) {
      case 'local':
        this.log(`  Server: ${serverConfig.path} (local)`);
        return new LocalAdapter(serverConfig.path);
      case 'ftp':
        this.log(`  Server: ftp://${serverConfig.host}${serverConfig.remotePath || '/'} (FTP)`);
        return new FtpAdapter(serverConfig);
      default: {
        const _exhaustive: never = serverConfig;
        throw new Error(`Unknown server type: "${(_exhaustive as ServerConfig).type}"`);
      }
    }
  }

  private _serverDesc(serverConfig: ServerConfig): string {
    if (serverConfig.type === 'local') return `local: ${serverConfig.path}`;
    return `ftp://${serverConfig.host}${serverConfig.remotePath || '/'}`;
  }
}

export default SyncClient;
