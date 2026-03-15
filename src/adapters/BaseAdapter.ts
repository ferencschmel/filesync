import { DirectoryEntry } from '../types';

abstract class BaseAdapter {
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract readFile(remotePath: string): Promise<Buffer | null>;
  abstract uploadFile(localPath: string, remotePath: string): Promise<void>;
  abstract downloadFile(remotePath: string, localPath: string): Promise<void>;
  abstract deleteFile(remotePath: string): Promise<void>;
  abstract deleteDir(remotePath: string): Promise<void>;
  abstract ensureDir(remotePath: string): Promise<void>;
  abstract listDir(remotePath: string): Promise<DirectoryEntry[]>;
}

export default BaseAdapter;
