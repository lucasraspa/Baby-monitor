import { describeStatus } from './logic.js';

const HOME_POLL_MS = 3000;

const el = (id) => document.getElementById(id);

function render(description) {
  el('camera-text').textContent = description.cameraText;
  el('camera-dot').dataset.state = description.cameraDot;
  el('camera-warning').textContent = description.cameraWarning;
  el('camera-warning').hidden = description.cameraWarning === '';
  el('monitor-text').textContent = description.monitorText;
  el('monitor-dot').dataset.state = description.monitorDot;
  el('monitor-warning').textContent = description.monitorWarning;
  el('monitor-warning').hidden = description.monitorWarning === '';
}

function isValidStatus(body) {
  return body !== null && typeof body === 'object'
    && typeof body.camara === 'boolean' && typeof body.monitor === 'boolean';
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) {
      return null;
    }
    const body = await res.json();
    return isValidStatus(body) ? { camara: body.camara, monitor: body.monitor } : null;
  } catch {
    return null;
  }
}

async function poll() {
  render(describeStatus(await fetchStatus()));
  setTimeout(poll, HOME_POLL_MS);
}

poll();
