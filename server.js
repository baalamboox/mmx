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
  validateMcpToken
} from './auth-db.js';

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
    const activeVault = await ensureUserVault(req.user);
    req.userVault = activeVault;
    req.userVaultDir = getUserVaultDir(req.user, activeVault.name);

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
    const activeVault = await ensureUserVault(req.user);
    const isEncrypted = !!activeVault.encrypted;
    const activeKey = getActiveVaultKey(req.user.id, activeVault.name);
    const isLocked = isEncrypted && !activeKey;
    const vaultDir = getUserVaultDir(req.user, activeVault.name);

    res.json({
      name: activeVault.name,
      path: vaultDir,
      encrypted: isEncrypted,
      locked: isLocked
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener bóveda activa', details: err.message });
  }
});

// Desbloquear bóveda cifrada mediante contraseña para el usuario
app.post('/api/vault/unlock', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const activeVault = await ensureUserVault(req.user);

    if (!activeVault.encrypted) {
      return res.json({ success: true, message: 'La bóveda no está cifrada', locked: false, name: activeVault.name });
    }

    if (!password) {
      return res.status(400).json({ error: 'La contraseña es requerida' });
    }

    const salt = Buffer.from(activeVault.salt, 'hex');
    const derivedKey = deriveKey(password, salt);
    const actualHash = createVerificationHash(derivedKey);

    if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(activeVault.verification_hash, 'hex'))) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    setActiveVaultKey(req.user.id, activeVault.name, derivedKey, salt);

    res.json({ success: true, message: 'Bóveda desbloqueada con éxito', locked: false, name: activeVault.name });
  } catch (err) {
    res.status(500).json({ error: 'Error al desbloquear bóveda', details: err.message });
  }
});

// Bloquear bóveda activa (eliminar clave en memoria del usuario)
app.post('/api/vault/lock', requireAuth, async (req, res) => {
  try {
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

      const isCurrent = !!v.is_active;
      const activeKey = getActiveVaultKey(req.user.id, v.name);
      result.push({
        name: v.name,
        path: vPath,
        filesCount: fileCount,
        isActive: isCurrent,
        isEncrypted: !!v.encrypted,
        isLocked: !!v.encrypted && (!isCurrent || !activeKey)
      });
    }

    const active = userVaults.find(v => v.is_active) || userVaults[0];
    const activeKey = active ? getActiveVaultKey(req.user.id, active.name) : null;

    res.json({
      active: active ? active.name : '',
      encrypted: !!active?.encrypted,
      locked: !!active?.encrypted && !activeKey,
      vaults: result
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
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'El nombre de la bóveda es requerido' });
    }
    const cleanName = name.replace(/[<>:"/\\|?*]/g, '').trim();

    const userVaults = getUserVaults(req.user.id);
    const targetVault = userVaults.find(v => v.name.toLowerCase() === cleanName.toLowerCase());
    if (!targetVault) {
      return res.status(404).json({ error: `La bóveda "${cleanName}" no existe en tu cuenta` });
    }

    setUserActiveVault(req.user.id, targetVault.name);
    const targetDir = getUserVaultDir(req.user, targetVault.name);
    const activeKey = getActiveVaultKey(req.user.id, targetVault.name);

    res.json({
      success: true,
      name: targetVault.name,
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
    let { folder } = req.body;
    if (!folder) {
      return res.status(400).json({ error: 'El nombre de la carpeta es requerido' });
    }

    const cleanFolder = folder.replace(/[<>:"|?*]/g, '').trim();
    const fullPath = resolveUserVaultPath(req.user, req.userVault.name, cleanFolder);

    await fs.mkdir(fullPath, { recursive: true });
    res.json({ success: true, folder: cleanFolder.replace(/\\/g, '/') });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear carpeta', details: err.message });
  }
});

// 4. Eliminar una subcarpeta en la bóveda del usuario
app.delete('/api/folders', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const folder = req.query.folder || req.body.folder;
    if (!folder) {
      return res.status(400).json({ error: 'La ruta de la carpeta es requerida' });
    }

    const fullPath = resolveUserVaultPath(req.user, req.userVault.name, folder);
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
    const fullPath = resolveUserVaultPath(req.user, req.userVault.name, rawPath);
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
    const { filename, folder, base64 } = req.body;
    if (!filename || !base64) {
      return res.status(400).json({ error: 'Se requiere nombre de archivo y contenido en base64' });
    }

    const cleanFolder = (folder || '').replace(/\\/g, '/').replace(/[<>:"|?*]/g, '').trim();
    const cleanName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '').trim();
    const relativePath = cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
    const fullPath = resolveUserVaultPath(req.user, req.userVault.name, relativePath);

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

    const fullPath = resolveUserVaultPath(req.user, req.userVault.name, notePath);
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

    const fullPath = resolveUserVaultPath(req.user, req.userVault.name, relativePath);

    if (oldPath && oldPath !== relativePath) {
      try {
        const oldFullPath = resolveUserVaultPath(req.user, req.userVault.name, oldPath);
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
    let notePath = req.query.path || req.params.path;
    if (!notePath) {
      return res.status(400).json({ error: 'Ruta de archivo requerida' });
    }
    if (!path.extname(notePath)) notePath += '.md';

    const fullPath = resolveUserVaultPath(req.user, req.userVault.name, notePath);
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
    server.listen(PORT, () => {
      console.log(`\n===========================================`);
      console.log(`🔒 Servidor Kortexa HTTPS (SSL/TLS) activo en:`);
      console.log(`👉 https://localhost:${PORT}`);
      console.log(`📂 Raíz de bóvedas de usuarios: ${USER_VAULTS_ROOT}`);
      console.log(`📜 Certificados: ${KEY_PATH}`);
      console.log(`===========================================\n`);
    });
  } catch (sslErr) {
    console.error('Error al inicializar HTTPS con certificados:', sslErr.message);
    console.log('Iniciando en modo HTTP como respaldo...');
    app.listen(PORT, () => {
      console.log(`\n===========================================`);
      console.log(`🧠 Servidor Kortexa HTTP corriendo en:`);
      console.log(`👉 http://localhost:${PORT}`);
      console.log(`📂 Raíz de bóvedas de usuarios: ${USER_VAULTS_ROOT}`);
      console.log(`===========================================\n`);
    });
  }
} else {
  app.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`🧠 Servidor Kortexa HTTP corriendo en:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`📂 Raíz de bóvedas de usuarios: ${USER_VAULTS_ROOT}`);
    console.log(`===========================================\n`);
  });
}
