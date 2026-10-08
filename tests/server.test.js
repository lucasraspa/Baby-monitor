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
