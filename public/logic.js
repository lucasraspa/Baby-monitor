export const STALL_THRESHOLD_MS = 6000;
export const LOST_AFTER_MS = 10000;
export const RENEGOTIATE_AFTER_DISCONNECT_MS = 3000;

const NO_SERVER_TEXT = 'Sin conexión con el servidor';

const NO_RECONNECT_CODES = [4000, 4400];

export function shouldReconnect(closeCode) {
  return !NO_RECONNECT_CODES.includes(closeCode);
}

export function initialFrameState(now) {
  return { frames: -1, advancedAt: now };
}

export function trackFrames(state, frames, now) {
  // A lower counter means a new connection (counter reset): that is progress too.
  return frames !== state.frames ? { frames, advancedAt: now } : state;
}

export function isStalled(state, now, thresholdMs = STALL_THRESHOLD_MS) {
  return now - state.advancedAt > thresholdMs;
}

export function classify({ everLive, flowing, downMs }) {
  if (flowing) {
    return 'live';
  }
  if (!everLive) {
    return 'waiting';
  }
  return downMs >= LOST_AFTER_MS ? 'lost' : 'reconnecting';
}

export function describeMediaError(err) {
  if (err.name === 'NotAllowedError') {
    return 'Safari no tiene permiso para la cámara o el micrófono. En Ajustes › Safari › Cámara y Micrófono elige «Permitir» y recarga la página.';
  }
  if (err.name === 'NotFoundError') {
    return 'No se encontró cámara o micrófono en este dispositivo.';
  }
  return `No se pudo iniciar la cámara: ${err.message ?? err.name}`;
}

export function renegotiationDelayMs(connectionState) {
  if (connectionState === 'failed') {
    return 0;
  }
  if (connectionState === 'disconnected') {
    return RENEGOTIATE_AFTER_DISCONNECT_MS;
  }
  return null;
}

function describeMonitorWarning(status) {
  if (status.monitor) {
    return 'Ya hay un monitor conectado. Si entras, lo sustituirás.';
  }
  return status.camara ? '' : 'Aún no hay cámara: se conectará solo cuando aparezca.';
}

export function describeStatus(status) {
  if (status === null) {
    return {
      cameraText: NO_SERVER_TEXT, cameraDot: 'unknown', cameraWarning: '',
      monitorText: NO_SERVER_TEXT, monitorDot: 'unknown', monitorWarning: '',
    };
  }
  return {
    cameraText: status.camara ? 'Cámara: activa' : 'Cámara: sin cámara',
    cameraDot: status.camara ? 'on' : 'off',
    cameraWarning: status.camara ? 'Ya hay una cámara conectada. Si entras, la sustituirás.' : '',
    monitorText: status.monitor ? 'Monitor: activo' : 'Monitor: sin monitor',
    monitorDot: status.monitor ? 'on' : 'off',
    monitorWarning: describeMonitorWarning(status),
  };
}
