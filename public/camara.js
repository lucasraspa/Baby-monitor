import { connectSignal, serialize } from './signal.js';
import { describeMediaError, renegotiationDelayMs } from './logic.js';

const MEDIA_CONSTRAINTS = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
};

const REPLACED_CLOSE_CODE = 4000;

const el = (id) => document.getElementById(id);
const setStatus = (text) => { el('status').textContent = text; };

let stream = null;
let pc = null;
let signal = null;
let retryTimer = null;
let wakeLock = null;

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
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  setStatus('Otra cámara está activa — recarga para recuperarla');
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
  signal = connectSignal('camara', { onMessage: serialize(handleMessage), onClose: handleSignalClose });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stream && (!wakeLock || wakeLock.released)) {
    acquireWakeLock();
  }
});
el('start').addEventListener('click', start);
