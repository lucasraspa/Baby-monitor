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
