import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom, ROLES } from './lib/room.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_PAYLOAD_BYTES = 64 * 1024;
const INVALID_ROLE_CODE = 4400;
const RELAYED_TYPES = new Set(['offer', 'answer', 'candidate']);
const PAGES = { '/camara': 'camara.html', '/monitor': 'monitor.html' };
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

function reply(res, status, body = '') {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply(res, 405, 'method not allowed');
    return;
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    reply(res, 200, 'ok');
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

export function createMonitorServer() {
  const room = createRoom();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('error inesperado', err);
      reply(res, 500, 'internal error');
    });
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES });

  wss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    ws.on('error', (err) => console.error('error de websocket', role, err.message));
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

  return server;
}
