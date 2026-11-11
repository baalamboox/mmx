import express from 'express';
import cors from 'cors';
import https from 'https';
import http from 'http';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  registerUser,
  loginUser,
  validateSession,
  deleteSession,
  getUserCount,
  getUserVaults,
  getUserActiveVault,
  setUserActiveVault,
  addUserVault,
  removeUserVault,
  renameUserVault,
  updateUserVaultEncryption,
  changeUserPassword,
  getUserMcpSettings,
  setUserMcpEnabled,
  regenerateUserMcpToken,
  validateMcpToken,
  getUserById,
  searchUsers,
  createOrUpdatePublicShare,
  removePublicShare,
  createOrUpdateUserShare,
  removeShareById,
  getSharesForResource,
  getSharesSharedWithUser,
  getShareByToken,
  verifySharePassword,
  checkUserResourceAccess,
  getUserSharedVaults,
  setUserActiveSharedVault,
  getSharedVaultById,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  getFriendships,
  areFriends,
  sendDirectMessage,
  getDirectMessages,
  markMessagesAsRead,
  getUnreadMessagesSummary
} from './auth-db.js';
import { initWebSocketServer, sendToUser, broadcast, isUserOnline, getOnlineUsersCount, getOnlineUserIds } from './ws-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'kortexa.config.json');

// ==========================================
// CRIPTOGRAFÍA DE ALTA SEGURIDAD (AES-256-GCM + PBKDF2)
// ==========================================
const MAGIC = Buffer.from('KENC'); // Identificador mágico de archivo cifrado
const VERSION = 1;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

function createVerificationHash(key) {
  return crypto.createHmac('sha256', key).update('KORTEXA_VAULT_VERIFY').digest('hex');
}

function isEncrypted(buffer) {
  if (!buffer || buffer.length < 4 + 1 + 16 + 12 + 16) return false;
  return buffer.subarray(0, 4).equals(MAGIC);
}

function encryptBuffer(buffer, key, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Paquete: [MAGIC: 4B][VERSION: 1B][SALT: 16B][IV: 12B][TAG: 16B][CIPHERTEXT: NB]
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    salt,
    iv,
    tag,
    encrypted
  ]);
}

function decryptBuffer(packet, key) {
  if (!isEncrypted(packet)) return packet;

  const salt = packet.subarray(5, 21);
  const iv = packet.subarray(21, 33);
  const tag = packet.subarray(33, 49);
  const ciphertext = packet.subarray(49);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function loadConfig() {
  try {
    if (fsSync.existsSync(CONFIG_FILE)) {
      const raw = fsSync.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.vaults)) {
        parsed.vaults = [parsed.vaultName || parsed.vaultDir || 'vault'];
      }
      if (!parsed.vaultsMeta || typeof parsed.vaultsMeta !== 'object') {
        parsed.vaultsMeta = {};
      }
      return parsed;
    }
  } catch {}
  return { vaultDir: 'vault', vaultName: 'vault', vaults: ['vault'], vaultsMeta: {} };
}

function saveConfig(cfg) {
  try {
    if (!Array.isArray(cfg.vaults)) {
      cfg.vaults = [cfg.vaultName || cfg.vaultDir || 'vault'];
    }
    if (!cfg.vaultsMeta || typeof cfg.vaultsMeta !== 'object') {
      cfg.vaultsMeta = {};
    }
    fsSync.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error guardando configuración:', err);
  }
}

// ==========================================
// BÓVEDAS AISLADAS POR USUARIO (SANDBOX MULTI-USUARIO)
// ==========================================
const USER_VAULTS_ROOT = path.join(__dirname, 'vaults');
if (!fsSync.existsSync(USER_VAULTS_ROOT)) {
  fsSync.mkdirSync(USER_VAULTS_ROOT, { recursive: true });
}

function getUserFolderName(user) {
  return String(user.username || user.id).toLowerCase().replace(/[^a-z0-9_.-]/g, '');
}

function getUserVaultsDir(user) {
  return path.join(USER_VAULTS_ROOT, getUserFolderName(user));
}

function getUserVaultDir(user, vaultName) {
  const cleanVault = String(vaultName || '').replace(/[<>:"/\\|?*]/g, '').trim();
  return path.join(getUserVaultsDir(user), cleanVault);
}

function resolveUserVaultPath(user, vaultName, relativePath) {
  const baseVaultDir = getUserVaultDir(user, vaultName);
  const safeRelative = path.normalize(relativePath || '').replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(baseVaultDir, safeRelative);
  if (!fullPath.startsWith(baseVaultDir)) {
    const err = new Error('Acceso no autorizado fuera de la bóveda');
    err.code = 'FORBIDDEN';
    throw err;
  }
  return fullPath;
}

function resolveReqVaultPath(req, relativePath) {
  const targetUser = req.userVault?.owner || req.user;
  return resolveUserVaultPath(targetUser, req.userVault.name, relativePath);
}

// Mapa en memoria de claves activas por usuario y bóveda: `${userId}:${vaultName}` -> { key: Buffer, salt: Buffer }
const activeUserVaultKeys = new Map();

function getActiveVaultKey(userId, vaultName) {
  return activeUserVaultKeys.get(`${userId}:${vaultName}`);
}

function setActiveVaultKey(userId, vaultName, key, salt) {
  activeUserVaultKeys.set(`${userId}:${vaultName}`, { key, salt });
}

function clearActiveVaultKey(userId, vaultName) {
  activeUserVaultKeys.delete(`${userId}:${vaultName}`);
}

// Asegurar que el usuario tenga su directorio en disco y al menos una bóveda activa registrada
async function ensureUserVault(user) {
  if (!user || !user.id) throw new Error('Usuario no válido');
  const userDir = getUserVaultsDir(user);
  await fs.mkdir(userDir, { recursive: true });

  let activeVault = getUserActiveVault(user.id);

  // Migración automática para memo69 (o primer usuario registrado) si existen carpetas previas en la raíz
  if (!activeVault && (user.username === 'memo69' || user.id === 8 || user.id === 3)) {
    const rootMemong = path.join(__dirname, 'memong');
    const userMemong = path.join(userDir, 'memong');
    if (fsSync.existsSync(rootMemong)) {
      if (!fsSync.existsSync(userMemong)) {
        try {
          await fs.cp(rootMemong, userMemong, { recursive: true });
        } catch (e) {
          console.error('Error migrando memong a carpeta de usuario:', e);
        }
      }
      try {
        addUserVault(user.id, 'memong', true, true, 'fecc23690f074c81df916399c968b875', '9bcbcd82cea0f0eaace009faebdd8a39fa6e8bc6afa2072540f1230d66b22cac');
      } catch {}
    }

    const rootProyectos = path.join(__dirname, 'Proyectos');
    const userProyectos = path.join(userDir, 'Proyectos');
    if (fsSync.existsSync(rootProyectos)) {
      if (!fsSync.existsSync(userProyectos)) {
        try {
          await fs.cp(rootProyectos, userProyectos, { recursive: true });
        } catch (e) {
          console.error('Error migrando Proyectos a carpeta de usuario:', e);
        }
      }
      try {
        addUserVault(user.id, 'Proyectos', false, false);
      } catch {}
    }

    activeVault = getUserActiveVault(user.id);
  }

  // Si aún no tiene ninguna bóveda, crear bóveda personal por defecto
  if (!activeVault) {
    const defaultName = 'Mi-Boveda';
    const defaultVaultDir = path.join(userDir, defaultName);
    await fs.mkdir(defaultVaultDir, { recursive: true });
    const welcomeNote = `# Mi Espacio de Conocimiento 🧠\n\n¡Bienvenido a tu espacio privado en **Kortexa**, **${user.nombres || user.username}**!\n\nEsta bóveda es totalmente privada y aislada de los demás usuarios.\n\n- Crea tus pensamientos usando el botón **+** en la barra lateral.\n- Conecta ideas utilizando enlaces de doble corchete como [[Ideas]].\n- Explora tu red sináptica en la vista de **Grafo**.\n`;
    await fs.writeFile(path.join(defaultVaultDir, 'Bienvenida.md'), welcomeNote, 'utf-8');
    activeVault = addUserVault(user.id, defaultName, true, false);
  }

  return activeVault;
}

// Lectura y Escritura Segura con Cifrado Transparente
async function readVaultFileBuffer(fullPath, activeKey = null) {
  const raw = await fs.readFile(fullPath);
  if (isEncrypted(raw)) {
    if (!activeKey) {
      const err = new Error('Bóveda bloqueada');
      err.code = 'LOCKED';
      throw err;
    }
    return decryptBuffer(raw, activeKey.key);
  }
  return raw;
}

async function readVaultFileText(fullPath, activeKey = null) {
  const buf = await readVaultFileBuffer(fullPath, activeKey);
  return buf.toString('utf-8');
}

async function writeVaultFile(fullPath, contentOrBuffer, isEncrypted = false, activeKey = null) {
  const buf = Buffer.isBuffer(contentOrBuffer) 
    ? contentOrBuffer 
    : Buffer.from(contentOrBuffer ?? '', 'utf-8');

  if (isEncrypted) {
    if (!activeKey) {
      const err = new Error('Bóveda bloqueada');
      err.code = 'LOCKED';
      throw err;
    }
    const encryptedBuf = encryptBuffer(buf, activeKey.key, activeKey.salt);
    await fs.writeFile(fullPath, encryptedBuf);
  } else {
    await fs.writeFile(fullPath, buf);
  }
}

// Cifrar recursivamente directorio
async function encryptDirectory(dir, key, salt) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) {
        await encryptDirectory(fullPath, key, salt);
      }
    } else if (entry.isFile()) {
      const raw = await fs.readFile(fullPath);
      if (!isEncrypted(raw)) {
        const encrypted = encryptBuffer(raw, key, salt);
        await fs.writeFile(fullPath, encrypted);
      }
    }
  }
}

// Descifrar recursivamente directorio
async function decryptDirectory(dir, key) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) {
        await decryptDirectory(fullPath, key);
      }
    } else if (entry.isFile()) {
      const raw = await fs.readFile(fullPath);
      if (isEncrypted(raw)) {
        const decrypted = decryptBuffer(raw, key);
        await fs.writeFile(fullPath, decrypted);
      }
    }
  }
}

// Middleware de verificación de bóveda y bloqueo para el usuario actual
async function checkVaultLock(req, res, next) {
  try {
    // Si el usuario tiene activa una bóveda compartida por otro usuario
    if (req.user && req.user.active_shared_vault_id) {
      const sharedVault = getSharedVaultById(req.user.active_shared_vault_id, req.user.id);
      if (sharedVault) {
        const ownerUser = getUserById(sharedVault.owner_id);
        if (ownerUser) {
          const isEncrypted = sharedVault.vault_encrypted === 1;
          req.userVault = {
            id: sharedVault.id,
            name: sharedVault.vault_name,
            isShared: true,
            shareId: sharedVault.id,
            permission: sharedVault.permission,
            encrypted: isEncrypted,
            salt: sharedVault.vault_salt,
            verification_hash: sharedVault.vault_verification_hash,
            owner: {
              id: ownerUser.id,
              username: ownerUser.username,
              fullname: `${sharedVault.owner_nombres} ${sharedVault.owner_apellido_paterno}`.trim()
            }
          };
          req.userVaultDir = getUserVaultDir(ownerUser, sharedVault.vault_name);
          req.isSharedVault = true;
          req.vaultPermission = sharedVault.permission;

          const activeKey = getActiveVaultKey(req.user.id, `shared_${sharedVault.id}`)
                         || getActiveVaultKey(req.user.id, sharedVault.vault_name)
                         || getActiveVaultKey(ownerUser.id, sharedVault.vault_name);

          if (isEncrypted && !activeKey) {
            return res.status(423).json({
              error: 'Bóveda compartida protegida. Ingrese la contraseña de la bóveda para acceder.',
              locked: true,
              vault: sharedVault.vault_name,
              isShared: true,
              shareId: sharedVault.id
            });
          }

          req.userVaultKey = activeKey;
          return next();
        }
      }
    }

    const activeVault = await ensureUserVault(req.user);
    req.userVault = activeVault;
    req.userVaultDir = getUserVaultDir(req.user, activeVault.name);
    req.isSharedVault = false;
    req.vaultPermission = 'write';

    if (activeVault.encrypted) {
      const activeKey = getActiveVaultKey(req.user.id, activeVault.name);
      if (!activeKey) {
        return res.status(423).json({
          error: 'Bóveda bloqueada. Ingrese su contraseña maestra para acceder.',
          locked: true,
          vault: activeVault.name
        });
      }
      req.userVaultKey = activeKey;
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error al acceder a la bóveda', details: err.message });
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Funciones y Middlewares de Autenticación
function parseCookies(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};
  const cookies = {};
  for (const item of cookieHeader.split(';')) {
    const [name, ...val] = item.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(val.join('='));
    }
  }
  return cookies;
}

function authMiddleware(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  } else {
    const cookies = parseCookies(req);
    if (cookies.kortexa_token) {
      token = cookies.kortexa_token;
    } else if (req.query?.auth_token) {
      token = req.query.auth_token;
    }
  }

  if (token) {
    try {
      let user = validateSession(token);
      let isMcpToken = false;
      if (!user) {
        user = validateMcpToken(token);
        if (user) isMcpToken = true;
      }
      if (user) {
        req.user = user;
        req.authToken = token;
        req.isMcpToken = isMcpToken;
      }
    } catch {}
  }

  // Comprobar si la petición proviene de un cliente MCP y si el usuario tiene deshabilitado MCP
  const isMcpReq = req.isMcpToken || req.headers['x-mcp-request'] === '1' || req.query?.mcp === '1';
  if (isMcpReq && req.user && req.user.mcp_enabled === false) {
    return res.status(403).json({
      error: 'El acceso al servidor MCP está deshabilitado para esta cuenta en la configuración de Kortexa.',
      code: 'MCP_DISABLED',
      mcp_disabled: true
    });
  }

  next();
}

app.use(authMiddleware);

function requireAuth(req, res, next) {
  const totalUsers = getUserCount();
  // Si no hay usuarios en la base de datos, permitimos acceso para configuración inicial
  if (totalUsers === 0) {
    return next();
  }

  if (!req.user) {
    return res.status(401).json({
      error: 'Autenticación requerida. Inicie sesión para continuar.',
      code: 'AUTH_REQUIRED'
    });
  }
  next();
}

// Regex para enlaces tipo [[Nombre de Nota]] o ![[Archivo.ext]]
const WIKI_LINK_REGEX = /!?\[\[(.*?)\]\]/g;

// Extensiones de archivos multimedia y documentos soportados
const MEDIA_EXTENSIONS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'],
  video: ['.mp4', '.webm', '.ogv', '.mov', '.mkv'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.weba', '.opus'],
  pdf: ['.pdf'],
  note: ['.md', '.txt']
};

function getFileType(ext) {
  const lowerExt = (ext || '').toLowerCase();
  for (const [type, exts] of Object.entries(MEDIA_EXTENSIONS)) {
    if (exts.includes(lowerExt)) return type;
  }
  return 'other';
}

// ==========================================
// FUNCIONES AUXILIARES RECURSIVAS
// ==========================================

// Escanear todos los archivos de un vault recursivamente (notas y archivos multimedia)
async function getAllVaultFiles(dir, base = dir) {
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Ignorar carpetas ocultas del sistema
          if (entry.name.startsWith('.')) return [];
          return getAllVaultFiles(fullPath, base);
        } else if (entry.isFile()) {
          if (entry.name.startsWith('.')) return [];
          const ext = path.extname(entry.name).toLowerCase();
          const type = getFileType(ext);
          const stats = await fs.stat(fullPath);
          const relativePath = path.relative(base, fullPath).replace(/\\/g, '/');
          const folderRelative = path.dirname(relativePath).replace(/\\/g, '/');
          const isNote = type === 'note';

          return [{
            filename: relativePath,
            title: isNote ? path.basename(entry.name, ext) : entry.name,
            name: entry.name,
            ext,
            type,
            folder: folderRelative === '.' ? '' : folderRelative,
            fullPath,
            mtime: stats.mtime,
            size: stats.size,
            url: `/api/vault-raw/${encodeURI(relativePath)}`
          }];
        }
        return [];
      })
    );
    return results.flat();
  } catch (err) {
    return [];
  }
}

// Obtener solo notas markdown para análisis sintáctico
async function getAllMdFiles(dir) {
  const all = await getAllVaultFiles(dir);
  return all.filter(f => f.type === 'note');
}

// Escanear todas las subcarpetas existentes recursivamente
async function getAllFolders(dir, base = dir) {
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) return [];
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(base, fullPath).replace(/\\/g, '/');
          const subFolders = await getAllFolders(fullPath, base);
          return [relativePath, ...subFolders];
        }
        return [];
      })
    );
    return results.flat();
  } catch (err) {
    return [];
  }
}

// ==========================================
// RUTAS API
// ==========================================

// --- RUTAS DE AUTENTICACIÓN ---

// Estado de autenticación
app.get('/api/auth/status', (req, res) => {
  const totalUsers = getUserCount();
  res.json({
    hasUsers: totalUsers > 0,
    loggedIn: !!req.user,
    user: req.user || null
  });
});

// Registro de usuario
app.post('/api/auth/register', (req, res) => {
  try {
    const { nombres, apellido_paterno, apellido_materno, email, username, password, confirm_password } = req.body;

    if (!password || !confirm_password) {
      return res.status(400).json({ error: 'La contraseña y su confirmación son obligatorias.' });
    }

    if (password !== confirm_password) {
      return res.status(400).json({ error: 'Las contraseñas no coinciden. Por favor verifícalas.' });
    }

    const { user, token, expires_at } = registerUser({
      nombres,
      apellido_paterno,
      apellido_materno,
      email,
      username,
      password
    });

    res.setHeader('Set-Cookie', `kortexa_token=${token}; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);

    res.json({
      success: true,
      message: 'Usuario registrado exitosamente',
      user,
      token,
      expires_at
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Inicio de sesión
app.post('/api/auth/login', (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;
    const { user, token, expires_at } = loginUser({ usernameOrEmail, password });

    res.setHeader('Set-Cookie', `kortexa_token=${token}; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);

    res.json({
      success: true,
      message: 'Inicio de sesión exitoso',
      user,
      token,
      expires_at
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Cierre de sesión
app.post('/api/auth/logout', (req, res) => {
  if (req.authToken) {
    deleteSession(req.authToken);
  }
  res.setHeader('Set-Cookie', 'kortexa_token=; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ success: true, message: 'Sesión finalizada correctamente' });
});

// Perfil de usuario autenticado
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

// Cambio de contraseña de usuario
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({ error: 'Debes ingresar tu contraseña actual.' });
    }

    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ error: 'La confirmación de la nueva contraseña no coincide.' });
    }

    changeUserPassword(req.user.id, currentPassword, newPassword);

    res.json({
      success: true,
      message: '¡Tu contraseña ha sido actualizada con éxito!'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// RUTAS DE INTEGRACIÓN MCP (MODEL CONTEXT PROTOCOL)
// ==========================================

// Obtener estado y configuración MCP del usuario
app.get('/api/user/mcp-settings', requireAuth, (req, res) => {
  try {
    const settings = getUserMcpSettings(req.user.id);
    const mcpScriptPath = path.join(__dirname, 'mcp-server.js');
    const apiUrl = `${req.protocol}://${req.get('host')}/api`;

    const configSnippet = {
      mcpServers: {
        kortexa: {
          command: "node",
          args: [mcpScriptPath],
          env: {
            VAULT_API_URL: apiUrl,
            VAULT_AUTH_TOKEN: settings.mcp_token
          }
        }
      }
    };

    res.json({
      success: true,
      mcp_enabled: settings.mcp_enabled,
      mcp_token: settings.mcp_token,
      api_url: apiUrl,
      mcp_script_path: mcpScriptPath,
      config_snippet: configSnippet
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Habilitar o deshabilitar servidor MCP
app.post('/api/user/mcp-toggle', requireAuth, (req, res) => {
  try {
    const { enabled } = req.body;
    const isEnabled = Boolean(enabled);
    const result = setUserMcpEnabled(req.user.id, isEnabled);

    res.json({
      success: true,
      mcp_enabled: result.mcp_enabled,
      message: result.mcp_enabled
        ? 'El servidor MCP ha sido habilitado para tu cuenta.'
        : 'El servidor MCP ha sido deshabilitado.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Regenerar token MCP de acceso
app.post('/api/user/mcp-regenerate-token', requireAuth, (req, res) => {
  try {
    const result = regenerateUserMcpToken(req.user.id);
    res.json({
      success: true,
      mcp_token: result.mcp_token,
      message: 'Token de acceso MCP regenerado exitosamente.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUTAS DE BÓVEDAS (AISLADAS POR USUARIO) ---

// 0. Obtener información y estado de cifrado de la bóveda activa del usuario
app.get('/api/vault', requireAuth, async (req, res) => {
  try {
    // Si tiene activa una bóveda compartida
    if (req.user && req.user.active_shared_vault_id) {
      const sharedVault = getSharedVaultById(req.user.active_shared_vault_id, req.user.id);
      if (sharedVault) {
        const ownerUser = getUserById(sharedVault.owner_id);
        const vaultDir = getUserVaultDir(ownerUser, sharedVault.vault_name);
        const isEncrypted = sharedVault.vault_encrypted === 1;
        const activeKey = getActiveVaultKey(req.user.id, `shared_${sharedVault.id}`)
                       || getActiveVaultKey(req.user.id, sharedVault.vault_name)
                       || getActiveVaultKey(ownerUser.id, sharedVault.vault_name);
        const isLocked = isEncrypted && !activeKey;

        return res.json({
          name: sharedVault.vault_name,
          displayName: `${sharedVault.vault_name} (de @${sharedVault.owner_username})`,
          path: vaultDir,
          encrypted: isEncrypted,
          locked: isLocked,
          isShared: true,
          permission: sharedVault.permission,
          owner: {
            username: sharedVault.owner_username,
            fullname: `${sharedVault.owner_nombres} ${sharedVault.owner_apellido_paterno}`.trim()
          }
        });
      }
    }

    const activeVault = await ensureUserVault(req.user);
    const isEncrypted = !!activeVault.encrypted;
    const activeKey = getActiveVaultKey(req.user.id, activeVault.name);
    const isLocked = isEncrypted && !activeKey;
    const vaultDir = getUserVaultDir(req.user, activeVault.name);

    res.json({
      name: activeVault.name,
      displayName: activeVault.name,
      path: vaultDir,
      encrypted: isEncrypted,
      locked: isLocked,
      isShared: false,
      permission: 'write'
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener bóveda activa', details: err.message });
  }
});

// Desbloquear bóveda cifrada mediante contraseña para el usuario
app.post('/api/vault/unlock', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    let targetVault = null;
    let isShared = false;
    let shareId = null;

    if (req.user && req.user.active_shared_vault_id) {
      const sharedVault = getSharedVaultById(req.user.active_shared_vault_id, req.user.id);
      if (sharedVault) {
        isShared = true;
        shareId = sharedVault.id;
        targetVault = {
          name: sharedVault.vault_name,
          encrypted: sharedVault.vault_encrypted === 1,
          salt: sharedVault.vault_salt,
          verification_hash: sharedVault.vault_verification_hash
        };
      }
    }

    if (!targetVault) {
      targetVault = await ensureUserVault(req.user);
    }

    if (!targetVault.encrypted) {
      return res.json({ success: true, message: 'La bóveda no está cifrada', locked: false, name: targetVault.name });
    }

    if (!password) {
      return res.status(400).json({ error: 'La contraseña es requerida' });
    }

    const salt = Buffer.from(targetVault.salt, 'hex');
    const derivedKey = deriveKey(password, salt);
    const actualHash = createVerificationHash(derivedKey);

    if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(targetVault.verification_hash, 'hex'))) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    if (isShared) {
      setActiveVaultKey(req.user.id, `shared_${shareId}`, derivedKey, salt);
      setActiveVaultKey(req.user.id, targetVault.name, derivedKey, salt);
    } else {
      setActiveVaultKey(req.user.id, targetVault.name, derivedKey, salt);
    }

    res.json({ success: true, message: 'Bóveda desbloqueada con éxito', locked: false, name: targetVault.name, isShared });
  } catch (err) {
    res.status(500).json({ error: 'Error al desbloquear bóveda', details: err.message });
  }
});

// Bloquear bóveda activa (eliminar clave en memoria del usuario)
app.post('/api/vault/lock', requireAuth, async (req, res) => {
  try {
    if (req.user && req.user.active_shared_vault_id) {
      const sharedVault = getSharedVaultById(req.user.active_shared_vault_id, req.user.id);
      if (sharedVault) {
        clearActiveVaultKey(req.user.id, `shared_${sharedVault.id}`);
        clearActiveVaultKey(req.user.id, sharedVault.vault_name);
        return res.json({ success: true, message: 'Bóveda compartida bloqueada', locked: true, name: sharedVault.vault_name, isShared: true });
      }
    }
    const activeVault = await ensureUserVault(req.user);
    clearActiveVaultKey(req.user.id, activeVault.name);
    res.json({ success: true, message: 'Bóveda bloqueada', locked: true, name: activeVault.name });
  } catch (err) {
    res.status(500).json({ error: 'Error al bloquear bóveda', details: err.message });
  }
});

// Cifrar físicamente la bóveda activa con AES-256-GCM
app.post('/api/vault/encrypt', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    const activeVault = await ensureUserVault(req.user);
    if (activeVault.encrypted) {
      return res.status(400).json({ error: 'La bóveda ya se encuentra cifrada' });
    }

    const salt = crypto.randomBytes(16);
    const derivedKey = deriveKey(password, salt);
    const verificationHash = createVerificationHash(derivedKey);

    const vaultDir = getUserVaultDir(req.user, activeVault.name);
    await encryptDirectory(vaultDir, derivedKey, salt);

    updateUserVaultEncryption(req.user.id, activeVault.name, true, salt.toString('hex'), verificationHash);
    setActiveVaultKey(req.user.id, activeVault.name, derivedKey, salt);

    res.json({
      success: true,
      message: `Bóveda "${activeVault.name}" cifrada con AES-256-GCM`,
      encrypted: true,
      locked: false
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al cifrar la bóveda', details: err.message });
  }
});

// Descifrar físicamente la bóveda activa a texto plano
app.post('/api/vault/decrypt', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const activeVault = await ensureUserVault(req.user);

    if (!activeVault.encrypted) {
      return res.status(400).json({ error: 'La bóveda no está cifrada' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Se requiere la contraseña para descifrar' });
    }

    const salt = Buffer.from(activeVault.salt, 'hex');
    const derivedKey = deriveKey(password, salt);
    const actualHash = createVerificationHash(derivedKey);

    if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(activeVault.verification_hash, 'hex'))) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const vaultDir = getUserVaultDir(req.user, activeVault.name);
    await decryptDirectory(vaultDir, derivedKey);

    updateUserVaultEncryption(req.user.id, activeVault.name, false, null, null);
    clearActiveVaultKey(req.user.id, activeVault.name);

    res.json({
      success: true,
      message: `Bóveda "${activeVault.name}" descifrada a texto plano`,
      encrypted: false,
      locked: false
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al descifrar la bóveda', details: err.message });
  }
});

// Listar todas las bóvedas del usuario autenticado
app.get('/api/vaults', requireAuth, async (req, res) => {
  try {
    await ensureUserVault(req.user);
    const userVaults = getUserVaults(req.user.id);
    const result = [];

    for (const v of userVaults) {
      const vPath = getUserVaultDir(req.user, v.name);
      let fileCount = 0;
      try {
        const files = await fs.readdir(vPath);
        fileCount = files.length;
      } catch {}

      const isCurrent = !req.user.active_shared_vault_id && !!v.is_active;
      const activeKey = getActiveVaultKey(req.user.id, v.name);
      result.push({
        name: v.name,
        path: vPath,
        filesCount: fileCount,
        isActive: isCurrent,
        isEncrypted: !!v.encrypted,
        isLocked: !!v.encrypted && (!isCurrent || !activeKey),
        isShared: false
      });
    }

    // Bóvedas compartidas con este usuario
    const sharedVaults = getUserSharedVaults(req.user.id);
    const sharedResult = [];
    for (const sv of sharedVaults) {
      const ownerUser = getUserById(sv.owner.id);
      let fileCount = 0;
      let svPath = '';
      if (ownerUser) {
        svPath = getUserVaultDir(ownerUser, sv.vault_name);
        try {
          const files = await fs.readdir(svPath);
          fileCount = files.length;
        } catch {}
      }

      const isCurrent = req.user.active_shared_vault_id === sv.share_id;
      const isEnc = sv.vault_encrypted === 1;
      const svKey = getActiveVaultKey(req.user.id, `shared_${sv.share_id}`)
                 || getActiveVaultKey(req.user.id, sv.vault_name)
                 || getActiveVaultKey(sv.owner.id, sv.vault_name);
      const isLoc = isEnc && !svKey;

      sharedResult.push({
        shareId: sv.share_id,
        name: sv.vault_name,
        displayName: `${sv.vault_name} (de @${sv.owner.username})`,
        owner: sv.owner,
        permission: sv.permission,
        path: svPath,
        filesCount: fileCount,
        isActive: isCurrent,
        isEncrypted: isEnc,
        isLocked: isLoc,
        isShared: true
      });
    }

    const currentShared = req.user.active_shared_vault_id 
      ? sharedResult.find(sv => sv.shareId === req.user.active_shared_vault_id)
      : null;

    const active = currentShared 
      ? { name: currentShared.name, displayName: currentShared.displayName, isShared: true, permission: currentShared.permission }
      : (userVaults.find(v => v.is_active) || userVaults[0]);

    const activeKey = (!currentShared && active) ? getActiveVaultKey(req.user.id, active.name) : null;
    const isEncrypted = currentShared ? currentShared.isEncrypted : !!active?.encrypted;
    const isLocked = currentShared ? currentShared.isLocked : (!!active?.encrypted && !activeKey);

    res.json({
      active: active ? active.name : '',
      displayName: active ? (active.displayName || active.name) : '',
      isShared: !!currentShared,
      permission: currentShared ? currentShared.permission : 'write',
      encrypted: isEncrypted,
      locked: isLocked,
      vaults: result,
      sharedVaults: sharedResult
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar las bóvedas', details: err.message });
  }
});

// Crear una nueva bóveda para el usuario autenticado
app.post('/api/vaults', requireAuth, async (req, res) => {
  try {
    const { name, switchNow = true } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'El nombre de la nueva bóveda es requerido' });
    }
    const cleanName = name.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'El nombre contiene caracteres inválidos' });
    }

    const newVaultDir = getUserVaultDir(req.user, cleanName);

    let isNew = false;
    try {
      await fs.access(newVaultDir);
    } catch {
      await fs.mkdir(newVaultDir, { recursive: true });
      isNew = true;
    }

    if (isNew) {
      const welcomeContent = `# Bóveda: ${cleanName}\n\n¡Bienvenido a tu nueva bóveda **${cleanName}**!\n\n- Comienza creando notas nuevas con el botón **+** en la barra lateral.\n- Conecta ideas utilizando enlaces de doble corchete como [[Ideas]].\n`;
      await fs.writeFile(path.join(newVaultDir, 'Bienvenida.md'), welcomeContent, 'utf-8');
    }

    addUserVault(req.user.id, cleanName, switchNow);

    const allUserVaults = getUserVaults(req.user.id);
    res.json({
      success: true,
      name: cleanName,
      path: newVaultDir,
      switched: switchNow,
      active: switchNow ? cleanName : (allUserVaults.find(v => v.is_active)?.name || cleanName),
      vaults: allUserVaults.map(v => v.name)
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear la bóveda', details: err.message });
  }
});

// Eliminar una bóveda y sus archivos del usuario autenticado
app.delete('/api/vaults', requireAuth, async (req, res) => {
  try {
    const name = req.query.name || req.body.name;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'El nombre de la bóveda es requerido' });
    }
    const cleanName = name.replace(/[<>:"/\\|?*]/g, '').trim();
    const targetDir = getUserVaultDir(req.user, cleanName);

    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch {}

    clearActiveVaultKey(req.user.id, cleanName);
    removeUserVault(req.user.id, cleanName);

    const remaining = getUserVaults(req.user.id);
    const active = remaining.find(v => v.is_active) || remaining[0];

    res.json({
      success: true,
      message: `Bóveda "${cleanName}" eliminada con éxito`,
      active: active ? active.name : '',
      vaults: remaining.map(v => v.name)
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar la bóveda', details: err.message });
  }
});

// Cambiar la bóveda activa del usuario
app.post('/api/vault/switch', requireAuth, async (req, res) => {
  try {
    const { name, shareId } = req.body;

    // Si se pasa shareId para cambiar a una bóveda compartida por otro usuario
    if (shareId) {
      const sharedVault = getSharedVaultById(Number(shareId), req.user.id);
      if (!sharedVault) {
        return res.status(404).json({ error: 'La bóveda compartida no existe o fue revocada' });
      }
      setUserActiveSharedVault(req.user.id, sharedVault.id);
      const ownerUser = getUserById(sharedVault.owner_id);
      const targetDir = getUserVaultDir(ownerUser, sharedVault.vault_name);
      const isEncrypted = sharedVault.vault_encrypted === 1;
      const hasKey = !!(getActiveVaultKey(req.user.id, `shared_${sharedVault.id}`)
                     || getActiveVaultKey(req.user.id, sharedVault.vault_name)
                     || getActiveVaultKey(ownerUser.id, sharedVault.vault_name));
      const isLocked = isEncrypted && !hasKey;

      return res.json({
        success: true,
        name: sharedVault.vault_name,
        displayName: `${sharedVault.vault_name} (de @${sharedVault.owner_username})`,
        isShared: true,
        shareId: sharedVault.id,
        permission: sharedVault.permission,
        path: targetDir,
        encrypted: isEncrypted,
        locked: isLocked
      });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'El nombre de la bóveda es requerido' });
    }
    const cleanName = name.replace(/[<>:"/\\|?*]/g, '').trim();

    const userVaults = getUserVaults(req.user.id);
    const targetVault = userVaults.find(v => v.name.toLowerCase() === cleanName.toLowerCase());
    if (!targetVault) {
      return res.status(404).json({ error: `La bóveda "${cleanName}" no existe en tu cuenta` });
    }

    // Desactivar bóveda compartida activa si había alguna
    setUserActiveSharedVault(req.user.id, null);
    setUserActiveVault(req.user.id, targetVault.name);
    const targetDir = getUserVaultDir(req.user, targetVault.name);
    const activeKey = getActiveVaultKey(req.user.id, targetVault.name);

    res.json({
      success: true,
      name: targetVault.name,
      displayName: targetVault.name,
      isShared: false,
      permission: 'write',
      path: targetDir,
      encrypted: !!targetVault.encrypted,
      locked: !!targetVault.encrypted && !activeKey
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar de bóveda', details: err.message });
  }
});

// Renombrar una bóveda del usuario
app.post('/api/vault/rename', requireAuth, async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) {
      return res.status(400).json({ error: 'Se requiere nombre actual y nuevo nombre' });
    }
    const cleanOld = oldName.replace(/[<>:"/\\|?*]/g, '').trim();
    const cleanNew = newName.replace(/[<>:"/\\|?*]/g, '').trim();

    const oldDir = getUserVaultDir(req.user, cleanOld);
    const newDir = getUserVaultDir(req.user, cleanNew);

    await fs.rename(oldDir, newDir);
    renameUserVault(req.user.id, cleanOld, cleanNew);

    const keyData = getActiveVaultKey(req.user.id, cleanOld);
    if (keyData) {
      setActiveVaultKey(req.user.id, cleanNew, keyData.key, keyData.salt);
      clearActiveVaultKey(req.user.id, cleanOld);
    }

    res.json({ success: true, name: cleanNew, path: newDir });
  } catch (err) {
    res.status(500).json({ error: 'Error al renombrar bóveda', details: err.message });
  }
});

// 1. Obtener todos los archivos de la bóveda activa del usuario (notas y multimedia)
app.get('/api/notes', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const files = await getAllVaultFiles(req.userVaultDir);
    files.sort((a, b) => b.mtime - a.mtime);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar los archivos', details: err.message });
  }
});

// 2. Obtener lista de todas las subcarpetas existentes en la bóveda del usuario
app.get('/api/folders', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const folders = await getAllFolders(req.userVaultDir);
    folders.sort();
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar carpetas', details: err.message });
  }
});

// 3. Crear una nueva subcarpeta en la bóveda del usuario
app.post('/api/folders', requireAuth, checkVaultLock, async (req, res) => {
  try {
    if (req.isSharedVault && req.vaultPermission !== 'write') {
      return res.status(403).json({ error: 'Permiso denegado: esta bóveda compartida es de solo lectura.' });
    }

    let { folder } = req.body;
    if (!folder) {
      return res.status(400).json({ error: 'El nombre de la carpeta es requerido' });
    }

    const cleanFolder = folder.replace(/[<>:"|?*]/g, '').trim();
    const fullPath = resolveReqVaultPath(req, cleanFolder);

    await fs.mkdir(fullPath, { recursive: true });
    res.json({ success: true, folder: cleanFolder.replace(/\\/g, '/') });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear carpeta', details: err.message });
  }
});

// 4. Eliminar una subcarpeta en la bóveda del usuario
app.delete('/api/folders', requireAuth, checkVaultLock, async (req, res) => {
  try {
    if (req.isSharedVault && req.vaultPermission !== 'write') {
      return res.status(403).json({ error: 'Permiso denegado: esta bóveda compartida es de solo lectura.' });
    }

    const folder = req.query.folder || req.body.folder;
    if (!folder) {
      return res.status(400).json({ error: 'La ruta de la carpeta es requerida' });
    }

    const fullPath = resolveReqVaultPath(req, folder);
    await fs.rm(fullPath, { recursive: true, force: true });
    res.json({ success: true, message: `Carpeta ${folder} eliminada.` });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar carpeta', details: err.message });
  }
});

// 5. Servir archivo estático/multimedia de la bóveda del usuario de forma segura
app.get('/api/vault-raw/:path(*)', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const rawPath = req.params.path;
    const fullPath = resolveReqVaultPath(req, rawPath);
    await fs.access(fullPath);
    const buf = await readVaultFileBuffer(fullPath, req.userVaultKey);
    const ext = path.extname(fullPath).toLowerCase();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type(ext);
    res.send(buf);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).send('Archivo no encontrado en la bóveda');
    }
    if (err.code === 'LOCKED') {
      return res.status(423).send('Bóveda bloqueada');
    }
    res.status(500).send('Error al acceder al archivo');
  }
});

// 6. Subir archivo multimedia o documento a la bóveda del usuario
app.post('/api/upload', requireAuth, checkVaultLock, async (req, res) => {
  try {
    if (req.isSharedVault && req.vaultPermission !== 'write') {
      return res.status(403).json({ error: 'Permiso denegado: esta bóveda compartida es de solo lectura.' });
    }

    const { filename, folder, base64 } = req.body;
    if (!filename || !base64) {
      return res.status(400).json({ error: 'Se requiere nombre de archivo y contenido en base64' });
    }

    const cleanFolder = (folder || '').replace(/\\/g, '/').replace(/[<>:"|?*]/g, '').trim();
    const cleanName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '').trim();
    const relativePath = cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
    const fullPath = resolveReqVaultPath(req, relativePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const buffer = Buffer.from(base64, 'base64');
    await writeVaultFile(fullPath, buffer, req.userVault.encrypted, req.userVaultKey);

    const ext = path.extname(cleanName).toLowerCase();
    const type = getFileType(ext);

    res.json({
      success: true,
      filename: relativePath.replace(/\\/g, '/'),
      title: type === 'note' ? path.basename(cleanName, ext) : cleanName,
      name: cleanName,
      type,
      folder: cleanFolder,
      url: `/api/vault-raw/${encodeURI(relativePath)}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al subir archivo', details: err.message });
  }
});

// 7. Obtener contenido o metadatos de un archivo (nota o multimedia)
app.get('/api/note', requireAuth, checkVaultLock, async (req, res) => {
  try {
    let notePath = req.query.path;
    const title = req.query.title;

    if (!notePath && title) {
      const allFiles = await getAllVaultFiles(req.userVaultDir);
      const cleanTitle = title.toLowerCase();
      const found = allFiles.find(n => 
        n.title.toLowerCase() === cleanTitle || 
        n.name.toLowerCase() === cleanTitle ||
        n.filename.toLowerCase() === cleanTitle
      );
      if (found) {
        notePath = found.filename;
      } else {
        notePath = title.includes('.') ? title : `${title}.md`;
      }
    }

    if (!notePath) {
      return res.status(400).json({ error: 'Se requiere parámetro path o title' });
    }

    if (!path.extname(notePath)) notePath += '.md';

    const fullPath = resolveReqVaultPath(req, notePath);
    const ext = path.extname(notePath).toLowerCase();
    const type = getFileType(ext);
    const folderRelative = path.dirname(notePath).replace(/\\/g, '/');
    const stats = await fs.stat(fullPath);

    if (type !== 'note') {
      return res.json({
        filename: notePath.replace(/\\/g, '/'),
        title: path.basename(notePath),
        name: path.basename(notePath),
        folder: folderRelative === '.' ? '' : folderRelative,
        type,
        ext,
        size: stats.size,
        mtime: stats.mtime,
        url: `/api/vault-raw/${encodeURI(notePath.replace(/\\/g, '/'))}`
      });
    }

    const content = await readVaultFileText(fullPath, req.userVaultKey);

    res.json({
      filename: notePath.replace(/\\/g, '/'),
      title: path.basename(notePath, ext),
      name: path.basename(notePath),
      folder: folderRelative === '.' ? '' : folderRelative,
      content,
      type: 'note',
      ext,
      size: stats.size,
      mtime: stats.mtime
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }
    res.status(500).json({ error: 'Error al leer archivo', details: err.message });
  }
});

// Ruta comodín para compatibilidad retroactiva: /api/notes/:path(*)
app.get('/api/notes/:path(*)', requireAuth, checkVaultLock, async (req, res) => {
  try {
    let notePath = req.params.path;
    if (!path.extname(notePath)) notePath += '.md';

    let fullPath;
    try {
      fullPath = resolveUserVaultPath(req.user, req.userVault.name, notePath);
      await fs.access(fullPath);
    } catch {
      const allFiles = await getAllVaultFiles(req.userVaultDir);
      const cleanTitle = path.basename(notePath, path.extname(notePath)).toLowerCase();
      const found = allFiles.find(n => n.title.toLowerCase() === cleanTitle || n.name.toLowerCase() === cleanTitle);
      if (found) {
        fullPath = found.fullPath;
        notePath = found.filename;
      } else {
        return res.status(404).json({ error: 'Archivo no encontrado' });
      }
    }

    const ext = path.extname(notePath).toLowerCase();
    const type = getFileType(ext);
    const folderRelative = path.dirname(notePath).replace(/\\/g, '/');
    const stats = await fs.stat(fullPath);

    if (type !== 'note') {
      return res.json({
        filename: notePath.replace(/\\/g, '/'),
        title: path.basename(notePath),
        name: path.basename(notePath),
        folder: folderRelative === '.' ? '' : folderRelative,
        type,
        ext,
        size: stats.size,
        mtime: stats.mtime,
        url: `/api/vault-raw/${encodeURI(notePath.replace(/\\/g, '/'))}`
      });
    }

    const content = await readVaultFileText(fullPath, req.userVaultKey);

    res.json({
      filename: notePath.replace(/\\/g, '/'),
      title: path.basename(notePath, ext),
      name: path.basename(notePath),
      folder: folderRelative === '.' ? '' : folderRelative,
      content,
      type: 'note',
      ext,
      size: stats.size,
      mtime: stats.mtime
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }
    res.status(500).json({ error: 'Error al leer archivo', details: err.message });
  }
});

// 6. Crear o actualizar una nota
app.post('/api/notes', requireAuth, checkVaultLock, async (req, res) => {
  try {
    if (req.isSharedVault && req.vaultPermission !== 'write') {
      return res.status(403).json({ error: 'Permiso denegado: esta bóveda compartida es de solo lectura.' });
    }

    let { title, folder, content, path: customPath, oldPath } = req.body;
    if (!title && !customPath) {
      return res.status(400).json({ error: 'El título o ruta es requerido' });
    }

    let relativePath;
    let safeTitle;

    if (customPath) {
      const normalized = customPath.replace(/\\/g, '/').replace(/[<>:"|?*]/g, '');
      safeTitle = path.basename(normalized, '.md');
      const dirName = path.dirname(normalized);
      relativePath = dirName === '.' ? `${safeTitle}.md` : `${dirName}/${safeTitle}.md`;
    } else {
      safeTitle = title.replace(/[<>:"/\\|?*]/g, '').trim();
      const cleanFolder = (folder || '').replace(/\\/g, '/').replace(/[<>:"|?*]/g, '').trim();
      relativePath = cleanFolder ? `${cleanFolder}/${safeTitle}.md` : `${safeTitle}.md`;
    }

    const fullPath = resolveReqVaultPath(req, relativePath);

    if (oldPath && oldPath !== relativePath) {
      try {
        const oldFullPath = resolveReqVaultPath(req, oldPath);
        await fs.unlink(oldFullPath);
      } catch {}
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await writeVaultFile(fullPath, content ?? '', req.userVault.encrypted, req.userVaultKey);

    const folderRelative = path.dirname(relativePath).replace(/\\/g, '/');

    res.json({
      success: true,
      filename: relativePath.replace(/\\/g, '/'),
      title: safeTitle,
      folder: folderRelative === '.' ? '' : folderRelative,
      content: content ?? ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar la nota', details: err.message });
  }
});

// 8. Eliminar una nota o archivo multimedia
app.delete(['/api/notes', '/api/notes/:path(*)'], requireAuth, checkVaultLock, async (req, res) => {
  try {
    if (req.isSharedVault && req.vaultPermission !== 'write') {
      return res.status(403).json({ error: 'Permiso denegado: esta bóveda compartida es de solo lectura.' });
    }

    let notePath = req.query.path || req.params.path;
    if (!notePath) {
      return res.status(400).json({ error: 'Ruta de archivo requerida' });
    }
    if (!path.extname(notePath)) notePath += '.md';

    const fullPath = resolveReqVaultPath(req, notePath);
    await fs.unlink(fullPath);
    res.json({ success: true, message: `Archivo ${notePath} eliminado.` });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar el archivo', details: err.message });
  }
});

// 9. Datos para el Grafo (Nodos y Enlaces con soporte de subcarpetas y multimedia)
app.get('/api/graph', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const allFiles = await getAllVaultFiles(req.userVaultDir);
    const mdFiles = allFiles.filter(f => f.type === 'note');
    const nodesMap = new Map();
    const links = [];

    for (const file of allFiles) {
      nodesMap.set(file.title, {
        id: file.title,
        name: file.name,
        filename: file.filename,
        folder: file.folder,
        type: file.type,
        exists: true
      });
      if (file.name !== file.title) {
        nodesMap.set(file.name, nodesMap.get(file.title));
      }
    }

    for (const file of mdFiles) {
      const sourceTitle = file.title;
      const content = await readVaultFileText(file.fullPath, req.userVaultKey);
      const matches = [...content.matchAll(WIKI_LINK_REGEX)];

      for (const match of matches) {
        let rawTarget = match[1].trim();
        if (!rawTarget) continue;
        if (rawTarget.includes('|')) {
          rawTarget = rawTarget.split('|')[0].trim();
        }
        const targetTitle = rawTarget;
        if (!targetTitle) continue;

        if (!nodesMap.has(targetTitle)) {
          nodesMap.set(targetTitle, {
            id: targetTitle,
            name: targetTitle,
            type: 'note',
            exists: false
          });
        }

        links.push({
          source: sourceTitle,
          target: targetTitle
        });
      }
    }

    res.json({
      nodes: Array.from(nodesMap.values()),
      links
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al generar el grafo', details: err.message });
  }
});

// 9. Backlinks para una nota específica en cualquier subcarpeta
app.get('/api/backlinks/:title', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const targetTitle = req.params.title.replace(/\.md$/, '');
    const mdFiles = await getAllMdFiles(req.userVaultDir);
    const backlinks = [];
    const searchTarget = `[[${targetTitle}]]`;

    for (const file of mdFiles) {
      if (file.title.toLowerCase() === targetTitle.toLowerCase()) continue;

      const content = await readVaultFileText(file.fullPath, req.userVaultKey);
      if (content.includes(searchTarget)) {
        backlinks.push({
          title: file.title,
          filename: file.filename,
          folder: file.folder
        });
      }
    }

    res.json(backlinks);
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar backlinks', details: err.message });
  }
});

// 10. Búsqueda de texto en todas las subcarpetas
app.get('/api/search', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase().trim();
    if (!query) {
      return res.json([]);
    }

    const mdFiles = await getAllMdFiles(req.userVaultDir);
    const results = [];

    for (const file of mdFiles) {
      const content = await readVaultFileText(file.fullPath, req.userVaultKey);
      const titleMatch = file.title.toLowerCase().includes(query);
      const contentMatch = content.toLowerCase().includes(query);

      if (titleMatch || contentMatch) {
        let snippet = '';
        if (contentMatch) {
          const index = content.toLowerCase().indexOf(query);
          const start = Math.max(0, index - 40);
          const end = Math.min(content.length, index + query.length + 60);
          snippet = (start > 0 ? '...' : '') + content.substring(start, end).replace(/\n/g, ' ') + (end < content.length ? '...' : '');
        }

        results.push({
          title: file.title,
          filename: file.filename,
          folder: file.folder,
          matchedTitle: titleMatch,
          snippet: snippet || content.substring(0, 100)
        });
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Error al realizar búsqueda', details: err.message });
  }
});

// ==========================================
// RUTAS DEL SISTEMA PARA COMPARTIR (FASE 1)
// ==========================================

// 1. Buscar usuarios para compartir
app.get('/api/users/search', requireAuth, (req, res) => {
  try {
    const q = req.query.q || '';
    const users = searchUsers(q, req.user.id).map(u => ({
      ...u,
      is_online: isUserOnline(u.id)
    }));
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar usuarios', details: err.message });
  }
});

// 1.1 Obtener lista de IDs de usuarios en línea
app.get('/api/users/online', requireAuth, (req, res) => {
  res.json({ onlineUserIds: getOnlineUserIds() });
});

// 2. Obtener estado de compartición de un recurso específico
app.get('/api/shares/resource', requireAuth, checkVaultLock, (req, res) => {
  try {
    const resourcePath = req.query.path || '';
    const vaultName = req.userVault.name;
    const shares = getSharesForResource(req.user.id, vaultName, resourcePath);
    if (shares.userShares) {
      shares.userShares = shares.userShares.map(s => ({
        ...s,
        user: {
          ...s.user,
          is_online: isUserOnline(s.user.id)
        }
      }));
    }
    res.json(shares);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener datos de compartición', details: err.message });
  }
});

// 3. Crear / Actualizar / Desactivar enlace público
app.post('/api/shares/public', requireAuth, checkVaultLock, (req, res) => {
  try {
    const { path: resourcePath, title, resource_type, enable, password, expires_at } = req.body;
    const vaultName = req.userVault.name;
    const cleanPath = (resourcePath || '').trim();

    if (enable === false) {
      removePublicShare({
        owner_id: req.user.id,
        vault_name: vaultName,
        resource_path: cleanPath
      });
      return res.json({ success: true, enabled: false });
    }

    const defaultTitle = title || path.basename(cleanPath) || vaultName;

    // Validar contraseña si se especificó
    if (password !== undefined && password !== null && password !== '') {
      if (typeof password !== 'string' || password.trim().length < 3) {
        return res.status(400).json({ error: 'La contraseña de enlace debe tener al menos 3 caracteres.' });
      }
    }

    // Validar expiración si se especificó
    if (expires_at) {
      const expDate = new Date(expires_at + (expires_at.includes('T') ? '' : 'T23:59:59'));
      if (isNaN(expDate.getTime())) {
        return res.status(400).json({ error: 'Fecha de expiración no válida.' });
      }
    }

    const result = createOrUpdatePublicShare({
      owner_id: req.user.id,
      vault_name: vaultName,
      resource_type: resource_type || (cleanPath ? 'file' : 'vault'),
      resource_path: cleanPath,
      resource_title: defaultTitle,
      password,
      expires_at
    });

    res.json({ success: true, enabled: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Error al configurar enlace público', details: err.message });
  }
});

// 4. Compartir recurso con otro usuario de Kortexa
app.post('/api/shares/user', requireAuth, checkVaultLock, (req, res) => {
  try {
    const { path: resourcePath, title, resource_type, target_user_id, permission } = req.body;
    const targetUserId = parseInt(target_user_id, 10);
    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Usuario destinatario inválido.' });
    }

    const targetUser = getUserById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: 'El usuario no existe.' });
    }

    const vaultName = req.userVault.name;
    const cleanPath = (resourcePath || '').trim();
    const defaultTitle = title || path.basename(cleanPath) || vaultName;

    const finalResourceType = resource_type || (cleanPath ? 'file' : 'vault');
    const finalPermission = permission === 'write' ? 'write' : 'read';

    const userShareRecord = createOrUpdateUserShare({
      owner_id: req.user.id,
      vault_name: vaultName,
      resource_type: finalResourceType,
      resource_path: cleanPath,
      resource_title: defaultTitle,
      shared_with_user_id: targetUserId,
      permission: finalPermission
    });

    // Notificar en tiempo real por WebSocket al usuario receptor
    sendToUser(targetUserId, 'SHARE_RECEIVED', {
      shareId: userShareRecord?.id,
      title: defaultTitle,
      path: cleanPath,
      vault_name: vaultName,
      resource_type: finalResourceType,
      permission: finalPermission,
      owner: {
        id: req.user.id,
        username: req.user.username,
        nombre_completo: `${req.user.nombres || ''} ${req.user.apellido_paterno || ''}`.trim() || req.user.username
      }
    });

    const shares = getSharesForResource(req.user.id, vaultName, cleanPath);
    res.json({ success: true, userShares: shares.userShares });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al compartir con usuario' });
  }
});

// 5. Eliminar / Revocar compartición por ID
app.delete('/api/shares/:id', requireAuth, async (req, res) => {
  try {
    const shareId = parseInt(req.params.id, 10);
    const db = (await import('./auth-db.js')).getAuthDb();
    const existingShare = db.prepare('SELECT * FROM shares WHERE id = ? AND owner_id = ?').get(shareId, req.user.id);
    const success = removeShareById(shareId, req.user.id);

    if (success && existingShare && existingShare.shared_with_user_id) {
      sendToUser(existingShare.shared_with_user_id, 'SHARE_REVOKED', {
        shareId: existingShare.id,
        title: existingShare.resource_title,
        path: existingShare.resource_path,
        resource_type: existingShare.resource_type,
        owner: {
          id: req.user.id,
          username: req.user.username
        }
      });
    }

    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: 'Error al revocar compartición', details: err.message });
  }
});

// 6. Listar todo lo que han compartido conmigo
app.get('/api/shares/shared-with-me', requireAuth, (req, res) => {
  try {
    const items = getSharesSharedWithUser(req.user.id).map(item => ({
      ...item,
      owner: {
        ...item.owner,
        is_online: isUserOnline(item.owner.id)
      }
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar recursos compartidos', details: err.message });
  }
});

// 7. Leer una nota compartida por otro usuario
app.get('/api/shared-notes/read', requireAuth, async (req, res) => {
  try {
    const shareId = parseInt(req.query.share_id, 10);
    if (!shareId) return res.status(400).json({ error: 'Parámetro share_id requerido' });

    const db = (await import('./auth-db.js')).getAuthDb();
    const share = db.prepare(`
      SELECT s.*, u.username as owner_username, u.nombres as owner_nombres, u.apellido_paterno as owner_apellido_paterno, u.id as owner_id
      FROM shares s
      JOIN users u ON s.owner_id = u.id
      WHERE s.id = ? AND s.shared_with_user_id = ?
    `).get(shareId, req.user.id);

    if (!share) {
      return res.status(404).json({ error: 'El recurso compartido no existe o fue revocado.' });
    }

    const ownerUser = getUserById(share.owner_id);
    const subPath = (req.query.sub_path || '').replace(/\\/g, '/');
    const relativeTarget = subPath ? path.join(share.resource_path || '', subPath) : share.resource_path;
    const fullPath = resolveUserVaultPath(ownerUser, share.vault_name, relativeTarget);

    if (!fsSync.existsSync(fullPath)) {
      return res.status(404).json({ error: 'El archivo original ya no se encuentra en la bóveda del propietario.' });
    }

    let activeKey = getActiveVaultKey(req.user.id, `shared_${share.id}`)
                 || getActiveVaultKey(req.user.id, share.vault_name)
                 || getActiveVaultKey(ownerUser.id, share.vault_name);

    if (!activeKey) {
      const candidatePwd = req.headers['x-vault-password'] || req.query.pwd;
      if (candidatePwd) {
        const ownerVault = db.prepare('SELECT encrypted, salt, verification_hash FROM user_vaults WHERE user_id = ? AND name = ?').get(ownerUser.id, share.vault_name);
        if (ownerVault && ownerVault.salt && ownerVault.verification_hash) {
          const saltBuf = Buffer.from(ownerVault.salt, 'hex');
          const derivedKey = deriveKey(candidatePwd, saltBuf);
          const testHash = createVerificationHash(derivedKey);
          if (crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(ownerVault.verification_hash, 'hex'))) {
            activeKey = { key: derivedKey, salt: saltBuf };
            setActiveVaultKey(req.user.id, `shared_${share.id}`, derivedKey, saltBuf);
            setActiveVaultKey(req.user.id, share.vault_name, derivedKey, saltBuf);
          }
        }
      }
    }

    const ext = path.extname(relativeTarget).toLowerCase();
    const fileType = getFileType(ext);
    const stats = await fs.stat(fullPath);

    let content = '';
    if (fileType === 'note') {
      try {
        content = await readVaultFileText(fullPath, activeKey);
      } catch (readErr) {
        if (readErr.code === 'LOCKED') {
          return res.status(423).json({
            error: 'El archivo pertenece a una bóveda cifrada protegida. Ingrese la contraseña de la bóveda para acceder.',
            locked: true,
            shareId: share.id,
            vaultName: share.vault_name
          });
        }
        throw readErr;
      }
    } else {
      // Para archivos multimedia binarios (video, audio, imagen, pdf)
      if (!activeKey) {
        const ownerVault = db.prepare('SELECT encrypted, salt, verification_hash FROM user_vaults WHERE user_id = ? AND name = ?').get(ownerUser.id, share.vault_name);
        if (ownerVault && ownerVault.encrypted === 1) {
          return res.status(423).json({
            error: 'El archivo multimedia pertenece a una bóveda cifrada protegida. Ingrese la contraseña de la bóveda para acceder.',
            locked: true,
            shareId: share.id,
            vaultName: share.vault_name
          });
        }
      }
    }

    const rawUrl = `/api/shared-notes/raw?share_id=${share.id}${subPath ? `&sub_path=${encodeURIComponent(subPath)}` : ''}`;

    res.json({
      shareId: share.id,
      title: subPath ? path.basename(subPath, ext) : share.resource_title,
      filename: relativeTarget,
      sub_path: subPath,
      resource_type: share.resource_type,
      file_type: fileType,
      ext,
      size: stats.size,
      url: rawUrl,
      permission: share.permission,
      content,
      owner: {
        id: ownerUser.id,
        username: ownerUser.username,
        nombre_completo: `${share.owner_nombres} ${share.owner_apellido_paterno}`.trim()
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al leer la nota compartida', details: err.message });
  }
});

// Servir archivo multimedia o binario compartido entre usuarios de forma segura
app.get('/api/shared-notes/raw', requireAuth, async (req, res) => {
  try {
    const shareId = parseInt(req.query.share_id, 10);
    if (!shareId) return res.status(400).send('Parámetro share_id requerido');

    const db = (await import('./auth-db.js')).getAuthDb();
    const share = db.prepare(`
      SELECT s.*, u.username as owner_username, u.id as owner_id
      FROM shares s
      JOIN users u ON s.owner_id = u.id
      WHERE s.id = ? AND s.shared_with_user_id = ?
    `).get(shareId, req.user.id);

    if (!share) {
      return res.status(404).send('Recurso compartido no encontrado o revocado');
    }

    const ownerUser = getUserById(share.owner_id);
    const subPath = (req.query.sub_path || '').replace(/\\/g, '/');
    const relativeTarget = subPath ? path.join(share.resource_path || '', subPath) : share.resource_path;
    const fullPath = resolveUserVaultPath(ownerUser, share.vault_name, relativeTarget);

    if (!fsSync.existsSync(fullPath)) {
      return res.status(404).send('Archivo no encontrado');
    }

    let activeKey = getActiveVaultKey(req.user.id, `shared_${share.id}`)
                 || getActiveVaultKey(req.user.id, share.vault_name)
                 || getActiveVaultKey(ownerUser.id, share.vault_name);

    if (!activeKey) {
      const candidatePwd = req.headers['x-vault-password'] || req.query.pwd;
      if (candidatePwd) {
        const ownerVault = db.prepare('SELECT encrypted, salt, verification_hash FROM user_vaults WHERE user_id = ? AND name = ?').get(ownerUser.id, share.vault_name);
        if (ownerVault && ownerVault.salt && ownerVault.verification_hash) {
          const saltBuf = Buffer.from(ownerVault.salt, 'hex');
          const derivedKey = deriveKey(candidatePwd, saltBuf);
          const testHash = createVerificationHash(derivedKey);
          if (crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(ownerVault.verification_hash, 'hex'))) {
            activeKey = { key: derivedKey, salt: saltBuf };
            setActiveVaultKey(req.user.id, `shared_${share.id}`, derivedKey, saltBuf);
            setActiveVaultKey(req.user.id, share.vault_name, derivedKey, saltBuf);
          }
        }
      }
    }

    let buffer;
    try {
      buffer = await readVaultFileBuffer(fullPath, activeKey);
    } catch (readErr) {
      if (readErr.code === 'LOCKED') {
        return res.status(423).send('Bóveda bloqueada: se requiere la contraseña');
      }
      throw readErr;
    }

    const ext = path.extname(relativeTarget).toLowerCase();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type(ext);
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error al servir archivo compartido');
  }
});

// 8. Guardar cambios en una nota compartida (si tiene permiso 'write')
app.post('/api/shared-notes/save', requireAuth, async (req, res) => {
  try {
    const { share_id, content, sub_path } = req.body;
    const shareId = parseInt(share_id, 10);
    if (!shareId) return res.status(400).json({ error: 'share_id requerido' });

    const db = (await import('./auth-db.js')).getAuthDb();
    const share = db.prepare(`
      SELECT s.*, u.id as owner_id
      FROM shares s
      JOIN users u ON s.owner_id = u.id
      WHERE s.id = ? AND s.shared_with_user_id = ?
    `).get(shareId, req.user.id);

    if (!share) {
      return res.status(404).json({ error: 'El recurso compartido no existe o fue revocado.' });
    }

    if (share.permission !== 'write') {
      return res.status(403).json({ error: 'Permiso denegado: solo tienes acceso de lectura a este recurso.' });
    }

    const ownerUser = getUserById(share.owner_id);
    const subClean = (sub_path || '').replace(/\\/g, '/');
    const relativeTarget = subClean ? path.join(share.resource_path || '', subClean) : share.resource_path;
    const fullPath = resolveUserVaultPath(ownerUser, share.vault_name, relativeTarget);

    let activeKey = getActiveVaultKey(req.user.id, `shared_${share.id}`)
                 || getActiveVaultKey(req.user.id, share.vault_name)
                 || getActiveVaultKey(ownerUser.id, share.vault_name);
    const isEnc = fsSync.existsSync(fullPath) && isEncrypted(await fs.readFile(fullPath));

    if (isEnc && !activeKey) {
      return res.status(423).json({
        error: 'No se puede guardar: la bóveda del propietario está cifrada y bloqueada.',
        locked: true
      });
    }

    await writeVaultFile(fullPath, content ?? '', isEnc, activeKey);

    // Notificar en tiempo real al dueño de la nota
    sendToUser(share.owner_id, 'NOTE_UPDATED', {
      shareId: share.id,
      title: share.resource_title,
      sub_path: subClean,
      user: {
        id: req.user.id,
        username: req.user.username,
        nombre_completo: `${req.user.nombres || ''} ${req.user.apellido_paterno || ''}`.trim() || req.user.username
      }
    });

    res.json({ success: true, message: 'Nota compartida guardada correctamente.' });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar nota compartida', details: err.message });
  }
});

// 8.1 Obtener árbol de notas y subcarpetas de una carpeta compartida
app.get('/api/shared-folders/tree', requireAuth, async (req, res) => {
  try {
    const shareId = parseInt(req.query.share_id, 10);
    if (!shareId) return res.status(400).json({ error: 'share_id requerido' });

    const db = (await import('./auth-db.js')).getAuthDb();
    const share = db.prepare(`
      SELECT s.*, u.username as owner_username, u.nombres as owner_nombres, u.apellido_paterno as owner_apellido_paterno
      FROM shares s
      JOIN users u ON s.owner_id = u.id
      WHERE s.id = ? AND s.shared_with_user_id = ? AND s.resource_type = 'folder'
    `).get(shareId, req.user.id);

    if (!share) {
      return res.status(404).json({ error: 'La carpeta compartida no existe o fue revocada.' });
    }

    const ownerUser = getUserById(share.owner_id);
    const folderDir = resolveUserVaultPath(ownerUser, share.vault_name, share.resource_path);

    if (!fsSync.existsSync(folderDir)) {
      return res.status(404).json({ error: 'La carpeta ya no existe en la bóveda del propietario.' });
    }

    const files = await getAllVaultFiles(folderDir, folderDir);
    const folders = await getAllFolders(folderDir, folderDir);

    res.json({
      shareId: share.id,
      folderName: share.resource_title,
      folderPath: share.resource_path,
      permission: share.permission,
      owner: {
        id: ownerUser.id,
        username: ownerUser.username,
        nombre_completo: `${share.owner_nombres} ${share.owner_apellido_paterno}`.trim()
      },
      files,
      folders
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener árbol de carpeta compartida', details: err.message });
  }
});

// 9. API Pública para obtener contenido mediante share_token (Soporta archivos, carpetas y bóvedas)
app.get('/api/public/share/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const share = getShareByToken(token);

    if (!share) {
      return res.status(404).json({ error: 'Enlace no encontrado o inválido.' });
    }
    if (share.expired) {
      return res.status(410).json({ error: 'Este enlace de compartición ha expirado.', expired: true });
    }

    // Verificar si requiere contraseña
    if (share.has_password) {
      const authHeaderPwd = req.headers['x-share-password'] || req.query.pwd;
      const isOk = verifySharePassword(token, authHeaderPwd);
      if (!isOk) {
        return res.json({
          has_password: true,
          requires_password: true,
          title: share.resource_title,
          resource_type: share.resource_type,
          owner_fullname: share.owner_fullname,
          owner_username: share.owner_username
        });
      }
    }

    const ownerUser = getUserById(share.owner_id);
    const basePath = resolveUserVaultPath(ownerUser, share.vault_name, share.resource_path || '');

    if (!fsSync.existsSync(basePath)) {
      return res.status(404).json({ error: 'El recurso ya no existe en la bóveda de origen.' });
    }

    const db = (await import('./auth-db.js')).getAuthDb();
    const ownerVault = db.prepare('SELECT encrypted, salt, verification_hash FROM user_vaults WHERE user_id = ? AND name = ?').get(ownerUser.id, share.vault_name);
    const isVaultEncrypted = ownerVault && ownerVault.encrypted === 1;

    let activeKey = getActiveVaultKey(ownerUser.id, share.vault_name)
                 || getActiveVaultKey(`public_${token}`, share.vault_name);

    if (isVaultEncrypted && !activeKey) {
      const candidatePwd = req.headers['x-vault-password'] || req.query.vault_pwd;
      if (candidatePwd && ownerVault.salt && ownerVault.verification_hash) {
        const saltBuf = Buffer.from(ownerVault.salt, 'hex');
        const candidateKey = deriveKey(candidatePwd, saltBuf);
        const testHash = createVerificationHash(candidateKey);
        if (crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(ownerVault.verification_hash, 'hex'))) {
          activeKey = { key: candidateKey, salt: saltBuf };
          setActiveVaultKey(`public_${token}`, share.vault_name, candidateKey, saltBuf);
        }
      }
    }

    if (isVaultEncrypted && !activeKey) {
      return res.json({
        has_password: share.has_password,
        requires_password: false,
        requires_vault_password: true,
        vault_locked: true,
        title: share.resource_title,
        resource_type: share.resource_type,
        owner: {
          fullname: share.owner_fullname,
          username: share.owner_username
        }
      });
    }

    // Si es una carpeta o bóveda y NO se pide un archivo específico -> Retornar lista/árbol de archivos
    if (share.resource_type === 'folder' || share.resource_type === 'vault') {
      const requestedFile = req.query.file;
      if (!requestedFile) {
        const allFiles = await getAllVaultFiles(basePath, basePath);
        const allFolders = await getAllFolders(basePath, basePath);
        return res.json({
          has_password: share.has_password,
          requires_password: false,
          title: share.resource_title,
          resource_type: share.resource_type,
          files: allFiles.map(f => ({
            title: f.title,
            filename: f.filename,
            folder: f.folder,
            ext: f.ext,
            type: f.type,
            size: f.size
          })),
          folders: allFolders,
          owner: {
            fullname: share.owner_fullname,
            username: share.owner_username
          },
          created_at: share.created_at,
          expires_at: share.expires_at
        });
      }

      // Si se pide un archivo específico dentro de la carpeta/bóveda
      const subSafe = path.normalize(requestedFile).replace(/^(\.\.[\/\\])+/, '');
      const targetFilePath = path.join(basePath, subSafe);
      if (!targetFilePath.startsWith(basePath) || !fsSync.existsSync(targetFilePath)) {
        return res.status(404).json({ error: 'El archivo solicitado no existe.' });
      }

      const ext = path.extname(targetFilePath).toLowerCase();
      const type = getFileType(ext);
      let content = null;
      if (type === 'note') {
        try {
          content = await readVaultFileText(targetFilePath, activeKey);
        } catch (err) {
          if (err.code === 'LOCKED') {
            return res.status(423).json({ error: 'El archivo pertenece a una bóveda cifrada protegida.', vault_locked: true });
          }
          throw err;
        }
      }

      return res.json({
        has_password: share.has_password,
        requires_password: false,
        title: type === 'note' ? path.basename(targetFilePath, ext) : path.basename(targetFilePath),
        filename: subSafe,
        resource_type: share.resource_type,
        file_type: type,
        ext,
        content,
        download_url: `/s/${token}/raw?file=${encodeURIComponent(subSafe)}`,
        owner: {
          fullname: share.owner_fullname,
          username: share.owner_username
        }
      });
    }

    // Para archivo individual
    const ext = path.extname(share.resource_path).toLowerCase();
    const type = getFileType(ext);

    let content = null;
    if (type === 'note') {
      try {
        content = await readVaultFileText(basePath, activeKey);
      } catch (err) {
        if (err.code === 'LOCKED') {
          return res.status(423).json({ error: 'El archivo pertenece a una bóveda cifrada protegida.', vault_locked: true });
        }
        throw err;
      }
    }

    res.json({
      has_password: share.has_password,
      requires_password: false,
      title: share.resource_title,
      filename: share.resource_path,
      resource_type: share.resource_type,
      file_type: type,
      ext,
      content,
      download_url: `/s/${token}/raw`,
      owner: {
        fullname: share.owner_fullname,
        username: share.owner_username
      },
      created_at: share.created_at,
      expires_at: share.expires_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al procesar enlace público', details: err.message });
  }
});

// 10. Validar contraseña de un enlace público
app.post('/api/public/share/:token/auth', (req, res) => {
  try {
    const token = req.params.token;
    const { password } = req.body;
    const ok = verifySharePassword(token, password);
    if (!ok) {
      return res.status(401).json({ error: 'Contraseña incorrecta', valid: false });
    }
    res.json({ success: true, valid: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al validar contraseña', details: err.message });
  }
});

// 10.1 Validar contraseña de bóveda cifrada en un enlace público
app.post('/api/public/share/:token/vault-auth', async (req, res) => {
  try {
    const token = req.params.token;
    const { password } = req.body;
    const share = getShareByToken(token);
    if (!share || share.expired) {
      return res.status(404).json({ error: 'Enlace no encontrado o expirado' });
    }
    const db = (await import('./auth-db.js')).getAuthDb();
    const ownerVault = db.prepare('SELECT encrypted, salt, verification_hash FROM user_vaults WHERE user_id = ? AND name = ?').get(share.owner_id, share.vault_name);
    if (!ownerVault || !ownerVault.encrypted) {
      return res.json({ success: true, valid: true });
    }
    if (!password) {
      return res.status(400).json({ error: 'Contraseña de la bóveda requerida', valid: false });
    }
    const saltBuf = Buffer.from(ownerVault.salt, 'hex');
    const candidateKey = deriveKey(password, saltBuf);
    const testHash = createVerificationHash(candidateKey);
    if (!crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(ownerVault.verification_hash, 'hex'))) {
      return res.status(401).json({ error: 'Contraseña de la bóveda incorrecta', valid: false });
    }
    setActiveVaultKey(`public_${token}`, share.vault_name, candidateKey, saltBuf);
    res.json({ success: true, valid: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al verificar clave de bóveda', details: err.message });
  }
});

// 11. Descargar o transmitir archivo crudo de un enlace público
app.get('/s/:token/raw', async (req, res) => {
  try {
    const token = req.params.token;
    const share = getShareByToken(token);
    if (!share || share.expired) {
      return res.status(404).send('Enlace no encontrado o expirado');
    }

    if (share.has_password) {
      const authHeaderPwd = req.headers['x-share-password'] || req.query.pwd;
      if (!verifySharePassword(token, authHeaderPwd)) {
        return res.status(401).send('Acceso protegido por contraseña');
      }
    }

    const ownerUser = getUserById(share.owner_id);
    const basePath = resolveUserVaultPath(ownerUser, share.vault_name, share.resource_path || '');
    let targetFile = basePath;

    if (share.resource_type === 'folder' || share.resource_type === 'vault') {
      const requestedFile = req.query.file;
      if (!requestedFile) return res.status(400).send('Archivo no especificado');
      const subSafe = path.normalize(requestedFile).replace(/^(\.\.[\/\\])+/, '');
      targetFile = path.join(basePath, subSafe);
      if (!targetFile.startsWith(basePath)) return res.status(403).send('Acceso no autorizado');
    }

    if (!fsSync.existsSync(targetFile)) {
      return res.status(404).send('Archivo no encontrado');
    }

    let activeKey = getActiveVaultKey(ownerUser.id, share.vault_name)
                 || getActiveVaultKey(`public_${token}`, share.vault_name);

    if (!activeKey) {
      const candidatePwd = req.headers['x-vault-password'] || req.query.vault_pwd;
      const db = (await import('./auth-db.js')).getAuthDb();
      const ownerVault = db.prepare('SELECT encrypted, salt, verification_hash FROM user_vaults WHERE user_id = ? AND name = ?').get(ownerUser.id, share.vault_name);
      if (candidatePwd && ownerVault?.salt && ownerVault?.verification_hash) {
        const saltBuf = Buffer.from(ownerVault.salt, 'hex');
        const candidateKey = deriveKey(candidatePwd, saltBuf);
        const testHash = createVerificationHash(candidateKey);
        if (crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(ownerVault.verification_hash, 'hex'))) {
          activeKey = { key: candidateKey, salt: saltBuf };
          setActiveVaultKey(`public_${token}`, share.vault_name, candidateKey, saltBuf);
        }
      }
    }

    let buffer;
    try {
      buffer = await readVaultFileBuffer(targetFile, activeKey);
    } catch (readErr) {
      if (readErr.code === 'LOCKED') {
        return res.status(423).send('Bóveda bloqueada: se requiere la contraseña para descifrar este archivo.');
      }
      throw readErr;
    }

    const ext = path.extname(targetFile).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.md': 'text/markdown; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(targetFile))}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error al transmitir archivo');
  }
});

// 12. Página de visualización pública amigable para /s/:token
app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share-viewer.html'));
});

// ==========================================
// 13. SISTEMA DE AMIGOS & CHAT DIRECTO EN TIEMPO REAL
// ==========================================

// 13.1 Listar amigos y solicitudes
app.get('/api/friends', requireAuth, (req, res) => {
  try {
    const data = getFriendships(req.user.id);
    data.friends = data.friends.map(f => ({
      ...f,
      user: {
        ...f.user,
        is_online: isUserOnline(f.user.id)
      }
    }));
    data.incomingRequests = data.incomingRequests.map(r => ({
      ...r,
      from_user: {
        ...r.from_user,
        is_online: isUserOnline(r.from_user.id)
      }
    }));
    data.outgoingRequests = data.outgoingRequests.map(r => ({
      ...r,
      to_user: {
        ...r.to_user,
        is_online: isUserOnline(r.to_user.id)
      }
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener lista de amigos', details: err.message });
  }
});

// 13.2 Enviar solicitud de amistad
app.post('/api/friends/request', requireAuth, (req, res) => {
  try {
    const { target_user_id } = req.body;
    const targetUserId = parseInt(target_user_id, 10);
    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ error: 'ID de usuario destinatario inválido.' });
    }

    const result = sendFriendRequest(req.user.id, targetUserId);

    if (result.autoAccepted) {
      sendToUser(targetUserId, 'FRIEND_REQUEST_ACCEPTED', {
        friend: {
          id: req.user.id,
          username: req.user.username,
          nombre_completo: `${req.user.nombres || ''} ${req.user.apellido_paterno || ''}`.trim() || req.user.username
        }
      });
      sendToUser(req.user.id, 'FRIEND_REQUEST_ACCEPTED', {
        friend: result.friend
      });
    } else {
      sendToUser(targetUserId, 'FRIEND_REQUEST_RECEIVED', {
        requestId: result.id,
        from_user: {
          id: req.user.id,
          username: req.user.username,
          nombre_completo: `${req.user.nombres || ''} ${req.user.apellido_paterno || ''}`.trim() || req.user.username
        }
      });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Error al enviar solicitud de amistad' });
  }
});

// 13.3 Responder solicitud de amistad (accept | reject)
app.post('/api/friends/respond', requireAuth, (req, res) => {
  try {
    const { request_id, action } = req.body;
    const requestId = parseInt(request_id, 10);
    if (!requestId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Parámetros request_id y action válidos requeridos.' });
    }

    const result = respondFriendRequest(requestId, req.user.id, action);

    if (action === 'accept') {
      sendToUser(result.sender_id, 'FRIEND_REQUEST_ACCEPTED', {
        friend: {
          id: req.user.id,
          username: req.user.username,
          nombre_completo: `${req.user.nombres || ''} ${req.user.apellido_paterno || ''}`.trim() || req.user.username
        }
      });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Error al responder solicitud de amistad' });
  }
});

// 13.4 Eliminar amigo
app.delete('/api/friends/:friendId', requireAuth, (req, res) => {
  try {
    const friendId = parseInt(req.params.friendId, 10);
    const success = removeFriend(req.user.id, friendId);

    if (success) {
      sendToUser(friendId, 'FRIEND_REMOVED', {
        friendId: req.user.id,
        username: req.user.username
      });
    }

    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar amigo', details: err.message });
  }
});

// 13.5 Obtener mensajes de chat con un amigo
app.get('/api/chat/:friendId/messages', requireAuth, (req, res) => {
  try {
    const friendId = parseInt(req.params.friendId, 10);
    const messages = getDirectMessages(req.user.id, friendId);
    markMessagesAsRead(friendId, req.user.id);
    res.json({ messages });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Error al obtener mensajes' });
  }
});

// 13.6 Enviar mensaje de chat a un amigo
app.post('/api/chat/:friendId/messages', requireAuth, (req, res) => {
  try {
    const friendId = parseInt(req.params.friendId, 10);
    const { content } = req.body;

    const message = sendDirectMessage(req.user.id, friendId, content);

    // Notificar en tiempo real al amigo por WebSocket
    sendToUser(friendId, 'CHAT_MESSAGE_RECEIVED', {
      message: {
        ...message,
        sender: {
          id: req.user.id,
          username: req.user.username,
          nombre_completo: `${req.user.nombres || ''} ${req.user.apellido_paterno || ''}`.trim() || req.user.username
        }
      }
    });

    res.json({ success: true, message });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Error al enviar mensaje' });
  }
});

// 13.7 Resumen de mensajes no leídos
app.get('/api/chat/unread', requireAuth, (req, res) => {
  try {
    const summary = getUnreadMessagesSummary(req.user.id);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener mensajes no leídos', details: err.message });
  }
});

// ==========================================
// INICIALIZACIÓN DEL SERVIDOR (HTTP / HTTPS)
// ==========================================
const CERTS_DIR = path.join(__dirname, 'certs');
const KEY_PATH = process.env.SSL_KEY_PATH || path.join(CERTS_DIR, 'key.pem');
const CERT_PATH = process.env.SSL_CERT_PATH || path.join(CERTS_DIR, 'cert.pem');

const hasSslCerts = fsSync.existsSync(KEY_PATH) && fsSync.existsSync(CERT_PATH);
const useHttps = process.env.DISABLE_HTTPS !== 'true' && hasSslCerts;

if (useHttps) {
  try {
    const sslOptions = {
      key: fsSync.readFileSync(KEY_PATH),
      cert: fsSync.readFileSync(CERT_PATH)
    };

    const server = https.createServer(sslOptions, app);
    initWebSocketServer(server);

    server.listen(PORT, () => {
      console.log(`\n===========================================`);
      console.log(`🔒 Servidor Kortexa HTTPS (SSL/TLS) activo en:`);
      console.log(`👉 https://localhost:${PORT}`);
      console.log(`⚡ Canal WebSocket activo en: wss://localhost:${PORT}/ws`);
      console.log(`📂 Raíz de bóvedas de usuarios: ${USER_VAULTS_ROOT}`);
      console.log(`📜 Certificados: ${KEY_PATH}`);
      console.log(`===========================================\n`);
    });
  } catch (sslErr) {
    console.error('Error al inicializar HTTPS con certificados:', sslErr.message);
    console.log('Iniciando en modo HTTP como respaldo...');
    const server = http.createServer(app);
    initWebSocketServer(server);
    server.listen(PORT, () => {
      console.log(`\n===========================================`);
      console.log(`🧠 Servidor Kortexa HTTP corriendo en:`);
      console.log(`👉 http://localhost:${PORT}`);
      console.log(`⚡ Canal WebSocket activo en: ws://localhost:${PORT}/ws`);
      console.log(`📂 Raíz de bóvedas de usuarios: ${USER_VAULTS_ROOT}`);
      console.log(`===========================================\n`);
    });
  }
} else {
  const server = http.createServer(app);
  initWebSocketServer(server);
  server.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`🧠 Servidor Kortexa HTTP corriendo en:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`⚡ Canal WebSocket activo en: ws://localhost:${PORT}/ws`);
    console.log(`📂 Raíz de bóvedas de usuarios: ${USER_VAULTS_ROOT}`);
    console.log(`===========================================\n`);
  });
}
