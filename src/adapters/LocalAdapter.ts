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
