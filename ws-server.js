import { WebSocketServer, WebSocket } from 'ws';
import { validateSession, getPresenceSubscriberIds } from './auth-db.js';

// Mapa de conexiones activas por usuario: userId -> Set<WebSocket>
const userSockets = new Map();
// Mapa de desconexiones diferidas (grace period de 3.5s anti-flapping para F5 o hipos de red): userId -> Timeout
const disconnectTimeouts = new Map();

let wss = null;

/**
 * Notifica un cambio de estado de presencia únicamente a contactos relevantes
 * (amigos mutuos confirmados y colaboradores de recursos compartidos)
 */
function notifyPresenceChange(userId, username, online) {
  try {
    const subscriberIds = getPresenceSubscriberIds(userId);
    if (!subscriberIds || subscriberIds.length === 0) return;
    sendToUsers(subscriberIds, 'USER_STATUS_CHANGED', {
      userId,
      username,
      online
    });
  } catch (err) {
    console.error('Error notificando cambio de presencia:', err);
  }
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    try {
      list[name] = decodeURIComponent(value);
    } catch {
      list[name] = value;
    }
  });
  return list;
}

/**
 * Inicializa el servidor WebSocket montado sobre el servidor HTTPS de Express
 */
export function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({
    server: httpServer,
    path: '/ws'
  });

  wss.on('connection', (ws, req) => {
    // 1. Extraer y validar sesión de cookies
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies.kortexa_token;

    // Alternativa: token por query param ?auth_token=...
    if (!token) {
      try {
        const url = new URL(req.url, 'https://localhost');
        token = url.searchParams.get('auth_token');
      } catch {}
    }

    if (!token) {
      ws.close(4001, 'Token de autenticación requerido');
      return;
    }

    const user = validateSession(token);
    if (!user) {
      ws.close(4001, 'Sesión inválida o expirada');
      return;
    }

    // Asociar usuario al socket
    ws.userId = user.id;
    ws.username = user.username;
    ws.isAlive = true;

    // Si había un temporizador de desconexión pendiente (por F5 o microcorte), cancelarlo
    const hadPendingDisconnect = disconnectTimeouts.has(user.id);
    if (hadPendingDisconnect) {
      clearTimeout(disconnectTimeouts.get(user.id));
      disconnectTimeouts.delete(user.id);
    }

    const wasOffline = !hadPendingDisconnect && (!userSockets.has(user.id) || userSockets.get(user.id).size === 0);

    if (!userSockets.has(user.id)) {
      userSockets.set(user.id, new Set());
    }
    userSockets.get(user.id).add(ws);

    // Si el usuario realmente pasa a estar en línea, notificar a sus amigos y contactos
    if (wasOffline) {
      notifyPresenceChange(user.id, user.username, true);
    }

    // Filtrar usuarios en línea: solo enviar contactos/amigos relevantes al usuario para preservar privacidad
    const relevantContacts = getPresenceSubscriberIds(user.id);
    const onlineContacts = relevantContacts.filter(uid => isUserOnline(uid));

    // Enviar mensaje de bienvenida con la lista de contactos en línea
    safeSend(ws, {
      type: 'CONNECTED',
      data: {
        userId: user.id,
        username: user.username,
        message: 'Conectado al canal en tiempo real de Kortexa',
        onlineUserIds: onlineContacts
      }
    });

    // Heartbeat: responder a pings
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Escuchar mensajes entrantes (ping del cliente, indicador de escritura, etc.)
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'PING') {
          safeSend(ws, { type: 'PONG', timestamp: Date.now() });
        } else if (msg.type === 'TYPING' && msg.data && msg.data.friendId) {
          const targetFriendId = parseInt(msg.data.friendId, 10);
          sendToUser(targetFriendId, 'USER_TYPING', {
            userId: ws.userId,
            username: ws.username,
            isTyping: Boolean(msg.data.isTyping)
          });
        }
      } catch {}
    });

    // Limpieza al desconectar con grace period anti-flapping (3500ms)
    ws.on('close', () => {
      const set = userSockets.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          // Iniciar periodo de gracia para evitar parpadeos si el usuario recarga la página
          const timer = setTimeout(() => {
            disconnectTimeouts.delete(user.id);
            userSockets.delete(user.id);
            notifyPresenceChange(user.id, user.username, false);
          }, 3500);
          disconnectTimeouts.set(user.id, timer);
        }
      }
    });

    ws.on('error', () => {
      try { ws.terminate(); } catch {}
    });
  });

  // Intervalo de Heartbeat cada 30 segundos
  const pingInterval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  console.log('⚡ Servidor WebSocket de Kortexa activo en /ws');
  return wss;
}

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Envía un evento a un usuario específico en todos sus dispositivos/pestañas abiertas
 */
export function sendToUser(userId, eventType, data = {}) {
  const targetId = parseInt(userId, 10);
  const sockets = userSockets.get(targetId);
  if (!sockets || sockets.size === 0) return 0;

  let sentCount = 0;
  const payload = {
    type: eventType,
    timestamp: new Date().toISOString(),
    data
  };

  sockets.forEach((ws) => {
    if (safeSend(ws, payload)) {
      sentCount++;
    }
  });

  return sentCount;
}

/**
 * Envía un evento a múltiples usuarios
 */
export function sendToUsers(userIds, eventType, data = {}) {
  let count = 0;
  if (!Array.isArray(userIds)) return 0;
  userIds.forEach(uid => {
    count += sendToUser(uid, eventType, data);
  });
  return count;
}

/**
 * Envía un evento a todos los usuarios conectados (Broadcast)
 */
export function broadcast(eventType, data = {}) {
  if (!wss) return 0;
  let count = 0;
  const payload = {
    type: eventType,
    timestamp: new Date().toISOString(),
    data
  };
  wss.clients.forEach((ws) => {
    if (safeSend(ws, payload)) {
      count++;
    }
  });
  return count;
}

/**
 * Consulta si un usuario está en línea (incluye grace period en reconexiones breves)
 */
export function isUserOnline(userId) {
  const targetId = parseInt(userId, 10);
  const set = userSockets.get(targetId);
  return Boolean((set && set.size > 0) || disconnectTimeouts.has(targetId));
}

/**
 * Cantidad total de usuarios únicos conectados
 */
export function getOnlineUsersCount() {
  return userSockets.size;
}

/**
 * Retorna un arreglo con los IDs de todos los usuarios en línea
 */
export function getOnlineUserIds() {
  return Array.from(userSockets.keys());
}
