import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, createNtfySender, CAMERA_LOST_AFTER_MS, CRY_COOLDOWN_MS } from '../lib/notifier.js';

function harness(overrides = {}) {
  const sent = [];
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  const notifier = createNotifier({
    send: async (notification) => { sent.push(notification); },
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    ...overrides,
  });
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { notifier, sent, advance };
}

test('notifies once when the camera stays away past the grace period', () => {
  const { notifier, sent, advance } = harness();
  notifier.cameraJoined();
  notifier.cameraLeft();
  advance(CAMERA_LOST_AFTER_MS - 1);
  assert.equal(sent.length, 0);
  advance(1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Cámara desconectada/);
  assert.equal(sent[0].priority, 'high');
});

test('does not notify when the camera returns within the grace period', () => {
  const { notifier, sent, advance } = harness();
  notifier.cameraJoined();
  notifier.cameraLeft();
  advance(CAMERA_LOST_AFTER_MS - 1);
  notifier.cameraJoined();
  advance(CAMERA_LOST_AFTER_MS * 2);
  assert.equal(sent.length, 0);
});

test('announces recovery only after a lost notification', () => {
  const { notifier, sent, advance } = harness();
  notifier.cameraJoined();
  notifier.cameraLeft();
  advance(CAMERA_LOST_AFTER_MS);
  notifier.cameraJoined();
  assert.equal(sent.length, 2);
  assert.match(sent[1].message, /Cámara recuperada/);
  notifier.cameraJoined();
  assert.equal(sent.length, 2);
});

test('notifies on cry start and respects the cooldown', () => {
  const { notifier, sent, advance } = harness();
  notifier.cryChanged(true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Llanto detectado/);
  notifier.cryChanged(false);
  advance(CRY_COOLDOWN_MS - 1);
  notifier.cryChanged(true);
  assert.equal(sent.length, 1);
  advance(1);
  notifier.cryChanged(true);
  assert.equal(sent.length, 2);
});

test('does not notify when crying stops', () => {
  const { notifier, sent } = harness();
  notifier.cryChanged(false);
  assert.equal(sent.length, 0);
});

test('a failing sender never throws into the caller', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const { notifier } = harness({ send: async () => { throw new Error('ntfy down'); } });
    notifier.cryChanged(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
  }
});

test('ntfy sender posts the message with auth, title and priority', async () => {
  const calls = [];
  const send = createNtfySender({
    url: 'http://ntfy.local:2586', topic: 'bebe', token: 'tk_secret',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
  });
  await send({ title: 'Baby monitor', message: 'Llanto detectado', priority: 'high' });
  assert.equal(calls[0].url, 'http://ntfy.local:2586/bebe');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'Llanto detectado');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tk_secret');
  assert.equal(calls[0].init.headers.Priority, 'high');
  assert.equal(calls[0].init.headers.Title, 'Baby monitor');
});

test('ntfy sender is a no-op without url or topic', async () => {
  const calls = [];
  const send = createNtfySender({ fetchImpl: async (...a) => { calls.push(a); return { ok: true }; } });
  await send({ title: 't', message: 'm' });
  assert.equal(calls.length, 0);
});

test('ntfy sender rejects on a non-ok response so the failure gets logged', async () => {
  const send = createNtfySender({
    url: 'http://x', topic: 'bebe', fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  await assert.rejects(send({ title: 't', message: 'm' }), /403/);
});
