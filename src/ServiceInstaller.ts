import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface InstallOptions {
  configFile: string;
  serviceName: string;
  exePath: string;        // resolved path to the running binary
}

export interface UninstallOptions {
  serviceName: string;
  removeData: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────

function run(cmd: string): void {
  execSync(cmd, { stdio: 'inherit' });
}

function runSilent(cmd: string): boolean {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

function nssmAvailable(): boolean {
  return runSilent('nssm version');
}

// ── Windows ────────────────────────────────────────────────────────────────

export async function installWindowsService(opts: InstallOptions): Promise<void> {
  if (!nssmAvailable()) {
    throw new Error(
      'NSSM is not installed or not in PATH.\n' +
      '  Install with Chocolatey : choco install nssm\n' +
      '  Or download from        : https://nssm.cc/download'
    );
  }

  const { serviceName, exePath, configFile } = opts;
  const configAbsolute = path.resolve(configFile);
  const workDir        = path.dirname(configAbsolute);
  const logDir         = path.join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'synctool', 'logs');

  // Remove existing installation
  if (runSilent(`sc.exe query "${serviceName}"`)) {
    console.log(`Service '${serviceName}' already exists — stopping and reconfiguring...`);
    runSilent(`net stop "${serviceName}"`);
    run(`nssm remove "${serviceName}" confirm`);
  }

  await fs.ensureDir(logDir);

  const args = `watch-sync --config "${configAbsolute}"`;
  run(`nssm install "${serviceName}" "${exePath}"`);
  run(`nssm set "${serviceName}" AppParameters ${args}`);
  run(`nssm set "${serviceName}" AppDirectory "${workDir}"`);
  run(`nssm set "${serviceName}" DisplayName "syncTool File Sync"`);
  run(`nssm set "${serviceName}" Description "Hash-based serverless file sync daemon"`);
  run(`nssm set "${serviceName}" Start SERVICE_AUTO_START`);
  run(`nssm set "${serviceName}" AppStdout "${path.join(logDir, 'stdout.log')}"`);
  run(`nssm set "${serviceName}" AppStderr "${path.join(logDir, 'stderr.log')}"`);
  run(`nssm set "${serviceName}" AppRotateFiles 1`);
  run(`nssm set "${serviceName}" AppRotateBytes 10485760`);
  run(`nssm set "${serviceName}" AppExit Default Restart`);
  run(`nssm set "${serviceName}" AppRestartDelay 5000`);
  run(`net start "${serviceName}"`);

  console.log(`\nService '${serviceName}' installed and started.`);
  console.log(`  Binary : ${exePath}`);
  console.log(`  Config : ${configAbsolute}`);
  console.log(`  Logs   : ${logDir}`);
  console.log(`\n  Stop    : net stop ${serviceName}`);
  console.log(`  Start   : net start ${serviceName}`);
  console.log(`  Remove  : ${path.basename(exePath)} uninstall-service --name ${serviceName}`);
}

export async function uninstallWindowsService(opts: UninstallOptions): Promise<void> {
  const { serviceName, removeData } = opts;

  runSilent(`net stop "${serviceName}"`);

  const removed = nssmAvailable()
    ? runSilent(`nssm remove "${serviceName}" confirm`)
    : runSilent(`sc.exe delete "${serviceName}"`);

  if (!removed) {
    throw new Error(`Could not remove service '${serviceName}'. Is it installed?`);
  }

  if (removeData) {
    const dataDir = path.join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'synctool');
    await fs.remove(dataDir);
    console.log(`Removed ${dataDir}`);
  }

  console.log(`Service '${serviceName}' removed.`);
}

// ── Linux ──────────────────────────────────────────────────────────────────

function requireRoot(): void {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Must be run as root. Try: sudo ' + process.argv.join(' '));
  }
}

export async function installLinuxService(opts: InstallOptions): Promise<void> {
  requireRoot();

  const { serviceName, exePath, configFile } = opts;
  const configAbsolute = path.resolve(configFile);
  const installBin     = `/opt/synctool/${path.basename(exePath)}`;
  const installCfgDir  = '/etc/synctool';
  const installCfg     = `${installCfgDir}/config.json`;
  const serviceFile    = `/etc/systemd/system/${serviceName}.service`;
  const serviceUser    = serviceName;

  // Create dedicated system user
  if (!runSilent(`id -u ${serviceUser}`)) {
    console.log(`Creating system user '${serviceUser}'...`);
    run(`useradd --system --no-create-home --shell /sbin/nologin ${serviceUser}`);
  }

  // Install binary
  console.log(`Installing binary to ${installBin}...`);
  await fs.ensureDir(path.dirname(installBin));
  await fs.copy(exePath, installBin, { overwrite: true });
  run(`chmod 755 "${installBin}"`);
  run(`chown root:root "${installBin}"`);

  // Install config
  await fs.ensureDir(installCfgDir);
  const srcConfig = path.resolve(configAbsolute);
  if (await fs.pathExists(srcConfig)) {
    if (srcConfig !== path.resolve(installCfg)) {
      await fs.copy(srcConfig, installCfg, { overwrite: true });
    }
  } else {
    console.warn(`Warning: '${srcConfig}' not found. Copy config.json to ${installCfg} before starting the service.`);
  }

  run(`chown -R ${serviceUser}:${serviceUser} "${installCfgDir}"`);
  run(`chown -R ${serviceUser}:${serviceUser} "${path.dirname(installBin)}"`);

  // Write systemd unit
  const instDir = path.dirname(installBin);
  const unit = [
    '[Unit]',
    'Description=syncTool - Hash-based file sync daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${installBin} watch-sync --config ${installCfg}`,
    `WorkingDirectory=${installCfgDir}`,
    `User=${serviceUser}`,
    `Group=${serviceUser}`,
    'Restart=on-failure',
    'RestartSec=5s',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${serviceName}`,
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    `ReadWritePaths=${installCfgDir} ${instDir}`,
    'PrivateTmp=true',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  await fs.writeFile(serviceFile, unit, 'utf8');
  console.log(`Written ${serviceFile}`);

  run('systemctl daemon-reload');
  run(`systemctl enable ${serviceName}`);
  run(`systemctl restart ${serviceName}`);

  console.log(`\nService '${serviceName}' installed and started.`);
  console.log(`  Binary : ${installBin}`);
  console.log(`  Config : ${installCfg}`);
  console.log(`  Logs   : journalctl -u ${serviceName} -f`);
  console.log(`\n  Stop    : systemctl stop ${serviceName}`);
  console.log(`  Restart : systemctl restart ${serviceName}`);
  console.log(`  Remove  : sudo ${installBin} uninstall-service --name ${serviceName}`);
}

export async function uninstallLinuxService(opts: UninstallOptions): Promise<void> {
  requireRoot();

  const { serviceName, removeData } = opts;
  const serviceFile = `/etc/systemd/system/${serviceName}.service`;

  runSilent(`systemctl stop ${serviceName}`);
  runSilent(`systemctl disable ${serviceName}`);

  if (await fs.pathExists(serviceFile)) {
    await fs.remove(serviceFile);
    run('systemctl daemon-reload');
    console.log(`Removed ${serviceFile}`);
  } else {
    console.warn(`Service file not found: ${serviceFile}`);
  }

  if (removeData) {
    await fs.remove('/opt/synctool');
    await fs.remove('/etc/synctool');
    console.log('Removed /opt/synctool and /etc/synctool');
  }

  console.log(`Service '${serviceName}' removed.`);
}
