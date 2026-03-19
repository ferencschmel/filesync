import * as http from 'http';
import SyncClient from './SyncClient';

const MAX_LOG_LINES = 500;

class WebServer {
  private _client: SyncClient;
  private _port: number;
  private _server: http.Server | null = null;
  private _logs: string[] = [];
  private _originalLog: (msg: string) => void;

  constructor(client: SyncClient, port: number) {
    this._client = client;
    this._port = port;
    this._originalLog = client.log;

    // Intercept all log messages so we can display them in the UI
    client.log = (msg: string) => {
      this._originalLog(msg);
      this._logs.push(`${new Date().toISOString().substring(11, 19)} ${msg}`);
      if (this._logs.length > MAX_LOG_LINES) this._logs.shift();
    };
  }

  start(): void {
    this._server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${this._port}`);

      if (req.method === 'GET' && url.pathname === '/api/status') {
        this._sendJson(res, this._client.getStatus());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/init-status') {
        this._sendJson(res, this._client.getInitStatus());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        this._sendJson(res, this._logs);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const pair = url.searchParams.get('pair') ?? undefined;
        this._client.sync(pair).catch(err =>
          this._client.log(`Sync error: ${err instanceof Error ? err.message : String(err)}`)
        );
        this._sendJson(res, { triggered: true, pair: pair ?? 'all' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/conflicts') {
        this._sendJson(res, this._client.getConflicts());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/resolve-conflict') {
        const pair = url.searchParams.get('pair');
        const relPath = url.searchParams.get('relPath');
        const keep = url.searchParams.get('keep') as 'local' | 'server' | null;
        if (!pair || !relPath || (keep !== 'local' && keep !== 'server')) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing or invalid pair, relPath, or keep param');
          return;
        }
        this._client.resolveConflict(pair, relPath, keep)
          .then(() => this._sendJson(res, { ok: true }))
          .catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/init') {
        const pair = url.searchParams.get('pair') ?? undefined;
        this._client.init(pair).catch(err =>
          this._client.log(`Init error: ${err instanceof Error ? err.message : String(err)}`)
        );
        this._sendJson(res, { triggered: true, pair: pair ?? 'all' });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this._renderHtml());
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    this._server.listen(this._port, () => {
      this._client.log(`Web UI available at http://localhost:${this._port}`);
    });
  }

  stop(): void {
    this._server?.close();
    this._client.log = this._originalLog;
  }

  private _sendJson(res: http.ServerResponse, data: unknown): void {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  private _renderHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>syncTool</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f4f5; color: #18181b; }
    header { background: #18181b; color: #fafafa; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 1.2rem; font-weight: 600; }
    header .version { font-size: 0.75rem; opacity: 0.5; }
    main { max-width: 1100px; margin: 24px auto; padding: 0 16px; display: grid; gap: 24px; }
    section { background: #fff; border-radius: 8px; border: 1px solid #e4e4e7; overflow: hidden; }
    section h2 { padding: 14px 20px; font-size: 0.85rem; font-weight: 600; text-transform: uppercase;
                 letter-spacing: 0.05em; border-bottom: 1px solid #e4e4e7; color: #71717a; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; padding: 10px 20px; font-size: 0.75rem; font-weight: 600;
         text-transform: uppercase; letter-spacing: 0.04em; color: #71717a;
         border-bottom: 1px solid #e4e4e7; background: #fafafa; }
    td { padding: 10px 20px; border-bottom: 1px solid #f4f4f5; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
    .badge-ok   { background: #dcfce7; color: #166534; }
    .badge-err  { background: #fee2e2; color: #991b1b; }
    .badge-busy { background: #fef9c3; color: #854d0e; }
    .badge-idle { background: #f4f4f5; color: #71717a; }
    .badge-conflict { background: #fff7ed; color: #9a3412; }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .conflict-row td { vertical-align: middle; }
    .conflict-path { font-family: monospace; font-size: 0.82rem; color: #18181b; }
    .conflict-pair { font-size: 0.75rem; color: #71717a; }
    .conflict-links { display: flex; gap: 12px; margin-top: 4px; font-size: 0.75rem; }
    .conflict-links a { color: #2563eb; text-decoration: none; }
    .conflict-links a:hover { text-decoration: underline; }
    .no-conflicts { padding: 20px; font-size: 0.85rem; color: #71717a; text-align: center; }
    button { padding: 6px 14px; border-radius: 6px; border: 1px solid #d4d4d8; background: #18181b;
             color: #fafafa; font-size: 0.8rem; cursor: pointer; white-space: nowrap; }
    button:hover { background: #3f3f46; }
    button.secondary { background: #fff; color: #18181b; }
    button.secondary:hover { background: #f4f4f5; }
    .actions { padding: 14px 20px; display: flex; gap: 8px; border-top: 1px solid #e4e4e7; }
    .stats { font-size: 0.8rem; color: #52525b; }
    .progress { font-size: 0.75rem; color: #854d0e; max-width: 280px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #logbox { font-family: monospace; font-size: 0.8rem; background: #18181b; color: #a3e635;
              padding: 16px; height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
    .meta { padding: 10px 20px; font-size: 0.75rem; color: #a1a1aa; border-top: 1px solid #e4e4e7; }
  </style>
</head>
<body>
<header>
  <h1>syncTool</h1>
  <span class="version">Dashboard v.1.0.0</span>
</header>
<main>
  <section>
    <h2>Sync Pairs</h2>
    <table><tbody id="pairs-body"></tbody></table>
    <div class="actions">
      <button onclick="triggerSync()">Sync all</button>
      <button class="secondary" onclick="triggerInit()">Initialise all</button>
    </div>
  </section>
  <section id="conflicts-section">
    <h2>Conflicts</h2>
    <div id="conflicts-body"><p class="no-conflicts">No active conflicts</p></div>
  </section>
  <section>
    <h2>Log</h2>
    <div id="logbox"></div>
    <div class="meta" id="last-refresh">Refreshing every 3 s</div>
  </section>
</main>
<script>
  const HEADERS = '<tr><th>Name</th><th>Local path</th><th>Server</th><th>Sync status</th><th>Last sync</th><th>Sync stats</th><th>Init status</th><th>Dirs</th><th></th></tr>';

  function fmt(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }
  function statsText(s) {
    if (!s) return '—';
    const parts = [];
    if (s.uploaded)                    parts.push('\u2191' + s.uploaded + ' up');
    if (s.downloaded)                  parts.push('\u2193' + s.downloaded + ' down');
    if (s.deleted)                     parts.push(s.deleted + ' del');
    if (s.skipped)                     parts.push(s.skipped + ' skip');
    if (s.conflicts && s.conflicts.length) parts.push(s.conflicts.length + ' conflict');
    return parts.length ? parts.join(' · ') : 'no changes';
  }
  function syncBadge(s) {
    if (s.syncing)    return '<span class="badge badge-busy">Syncing\u2026</span>';
    if (s.lastError)  return '<span class="badge badge-err" title="' + esc(s.lastError) + '">Error</span>';
    if (s.lastSyncAt) return '<span class="badge badge-ok">OK</span>';
    return '<span class="badge badge-idle">Never synced</span>';
  }
  function initBadge(i) {
    if (i.initializing) return '<span class="badge badge-busy">Running\u2026</span>';
    if (i.lastError)    return '<span class="badge badge-err" title="' + esc(i.lastError) + '">Error</span>';
    if (i.lastInitAt)   return '<span class="badge badge-ok">Done</span>';
    return '<span class="badge badge-idle">Not run</span>';
  }
  function esc(s) { return String(s).replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

  function triggerSync(pair) {
    fetch('/api/sync' + (pair ? '?pair=' + encodeURIComponent(pair) : ''), { method: 'POST' })
      .then(() => refresh());
  }
  function triggerInit(pair) {
    fetch('/api/init' + (pair ? '?pair=' + encodeURIComponent(pair) : ''), { method: 'POST' })
      .then(() => refresh());
  }

  function resolveConflict(pair, relPath, keep) {
    const params = new URLSearchParams({ pair, relPath, keep });
    fetch('/api/resolve-conflict?' + params, { method: 'POST' })
      .then(r => r.json())
      .then(result => {
        if (result.error) { alert('Error: ' + result.error); }
        refresh();
      });
  }

  function refresh() {
    Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/init-status').then(r => r.json()),
    ]).then(([syncList, initList]) => {
      const initMap = {};
      initList.forEach(i => { initMap[i.name] = i; });

      const rows = syncList.map(s => {
        const i = initMap[s.name] || {};
        const progressCell = i.initializing && i.currentDir
          ? '<div class="progress" title="' + esc(i.currentDir) + '">' + esc(i.currentDir.split(/[\\\\/]/).pop()) + '</div>'
          : '';
        return \`<tr>
          <td><strong>\${esc(s.name)}</strong></td>
          <td class="stats">\${esc(s.localPath)}</td>
          <td class="stats">\${esc(s.serverDesc)}</td>
          <td>\${syncBadge(s)}</td>
          <td class="stats">\${fmt(s.lastSyncAt)}</td>
          <td class="stats">\${statsText(s.lastStats)}</td>
          <td>\${initBadge(i)}\${progressCell}</td>
          <td class="stats">\${i.dirsProcessed || '—'}</td>
          <td><div class="btn-row">
            <button onclick="triggerSync('\${esc(s.name)}')">Sync</button>
            <button class="secondary" onclick="triggerInit('\${esc(s.name)}')">Init</button>
          </div></td>
        </tr>\`;
      }).join('');
      document.getElementById('pairs-body').innerHTML = HEADERS + rows;
    });

    fetch('/api/conflicts').then(r => r.json()).then(conflicts => {
      const body = document.getElementById('conflicts-body');
      if (!conflicts.length) {
        body.innerHTML = '<p class="no-conflicts">No active conflicts</p>';
        return;
      }
      const rows = conflicts.map(c => \`<tr class="conflict-row">
        <td><span class="conflict-pair">\${esc(c.pairName)}</span></td>
        <td>
          <span class="conflict-path">\${esc(c.relPath)}</span>
          <div class="conflict-links">
            <a href="file://\${esc(c.localPath)}" title="\${esc(c.localPath)}">&#128196; local version</a>
            <a href="file://\${esc(c.conflictPath)}" title="\${esc(c.conflictPath)}">&#128196; server version</a>
          </div>
        </td>
        <td><div class="btn-row">
          <button onclick="resolveConflict('\${esc(c.pairName)}','\${esc(c.relPath)}','local')">Keep local</button>
          <button class="secondary" onclick="resolveConflict('\${esc(c.pairName)}','\${esc(c.relPath)}','server')">Keep server</button>
        </div></td>
      </tr>\`).join('');
      const header = '<tr><th>Pair</th><th>File</th><th></th></tr>';
      body.innerHTML = '<table>' + header + rows + '</table>';
    });

    fetch('/api/logs').then(r => r.json()).then(lines => {
      const box = document.getElementById('logbox');
      box.textContent = lines.join('\\n');
      box.scrollTop = box.scrollHeight;
    });

    document.getElementById('last-refresh').textContent =
      'Last refreshed: ' + new Date().toLocaleTimeString();
  }

  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>`;
  }
}

export default WebServer;
