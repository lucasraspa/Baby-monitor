import { connectSignal, serialize } from './signal.js';
import {
  classify,
  initialFrameState,
  trackFrames,
  isStalled,
  initialCryState,
  trackCry,
  monitorStatus,
  fullscreenMode,
} from './logic.js';

const TICK_MS = 1000;
const ALARM_BEEP_HZ = { lost: 880, cry: 520 };
const ALARM_BEEP_SECONDS = 0.3;
const ALARM_BEEP_GAIN = 0.3;
const REPLACED_CLOSE_CODE = 4000;
const LABELS = {
  waiting: 'Esperando cámara…',
  live: 'En directo',
  reconnecting: 'Reconectando…',
  cry: 'Llanto detectado',
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
let beepInFlight = false;
let playPending = false;
let displaced = false;
let everLive = false;
let downSince = null;
let frameState = initialFrameState(Date.now());
let cryState = initialCryState();
let alarmKind = null;

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
  if (!audioCtx || alarmSilenced || beepInFlight) {
    return;
  }
  beepInFlight = true;
  try {
    await resumeAudio();
    if (alarmTimer === null || alarmSilenced || audioCtx.state !== 'running') {
      return;
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = ALARM_BEEP_HZ[alarmKind] ?? ALARM_BEEP_HZ.lost;
    gain.gain.value = ALARM_BEEP_GAIN;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ALARM_BEEP_SECONDS);
  } finally {
    beepInFlight = false;
  }
}

function setAlarm(kind) {
  const active = kind !== null;
  if (active && alarmKind !== null && kind !== alarmKind) {
    alarmSilenced = false;
    el('alarm-off').textContent = 'Silenciar alarma';
    el('alarm-off').disabled = false;
  }
  if (active && kind !== alarmKind) {
    document.body.classList.remove('immersive'); // show the silence button once per alert, not every tick
  }
  alarmKind = kind;
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
  setAlarm(status === 'lost' || status === 'cry' ? status : null);
}

function closePeer() {
  pc?.close();
  pc = null;
  frameState = initialFrameState(Date.now());
  cryState = initialCryState();
}

async function readStats(peer) {
  if (!peer) {
    return { frames: null, audioLevel: null };
  }
  const stats = { frames: null, audioLevel: null };
  (await peer.getStats()).forEach((report) => {
    if (report.type !== 'inbound-rtp') {
      return;
    }
    if (report.kind === 'video') {
      stats.frames = report.framesDecoded ?? 0;
    } else if (report.kind === 'audio') {
      stats.audioLevel = report.audioLevel ?? null;
    }
  });
  return stats;
}

async function tick() {
  const now = Date.now();
  const peer = pc;
  const { frames, audioLevel } = await readStats(peer);
  if (pc !== peer || displaced) {
    return;
  }
  if (frames !== null) {
    frameState = trackFrames(frameState, frames, now);
  }
  const advancing = frames !== null && frames > 0 && !isStalled(frameState, now);
  if (advancing && el('video').paused) {
    playVideo();
  }
  const flowing = advancing && !el('video').paused;
  if (flowing) {
    everLive = true;
    downSince = null;
  } else if (everLive && downSince === null) {
    downSince = now;
  }
  cryState = trackCry(cryState, flowing ? audioLevel : null);
  const connection = classify({ everLive, flowing, downMs: downSince === null ? 0 : now - downSince });
  render(monitorStatus(connection, cryState.crying));
}

function handleDisplaced() {
  displaced = true;
  clearInterval(tickTimer);
  tickTimer = null;
  closePeer();
  el('video').srcObject = null;
  setAlarm(null);
  render('displaced');
}

function playVideo() {
  if (playPending) {
    return;
  }
  playPending = true;
  el('video').play().then(
    () => { el('overlay').hidden = true; },
    () => { el('overlay').hidden = false; },
  ).finally(() => { playPending = false; });
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

function toggleFullscreen() {
  const stage = el('stage');
  const mode = fullscreenMode(stage, el('video'));
  if (mode === 'video') {
    try {
      el('video').webkitEnterFullscreen();
    } catch (err) {
      console.error('fullscreen', err);
      document.body.classList.add('immersive');
    }
    return;
  }
  if (mode === 'immersive') {
    document.body.classList.toggle('immersive');
    return;
  }
  const active = document.fullscreenElement ?? document.webkitFullscreenElement;
  if (active) {
    (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    return;
  }
  const request = stage.requestFullscreen ?? stage.webkitRequestFullscreen;
  Promise.resolve(request.call(stage)).catch(() => document.body.classList.add('immersive'));
}

el('connect').addEventListener('click', connect);
el('fullscreen').addEventListener('click', toggleFullscreen);
el('stage').addEventListener('click', (event) => {
  if (document.body.classList.contains('immersive') && !event.target.closest('#bar')) {
    document.body.classList.remove('immersive');
  }
});
el('play').addEventListener('click', () => { el('video').muted = false; playVideo(); });
el('mute').addEventListener('click', () => {
  const video = el('video');
  video.muted = !video.muted;
  el('mute').textContent = video.muted ? '🔇' : '🔊';
});
el('video').addEventListener('pause', () => {
  if (signal && !displaced) {
    playVideo();
  }
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
