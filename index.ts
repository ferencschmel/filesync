#!/usr/bin/env node

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { Command } from 'commander';
import SyncClient from './src/SyncClient';
import WebServer from './src/WebServer';
import {
  installWindowsService, uninstallWindowsService,
  installLinuxService,   uninstallLinuxService,
} from './src/ServiceInstaller';
import { readHashFile } from './src/HashManager';
import { HASH_FILE_NAME } from './src/constants';
import { AppConfig } from './src/types';

const program = new Command();

program
  .name('synctool')
  .description('Hash-based serverless file/directory sync tool')
  .version('0.0.1');

program
  .option('-c, --config <path>', 'Path to config file', 'config.json');

program
  .command('init')
  .description('Build .synchash files for all configured local sync roots')
  .option('-p, --pair <name>', 'Only initialise a specific sync pair')
  .action(async (opts: { pair?: string }) => {
    const client = await loadClient(program.opts().config as string);
    const onProgress = (dir: string, count: number) => {
      process.stdout.write(`\r[synctool] Processed ${count} dirs... ${dir.slice(-60)}\x1b[K`);
    };
    await client.init(opts.pair, onProgress).catch(die);
    process.stdout.write('\n');
  });

program
  .command('sync')
  .description('Sync local files to the server (one-shot)')
  .option('-p, --pair <name>', 'Only sync a specific sync pair')
  .action(async (opts: { pair?: string }) => {
    const client = await loadClient(program.opts().config as string);
    await client.sync(opts.pair).catch(die);
  });

program
  .command('watch')
  .description('Watch for local changes and update hash files (optionally auto-sync)')
  .action(async () => {
    const client = await loadClient(program.opts().config as string);
    const ui = startWebUi(client);
    await client.watch();
    client.startPolling();
    process.on('SIGINT', () => {
      client.stopWatching();
      client.stopPolling();
      ui?.stop();
      console.log('\n[synctool] Stopped.');
      process.exit(0);
    });
  });

program
  .command('watch-sync')
  .description('Watch for changes and sync automatically on every change')
  .action(async () => {
    const rawConfig = await loadConfig(program.opts().config as string);
    rawConfig.autoSyncOnChange = true;
    const client = new SyncClient(rawConfig, { log: console.log });
    const ui = startWebUi(client);
    await client.watch();
    client.startPolling();
    process.on('SIGINT', () => {
      client.stopWatching();
      client.stopPolling();
      ui?.stop();
      console.log('\n[synctool] Stopped.');
      process.exit(0);
    });
  });

program
  .command('status')
  .description('Show sync status for all pairs (compares local vs server hash)')
  .action(async () => {
    const client = await loadClient(program.opts().config as string);
    for (const pair of client.config.syncPairs) {
      const localHash = await readHashFile(pair.localPath);
      if (!localHash) {
        console.log(`[${pair.name}] Not initialised (run "synctool init")`);
        continue;
      }
      const adapter = client._createAdapter(pair.server);
      try {
        await adapter.connect();
        const raw = await adapter.readFile(HASH_FILE_NAME);
        const serverHash = raw ? JSON.parse(raw.toString('utf8')) : null;
        if (!serverHash) {
          console.log(`[${pair.name}] Server not initialised (no hash file on server)`);
        } else if (serverHash.hash === localHash.hash) {
          console.log(`[${pair.name}] In sync`);
        } else {
          console.log(`[${pair.name}] Out of sync - run "synctool sync"`);
        }
      } finally {
        await adapter.disconnect();
      }
    }
  });

program
  .command('install-service')
  .description('Install synctool as a system service (Windows or Linux)')
  .requiredOption('-f, --config-file <path>', 'Path to config.json for the service')
  .option('--name <name>', 'Service name', 'synctool')
  .option('--exe <path>', 'Path to the synctool executable (defaults to this binary)')
  .action(async (opts: { configFile: string; name: string; exe?: string }) => {
    const platform = os.platform();
    const exePath = path.resolve(opts.exe ?? process.execPath);
    const installOpts = { configFile: opts.configFile, serviceName: opts.name, exePath };
    if (platform === 'win32') {
      await installWindowsService(installOpts).catch(die);
    } else if (platform === 'linux') {
      await installLinuxService(installOpts).catch(die);
    } else {
      die(`install-service is not supported on platform: ${platform}`);
    }
  });

program
  .command('uninstall-service')
  .description('Remove the synctool system service')
  .option('--name <name>', 'Service name', 'synctool')
  .option('--remove-data', 'Also remove installed binary and config files (Linux)')
  .action(async (opts: { name: string; removeData: boolean }) => {
    const platform = os.platform();
    const uninstallOpts = { serviceName: opts.name, removeData: opts.removeData ?? false };
    if (platform === 'win32') {
      await uninstallWindowsService(uninstallOpts).catch(die);
    } else if (platform === 'linux') {
      await uninstallLinuxService(uninstallOpts).catch(die);
    } else {
      die(`uninstall-service is not supported on platform: ${platform}`);
    }
  });

program.parse(process.argv);

async function loadConfig(configPath: string): Promise<AppConfig> {
  const resolved = path.resolve(configPath);
  if (!await fs.pathExists(resolved)) {
    die(`Config file not found: ${resolved}\nCopy config.example.json to config.json and edit it.`);
  }
  return fs.readJson(resolved) as Promise<AppConfig>;
}

async function loadClient(configPath: string): Promise<SyncClient> {
  const config = await loadConfig(configPath);
  return new SyncClient(config, { log: console.log });
}

function startWebUi(client: SyncClient): WebServer | null {
  if (!client.config.uiPort) return null;
  const ui = new WebServer(client, client.config.uiPort);
  ui.start();
  return ui;
}

function die(msg: string | Error): never {
  console.error(typeof msg === 'string' ? `[synctool] Error: ${msg}` : msg);
  process.exit(1);
}
