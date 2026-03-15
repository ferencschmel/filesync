import { AppConfig, SyncPairConfig, ServerConfig, PairStatus, InitStatus } from './types';
import BaseAdapter from './adapters/BaseAdapter';
import FileWatcher from './FileWatcher';
import LocalAdapter from './adapters/LocalAdapter';
import FtpAdapter from './adapters/FtpAdapter';
import SyncEngine from './SyncEngine';
import { buildAllHashFiles } from './HashManager';

interface SyncClientOptions {
  log?: (msg: string) => void;
}

class SyncClient {
  public config: AppConfig;
  public log: (msg: string) => void;
  private _watchers: FileWatcher[];
  private _pairStatus: Map<string, PairStatus>;
  private _initStatus: Map<string, InitStatus>;

  constructor(config: AppConfig, options: SyncClientOptions = {}) {
    this.config = config;
    this.log = options.log || ((msg: string) => console.log(`[synctool] ${msg}`));
    this._watchers = [];
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
    }
    this.log('Watchers started. Press Ctrl+C to stop.');
  }

  stopWatching(): void {
    for (const w of this._watchers) w.stop();
    this._watchers = [];
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
