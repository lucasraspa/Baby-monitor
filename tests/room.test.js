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

test('status reports no roles in an empty room', () => {
  assert.deepEqual(createRoom().status(), { camara: false, monitor: false });
});

test('status reports a role after it joins and clears it after it leaves', () => {
  const room = createRoom();
  const camara = fakeClient();
  const monitor = fakeClient();

  room.join('camara', camara);
  assert.deepEqual(room.status(), { camara: true, monitor: false });
  room.join('monitor', monitor);
  assert.deepEqual(room.status(), { camara: true, monitor: true });
  room.leave('camara', camara);
  assert.deepEqual(room.status(), { camara: false, monitor: true });
});

test('status stays true after a replacement and ignores the replaced client leaving', () => {
  const room = createRoom();
  const first = fakeClient();
  const second = fakeClient();
  room.join('camara', first);
  room.join('camara', second);
  room.leave('camara', first);

  assert.deepEqual(room.status(), { camara: true, monitor: false });
});

test('status returns a new object each call', () => {
  const room = createRoom();
  const a = room.status();
  a.camara = true;

  assert.notEqual(room.status(), a);
  assert.deepEqual(room.status(), { camara: false, monitor: false });
});
