export const ROLES = ['camara', 'monitor'];
export const REPLACED_CODE = 4000;

const otherRole = (role) => (role === 'camara' ? 'monitor' : 'camara');

export function createRoom() {
  const clients = { camara: null, monitor: null };

  function join(role, client) {
    if (!ROLES.includes(role)) {
      throw new Error(`rol inválido: ${role}`);
    }
    const previous = clients[role];
    clients[role] = client;
    if (previous && previous !== client) {
      previous.close(REPLACED_CODE, 'replaced');
    }
    const peer = clients[otherRole(role)];
    client.send(JSON.stringify({ type: 'welcome', peer: Boolean(peer) }));
    peer?.send(JSON.stringify({ type: 'peer-joined' }));
  }

  function leave(role, client) {
    if (clients[role] !== client) {
      return;
    }
    clients[role] = null;
    clients[otherRole(role)]?.send(JSON.stringify({ type: 'peer-left' }));
  }

  function relay(role, message) {
    const peer = clients[otherRole(role)];
    if (!peer) {
      return false;
    }
    peer.send(JSON.stringify(message));
    return true;
  }

  function status() {
    return { camara: clients.camara !== null, monitor: clients.monitor !== null };
  }

  return { join, leave, relay, status };
}
