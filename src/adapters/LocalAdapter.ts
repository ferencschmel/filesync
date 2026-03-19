import * as path from 'path';
import * as fs from 'fs-extra';
import { DirectoryEntry } from '../types';
import BaseAdapter from './BaseAdapter';

class LocalAdapter extends BaseAdapter {
  private serverRoot: string;

  constructor(serverRoot: string) {
    super();
    this.serverRoot = serverRoot;
  }

  private _abs(remotePath: string): string {
    return path.join(this.serverRoot, remotePath);
  }

  async connect(): Promise<void> {
    if (process.platform === 'win32') {
      const fwd = this.serverRoot.replace(/\\/g, '/');

      // UNC network paths (\\server\share) cannot be created by mkdir — the share
      // must already exist. fs.ensureDir recurses up to the UNC root (//?), which
      // is a virtual OS prefix and not a real directory, causing ENOENT.
      if (fwd.startsWith('//') && !fwd.startsWith('//?/')) {
        if (!await fs.pathExists(this.serverRoot)) {
          throw new Error(`Server path is not accessible: ${this.serverRoot}`);
        }
        return;
      }

      // Drive-letter paths (e.g. Z:\Backup\): verify the drive root is accessible
      // before calling ensureDir. Windows services run as SYSTEM and do not have
      // access to user-mapped drives. When the drive is missing, ensureDir walks up
      // to the extended-length path prefix (\\?) and throws a confusing ENOENT.
      const { root } = path.parse(this.serverRoot);
      if (root && !await fs.pathExists(root)) {
        const drive = root.replace(/[/\\]/g, '');
        throw new Error(
          `Drive "${drive}" is not accessible. User-mapped drives are not available ` +
          `to Windows services. Use a UNC path (e.g. \\\\server\\share\\Backup) instead.`
        );
      }
    }
    await fs.ensureDir(this.serverRoot);
  }

  async disconnect(): Promise<void> {}

  async readFile(remotePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this._abs(remotePath));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const dest = this._abs(remotePath);
    await fs.ensureDir(path.dirname(dest));
    await fs.copyFile(localPath, dest);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(localPath));
    await fs.copyFile(this._abs(remotePath), localPath);
  }

  async deleteFile(remotePath: string): Promise<void> {
    try {
      await fs.unlink(this._abs(remotePath));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await fs.rename(this._abs(fromPath), this._abs(toPath));
  }

  async deleteDir(remotePath: string): Promise<void> {
    try {
      await fs.rm(this._abs(remotePath), { recursive: true, force: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async ensureDir(remotePath: string): Promise<void> {
    await fs.ensureDir(this._abs(remotePath));
  }

  async listDir(remotePath: string): Promise<DirectoryEntry[]> {
    try {
      const entries = await fs.readdir(this._abs(remotePath), { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}

export default LocalAdapter;
