# syncTool

A serverless file/directory sync tool for Windows, macOS, and Linux. Uses SHA-256 hash chains for efficient change detection and a three-way merge strategy for reliable bidirectional sync.

## How it works

Each directory contains a `.synchash` file that stores hashes of all files and subdirectory hash-files. This allows top-down change detection — if the root hash matches, nothing has changed and the sync is skipped entirely.

A local `.synclaststate` file records the hashes at the time of the last sync. This enables three-way merge logic:

| Local | Last synced | Server | Action |
|-------|-------------|--------|--------|
| A | A | A | Nothing (in sync) |
| A | B | B | Upload (local changed) |
| A | A | B | Download (server changed) |
| A | B | C | Conflict (save server copy as `.sync-conflict-server`) |

Directories deleted locally (that were previously synced) are deleted on the server. Directories present on the server but never synced locally are downloaded.

## Installation

### From source

```bash
npm install
npm run build
node dist/index.js --help
```

### Standalone executables

Pre-built executables require no Node.js installation:

```bash
# Windows
synctool-win-x64.exe <command>

# macOS (Apple Silicon)
./synctool-macos-arm64 <command>

# macOS (Intel)
./synctool-macos-x64 <command>

# Linux
./synctool-linux-x64 <command>
```

## Configuration

Create a `config.json` in your working directory. Two server types are supported: `local` (mapped drive or network share) and `ftp`.

### Local / mapped drive

```json
{
  "syncPairs": [
    {
      "name": "documents",
      "localPath": "/Users/alice/Documents/project",
      "server": {
        "type": "local",
        "path": "/Volumes/NAS/project"
      }
    }
  ]
}
```

### FTP

```json
{
  "syncPairs": [
    {
      "name": "website",
      "localPath": "/Users/alice/sites/mysite",
      "server": {
        "type": "ftp",
        "host": "ftp.example.com",
        "port": 21,
        "user": "ftpuser",
        "password": "secret",
        "remotePath": "/public_html",
        "secure": false
      }
    }
  ]
}
```

### Multiple sync pairs

```json
{
  "syncPairs": [
    {
      "name": "docs",
      "localPath": "/Users/alice/docs",
      "server": { "type": "local", "path": "/Volumes/NAS/docs" }
    },
    {
      "name": "assets",
      "localPath": "/Users/alice/assets",
      "server": {
        "type": "ftp",
        "host": "ftp.example.com",
        "user": "ftpuser",
        "password": "secret",
        "remotePath": "/assets"
      }
    }
  ],
  "autoSyncDelay": 2000
}
```

### Config options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `syncPairs` | array | required | List of sync pairs (see above) |
| `autoSyncOnChange` | boolean | `false` | Sync automatically when a file change is detected (used by `watch-sync`) |
| `autoSyncDelay` | number | `1000` | Milliseconds to debounce file-change events before acting |
| `uiPort` | number | — | When set, starts a web dashboard on this port while `watch` or `watch-sync` is running |

### Using a custom config path

All commands accept `-c` / `--config` to point at a different config file:

```bash
node dist/index.js -c /path/to/myconfig.json sync
```

## Commands

### `init` — build local hash files

Scans the local directory and builds `.synchash` files. Run this once before the first sync.

```bash
node dist/index.js init
node dist/index.js init --pair docs        # only one pair
```

### `sync` — one-shot sync

Compares local and server state, uploads/downloads changes, resolves conflicts.

```bash
node dist/index.js sync
node dist/index.js sync --pair docs        # only one pair
```

### `watch` — watch for local changes

Monitors local directories with `chokidar` and keeps `.synchash` files up to date as files change. Does **not** sync automatically; run `sync` manually when ready.

```bash
node dist/index.js watch
```

Press `Ctrl+C` to stop.

### `watch-sync` — watch and auto-sync

Like `watch`, but triggers a full sync automatically after each change (respects `autoSyncDelay`).

```bash
node dist/index.js watch-sync
```

Press `Ctrl+C` to stop.

## Web UI

Add `uiPort` to your config to enable the web dashboard when running `watch` or `watch-sync`:

```json
{
  "uiPort": 8080,
  "syncPairs": [ ... ]
}
```

Open `http://localhost:8080` in a browser. The dashboard shows:

- Each sync pair with its status, last sync time, and file counts (uploaded / downloaded / deleted / skipped)
- A **Sync** button per pair and a **Sync all** button to trigger an immediate sync
- A live log window that auto-refreshes every 5 seconds

The dashboard also exposes a simple REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | JSON array of all pair statuses |
| `GET` | `/api/logs` | JSON array of recent log lines |
| `POST` | `/api/sync` | Trigger sync for all pairs |
| `POST` | `/api/sync?pair=<name>` | Trigger sync for one pair |

### `status` — check sync state

Compares the local root hash against the server root hash and reports whether each pair is in sync.

```bash
node dist/index.js status
```

Example output:
```
[docs]   In sync
[assets] Out of sync - run "synctool sync"
[other]  Not initialised (run "synctool init")
```

## Typical workflow

```bash
# 1. Create config.json
# 2. Build initial hash files
node dist/index.js init

# 3. Run a sync
node dist/index.js sync

# 4. Keep syncing automatically while working
node dist/index.js watch-sync
```

## Conflict handling

When the same file is modified both locally and on the server since the last sync, synctool:

1. Downloads the server version and saves it alongside the original as `sync-conflict-server.filename.ext`
2. Uploads the local version to the server
3. Logs the conflict path

Review and manually merge the `.sync-conflict-server` copy, then delete it and run `sync` again.

## Internal files

These files are created by synctool and should not be edited manually:

| File | Location | Purpose |
|------|----------|---------|
| `.synchash` | Every synced directory | Hash of all files and subdirectories in that folder |
| `.synclaststate` | Local root of each sync pair | Records hashes at the time of the last sync (three-way merge base) |

Add both to `.gitignore` if the sync root is also a git repository:

```
.synchash
.synclaststate
sync-conflict-server.*
```

## Building standalone executables

```bash
npm run build
npm run package:win        # release/synctool-win-x64.exe
npm run package:mac-arm64  # release/synctool-macos-arm64
npm run package:mac-x64    # release/synctool-macos-x64
npm run package:linux      # release/synctool-linux-x64
npm run package:all        # all four at once
```

## Running tests

```bash
npm test                   # run all tests
npm run test:coverage      # with coverage report
```
