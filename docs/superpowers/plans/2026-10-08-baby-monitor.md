# Baby Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una web app que convierte un iPad (cámara) y un iPhone (monitor) en un baby monitor de vídeo y audio por WiFi local.

**Architecture:** Un servidor Node mínimo sirve dos páginas (`/camara`, `/monitor`) y un WebSocket de señalización con una sala única. El vídeo y el audio viajan por WebRTC directo entre los dos Safari. El monitor detecta imagen congelada comprobando que `framesDecoded` avanza, y lanza alarma visual y sonora si se pierde la señal.

**Tech Stack:** Node ≥ 18 (ES modules), `ws`, `node:test`, HTML/JS plano sin build, Docker (node:22-alpine) en LXC 118 detrás de NPM.

**Spec:** [docs/superpowers/specs/2026-10-08-baby-monitor-design.md](../specs/2026-10-08-baby-monitor-design.md)

## Global Constraints

- Solo WiFi local; sin acceso externo ni Cloudflare Tunnel; sin login en la v1.
- Web app en Safari (iPad y iPhone); sin app nativa.
- Safari solo da cámara y micrófono en HTTPS: URL final `https://bebe.lhomelab.casa`.
- Una sola sala fija, un rol `camara` y un rol `monitor`; un segundo cliente del mismo rol reemplaza al anterior.
- El vídeo no pasa por el servidor; `RTCPeerConnection` con `iceServers: []` (solo LAN).
- Sin vibración (iOS Safari no soporta `navigator.vibrate`): alarma visual y sonora.
- Excluido: acceso externo, aviso de llanto, audio bidireccional, grabación, cuentas.
- Código inmutable (no mutar objetos de estado), funciones < 50 líneas, ficheros < 800 líneas, sin `console.log` (solo `console.error` para errores reales).
- Puerto del contenedor: `8830` (verificar que está libre en LXC 118 antes de desplegar).
- Commits: `<type>: <description>` y como último párrafo `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Cobertura: ≥ 80 % medida sobre `lib/`, `server.js` y `public/logic.js`. `public/camara.js`, `public/monitor.js` y `public/signal.js` dependen de APIs de Safari (`getUserMedia`, `RTCPeerConnection`, Wake Lock) y se verifican a mano en los dispositivos reales (Task 6).
- Entorno local: Node 18 (sin `--experimental-test-coverage`; se usa `c8`), sin Docker. El build de imagen se hace por SSH en LXC 118.

## Review Focus

Entradas y fallos que el spec implica pero que ninguna tarea nombra de forma explícita; cada línea tiene su test en la tarea indicada:

1. **Segundo monitor o cámara abre la página** (pestaña duplicada): reemplaza al anterior y el desplazado **no** reconecta en bucle (si lo hiciera, dos pestañas se expulsarían eternamente). Task 1, 2 y 3.
2. **Mensaje malformado, de tipo no permitido o > 64 KB:** no tumba el servidor y no se reenvía. Task 2.
3. **Rol inválido en `/ws?role=…`:** se rechaza (código 4400) y el cliente no reintenta. Task 2 y 3.
4. **Path traversal en los estáticos** (`/../server.js`, `/lib/room.js`): 404. Task 2.
5. **Imagen congelada con conexión viva** y **contador de frames que vuelve a 0 en una conexión nueva:** debe marcarse como sin señal en el primer caso y no en el segundo. Task 3.

## File Structure

```
baby-monitor/
├── package.json               # type: module, ws, c8
├── index.js                   # arranque: PORT, SIGTERM
├── server.js                  # HTTP estático + WebSocket de señalización
├── lib/room.js                # lógica pura de la sala (sin red)
├── public/
│   ├── logic.js               # funciones puras del cliente (estado, reconexión, errores)
│   ├── signal.js              # cliente WebSocket con reconexión + cola serial
│   ├── camara.html / camara.js
│   ├── monitor.html / monitor.js
│   └── style.css
├── tests/
│   ├── room.test.js
│   ├── server.test.js
│   └── logic.test.js
├── Dockerfile · docker-compose.yml · .dockerignore · .gitignore
└── docs/superpowers/{specs,plans}/
```

Responsabilidades: `room.js` no conoce `ws` (los clientes son objetos con `send(string)` y `close(code, reason)`), así que se prueba con dobles. `logic.js` no toca el DOM. Las páginas solo cablean APIs del navegador.

---

### Task 1: Scaffold y lógica de sala

**Files:**
- Create: `package.json`, `.gitignore`, `lib/room.js`
- Test: `tests/room.test.js`

**Interfaces:**
- Produces:
  - `ROLES: ['camara','monitor']`, `REPLACED_CODE = 4000`
  - `createRoom(): { join(role, client): void, leave(role, client): void, relay(role, message): boolean }`
  - Cliente: `{ send(raw: string): void, close(code: number, reason: string): void }`
  - Mensajes del servidor al cliente: `{type:'welcome', peer:boolean}`, `{type:'peer-joined'}`, `{type:'peer-left'}`; los mensajes relayados se reenvían tal cual con `JSON.stringify`.

- [ ] **Step 1: Inicializar el repo y las dependencias**

```bash
cd /Downloads/Docker/baby-monitor
git init
printf 'node_modules/\ncoverage/\n' > .gitignore
cat > package.json <<'EOF'
{
  "name": "baby-monitor",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "test": "node --test tests/*.test.js",
    "coverage": "c8 --include=lib --include=server.js --include=public/logic.js node --test tests/*.test.js"
  },
  "engines": { "node": ">=18" },
  "dependencies": { "ws": "^8.18.0" },
  "devDependencies": { "c8": "^10.1.2" }
}
EOF
npm install
git add .gitignore package.json package-lock.json docs
git commit -m "docs: add baby monitor spec, plan and project scaffold" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: `node_modules/` creado, `package-lock.json` presente, commit hecho.

- [ ] **Step 2: Escribir los tests que fallan**

`tests/room.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, REPLACED_CODE } from '../lib/room.js';

function fakeClient() {
  const sent = [];
  const closed = [];
  return {
    sent,
    closed,
    send: (raw) => sent.push(JSON.parse(raw)),
    close: (code, reason) => closed.push({ code, reason }),
  };
}

test('welcome reports no peer when the other role is absent', () => {
  const room = createRoom();
  const monitor = fakeClient();

  room.join('monitor', monitor);

  assert.deepEqual(monitor.sent, [{ type: 'welcome', peer: false }]);
});

test('joining tells the joiner a peer exists and notifies the peer', () => {
  const room = createRoom();
  const monitor = fakeClient();
  const camara = fakeClient();

  room.join('monitor', monitor);
  room.join('camara', camara);

  assert.deepEqual(camara.sent, [{ type: 'welcome', peer: true }]);
  assert.deepEqual(monitor.sent, [
    { type: 'welcome', peer: false },
    { type: 'peer-joined' },
  ]);
});

test('relay forwards the message to the other role and reports delivery', () => {
  const room = createRoom();
  const monitor = fakeClient();
  const camara = fakeClient();
  room.join('monitor', monitor);
  room.join('camara', camara);

  const delivered = room.relay('camara', { type: 'offer', sdp: 'x' });

  assert.equal(delivered, true);
  assert.deepEqual(monitor.sent.at(-1), { type: 'offer', sdp: 'x' });
});

test('relay returns false and does not throw when no peer is present', () => {
  const room = createRoom();
  room.join('camara', fakeClient());

  assert.equal(room.relay('camara', { type: 'offer' }), false);
});

test('a second client with the same role replaces the first', () => {
  const room = createRoom();
  const first = fakeClient();
  const second = fakeClient();
  const camara = fakeClient();
  room.join('camara', camara);
  room.join('monitor', first);

  room.join('monitor', second);
  room.relay('camara', { type: 'offer' });

  assert.deepEqual(first.closed, [{ code: REPLACED_CODE, reason: 'replaced' }]);
  assert.deepEqual(second.sent[0], { type: 'welcome', peer: true });
  assert.deepEqual(second.sent.at(-1), { type: 'offer' });
  assert.equal(first.sent.some((m) => m.type === 'offer'), false);
});

test('leaving as a replaced client neither clears the new one nor notifies the peer', () => {
  const room = createRoom();
  const first = fakeClient();
  const second = fakeClient();
  const camara = fakeClient();
  room.join('camara', camara);
  room.join('monitor', first);
  room.join('monitor', second);
  const before = camara.sent.length;

  room.leave('monitor', first);

  assert.equal(camara.sent.length, before);
  assert.equal(room.relay('camara', { type: 'offer' }), true);
});

test('leaving as the current client notifies the peer', () => {
  const room = createRoom();
  const monitor = fakeClient();
  const camara = fakeClient();
  room.join('camara', camara);
  room.join('monitor', monitor);

  room.leave('monitor', monitor);

  assert.deepEqual(camara.sent.at(-1), { type: 'peer-left' });
  assert.equal(room.relay('camara', { type: 'offer' }), false);
});

test('joining with an unknown role throws', () => {
  const room = createRoom();

  assert.throws(() => room.join('abuela', fakeClient()), /rol inválido/);
});
```

- [ ] **Step 3: Verificar que fallan**

Run: `cd /Downloads/Docker/baby-monitor && npm test`
Expected: FAIL con `Cannot find module '../lib/room.js'`.

- [ ] **Step 4: Implementar `lib/room.js`**

```js
export const ROLES = ['camara', 'monitor'];
export const REPLACED_CODE = 4000;

const otherRole = (role) => (role === 'camara' ? 'monitor' : 'camara');

export function createRoom() {
  const clients = { camara: null, monitor: null };

  function join(role, client) {
    if (!ROLES.includes(role)) {
      throw new Error(`rol inválido: ${role}`);
    }
    const previous = clients[role];
    clients[role] = client;
    if (previous && previous !== client) {
      previous.close(REPLACED_CODE, 'replaced');
    }
    const peer = clients[otherRole(role)];
    client.send(JSON.stringify({ type: 'welcome', peer: Boolean(peer) }));
    peer?.send(JSON.stringify({ type: 'peer-joined' }));
  }

  function leave(role, client) {
    if (clients[role] !== client) {
      return;
    }
    clients[role] = null;
    clients[otherRole(role)]?.send(JSON.stringify({ type: 'peer-left' }));
  }

  function relay(role, message) {
    const peer = clients[otherRole(role)];
    if (!peer) {
      return false;
    }
    peer.send(JSON.stringify(message));
    return true;
  }

  return { join, leave, relay };
}
```

- [ ] **Step 5: Verificar que pasan**

Run: `npm test`
Expected: 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib tests
git commit -m "feat: add signaling room logic" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Servidor HTTP + señalización

**Files:**
- Create: `server.js`, `index.js`
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `createRoom`, `ROLES` de `lib/room.js`.
- Produces:
  - `createMonitorServer(): http.Server` (con el WebSocket en `/ws?role=camara|monitor` ya adjunto).
  - HTTP: `GET /healthz` → 200 `ok`; `GET /camara` → `public/camara.html`; `GET /monitor` → `public/monitor.html`; `GET /<nombre>.js|.css` → fichero de `public/` (solo `[a-z-]+`); cualquier otra ruta → 404; método distinto de GET/HEAD → 405.
  - WebSocket: rol inválido → cierre con código `4400`; tipos relayados: `offer`, `answer`, `candidate`; `maxPayload` 64 KB.

- [ ] **Step 1: Escribir los tests que fallan**

`tests/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createMonitorServer } from '../server.js';

const MESSAGE_TIMEOUT_MS = 2000;

function openClient(port, role) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });
  const next = (timeoutMs = MESSAGE_TIMEOUT_MS) =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          waiters.push((message) => {
            clearTimeout(timer);
            resolve(message);
          });
        });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  return { ws, next, opened, closed };
}

async function fixture(t) {
  const server = createMonitorServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const clients = [];
  t.after(() => {
    clients.forEach((c) => c.ws.terminate());
    server.closeAllConnections();
    server.close();
  });
  return {
    port,
    client(role) {
      const c = openClient(port, role);
      clients.push(c);
      return c;
    },
  };
}

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('healthz answers 200', async (t) => {
  const { port } = await fixture(t);

  assert.equal((await get(port, '/healthz')).status, 200);
});

test('unknown paths and traversal attempts answer 404', async (t) => {
  const { port } = await fixture(t);

  for (const path of ['/', '/server.js', '/lib/room.js', '/../server.js', '/%2e%2e/server.js', '/package.json']) {
    assert.equal((await get(port, path)).status, 404, path);
  }
});

test('non GET methods answer 405', async (t) => {
  const { port } = await fixture(t);

  assert.equal((await get(port, '/camara', 'POST')).status, 405);
});

test('relays offer and answer between camara and monitor', async (t) => {
  const f = await fixture(t);
  const monitor = f.client('monitor');
  await monitor.opened;
  assert.deepEqual(await monitor.next(), { type: 'welcome', peer: false });
  const camara = f.client('camara');
  await camara.opened;

  assert.deepEqual(await camara.next(), { type: 'welcome', peer: true });
  assert.deepEqual(await monitor.next(), { type: 'peer-joined' });

  camara.ws.send(JSON.stringify({ type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } }));
  assert.deepEqual(await monitor.next(), { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } });

  monitor.ws.send(JSON.stringify({ type: 'answer', sdp: { type: 'answer', sdp: 'v=0' } }));
  assert.deepEqual(await camara.next(), { type: 'answer', sdp: { type: 'answer', sdp: 'v=0' } });
});

test('malformed JSON and spoofed message types are ignored without breaking the room', async (t) => {
  const f = await fixture(t);
  const monitor = f.client('monitor');
  await monitor.opened;
  await monitor.next();
  const camara = f.client('camara');
  await camara.opened;
  await camara.next();
  await monitor.next();

  camara.ws.send('esto no es json');
  camara.ws.send(JSON.stringify({ type: 'peer-left' }));
  camara.ws.send(JSON.stringify({ type: 'offer', sdp: 'ok' }));

  assert.deepEqual(await monitor.next(), { type: 'offer', sdp: 'ok' });
});

test('sending to an absent peer does not break the server', async (t) => {
  const f = await fixture(t);
  const camara = f.client('camara');
  await camara.opened;
  await camara.next();

  camara.ws.send(JSON.stringify({ type: 'offer', sdp: 'nadie' }));
  const monitor = f.client('monitor');
  await monitor.opened;

  assert.deepEqual(await monitor.next(), { type: 'welcome', peer: true });
});

test('a payload over 64 KB closes the connection with 1009', async (t) => {
  const f = await fixture(t);
  const camara = f.client('camara');
  await camara.opened;
  await camara.next();

  camara.ws.send('x'.repeat(70 * 1024));

  assert.equal(await camara.closed, 1009);
});

test('an invalid role is rejected with 4400', async (t) => {
  const f = await fixture(t);
  const intruder = f.client('abuela');

  await intruder.opened;

  assert.equal(await intruder.closed, 4400);
});

test('a second monitor replaces the first with 4000 and the camera is not told the monitor left', async (t) => {
  const f = await fixture(t);
  const camara = f.client('camara');
  await camara.opened;
  await camara.next();
  const first = f.client('monitor');
  await first.opened;
  await first.next();
  assert.deepEqual(await camara.next(), { type: 'peer-joined' });

  const second = f.client('monitor');
  await second.opened;

  assert.deepEqual(await camara.next(), { type: 'peer-joined' });
  assert.equal(await first.closed, 4000);
  await assert.rejects(camara.next(200), /timeout/);
});

test('closing a client notifies the peer with peer-left', async (t) => {
  const f = await fixture(t);
  const camara = f.client('camara');
  await camara.opened;
  await camara.next();
  const monitor = f.client('monitor');
  await monitor.opened;
  await monitor.next();
  await camara.next();

  monitor.ws.close();

  assert.deepEqual(await camara.next(), { type: 'peer-left' });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npm test`
Expected: FAIL con `Cannot find module '../server.js'` (los 8 tests de `room` siguen pasando).

- [ ] **Step 3: Implementar `server.js`**

```js
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
    ws.on('error', (err) => console.error('error de websocket', role, err.message));
  });

  return server;
}
```

- [ ] **Step 4: Implementar `index.js`**

```js
import { createMonitorServer } from './server.js';

const PORT = Number(process.env.PORT ?? 8830);

createMonitorServer().listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`baby-monitor escuchando en :${PORT}\n`);
});

process.on('SIGTERM', () => process.exit(0));
```

- [ ] **Step 5: Verificar que pasan**

Run: `npm test`
Expected: 8 (room) + 10 (server) = 18 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js index.js tests/server.test.js
git commit -m "feat: add http and websocket signaling server" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Lógica pura del cliente

**Files:**
- Create: `public/logic.js`
- Test: `tests/logic.test.js`

**Interfaces:**
- Produces (todas puras, sin DOM):
  - `STALL_THRESHOLD_MS = 6000`, `LOST_AFTER_MS = 10000`
  - `shouldReconnect(closeCode: number): boolean` — `false` para `4000` y `4400`.
  - `initialFrameState(now: number): { frames: number, advancedAt: number }`
  - `trackFrames(state, frames: number, now: number): state` (devuelve un estado nuevo o el mismo si no avanza; nunca muta).
  - `isStalled(state, now: number, thresholdMs = STALL_THRESHOLD_MS): boolean`
  - `classify({ everLive: boolean, flowing: boolean, downMs: number }): 'live' | 'waiting' | 'reconnecting' | 'lost'`
  - `describeMediaError(err: { name: string, message?: string }): string`

- [ ] **Step 1: Escribir los tests que fallan**

`tests/logic.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALL_THRESHOLD_MS,
  LOST_AFTER_MS,
  shouldReconnect,
  initialFrameState,
  trackFrames,
  isStalled,
  classify,
  describeMediaError,
} from '../public/logic.js';

test('shouldReconnect is false for replaced and invalid-role closes only', () => {
  assert.equal(shouldReconnect(4000), false);
  assert.equal(shouldReconnect(4400), false);
  assert.equal(shouldReconnect(1006), true);
  assert.equal(shouldReconnect(1001), true);
});

test('trackFrames records the time frames last advanced and does not mutate', () => {
  const start = initialFrameState(1000);

  const advanced = trackFrames(start, 5, 2000);
  const same = trackFrames(advanced, 5, 3000);

  assert.deepEqual(advanced, { frames: 5, advancedAt: 2000 });
  assert.deepEqual(same, advanced);
  assert.deepEqual(start, { frames: -1, advancedAt: 1000 });
});

test('isStalled turns true only after the threshold without new frames', () => {
  const state = trackFrames(initialFrameState(0), 10, 1000);

  assert.equal(isStalled(state, 1000 + STALL_THRESHOLD_MS), false);
  assert.equal(isStalled(state, 1000 + STALL_THRESHOLD_MS + 1), true);
});

test('a new connection restarting at 0 frames is not stalled when state is reset', () => {
  const old = trackFrames(initialFrameState(0), 5000, 100);
  const fresh = initialFrameState(20000);

  assert.equal(isStalled(old, 20000), true);
  assert.equal(isStalled(trackFrames(fresh, 3, 20500), 21000), false);
});

test('classify: waiting before the first frame, live while flowing', () => {
  assert.equal(classify({ everLive: false, flowing: false, downMs: 0 }), 'waiting');
  assert.equal(classify({ everLive: false, flowing: true, downMs: 0 }), 'live');
  assert.equal(classify({ everLive: true, flowing: true, downMs: 0 }), 'live');
});

test('classify: reconnecting at first, lost after the grace period', () => {
  assert.equal(classify({ everLive: true, flowing: false, downMs: 0 }), 'reconnecting');
  assert.equal(classify({ everLive: true, flowing: false, downMs: LOST_AFTER_MS - 1 }), 'reconnecting');
  assert.equal(classify({ everLive: true, flowing: false, downMs: LOST_AFTER_MS }), 'lost');
});

test('describeMediaError gives actionable text for denied and missing devices', () => {
  assert.match(describeMediaError({ name: 'NotAllowedError' }), /permiso/i);
  assert.match(describeMediaError({ name: 'NotFoundError' }), /no se encontr/i);
  assert.match(describeMediaError({ name: 'Raro', message: 'boom' }), /boom/);
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npm test`
Expected: FAIL con `Cannot find module '../public/logic.js'`.

- [ ] **Step 3: Implementar `public/logic.js`**

```js
export const STALL_THRESHOLD_MS = 6000;
export const LOST_AFTER_MS = 10000;

const NO_RECONNECT_CODES = [4000, 4400];

export function shouldReconnect(closeCode) {
  return !NO_RECONNECT_CODES.includes(closeCode);
}

export function initialFrameState(now) {
  return { frames: -1, advancedAt: now };
}

export function trackFrames(state, frames, now) {
  return frames > state.frames ? { frames, advancedAt: now } : state;
}

export function isStalled(state, now, thresholdMs = STALL_THRESHOLD_MS) {
  return now - state.advancedAt > thresholdMs;
}

export function classify({ everLive, flowing, downMs }) {
  if (flowing) {
    return 'live';
  }
  if (!everLive) {
    return 'waiting';
  }
  return downMs >= LOST_AFTER_MS ? 'lost' : 'reconnecting';
}

export function describeMediaError(err) {
  if (err.name === 'NotAllowedError') {
    return 'Safari no tiene permiso para la cámara o el micrófono. En Ajustes › Safari › Cámara y Micrófono elige «Permitir» y recarga la página.';
  }
  if (err.name === 'NotFoundError') {
    return 'No se encontró cámara o micrófono en este dispositivo.';
  }
  return `No se pudo iniciar la cámara: ${err.message ?? err.name}`;
}
```

- [ ] **Step 4: Verificar que pasan y la cobertura**

Run: `npm test && npm run coverage`
Expected: 25 tests PASS; cobertura de `lib/`, `server.js`, `public/logic.js` ≥ 80 %.

- [ ] **Step 5: Commit**

```bash
git add public/logic.js tests/logic.test.js
git commit -m "feat: add pure client logic for status and reconnect" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Páginas de cámara y monitor

**Files:**
- Create: `public/style.css`, `public/signal.js`, `public/camara.html`, `public/camara.js`, `public/monitor.html`, `public/monitor.js`
- Modify: `tests/server.test.js` (añadir un test de páginas)

**Interfaces:**
- Consumes: `connectSignal`, `serialize` (de `signal.js`), y de `logic.js` todo lo listado en Task 3. Mensajes de señalización de Task 2.
- Produces:
  - `connectSignal(role, { onMessage, onOpen, onClose }): { send(msg), stop() }` — reconecta cada 2 s salvo `shouldReconnect(code) === false`.
  - `serialize(handler): (msg) => Promise<void>` — ejecuta los mensajes de uno en uno y registra errores.
- Protocolo WebRTC: la **cámara siempre ofrece** (`welcome` con `peer:true` o `peer-joined` ⇒ nueva `RTCPeerConnection` + `offer`); el monitor responde con `answer`; ambos intercambian `candidate`.

- [ ] **Step 1: Escribir el test que falla (páginas servidas)**

Añadir al final de `tests/server.test.js`:

```js
test('serves the pages and client assets with the right content types', async (t) => {
  const { port } = await fixture(t);

  for (const [path, type] of [
    ['/camara', 'text/html'],
    ['/monitor', 'text/html'],
    ['/style.css', 'text/css'],
    ['/logic.js', 'text/javascript'],
    ['/signal.js', 'text/javascript'],
    ['/camara.js', 'text/javascript'],
    ['/monitor.js', 'text/javascript'],
  ]) {
    const res = await get(port, path);
    assert.equal(res.status, 200, path);
    assert.match(res.type, new RegExp(type), path);
  }
});
```

Run: `npm test` — Expected: FAIL en el test nuevo (404 en `/camara`).

- [ ] **Step 2: `public/style.css`**

```css
:root {
  --bg: #0b0d10;
  --fg: #e8eaed;
  --muted: #8a9099;
  --accent: #c9f24d;
  --live: #3ddc84;
  --warn: #ffb020;
  --lost: #ff4d4d;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: -apple-system, system-ui, sans-serif; }
main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: env(safe-area-inset-top) 1rem env(safe-area-inset-bottom); text-align: center; }
main[hidden], [hidden] { display: none !important; }
button { font-size: 1.4rem; padding: 1rem 2rem; border: 0; border-radius: 1rem; background: var(--accent); color: #111; }
button.secondary { background: #20242b; color: var(--fg); font-size: 1rem; padding: .6rem 1rem; }
video { max-width: 100%; max-height: 100%; background: #000; }
.muted { color: var(--muted); }
.warn { color: var(--warn); }

/* camara: vista previa pequeña y oscura para no molestar al bebé */
body.camara video { width: 40vw; opacity: .35; border-radius: .5rem; }

/* monitor: vídeo a pantalla completa con barra de estado */
body.monitor main { justify-content: flex-start; padding: 0; gap: 0; }
#stage { position: relative; width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center; }
#stage video { width: 100%; height: 100%; object-fit: contain; }
#bar { position: absolute; top: env(safe-area-inset-top); left: 0; right: 0; display: flex; align-items: center; gap: .6rem; padding: .6rem 1rem; background: rgba(0,0,0,.55); }
#dot { width: 1rem; height: 1rem; border-radius: 50%; background: var(--muted); }
body[data-status="live"] #dot { background: var(--live); }
body[data-status="reconnecting"] #dot, body[data-status="waiting"] #dot { background: var(--warn); }
body[data-status="lost"] #dot { background: var(--lost); }
#bar .spacer { flex: 1; }
#overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.6); }
body[data-status="lost"] #stage { animation: flash 1s steps(2, start) infinite; }
@keyframes flash { 50% { box-shadow: inset 0 0 0 .6rem var(--lost); background: #300; } }
```

- [ ] **Step 3: `public/signal.js`**

```js
import { shouldReconnect } from './logic.js';

const RECONNECT_DELAY_MS = 2000;

export function connectSignal(role, { onMessage, onOpen, onClose }) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}/ws?role=${role}`;
  let ws;
  let timer;
  let stopped = false;

  function open() {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => onOpen?.());
    ws.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('mensaje de señalización inválido', err);
      }
    });
    ws.addEventListener('close', (event) => {
      onClose?.(event.code);
      if (!stopped && shouldReconnect(event.code)) {
        timer = setTimeout(open, RECONNECT_DELAY_MS);
      }
    });
  }

  open();

  return {
    send(message) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}

export function serialize(handler) {
  let chain = Promise.resolve();
  return (message) => {
    chain = chain
      .then(() => handler(message))
      .catch((err) => console.error('error procesando', message.type, err));
    return chain;
  };
}
```

- [ ] **Step 4: `public/camara.html`**

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Cámara del bebé</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="camara">
  <main id="intro">
    <h1>Cámara del bebé</h1>
    <p class="muted">Deja el iPad enchufado y apuntando al bebé.</p>
    <button id="start" type="button">Iniciar cámara</button>
    <p id="error" class="warn" role="alert" hidden></p>
  </main>
  <main id="running" hidden>
    <video id="preview" autoplay playsinline muted></video>
    <p id="status">Esperando monitor…</p>
    <p class="muted">Mantén el iPad enchufado.</p>
    <p id="wakewarn" class="warn" hidden>Este iPad no puede mantener la pantalla encendida: desactiva el bloqueo automático en Ajustes › Pantalla y brillo.</p>
  </main>
  <script type="module" src="/camara.js"></script>
</body>
</html>
```

- [ ] **Step 5: `public/camara.js`**

```js
import { connectSignal, serialize } from './signal.js';
import { describeMediaError } from './logic.js';

const MEDIA_CONSTRAINTS = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
};

const el = (id) => document.getElementById(id);
const setStatus = (text) => { el('status').textContent = text; };

let stream = null;
let pc = null;
let signal = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    el('wakewarn').hidden = false;
    return;
  }
  try {
    await navigator.wakeLock.request('screen');
  } catch (err) {
    console.error('wakeLock', err);
    el('wakewarn').hidden = false;
  }
}

function closePeer() {
  pc?.close();
  pc = null;
}

async function startOffer() {
  closePeer();
  pc = new RTCPeerConnection({ iceServers: [] });
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signal.send({ type: 'candidate', candidate: event.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
    setStatus(pc?.connectionState === 'connected' ? 'Monitor conectado' : 'Conectando con el monitor…');
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal.send({ type: 'offer', sdp: pc.localDescription });
}

async function handleMessage(message) {
  switch (message.type) {
    case 'welcome':
      if (message.peer) {
        await startOffer();
      } else {
        setStatus('Esperando monitor…');
      }
      break;
    case 'peer-joined':
      await startOffer();
      break;
    case 'peer-left':
      closePeer();
      setStatus('Esperando monitor…');
      break;
    case 'answer':
      await pc?.setRemoteDescription(message.sdp);
      break;
    case 'candidate':
      await pc?.addIceCandidate(message.candidate);
      break;
  }
}

async function start() {
  el('start').disabled = true;
  el('error').hidden = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  } catch (err) {
    el('error').textContent = describeMediaError(err);
    el('error').hidden = false;
    el('start').disabled = false;
    return;
  }
  el('preview').srcObject = stream;
  el('intro').hidden = true;
  el('running').hidden = false;
  await acquireWakeLock();
  signal = connectSignal('camara', { onMessage: serialize(handleMessage) });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stream) {
    acquireWakeLock();
  }
});
el('start').addEventListener('click', start);
```

- [ ] **Step 6: `public/monitor.html`**

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Monitor del bebé</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="monitor" data-status="waiting">
  <main id="intro">
    <h1>Monitor del bebé</h1>
    <p class="muted">Deja esta pantalla encendida (desactiva el bloqueo automático).</p>
    <button id="connect" type="button">Conectar</button>
  </main>
  <main id="running" hidden>
    <div id="stage">
      <video id="video" autoplay playsinline></video>
      <div id="bar">
        <span id="dot"></span>
        <span id="label">Esperando cámara…</span>
        <span class="spacer"></span>
        <button id="alarm-off" class="secondary" type="button" hidden>Silenciar alarma</button>
        <button id="mute" class="secondary" type="button" aria-label="Sonido">🔊</button>
      </div>
      <div id="overlay" hidden><button id="play" type="button">Toca para reproducir</button></div>
    </div>
  </main>
  <script type="module" src="/monitor.js"></script>
</body>
</html>
```

- [ ] **Step 7: `public/monitor.js`**

```js
import { connectSignal, serialize } from './signal.js';
import {
  classify,
  initialFrameState,
  trackFrames,
  isStalled,
} from './logic.js';

const TICK_MS = 1000;
const ALARM_BEEP_HZ = 880;
const ALARM_BEEP_SECONDS = 0.3;
const ALARM_BEEP_GAIN = 0.3;
const LABELS = {
  waiting: 'Esperando cámara…',
  live: 'En directo',
  reconnecting: 'Reconectando…',
  lost: 'SIN SEÑAL — revisa el iPad',
};

const el = (id) => document.getElementById(id);

let pc = null;
let signal = null;
let audioCtx = null;
let alarmTimer = null;
let alarmSilenced = false;
let everLive = false;
let downSince = null;
let frameState = initialFrameState(Date.now());

function beep() {
  navigator.vibrate?.(300);
  if (!audioCtx || alarmSilenced) {
    return;
  }
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = ALARM_BEEP_HZ;
  gain.gain.value = ALARM_BEEP_GAIN;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + ALARM_BEEP_SECONDS);
}

function setAlarm(active) {
  el('alarm-off').hidden = !active;
  if (active && !alarmTimer) {
    beep();
    alarmTimer = setInterval(beep, 1000);
  }
  if (!active && alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
    alarmSilenced = false;
  }
}

function render(status) {
  document.body.dataset.status = status;
  el('label').textContent = LABELS[status];
  setAlarm(status === 'lost');
}

function closePeer() {
  pc?.close();
  pc = null;
  frameState = initialFrameState(Date.now());
}

async function readFrames() {
  if (!pc) {
    return null;
  }
  let frames = null;
  (await pc.getStats()).forEach((report) => {
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      frames = report.framesDecoded ?? 0;
    }
  });
  return frames;
}

async function tick() {
  const now = Date.now();
  const frames = await readFrames();
  if (frames !== null) {
    frameState = trackFrames(frameState, frames, now);
  }
  const flowing = frames !== null && frames > 0 && !isStalled(frameState, now);
  if (flowing) {
    everLive = true;
    downSince = null;
  } else if (everLive && downSince === null) {
    downSince = now;
  }
  render(classify({ everLive, flowing, downMs: downSince === null ? 0 : now - downSince }));
}

function playVideo() {
  el('video').play().then(
    () => { el('overlay').hidden = true; },
    () => { el('overlay').hidden = false; },
  );
}

async function handleOffer(message) {
  closePeer();
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.ontrack = (event) => {
    el('video').srcObject = event.streams[0];
    playVideo();
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signal.send({ type: 'candidate', candidate: event.candidate });
    }
  };
  await pc.setRemoteDescription(message.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal.send({ type: 'answer', sdp: pc.localDescription });
}

async function handleMessage(message) {
  switch (message.type) {
    case 'offer':
      await handleOffer(message);
      break;
    case 'peer-left':
      closePeer();
      break;
    case 'candidate':
      await pc?.addIceCandidate(message.candidate);
      break;
  }
}

async function acquireWakeLock() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch (err) {
    console.error('wakeLock', err);
  }
}

async function connect() {
  audioCtx = new AudioContext();
  await audioCtx.resume();
  el('video').muted = false;
  el('intro').hidden = true;
  el('running').hidden = false;
  await acquireWakeLock();
  signal = connectSignal('monitor', { onMessage: serialize(handleMessage) });
  setInterval(() => tick().catch((err) => console.error('tick', err)), TICK_MS);
}

el('connect').addEventListener('click', connect);
el('play').addEventListener('click', () => { el('video').muted = false; playVideo(); });
el('mute').addEventListener('click', () => {
  const video = el('video');
  video.muted = !video.muted;
  el('mute').textContent = video.muted ? '🔇' : '🔊';
});
el('alarm-off').addEventListener('click', () => { alarmSilenced = true; });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && signal) {
    acquireWakeLock();
  }
});
```

- [ ] **Step 8: Verificar tests y arranque local**

Run:
```bash
npm test
PORT=8830 node index.js &
sleep 1
curl -s -o /dev/null -w '%{http_code} ' http://127.0.0.1:8830/camara http://127.0.0.1:8830/monitor http://127.0.0.1:8830/healthz
kill %1
```
Expected: 26 tests PASS; `200 200 200`.

- [ ] **Step 9: Revisión de código**

Lanzar el agente `code-reviewer` sobre `git diff` y el agente `typescript-reviewer` sobre `public/*.js` y `server.js`. Corregir CRITICAL y HIGH antes de seguir.

- [ ] **Step 10: Commit**

```bash
git add public tests
git commit -m "feat: add camera and monitor pages" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Imagen Docker y despliegue en LXC 118

> **Requiere confirmación de Lucas antes del Step 3**: modifica LXC 118 (crea un stack nuevo).

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`

**Interfaces:**
- Produces: contenedor `baby-monitor` escuchando en `192.168.86.250:8830`, healthcheck sobre `/healthz`.

- [ ] **Step 1: Crear los ficheros**

`Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js server.js ./
COPY lib ./lib
COPY public ./public
USER node
EXPOSE 8830
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8830/healthz || exit 1
CMD ["node", "index.js"]
```

`docker-compose.yml`:

```yaml
services:
  baby-monitor:
    build: .
    container_name: baby-monitor
    restart: unless-stopped
    ports:
      - "8830:8830"
    environment:
      - PORT=8830
    mem_limit: 128m
```

`.dockerignore`:

```
node_modules
coverage
docs
tests
.git
```

- [ ] **Step 2: Comprobar que el puerto está libre en LXC 118**

```bash
ssh -i /root/.ssh/id_rsa_nopass root@192.168.86.250 "ss -ltn | grep ':8830 ' || echo libre"
```
Expected: `libre`. Si no, elegir otro puerto y actualizar `Dockerfile`, `docker-compose.yml`, `index.js` y esta plan.

- [ ] **Step 3: Construir y arrancar (tras confirmación)**

```bash
cd /Downloads/Docker/baby-monitor && git add Dockerfile docker-compose.yml .dockerignore && git commit -m "ci: add dockerfile and compose" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
ssh -i /root/.ssh/id_rsa_nopass root@192.168.86.250 "cd /Data/Docker/baby-monitor && docker compose up -d --build"
```
(El directorio es el mismo por NFS: `/Downloads/Docker/baby-monitor` ↔ `/Data/Docker/baby-monitor`.)

- [ ] **Step 4: Verificar**

```bash
curl -s http://192.168.86.250:8830/healthz
ssh -i /root/.ssh/id_rsa_nopass root@192.168.86.250 "docker inspect --format '{{.State.Health.Status}}' baby-monitor"
```
Expected: `ok` y `healthy`.

---

### Task 6: HTTPS, DNS local, verificación en dispositivos y documentación

> **Requiere confirmación de Lucas en cada cambio de infraestructura** (NPM, Pi-hole, Cloudflare).

**Files:**
- Modify: `/Downloads/homelab-docs/info/stacks.md`, `/Downloads/homelab-docs/info/network.md`, `/Downloads/homelab-docs/CHANGELOG.md`, `/Downloads/claude/CLAUDE.md`

**Interfaces:**
- Consumes: contenedor de Task 5 en `192.168.86.250:8830`.
- Produces: `https://bebe.lhomelab.casa/camara` y `/monitor` accesibles solo desde la LAN, con certificado válido.

- [ ] **Step 1: DNS local en Pi-hole**

Comprobar la versión y añadir `bebe.lhomelab.casa → 192.168.86.65` (NPM):

```bash
ssh -i /root/.ssh/id_rsa_nopass root@192.168.86.150 "pct exec 106 -- pihole -v"
```
- Pi-hole v5: `pct exec 106 -- sh -c "echo '192.168.86.65 bebe.lhomelab.casa' >> /etc/pihole/custom.list && pihole restartdns reload-lists"`
- Pi-hole v6: `pct exec 106 -- pihole-FTL --config dns.hosts '["192.168.86.65 bebe.lhomelab.casa"]'` (¡esto **reemplaza** la lista: leer antes `pihole-FTL --config dns.hosts` y conservar las entradas existentes).

Verificar: `dig +short bebe.lhomelab.casa @192.168.86.38` → `192.168.86.65`.

- [ ] **Step 2: Certificado en NPM (UI `http://192.168.86.65:81`)**

SSL Certificates → Add → Let's Encrypt → dominio `bebe.lhomelab.casa` → «Use a DNS Challenge» → Cloudflare, con un token de API de Cloudflare con permiso `Zone:DNS:Edit` sobre `lhomelab.casa`. Si el token que usa homelab-mcp no sirve para esto, crear uno específico (no reutilizar uno con más permisos).

- [ ] **Step 3: Proxy host en NPM**

Proxy Hosts → Add: dominio `bebe.lhomelab.casa`, esquema `http`, destino `192.168.86.250:8830`, **Websockets Support activado** (sin esto `/ws` falla), SSL → el certificado del paso 2, Force SSL. **No** publicar el dominio por Cloudflare Tunnel.

- [ ] **Step 4: Verificar HTTPS desde la LAN**

```bash
curl -sI https://bebe.lhomelab.casa/monitor | head -1
```
Expected: `HTTP/2 200` sin error de certificado.

- [ ] **Step 5: Verificación manual en los dispositivos reales**

En el iPad: `https://bebe.lhomelab.casa/camara` → «Iniciar cámara» → aceptar permisos. En el iPhone: `https://bebe.lhomelab.casa/monitor` → «Conectar».

Checklist (anotar el resultado de cada línea; si algo falla, no seguir):
- [ ] Ver y oír al bebé con latencia < 1 s, punto verde.
- [ ] Monitor abierto antes que la cámara → «Esperando cámara…» y conecta solo al abrir el iPad.
- [ ] Cortar el WiFi del iPhone 5 s → ámbar, vuelve solo a verde.
- [ ] Bloquear el iPad (botón lateral) → en < 20 s el monitor pasa a rojo con parpadeo y pitido; «Silenciar alarma» lo calla.
- [ ] Abrir un segundo `/monitor` en otra pestaña → el primero se queda parado (sin bucle de reconexiones) y el segundo funciona.
- [ ] iPad enchufado 30 min sin que se duerma la pantalla.
- [ ] Si la conexión WebRTC no se establece en LAN (aislamiento de clientes o mDNS en la UDM), parar y volver a Lucas: plan B = go2rtc como relé (nuevo spec).

- [ ] **Step 6: Documentar (obligatorio según CLAUDE.md, justo tras el cambio)**

- `info/stacks.md`: nuevo stack `baby-monitor` (:8830, ruta `/Data/Docker/baby-monitor/`).
- `info/network.md`: `bebe.lhomelab.casa` → NPM .65 → LXC 118 :8830, solo LAN; entrada DNS en Pi-hole.
- `CHANGELOG.md`: entrada 2026-10-08 (nuevo stack, certificado DNS-01, límites conocidos).
- `CLAUDE.md`: añadir `baby-monitor :8830` a «Docker stacks activos» y actualizar la fecha de cabecera.

Luego:

```bash
python3 /Downloads/homelab-docs/scripts/check-context-consistency.py
cd /Downloads/homelab-docs && git add . && git commit -m "docs: add baby-monitor stack" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push
```
Expected: el script de consistencia sin errores.

- [ ] **Step 7: Cierre**

Usar `superpowers:verification-before-completion` (tests, cobertura y checklist del Step 5 con evidencia) y `superpowers:finishing-a-development-branch`. El repo `baby-monitor` es local: preguntar a Lucas si quiere crear remoto (Gitea en LXC 118 o GitHub privado).
