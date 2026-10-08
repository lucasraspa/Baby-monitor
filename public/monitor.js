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
const REPLACED_CLOSE_CODE = 4000;
const LABELS = {
  waiting: 'Esperando cámara…',
  live: 'En directo',
  reconnecting: 'Reconectando…',
  lost: 'SIN SEÑAL — revisa el iPad',
  displaced: 'Otro monitor ha tomado el control — recarga para recuperarlo',
};

const el = (id) => document.getElementById(id);

let pc = null;
let signal = null;
let audioCtx = null;
let alarmTimer = null;
let tickTimer = null;
let wakeLock = null;
let alarmSilenced = false;
let displaced = false;
let everLive = false;
let downSince = null;
let frameState = initialFrameState(Date.now());

function updateAudioWarning() {
  const needed = alarmTimer !== null && !alarmSilenced && audioCtx !== null && audioCtx.state !== 'running';
  el('audio-warning').hidden = !needed;
}

async function resumeAudio() {
  if (!audioCtx || audioCtx.state === 'running' || audioCtx.state === 'closed') {
    return;
  }
  try {
    await audioCtx.resume();
  } catch (err) {
    console.error('audio resume', err);
  }
  updateAudioWarning();
}

async function beep() {
  if (!audioCtx || alarmSilenced) {
    return;
  }
  await resumeAudio();
  if (audioCtx.state !== 'running') {
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
    alarmTimer = setInterval(beep, 1000);
    beep();
  }
  if (!active && alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
    alarmSilenced = false;
    el('alarm-off').textContent = 'Silenciar alarma';
    el('alarm-off').disabled = false;
  }
  updateAudioWarning();
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

async function readFrames(peer) {
  if (!peer) {
    return null;
  }
  let frames = null;
  (await peer.getStats()).forEach((report) => {
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      frames = report.framesDecoded ?? 0;
    }
  });
  return frames;
}

async function tick() {
  const now = Date.now();
  const peer = pc;
  const frames = await readFrames(peer);
  if (pc !== peer || displaced) {
    return;
  }
  if (frames !== null) {
    frameState = trackFrames(frameState, frames, now);
  }
  const flowing = frames !== null && frames > 0 && !isStalled(frameState, now) && !el('video').paused;
  if (flowing) {
    everLive = true;
    downSince = null;
  } else if (everLive && downSince === null) {
    downSince = now;
  }
  render(classify({ everLive, flowing, downMs: downSince === null ? 0 : now - downSince }));
}

function handleDisplaced() {
  displaced = true;
  clearInterval(tickTimer);
  tickTimer = null;
  closePeer();
  el('video').srcObject = null;
  setAlarm(false);
  render('displaced');
}

function playVideo() {
  el('video').play().then(
    () => { el('overlay').hidden = true; },
    () => { el('overlay').hidden = false; },
  );
}

async function handleOffer(message) {
  closePeer();
  const peer = new RTCPeerConnection({ iceServers: [] });
  pc = peer;
  peer.ontrack = (event) => {
    if (peer === pc) {
      el('video').srcObject = event.streams[0];
      playVideo();
    }
  };
  peer.onicecandidate = (event) => {
    if (event.candidate && peer === pc) {
      signal.send({ type: 'candidate', candidate: event.candidate });
    }
  };
  await peer.setRemoteDescription(message.sdp);
  const answer = await peer.createAnswer();
  if (peer !== pc) {
    return;
  }
  await peer.setLocalDescription(answer);
  if (peer !== pc) {
    return;
  }
  signal.send({ type: 'answer', sdp: peer.localDescription });
}

async function handleMessage(message) {
  const peer = pc;
  switch (message.type) {
    case 'offer':
      await handleOffer(message);
      break;
    case 'peer-left':
      closePeer();
      break;
    case 'candidate':
      await peer?.addIceCandidate(message.candidate);
      break;
  }
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    el('wakewarn-monitor').hidden = false;
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    wakeLock = sentinel;
    sentinel.addEventListener('release', () => {
      if (document.visibilityState === 'visible' && !displaced) {
        acquireWakeLock();
      }
    });
  } catch (err) {
    console.error('wakeLock', err);
    el('wakewarn-monitor').hidden = false;
  }
}

async function connect() {
  el('connect').disabled = true;
  if ('audioSession' in navigator) {
    navigator.audioSession.type = 'playback';
  }
  el('video').muted = false;
  el('video').play().catch(() => {});
  audioCtx = new AudioContext();
  audioCtx.onstatechange = () => {
    resumeAudio();
    updateAudioWarning();
  };
  await audioCtx.resume();
  el('intro').hidden = true;
  el('running').hidden = false;
  await acquireWakeLock();
  signal = connectSignal('monitor', {
    onMessage: serialize(handleMessage),
    onClose: (code) => { if (code === REPLACED_CLOSE_CODE) { handleDisplaced(); } },
  });
  tickTimer = setInterval(() => tick().catch((err) => console.error('tick', err)), TICK_MS);
}

el('connect').addEventListener('click', connect);
el('play').addEventListener('click', () => { el('video').muted = false; playVideo(); });
el('mute').addEventListener('click', () => {
  const video = el('video');
  video.muted = !video.muted;
  el('mute').textContent = video.muted ? '🔇' : '🔊';
});
el('audio-warning').addEventListener('click', resumeAudio);
el('alarm-off').addEventListener('click', () => {
  alarmSilenced = true;
  el('alarm-off').textContent = 'Alarma silenciada';
  el('alarm-off').disabled = true;
  updateAudioWarning();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !signal || displaced) {
    return;
  }
  resumeAudio();
  if (!wakeLock || wakeLock.released) {
    acquireWakeLock();
  }
});
