import { connectSignal, serialize } from './signal.js';
import {
  CAPTURE_AUDIO_SESSION,
  applyAudioSessionType,
  describeMediaError,
  mediaConstraints,
  normalizeFacing,
  otherFacing,
  initialCryState,
  normalizeThreshold,
  renegotiationDelayMs,
  rmsLevel,
  trackCry,
  videoConstraints,
} from './logic.js';

const FACING_STORAGE_KEY = 'camara.facing';
const FACING_LABELS = { environment: 'Cámara trasera', user: 'Cámara frontal' };
const RESTORE_FAILED_TEXT = 'No se pudo recuperar la cámara: recarga la página';

const REPLACED_CLOSE_CODE = 4000;
const THRESHOLD_STORAGE_KEY = 'camara.cryThreshold';
const METER_FULL_SCALE = 0.3;
const CRY_SAMPLE_MS = 1000;
const CRY_ANALYSER_FFT = 32768;

const el = (id) => document.getElementById(id);
const setStatus = (text) => { el('status').textContent = text; };

let stream = null;
let pc = null;
let signal = null;
let retryTimer = null;
let wakeLock = null;
let facing = readStoredFacing();
let audioCtx = null;
let cryState = initialCryState();
let cryTimer = null;
let threshold = readStoredThreshold();

function readStoredFacing() {
  try {
    return normalizeFacing(localStorage.getItem(FACING_STORAGE_KEY));
  } catch {
    return normalizeFacing(null);
  }
}

function storeFacing(value) {
  try {
    localStorage.setItem(FACING_STORAGE_KEY, value);
  } catch (err) {
    console.error('localStorage', err);
  }
}

function readStoredThreshold() {
  try {
    return normalizeThreshold(localStorage.getItem(THRESHOLD_STORAGE_KEY));
  } catch {
    return normalizeThreshold(null);
  }
}

function chooseThreshold(value) {
  threshold = normalizeThreshold(value);
  try {
    localStorage.setItem(THRESHOLD_STORAGE_KEY, String(threshold));
  } catch (err) {
    console.error('localStorage', err);
  }
  renderThreshold();
}

function renderThreshold() {
  el('threshold').value = String(threshold);
  el('threshold-text').textContent = threshold.toFixed(3);
  el('meter-mark').style.left = `${Math.min(100, (threshold / METER_FULL_SCALE) * 100)}%`;
}

function renderLevel(level, crying) {
  el('meter-fill').style.width = `${Math.min(100, (level / METER_FULL_SCALE) * 100)}%`;
  el('level-text').textContent = `Nivel ${level.toFixed(3)}`;
  el('cry-text').textContent = crying ? 'LLANTO' : 'Sin llanto';
}

function renderFacing() {
  document.querySelectorAll('[data-facing]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.facing === facing));
  });
  el('facing-label').textContent = FACING_LABELS[facing];
}

function chooseFacing(value) {
  facing = normalizeFacing(value);
  storeFacing(facing);
  renderFacing();
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    el('wakewarn').hidden = false;
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    wakeLock = sentinel;
    sentinel.addEventListener('release', () => {
      if (document.visibilityState === 'visible' && stream) {
        acquireWakeLock();
      }
    });
  } catch (err) {
    console.error('wakeLock', err);
    el('wakewarn').hidden = false;
  }
}

function closePeer() {
  clearTimeout(retryTimer);
  retryTimer = null;
  pc?.close();
  pc = null;
}

async function startOffer() {
  closePeer();
  if (!stream) {
    return;
  }
  const peer = new RTCPeerConnection({ iceServers: [] });
  pc = peer;
  stream.getTracks().forEach((track) => peer.addTrack(track, stream));
  peer.onicecandidate = (event) => {
    if (event.candidate && peer === pc) {
      signal.send({ type: 'candidate', candidate: event.candidate });
    }
  };
  peer.onconnectionstatechange = () => {
    if (peer !== pc) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
    setStatus(peer.connectionState === 'connected' ? 'Monitor conectado' : 'Conectando con el monitor…');
    const delay = renegotiationDelayMs(peer.connectionState);
    if (delay !== null) {
      retryTimer = setTimeout(() => startOffer().catch((err) => console.error('renegociación', err)), delay);
    }
  };
  const offer = await peer.createOffer();
  if (peer !== pc) {
    return;
  }
  await peer.setLocalDescription(offer);
  if (peer !== pc) {
    return;
  }
  signal.send({ type: 'offer', sdp: peer.localDescription });
}

async function handleMessage(message) {
  const peer = pc;
  switch (message.type) {
    case 'welcome':
      if (cryState.crying) {
        signal.send({ type: 'cry', crying: true });
      }
      if (message.peer) {
        await startOffer();
      } else {
        setStatus('Esperando monitor…');
      }
      break;
    case 'peer-joined':
      if (cryState.crying) {
        signal.send({ type: 'cry', crying: true });
      }
      await startOffer();
      break;
    case 'peer-left':
      closePeer();
      setStatus('Esperando monitor…');
      break;
    case 'answer':
      await peer?.setRemoteDescription(message.sdp);
      break;
    case 'candidate':
      await peer?.addIceCandidate(message.candidate);
      break;
  }
}

function handleSignalClose(code) {
  if (code !== REPLACED_CLOSE_CODE) {
    setStatus('Sin conexión con el servidor…');
    return;
  }
  closePeer();
  clearInterval(cryTimer);
  cryTimer = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  setStatus('Otra cámara está activa — recarga para recuperarla');
}

function startCryWatch(source) {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = CRY_ANALYSER_FFT;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  cryTimer = setInterval(() => {
    audioCtx.resume().catch((err) => console.error('audio resume', err));
    analyser.getFloatTimeDomainData(samples);
    const level = rmsLevel(samples);
    const next = trackCry(cryState, level, threshold);
    if (next.crying !== cryState.crying) {
      signal?.send({ type: 'cry', crying: next.crying });
    }
    cryState = next;
    renderLevel(level, next.crying);
  }, CRY_SAMPLE_MS);
}

function createAudioContext() {
  // Must run synchronously inside the tap: iOS leaves later-created contexts suspended.
  try {
    audioCtx = new AudioContext();
    audioCtx.resume().catch((err) => console.error('audio resume', err));
  } catch (err) {
    console.error('AudioContext no disponible', err);
    audioCtx = null;
  }
}

function setUpCryWatch() {
  if (!audioCtx) {
    el('cry-text').textContent = 'Detección de llanto NO disponible';
    return;
  }
  try {
    startCryWatch(audioCtx.createMediaStreamSource(stream));
  } catch (err) {
    console.error('detección de llanto no disponible', err);
    el('cry-text').textContent = 'Detección de llanto NO disponible';
  }
}

async function start() {
  createAudioContext();
  el('start').disabled = true;
  el('error').hidden = true;
  try {
    applyAudioSessionType(navigator, CAPTURE_AUDIO_SESSION);
    stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(facing));
  } catch (err) {
    el('error').textContent = describeMediaError(err);
    el('error').hidden = false;
    el('start').disabled = false;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    return;
  }
  el('preview').srcObject = stream;
  el('intro').hidden = true;
  el('running').hidden = false;
  await acquireWakeLock();
  signal = connectSignal('camara', { onMessage: serialize(handleMessage), onClose: handleSignalClose });
  setUpCryWatch();
}

function showSwitchError(text) {
  el('switch-error').textContent = text;
  el('switch-error').hidden = text === '';
}

function findVideoSender(oldTrack) {
  const senders = pc?.getSenders() ?? [];
  return senders.find((sender) => sender.track === oldTrack)
    ?? senders.find((sender) => sender.track?.kind === 'video');
}

async function adoptVideoTrack(current, oldTrack, fresh) {
  // The sender keeps the stopped (ended) track, so look it up now, in the current pc.
  await findVideoSender(oldTrack)?.replaceTrack(fresh);
  current.removeTrack(oldTrack);
  current.addTrack(fresh);
  el('preview').srcObject = current;
  el('preview').play?.().catch(() => {});
}

async function acquireVideoTrack(constraints) {
  applyAudioSessionType(navigator, CAPTURE_AUDIO_SESSION);
  const media = await navigator.mediaDevices.getUserMedia({ video: constraints });
  return media.getVideoTracks()[0];
}

async function replaceWith(current, oldTrack, constraints) {
  const fresh = await acquireVideoTrack(constraints);
  if (stream !== current) {
    fresh.stop();
    return false;
  }
  try {
    await adoptVideoTrack(current, oldTrack, fresh);
  } catch (err) {
    fresh.stop();
    throw err;
  }
  return true;
}

async function switchCamera() {
  const current = stream;
  const oldTrack = current?.getVideoTracks()[0];
  if (!oldTrack) {
    return;
  }
  const previous = facing;
  const next = otherFacing(previous);
  el('switch').disabled = true;
  showSwitchError('');
  oldTrack.stop(); // iOS only allows one camera at a time: release it before asking for the other
  try {
    if (await replaceWith(current, oldTrack, videoConstraints(next, true))) {
      chooseFacing(next);
    }
  } catch (err) {
    showSwitchError(describeMediaError(err));
    await restoreCamera(current, oldTrack, previous);
  } finally {
    el('switch').disabled = false;
  }
}

async function restoreCamera(current, oldTrack, previous) {
  try {
    await replaceWith(current, oldTrack, videoConstraints(previous));
  } catch (err) {
    console.error('restaurar cámara', err);
    showSwitchError(RESTORE_FAILED_TEXT);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stream && (!wakeLock || wakeLock.released)) {
    acquireWakeLock();
  }
});
el('start').addEventListener('click', start);
el('switch').addEventListener('click', switchCamera);
document.querySelectorAll('[data-facing]').forEach((button) => {
  button.addEventListener('click', () => chooseFacing(button.dataset.facing));
});
el('threshold').addEventListener('input', (event) => chooseThreshold(event.target.value));
renderFacing();
renderThreshold();
