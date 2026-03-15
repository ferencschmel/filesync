import { AppConfig, SyncPairConfig, ServerConfig } from './types';
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
  private log: (msg: string) => void;
  private _watchers: FileWatcher[];

  constructor(config: AppConfig, options: SyncClientOptions = {}) {
    this.config = config;
    this.log = options.log || ((msg: string) => console.log(`[synctool] ${msg}`));
    this._watchers = [];
  }

  async init(): Promise<void> {
    for (const pair of this.config.syncPairs) {
      this.log(`Initialising hash files for: ${pair.name} (${pair.localPath})`);
      await buildAllHashFiles(pair.localPath);
      this.log(`Done: ${pair.name}`);
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

  private async _syncPair(pair: SyncPairConfig): Promise<void> {
    this.log(`\nSyncing pair: ${pair.name}`);
    this.log(`  Local:  ${pair.localPath}`);

    const adapter = this._createAdapter(pair.server);

    try {
      await adapter.connect();
      const engine = new SyncEngine(adapter, { log: this.log });
      const stats = await engine.sync(pair.localPath);
      this.log(
        `  Done - uploaded: ${stats.uploaded}, deleted: ${stats.deleted}, ` +
        `skipped: ${stats.skipped}, dirs: ${stats.dirs}`
      );
    } finally {
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
}

export default SyncClient;
