export interface HashFileData {
  files: Record<string, string>;
  dirs: Record<string, string>;
  hash: string;
  updated: string;
}

export interface DirectoryEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deleted: number;
  skipped: number;
  conflicts: string[];
  dirs: number;
}

export interface LastState {
  syncedAt: string;
  hashes: Record<string, string>;
}

export interface LocalServerConfig {
  type: 'local';
  path: string;
}

export interface FtpServerConfig {
  type: 'ftp';
  host: string;
  port?: number;
  user: string;
  password: string;
  remotePath?: string;
  secure?: boolean;
}

export type ServerConfig = LocalServerConfig | FtpServerConfig;

export interface SyncPairConfig {
  name: string;
  localPath: string;
  server: ServerConfig;
}

export interface InitStatus {
  name: string;
  initializing: boolean;
  dirsProcessed: number;
  currentDir: string | null;
  lastInitAt: string | null;
  lastError: string | null;
}

export interface PairStatus {
  name: string;
  localPath: string;
  serverDesc: string;
  syncing: boolean;
  lastSyncAt: string | null;
  lastStats: SyncStats | null;
  lastError: string | null;
}

export interface AppConfig {
  syncPairs: SyncPairConfig[];
  autoSyncOnChange?: boolean;
  autoSyncDelay?: number;
  uiPort?: number;
}
