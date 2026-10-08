import { shouldReconnect } from './logic.js';

const RECONNECT_DELAY_MS = 2000;

export function connectSignal(role, { onMessage, onOpen, onClose }) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}/ws?role=${role}`;
  let ws;
  let timer;
  let stopped = false;

  function open() {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => onOpen?.());
    ws.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('mensaje de señalización inválido', err);
      }
    });
    ws.addEventListener('close', (event) => {
      onClose?.(event.code);
      if (!stopped && shouldReconnect(event.code)) {
        timer = setTimeout(open, RECONNECT_DELAY_MS);
      }
    });
  }

  open();

  return {
    send(message) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}

export function serialize(handler) {
  let chain = Promise.resolve();
  return (message) => {
    chain = chain
      .then(() => handler(message))
      .catch((err) => console.error('error procesando', message.type, err));
    return chain;
  };
}
