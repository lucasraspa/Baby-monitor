import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom, ROLES } from './lib/room.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_PAYLOAD_BYTES = 64 * 1024;
const INVALID_ROLE_CODE = 4400;
export const FORBIDDEN_ORIGIN_CODE = 4403;
export const HEARTBEAT_MS = 30000;
const RELAYED_TYPES = new Set(['offer', 'answer', 'candidate']);
const PAGES = { '/': 'index.html', '/camara': 'camara.html', '/monitor': 'monitor.html' };
const ASSET_PATTERN = /^\/([a-z-]+\.(?:js|css))$/;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function resolveFile(pathname) {
  if (PAGES[pathname]) {
    return PAGES[pathname];
  }
  const match = ASSET_PATTERN.exec(pathname);
  return match ? match[1] : null;
}

function parsePathname(target) {
  try {
    return new URL(target, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function reply(res, status, body = '') {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function replyStatus(req, res, room) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(room.status()));
}

async function handleRequest(req, res, room) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply(res, 405, 'method not allowed');
    return;
  }
  const pathname = parsePathname(req.url);
  if (pathname === null) {
    reply(res, 400, 'bad request');
    return;
  }
  if (pathname === '/healthz') {
    reply(res, 200, 'ok');
    return;
  }
  if (pathname === '/api/status') {
    replyStatus(req, res, room);
    return;
  }
  const file = resolveFile(pathname);
  if (!file) {
    reply(res, 404, 'not found');
    return;
  }
  try {
    const body = await readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      reply(res, 404, 'not found');
      return;
    }
    console.error('error sirviendo', file, err);
    reply(res, 500, 'internal error');
  }
}

function parseRelayable(data) {
  try {
    const message = JSON.parse(data.toString());
    return message && RELAYED_TYPES.has(message.type) ? message : null;
  } catch {
    return null;
  }
}

function isForeignOrigin(req) {
  const { origin, host } = req.headers;
  if (origin === undefined) {
    return false;
  }
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function startHeartbeat(wss, intervalMs) {
  const alive = new WeakSet();
  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, intervalMs);
  wss.on('close', () => clearInterval(timer));
}

export function createMonitorServer({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const room = createRoom();
  const server = http.createServer((req, res) => {
    handleRequest(req, res, room).catch((err) => {
      console.error('error inesperado', err);
      reply(res, 500, 'internal error');
    });
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES });

  startHeartbeat(wss, heartbeatMs);

  wss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    ws.on('error', (err) => console.error('error de websocket', role, err.message));
    if (isForeignOrigin(req)) {
      ws.close(FORBIDDEN_ORIGIN_CODE, 'forbidden origin');
      return;
    }
    if (!ROLES.includes(role)) {
      ws.close(INVALID_ROLE_CODE, 'invalid role');
      return;
    }
    room.join(role, ws);
    ws.on('message', (data) => {
      const message = parseRelayable(data);
      if (message) {
        room.relay(role, message);
      }
    });
    ws.on('close', () => room.leave(role, ws));
  });

  server.on('close', () => wss.close());
  return server;
}
