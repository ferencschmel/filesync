import * as http from 'http';
import * as net from 'net';
import WebServer from '../src/WebServer';
import SyncClient from '../src/SyncClient';
import { PairStatus, InitStatus, ActiveConflict } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

interface TestResponse {
  status: number;
  contentType: string;
  body: string;
  json<T = unknown>(): T;
}

function httpRequest(method: 'GET' | 'POST', path: string, port: number): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path, method }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          contentType: String(res.headers['content-type'] ?? ''),
          body,
          json<T>() { return JSON.parse(body) as T; },
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const get  = (path: string, port: number) => httpRequest('GET',  path, port);
const post = (path: string, port: number) => httpRequest('POST', path, port);

function makeClient() {
  const originalLog = jest.fn() as jest.MockedFunction<(msg: string) => void>;
  const mocks = {
    log: originalLog as (msg: string) => void,
    getStatus:       jest.fn().mockReturnValue([] as PairStatus[]),
    getInitStatus:   jest.fn().mockReturnValue([] as InitStatus[]),
    getConflicts:    jest.fn().mockReturnValue([] as ActiveConflict[]),
    sync:            jest.fn().mockResolvedValue(undefined),
    init:            jest.fn().mockResolvedValue(undefined),
    resolveConflict: jest.fn().mockResolvedValue(undefined),
  };
  return { client: mocks as unknown as SyncClient, originalLog, mocks };
}

async function startServer(client: SyncClient, port: number): Promise<WebServer> {
  const server = new WebServer(client, port);
  server.start();
  await new Promise(r => setTimeout(r, 50));
  return server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebServer', () => {
  let port: number;
  let client: SyncClient;
  let originalLog: jest.MockedFunction<(msg: string) => void>;
  let mocks: ReturnType<typeof makeClient>['mocks'];
  let server: WebServer;

  beforeEach(async () => {
    port = await getFreePort();
    ({ client, originalLog, mocks } = makeClient());
    server = await startServer(client, port);
  });

  afterEach(() => {
    try { server.stop(); } catch { /* ignore double-stop */ }
  });

  // ── constructor / log interception ─────────────────────────────────────────

  describe('log interception', () => {
    it('intercepts client.log and forwards to the original function', () => {
      client.log('test message');
      expect(originalLog).toHaveBeenCalledWith('test message');
    });

    it('accumulated log lines include the time-prefixed message', async () => {
      client.log('my log entry');
      const res = await get('/api/logs', port);
      const logs = res.json<string[]>();
      expect(logs.some(l => l.includes('my log entry'))).toBe(true);
    });

    it('stop() restores the original log function', () => {
      server.stop();
      expect(client.log).toBe(originalLog);
    });

    it('caps log buffer at 500 lines', () => {
      for (let i = 0; i < 510; i++) client.log(`line ${i}`);
      // Access private field via cast to verify internal cap
      const logs = (server as unknown as { _logs: string[] })._logs;
      expect(logs.length).toBe(500);
    });
  });

  // ── GET /api/status ────────────────────────────────────────────────────────

  describe('GET /api/status', () => {
    it('returns 200 with application/json content-type', async () => {
      const res = await get('/api/status', port);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain('application/json');
    });

    it('returns data from getStatus()', async () => {
      const data: PairStatus[] = [
        {
          name: 'Pair1', localPath: '/local', serverDesc: 'local:/srv',
          syncing: false, lastSyncAt: null, lastStats: null, lastError: null,
        },
      ];
      mocks.getStatus.mockReturnValue(data);

      const res = await get('/api/status', port);
      expect(res.json()).toEqual(data);
      expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /api/init-status ───────────────────────────────────────────────────

  describe('GET /api/init-status', () => {
    it('returns 200 and calls getInitStatus()', async () => {
      const data: InitStatus[] = [
        {
          name: 'Pair1', initializing: false, dirsProcessed: 5,
          currentDir: null, lastInitAt: '2024-01-01T00:00:00.000Z', lastError: null,
        },
      ];
      mocks.getInitStatus.mockReturnValue(data);

      const res = await get('/api/init-status', port);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual(data);
      expect(mocks.getInitStatus).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /api/logs ──────────────────────────────────────────────────────────

  describe('GET /api/logs', () => {
    it('returns an empty array initially', async () => {
      const res = await get('/api/logs', port);
      expect(res.status).toBe(200);
      // The server logs one message on start ("Web UI available at...")
      expect(Array.isArray(res.json())).toBe(true);
    });

    it('returns multiple log lines in order', async () => {
      client.log('alpha');
      client.log('beta');

      const res = await get('/api/logs', port);
      const logs = res.json<string[]>();
      const lastTwo = logs.slice(-2);
      expect(lastTwo[0]).toContain('alpha');
      expect(lastTwo[1]).toContain('beta');
    });
  });

  // ── POST /api/sync ─────────────────────────────────────────────────────────

  describe('POST /api/sync', () => {
    it('responds immediately with triggered:true and pair:all when no pair param', async () => {
      const res = await post('/api/sync', port);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ triggered: true, pair: 'all' });
      expect(mocks.sync).toHaveBeenCalledWith(undefined);
    });

    it('passes the pair query param to sync()', async () => {
      const res = await post('/api/sync?pair=MyPair', port);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ triggered: true, pair: 'MyPair' });
      expect(mocks.sync).toHaveBeenCalledWith('MyPair');
    });
  });

  // ── GET /api/conflicts ─────────────────────────────────────────────────────

  describe('GET /api/conflicts', () => {
    it('returns an empty array when no conflicts', async () => {
      const res = await get('/api/conflicts', port);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns conflict data from getConflicts()', async () => {
      const conflict: ActiveConflict = {
        pairName: 'Pair1',
        relPath: 'docs/notes.txt',
        localPath: '/local/docs/notes.txt',
        conflictPath: '/local/docs/sync-conflict-server.notes.txt',
      };
      mocks.getConflicts.mockReturnValue([conflict]);

      const res = await get('/api/conflicts', port);
      expect(res.json()).toEqual([conflict]);
      expect(mocks.getConflicts).toHaveBeenCalledTimes(1);
    });
  });

  // ── POST /api/resolve-conflict ─────────────────────────────────────────────

  describe('POST /api/resolve-conflict', () => {
    it('calls resolveConflict and returns {ok:true} for keep=local', async () => {
      const res = await post(
        '/api/resolve-conflict?pair=Pair1&relPath=docs%2Fnotes.txt&keep=local',
        port,
      );
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mocks.resolveConflict).toHaveBeenCalledWith('Pair1', 'docs/notes.txt', 'local');
    });

    it('calls resolveConflict and returns {ok:true} for keep=server', async () => {
      const res = await post(
        '/api/resolve-conflict?pair=Pair1&relPath=file.txt&keep=server',
        port,
      );
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mocks.resolveConflict).toHaveBeenCalledWith('Pair1', 'file.txt', 'server');
    });

    it('returns 400 when pair param is missing', async () => {
      const res = await post('/api/resolve-conflict?relPath=file.txt&keep=local', port);
      expect(res.status).toBe(400);
    });

    it('returns 400 when relPath param is missing', async () => {
      const res = await post('/api/resolve-conflict?pair=Pair1&keep=local', port);
      expect(res.status).toBe(400);
    });

    it('returns 400 when keep param is missing', async () => {
      const res = await post('/api/resolve-conflict?pair=Pair1&relPath=file.txt', port);
      expect(res.status).toBe(400);
    });

    it('returns 400 when keep param is invalid', async () => {
      const res = await post('/api/resolve-conflict?pair=Pair1&relPath=file.txt&keep=both', port);
      expect(res.status).toBe(400);
    });

    it('returns 500 with error message when resolveConflict rejects', async () => {
      mocks.resolveConflict.mockRejectedValueOnce(new Error('disk full'));

      const res = await post(
        '/api/resolve-conflict?pair=Pair1&relPath=file.txt&keep=local',
        port,
      );
      expect(res.status).toBe(500);
      expect(res.json()).toEqual({ error: 'disk full' });
    });
  });

  // ── POST /api/init ─────────────────────────────────────────────────────────

  describe('POST /api/init', () => {
    it('responds with triggered:true and pair:all when no pair param', async () => {
      const res = await post('/api/init', port);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ triggered: true, pair: 'all' });
      expect(mocks.init).toHaveBeenCalledWith(undefined);
    });

    it('passes the pair query param to init()', async () => {
      const res = await post('/api/init?pair=TestPair', port);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ triggered: true, pair: 'TestPair' });
      expect(mocks.init).toHaveBeenCalledWith('TestPair');
    });
  });

  // ── HTML routes ────────────────────────────────────────────────────────────

  describe('HTML routes', () => {
    it('GET / returns 200 with text/html and the dashboard markup', async () => {
      const res = await get('/', port);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain('text/html');
      expect(res.body).toContain('<!DOCTYPE html>');
      expect(res.body).toContain('syncTool');
      expect(res.body).toContain('id="pairs-body"');
      expect(res.body).toContain('id="conflicts-body"');
    });

    it('GET /index.html returns the same HTML as GET /', async () => {
      const [root, index] = await Promise.all([
        get('/', port),
        get('/index.html', port),
      ]);
      expect(index.status).toBe(200);
      expect(index.body).toBe(root.body);
    });
  });

  // ── 404 ───────────────────────────────────────────────────────────────────

  describe('unknown routes', () => {
    it('returns 404 for an unknown GET path', async () => {
      const res = await get('/no-such-endpoint', port);
      expect(res.status).toBe(404);
    });

    it('returns 404 for an unknown POST path', async () => {
      const res = await post('/no-such-endpoint', port);
      expect(res.status).toBe(404);
    });
  });
});
