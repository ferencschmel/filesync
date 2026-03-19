import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { updateHashChain } from './HashManager';
import { HASH_FILE_NAME } from './constants';

interface FileWatcherOptions {
  debounceMs?: number;
  log?: (msg: string) => void;
  onChange?: (path: string) => void;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class FileWatcher {
  private rootPath: string;
  private debounceMs: number;
  private log: (msg: string) => void;
  private onChange: (path: string) => void;
  private _watcher: FSWatcher | null;
  private _pending: Map<string, NodeJS.Timeout>;

  constructor(rootPath: string, options: FileWatcherOptions = {}) {
    this.rootPath = rootPath;
    this.debounceMs = options.debounceMs ?? 2000;
    this.log = options.log || (() => {});
    this.onChange = options.onChange || (() => {});
    this._watcher = null;
    this._pending = new Map();
  }

  start(): void {
    // On Windows, chokidar's default fs.watch backend keeps directory handles open
    // via ReadDirectoryChangesW, which prevents folder deletion while the service runs.
    // Polling avoids holding any directory handles.
    const usePolling = process.platform === 'win32';

    this._watcher = chokidar.watch(this.rootPath, {
      ignored: [
        /(^|[/\\])\../,
        new RegExp(escapeRegex(HASH_FILE_NAME)),
        /sync-conflict-server\./,
      ],
      ignoreInitial: true,
      persistent: true,
      usePolling,
      interval: usePolling ? 2000 : undefined,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this._watcher
      .on('add',       (p: string) => this._schedule(p, 'add'))
      .on('change',    (p: string) => this._schedule(p, 'change'))
      .on('unlink',    (p: string) => this._schedule(p, 'unlink'))
      .on('addDir',    (p: string) => this._schedule(p, 'addDir'))
      .on('unlinkDir', (p: string) => this._schedule(p, 'unlinkDir'))
      .on('error',     (err: Error) => this.log(`Watcher error: ${err.message}`));

    this.log(`Watching: ${this.rootPath}`);
  }

  stop(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    for (const timer of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
  }

  private _schedule(filePath: string, event: string): void {
    const dir = event.endsWith('Dir') ? filePath : path.dirname(filePath);

    if (this._pending.has(dir)) clearTimeout(this._pending.get(dir)!);

    this._pending.set(dir, setTimeout(async () => {
      this._pending.delete(dir);
      await this._handleChange(filePath, event);
    }, this.debounceMs));
  }

  private async _handleChange(filePath: string, event: string): Promise<void> {
    this.log(`Detected ${event}: ${filePath}`);
    try {
      await updateHashChain(filePath, this.rootPath);
      this.log(`Hash chain updated for: ${filePath}`);
      this.onChange(filePath);
    } catch (err: unknown) {
      this.log(`Error updating hash chain: ${(err as Error).message}`);
    }
  }
}

export default FileWatcher;
