import { WebSocketServer, WebSocket } from 'ws';
import { validateSession } from './auth-db.js';

// Mapa de conexiones activas por usuario: userId -> Set<WebSocket>
const userSockets = new Map();

let wss = null;

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

    const wasOffline = !userSockets.has(user.id) || userSockets.get(user.id).size === 0;

    if (!userSockets.has(user.id)) {
      userSockets.set(user.id, new Set());
    }
    userSockets.get(user.id).add(ws);

    // Si el usuario acaba de pasar a estar en línea, notificar a los demás usuarios
    if (wasOffline) {
      broadcast('USER_STATUS_CHANGED', {
        userId: user.id,
        username: user.username,
        online: true
      });
    }

    // Enviar mensaje de bienvenida con la lista de usuarios en línea actualmente
    safeSend(ws, {
      type: 'CONNECTED',
      data: {
        userId: user.id,
        username: user.username,
        message: 'Conectado al canal en tiempo real de Kortexa',
        onlineUserIds: getOnlineUserIds()
      }
    });

    // Heartbeat: responder a pings
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Escuchar mensajes entrantes (ping del cliente, etc.)
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'PING') {
          safeSend(ws, { type: 'PONG', timestamp: Date.now() });
        }
      } catch {}
    });

    // Limpieza al desconectar
    ws.on('close', () => {
      const set = userSockets.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          userSockets.delete(user.id);
          // Notificar que el usuario pasó a estar desconectado
          broadcast('USER_STATUS_CHANGED', {
            userId: user.id,
            username: user.username,
            online: false
          });
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
 * Consulta si un usuario está en línea
 */
export function isUserOnline(userId) {
  const targetId = parseInt(userId, 10);
  const set = userSockets.get(targetId);
  return Boolean(set && set.size > 0);
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
