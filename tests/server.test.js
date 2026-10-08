import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createMonitorServer } from '../server.js';

const MESSAGE_TIMEOUT_MS = 2000;

function within(promise, ms = MESSAGE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for close')), ms).unref()),
  ]);
}

function openClient(port, role, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`, options);
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

async function fixture(t, serverOptions = {}) {
  const server = createMonitorServer(serverOptions);
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
    client(role, options) {
      const c = openClient(port, role, options);
      clients.push(c);
      return c;
    },
  };
}

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'],
        nosniff: res.headers['x-content-type-options'],
        cache: res.headers['cache-control'],
        body: Buffer.concat(chunks).toString(),
      }));
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

  for (const path of ['/server.js', '/lib/room.js', '/../server.js', '/%2e%2e/server.js', '/package.json',
    '/public/logic.js', '/..%2Fpublic%2Flogic.js', '/public/../public/logic.js']) {
    assert.equal((await get(port, path)).status, 404, path);
  }
});

test('root serves the landing page as html', async (t) => {
  const { port } = await fixture(t);
  const res = await get(port, '/');

  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/html; charset=utf-8');
  assert.equal(res.cache, 'no-store');
});

test('home.js is served as javascript', async (t) => {
  const { port } = await fixture(t);
  const res = await get(port, '/home.js');

  assert.equal(res.status, 200);
  assert.equal(res.type, 'text/javascript; charset=utf-8');
});

test('api/status answers json with no-store and nothing but the two flags', async (t) => {
  const { port } = await fixture(t);
  const res = await get(port, '/api/status');

  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json; charset=utf-8');
  assert.equal(res.cache, 'no-store');
  assert.equal(res.nosniff, 'nosniff');
  assert.deepEqual(JSON.parse(res.body), { camara: false, monitor: false });
  assert.equal((await get(port, '/api/status', 'HEAD')).status, 200);
});

test('api/status follows camera and monitor joining and leaving', async (t) => {
  const f = await fixture(t);
  const status = async () => JSON.parse((await get(f.port, '/api/status')).body);

  const camara = f.client('camara');
  await camara.opened;
  await camara.next();
  assert.deepEqual(await status(), { camara: true, monitor: false });

  const monitor = f.client('monitor');
  await monitor.opened;
  await monitor.next();
  assert.deepEqual(await status(), { camara: true, monitor: true });

  camara.ws.close();
  assert.deepEqual(await monitor.next(), { type: 'peer-left' });
  assert.deepEqual(await status(), { camara: false, monitor: true });
});

test('api/status rejects POST with 405', async (t) => {
  const { port } = await fixture(t);

  assert.equal((await get(port, '/api/status', 'POST')).status, 405);
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

test('an invalid role receiving a large frame does not crash the server', async (t) => {
  const f = await fixture(t);
  const intruder = f.client('abuela');
  intruder.ws.once('open', () => intruder.ws.send('x'.repeat(70 * 1024)));
  await intruder.closed;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await get(f.port, '/healthz')).status, 200);
});

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

test('rejects a websocket whose Origin host differs from Host with 4403', async (t) => {
  const f = await fixture(t);
  const monitor = f.client('monitor');
  await monitor.opened;
  assert.deepEqual(await monitor.next(), { type: 'welcome', peer: false });

  const evil = f.client('camara', { headers: { Origin: 'https://evil.example' } });
  evil.ws.on('error', () => {});

  assert.equal(await within(evil.closed), 4403);
  await assert.rejects(monitor.next(300), /timeout/);
});

test('accepts a websocket whose Origin host equals the Host header', async (t) => {
  const f = await fixture(t);
  const camara = f.client('camara', { headers: { Origin: `http://127.0.0.1:${f.port}` } });
  await camara.opened;

  assert.deepEqual(await camara.next(), { type: 'welcome', peer: false });
});

test('rejects a websocket with an unparseable Origin', async (t) => {
  const f = await fixture(t);
  const bad = f.client('camara', { headers: { Origin: 'not a url' } });
  bad.ws.on('error', () => {});

  assert.equal(await within(bad.closed), 4403);
});

test('heartbeat terminates a client that stops answering pings and notifies the peer', async (t) => {
  const f = await fixture(t, { heartbeatMs: 50 });
  const monitor = f.client('monitor');
  await monitor.opened;
  assert.deepEqual(await monitor.next(), { type: 'welcome', peer: false });
  const camara = f.client('camara', { autoPong: false });
  await camara.opened;
  assert.deepEqual(await monitor.next(), { type: 'peer-joined' });

  await within(camara.closed);

  assert.deepEqual(await monitor.next(), { type: 'peer-left' });
});

test('heartbeat keeps a normal client connected across several rounds', async (t) => {
  const f = await fixture(t, { heartbeatMs: 50 });
  const monitor = f.client('monitor');
  await monitor.opened;
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(monitor.ws.readyState, 1);
});

test('a malformed request target answers 400 and static files are nosniff', async (t) => {
  const { port } = await fixture(t);

  assert.equal((await get(port, '//')).status, 400);
  assert.equal((await get(port, '/camara')).nosniff, 'nosniff');
});
