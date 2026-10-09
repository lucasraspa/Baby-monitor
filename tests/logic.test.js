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
  renegotiationDelayMs,
  describeStatus,
  DEFAULT_FACING,
  normalizeFacing,
  otherFacing,
  videoConstraints,
  mediaConstraints,
  applyAudioSessionType,
  CAPTURE_AUDIO_SESSION,
  RENEGOTIATE_AFTER_DISCONNECT_MS,
  CRY_LEVEL,
  CRY_WINDOW,
  CRY_MIN_LOUD,
  CRY_CLEAR_QUIET,
  initialCryState,
  trackCry,
  monitorStatus,
  fullscreenMode,
  rmsLevel,
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
  assert.equal(describeMediaError({ name: 'OverconstrainedError' }), 'Este dispositivo no tiene esa cámara.');
});

test('renegotiationDelayMs retries immediately on failed', () => {
  assert.equal(renegotiationDelayMs('failed'), 0);
});

test('renegotiationDelayMs waits before retrying on disconnected', () => {
  assert.equal(RENEGOTIATE_AFTER_DISCONNECT_MS, 3000);
  assert.equal(renegotiationDelayMs('disconnected'), RENEGOTIATE_AFTER_DISCONNECT_MS);
});

test('renegotiationDelayMs does not retry in other states', () => {
  for (const state of ['new', 'connecting', 'connected', 'closed', undefined]) {
    assert.equal(renegotiationDelayMs(state), null, String(state));
  }
});

test('trackFrames treats a decreasing counter as a reset and progress', () => {
  const old = trackFrames(initialFrameState(0), 5000, 100);

  const reset = trackFrames(old, 3, 9000);

  assert.deepEqual(reset, { frames: 3, advancedAt: 9000 });
  assert.deepEqual(old, { frames: 5000, advancedAt: 100 });
});

test('describeStatus without a server answer is unknown for both roles', () => {
  const unknown = 'Sin conexión con el servidor';

  assert.deepEqual(describeStatus(null), {
    cameraText: unknown, cameraDot: 'unknown', cameraWarning: '',
    monitorText: unknown, monitorDot: 'unknown', monitorWarning: '',
  });
});

test('describeStatus with an active camera warns before replacing it', () => {
  const d = describeStatus({ camara: true, monitor: false });

  assert.equal(d.cameraText, 'Cámara: activa');
  assert.equal(d.cameraDot, 'on');
  assert.equal(d.cameraWarning, 'Ya hay una cámara conectada. Si entras, la sustituirás.');
  assert.equal(d.monitorText, 'Monitor: sin monitor');
  assert.equal(d.monitorDot, 'off');
  assert.equal(d.monitorWarning, '');
});

test('describeStatus with no camera tells the monitor it will connect later', () => {
  const d = describeStatus({ camara: false, monitor: false });

  assert.equal(d.cameraText, 'Cámara: sin cámara');
  assert.equal(d.cameraDot, 'off');
  assert.equal(d.cameraWarning, '');
  assert.equal(d.monitorWarning, 'Aún no hay cámara: se conectará solo cuando aparezca.');
});

test('describeStatus with an active monitor warns about replacing it', () => {
  const d = describeStatus({ camara: true, monitor: true });

  assert.equal(d.monitorText, 'Monitor: activo');
  assert.equal(d.monitorDot, 'on');
  assert.equal(d.monitorWarning, 'Ya hay un monitor conectado. Si entras, lo sustituirás.');
});

test('describeStatus gives the replace warning priority over the no-camera hint', () => {
  const d = describeStatus({ camara: false, monitor: true });

  assert.equal(d.monitorWarning, 'Ya hay un monitor conectado. Si entras, lo sustituirás.');
  assert.equal(d.cameraDot, 'off');
});

test('describeStatus returns a new object each call', () => {
  assert.notEqual(describeStatus(null), describeStatus(null));
});

test('normalizeFacing keeps valid values and defaults everything else', () => {
  assert.equal(DEFAULT_FACING, 'environment');
  assert.equal(normalizeFacing('user'), 'user');
  assert.equal(normalizeFacing('environment'), 'environment');
  for (const bad of [null, undefined, '', 'left', 42, {}]) {
    assert.equal(normalizeFacing(bad), 'environment');
  }
});

test('otherFacing returns the opposite of the normalized value', () => {
  assert.equal(otherFacing('user'), 'environment');
  assert.equal(otherFacing('environment'), 'user');
  assert.equal(otherFacing('garbage'), 'user');
});

test('videoConstraints is ideal by default and exact when strict', () => {
  const soft = videoConstraints('user');
  const strict = videoConstraints('user', true);

  assert.deepEqual(soft, {
    facingMode: { ideal: 'user' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 15, max: 24 },
  });
  assert.deepEqual(strict.facingMode, { exact: 'user' });
  assert.deepEqual(videoConstraints('nonsense').facingMode, { ideal: 'environment' });
  assert.notEqual(videoConstraints('user'), soft);
  assert.notEqual(videoConstraints('user').frameRate, soft.frameRate);
});

test('mediaConstraints combines non-strict video with the unchanged audio settings', () => {
  const c = mediaConstraints('environment');

  assert.deepEqual(c.video, videoConstraints('environment'));
  assert.deepEqual(c.audio, { echoCancellation: false, noiseSuppression: false, autoGainControl: true });
  assert.notEqual(mediaConstraints('environment'), c);
  assert.notEqual(mediaConstraints('environment').audio, c.audio);
});

test('applyAudioSessionType sets the type and reports success', () => {
  const nav = { audioSession: { type: 'playback' }, other: 1 };

  assert.equal(CAPTURE_AUDIO_SESSION, 'play-and-record');
  assert.equal(applyAudioSessionType(nav, CAPTURE_AUDIO_SESSION), true);
  assert.equal(nav.audioSession.type, 'play-and-record');
  assert.equal(nav.other, 1);
});

test('applyAudioSessionType returns false without an audioSession', () => {
  assert.equal(applyAudioSessionType({}, 'play-and-record'), false);
  assert.equal(applyAudioSessionType(undefined, 'play-and-record'), false);
  assert.equal(applyAudioSessionType(null, 'play-and-record'), false);
});

test('applyAudioSessionType returns false when the assignment throws', () => {
  const audioSession = {};
  Object.defineProperty(audioSession, 'type', { set() { throw new TypeError('nope'); } });

  assert.equal(applyAudioSessionType({ audioSession }, 'play-and-record'), false);
});

const feed = (state, levels) => levels.reduce(trackCry, state);
const LOUD = CRY_LEVEL + 0.05;

test('trackCry starts not crying and ignores a single loud tick', () => {
  const state = feed(initialCryState(), [LOUD]);
  assert.equal(state.crying, false);
});

test('trackCry flags crying once enough ticks in the window are loud', () => {
  const loud = Array(CRY_MIN_LOUD).fill(LOUD);
  assert.equal(feed(initialCryState(), loud).crying, true);
});

test('trackCry does not flag sparse loud ticks (a door slam, not crying)', () => {
  const sparse = [LOUD, 0, 0, LOUD, 0, 0, LOUD, 0, 0, LOUD, 0, 0];
  assert.equal(feed(initialCryState(), sparse).crying, false);
});

test('trackCry keeps crying through short pauses between sobs', () => {
  const crying = feed(initialCryState(), Array(CRY_MIN_LOUD).fill(LOUD));
  assert.equal(feed(crying, Array(CRY_CLEAR_QUIET - 1).fill(0)).crying, true);
});

test('trackCry clears after sustained quiet', () => {
  const crying = feed(initialCryState(), Array(CRY_MIN_LOUD).fill(LOUD));
  assert.equal(feed(crying, Array(CRY_WINDOW + CRY_CLEAR_QUIET).fill(0)).crying, false);
});

test('trackCry treats missing audio level as silence', () => {
  const crying = feed(initialCryState(), Array(CRY_MIN_LOUD).fill(LOUD));
  assert.equal(feed(crying, Array(CRY_WINDOW + CRY_CLEAR_QUIET).fill(null)).crying, false);
});

test('trackCry returns a new state and never mutates the previous one', () => {
  const before = initialCryState();
  const snapshot = JSON.stringify(before);
  trackCry(before, LOUD);
  assert.equal(JSON.stringify(before), snapshot);
});

test('monitorStatus reports cry only while the stream is live', () => {
  assert.equal(monitorStatus('live', true), 'cry');
  assert.equal(monitorStatus('live', false), 'live');
  assert.equal(monitorStatus('lost', true), 'lost');
  assert.equal(monitorStatus('reconnecting', true), 'reconnecting');
});

test('fullscreenMode uses the native API when the element supports it', () => {
  assert.equal(fullscreenMode({ requestFullscreen() {} }), 'native');
  assert.equal(fullscreenMode({ webkitRequestFullscreen() {} }), 'native');
});

test('fullscreenMode falls back to immersive where only video can go fullscreen (iPhone)', () => {
  assert.equal(fullscreenMode({}), 'immersive');
  assert.equal(fullscreenMode(null), 'immersive');
});

test('rmsLevel is 0 for silence and for no samples', () => {
  assert.equal(rmsLevel(new Float32Array(8)), 0);
  assert.equal(rmsLevel(new Float32Array(0)), 0);
});

test('rmsLevel of a full-scale square wave is 1', () => {
  assert.equal(rmsLevel(Float32Array.from([1, -1, 1, -1])), 1);
});

test('rmsLevel of a half-amplitude square wave is 0.5', () => {
  assert.equal(rmsLevel(Float32Array.from([0.5, -0.5, 0.5, -0.5])), 0.5);
});
