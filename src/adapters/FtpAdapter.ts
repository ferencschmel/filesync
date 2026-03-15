import { Client } from 'basic-ftp';
import { Writable } from 'stream';
import * as fs from 'fs-extra';
import * as path from 'path';
import { FtpServerConfig, DirectoryEntry } from '../types';
import BaseAdapter from './BaseAdapter';

function isFtpNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string };
  return e.code === 550 || (typeof e.message === 'string' && e.message.includes('550'));
}

function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

class FtpAdapter extends BaseAdapter {
  private config: FtpServerConfig;
  private client: Client;
  private remotePath: string;

  constructor(config: FtpServerConfig) {
    super();
    this.config = config;
    this.client = new Client();
    this.remotePath = config.remotePath || '/';
  }

  private _abs(remotePath: string): string {
    return posixJoin(this.remotePath, remotePath);
  }

  async connect(): Promise<void> {
    await this.client.access({
      host: this.config.host,
      port: this.config.port || 21,
      user: this.config.user,
      password: this.config.password,
      secure: this.config.secure || false,
    });
    await this.client.ensureDir(this.remotePath);
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }

  async readFile(remotePath: string): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });
    try {
      await this.client.downloadTo(writable, this._abs(remotePath));
      return Buffer.concat(chunks);
    } catch (err: unknown) {
      if (isFtpNotFound(err)) return null;
      throw err;
    }
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const remote = this._abs(remotePath);
    await this.client.ensureDir(posixDirname(remote));
    await this.client.cd(this.remotePath);
    await this.client.uploadFrom(localPath, remote);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(localPath));
    await this.client.downloadTo(localPath, this._abs(remotePath));
  }

  async deleteFile(remotePath: string): Promise<void> {
    try {
      await this.client.remove(this._abs(remotePath));
    } catch (err: unknown) {
      if (!isFtpNotFound(err)) throw err;
    }
  }

  async deleteDir(remotePath: string): Promise<void> {
    try {
      await this.client.removeDir(this._abs(remotePath));
    } catch (err: unknown) {
      if (!isFtpNotFound(err)) throw err;
    }
  }

  async ensureDir(remotePath: string): Promise<void> {
    await this.client.ensureDir(this._abs(remotePath));
    await this.client.cd(this.remotePath);
  }

  async listDir(remotePath: string): Promise<DirectoryEntry[]> {
    try {
      const list = await this.client.list(this._abs(remotePath));
      return list.map(e => ({
        name: e.name,
        isFile: e.isFile,
        isDirectory: e.isDirectory,
      }));
    } catch (err: unknown) {
      if (isFtpNotFound(err)) return [];
      throw err;
    }
  }
}

export default FtpAdapter;
