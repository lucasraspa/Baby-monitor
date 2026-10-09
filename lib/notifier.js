export const CAMERA_LOST_AFTER_MS = 15000;
export const CRY_COOLDOWN_MS = 120000;
const TITLE = 'Baby monitor';
const NTFY_TIMEOUT_MS = 5000;

export function createNtfySender({ url, topic, token, fetchImpl = fetch } = {}) {
  if (!url || !topic) {
    return async () => {};
  }
  const endpoint = `${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
  return async ({ title, message, priority = 'default' }) => {
    const headers = { Title: title, Priority: priority };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetchImpl(endpoint, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(NTFY_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`ntfy respondió ${res.status}`);
    }
  };
}

export function createNotifier({
  send,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  lostAfterMs = CAMERA_LOST_AFTER_MS,
  cryCooldownMs = CRY_COOLDOWN_MS,
}) {
  let lostTimer = null;
  let lostNotified = false;
  let lastCryAt = null;

  const logFailure = (err) => console.error('no se pudo enviar la notificación', err.message);

  function push(message, priority) {
    try {
      Promise.resolve(send({ title: TITLE, message, priority })).catch(logFailure);
    } catch (err) {
      logFailure(err);
    }
  }

  function cameraJoined() {
    clearTimer(lostTimer);
    lostTimer = null;
    if (lostNotified) {
      lostNotified = false;
      push('Cámara recuperada', 'default');
    }
  }

  function cameraLeft() {
    clearTimer(lostTimer);
    lostTimer = setTimer(() => {
      lostTimer = null;
      lostNotified = true;
      push('Cámara desconectada: revisa el iPad', 'high');
    }, lostAfterMs);
  }

  function cryChanged(crying) {
    if (!crying) {
      return;
    }
    const at = now();
    if (lastCryAt !== null && at - lastCryAt < cryCooldownMs) {
      return;
    }
    lastCryAt = at;
    push('Llanto detectado', 'high');
  }

  return { cameraJoined, cameraLeft, cryChanged };
}
