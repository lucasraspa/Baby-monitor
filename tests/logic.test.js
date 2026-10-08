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
