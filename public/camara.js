import { connectSignal, serialize } from './signal.js';
import { describeMediaError, renegotiationDelayMs } from './logic.js';

const MEDIA_CONSTRAINTS = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
};

const el = (id) => document.getElementById(id);
const setStatus = (text) => { el('status').textContent = text; };

let stream = null;
let pc = null;
let signal = null;
let retryTimer = null;

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
  clearTimeout(retryTimer);
  retryTimer = null;
  pc?.close();
  pc = null;
}

async function startOffer() {
  closePeer();
  pc = new RTCPeerConnection({ iceServers: [] });
  const peer = pc;
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signal.send({ type: 'candidate', candidate: event.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
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
