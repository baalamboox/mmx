import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

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

let config = loadConfig();
let VAULT_DIR = path.isAbsolute(config.vaultDir) 
  ? config.vaultDir 
  : path.join(__dirname, config.vaultDir);

// Estado en memoria de la clave activa de la bóveda
let activeVaultKey = null;
let activeVaultSalt = null;

function tryAutoUnlock() {
  const currentVault = path.basename(VAULT_DIR);
  const meta = config.vaultsMeta?.[currentVault];
  if (meta?.encrypted && process.env.VAULT_PASSWORD) {
    try {
      const salt = Buffer.from(meta.salt, 'hex');
      const key = deriveKey(process.env.VAULT_PASSWORD, salt);
      const hash = createVerificationHash(key);
      if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(meta.verificationHash, 'hex'))) {
        activeVaultKey = key;
        activeVaultSalt = salt;
        console.log(`🔓 Bóveda "${currentVault}" desbloqueada automáticamente mediante VAULT_PASSWORD.`);
      }
    } catch (err) {
      console.warn('Fallo al auto-desbloquear bóveda:', err.message);
    }
  }
}
tryAutoUnlock();

// Lectura y Escritura Segura con Cifrado Transparente
async function readVaultFileBuffer(fullPath) {
  const raw = await fs.readFile(fullPath);
  if (isEncrypted(raw)) {
    if (!activeVaultKey) {
      const err = new Error('Bóveda bloqueada');
      err.code = 'LOCKED';
      throw err;
    }
    return decryptBuffer(raw, activeVaultKey);
  }
  return raw;
}

async function readVaultFileText(fullPath) {
  const buf = await readVaultFileBuffer(fullPath);
  return buf.toString('utf-8');
}

async function writeVaultFile(fullPath, contentOrBuffer) {
  const buf = Buffer.isBuffer(contentOrBuffer) 
    ? contentOrBuffer 
    : Buffer.from(contentOrBuffer ?? '', 'utf-8');

  const currentVault = path.basename(VAULT_DIR);
  const meta = config.vaultsMeta?.[currentVault];

  if (meta?.encrypted) {
    if (!activeVaultKey) {
      const err = new Error('Bóveda bloqueada');
      err.code = 'LOCKED';
      throw err;
    }
    const encryptedBuf = encryptBuffer(buf, activeVaultKey, activeVaultSalt);
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

// Middleware de verificación de bloqueo
function checkVaultLock(req, res, next) {
  const currentVault = path.basename(VAULT_DIR);
  const meta = config.vaultsMeta?.[currentVault];
  if (meta?.encrypted && !activeVaultKey) {
    return res.status(423).json({
      error: 'Bóveda bloqueada. Ingrese su contraseña maestra para acceder.',
      locked: true,
      vault: currentVault
    });
  }
  next();
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

// Asegurar que la carpeta vault exista
await fs.mkdir(VAULT_DIR, { recursive: true });

// ==========================================
// FUNCIONES AUXILIARES RECURSIVAS
// ==========================================

// Escanear todos los archivos del vault recursivamente (notas y archivos multimedia)
async function getAllVaultFiles(dir = VAULT_DIR, base = VAULT_DIR) {
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
    console.error('Error al escanear directorio del vault:', err);
    return [];
  }
}

// Obtener solo notas markdown para análisis sintáctico
async function getAllMdFiles() {
  const all = await getAllVaultFiles();
  return all.filter(f => f.type === 'note');
}

// Escanear todas las subcarpetas existentes recursivamente
async function getAllFolders(dir = VAULT_DIR, base = VAULT_DIR) {
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

// Resolver ruta segura dentro de la bóveda
function resolveVaultPath(relativePath) {
  const safeRelative = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(VAULT_DIR, safeRelative);
  if (!fullPath.startsWith(VAULT_DIR)) {
    throw new Error('Acceso no autorizado fuera de la bóveda');
  }
  return fullPath;
}

// ==========================================
// RUTAS API
// ==========================================

// 0. Obtener información y estado de cifrado de la bóveda activa
app.get('/api/vault', (req, res) => {
  const currentVault = path.basename(VAULT_DIR);
  const meta = config.vaultsMeta?.[currentVault];
  const isEncrypted = !!meta?.encrypted;
  const isLocked = isEncrypted && !activeVaultKey;

  res.json({
    name: currentVault,
    path: VAULT_DIR,
    encrypted: isEncrypted,
    locked: isLocked
  });
});

// Desbloquear bóveda cifrada mediante contraseña
app.post('/api/vault/unlock', (req, res) => {
  try {
    const { password } = req.body;
    const currentVault = path.basename(VAULT_DIR);
    const meta = config.vaultsMeta?.[currentVault];

    if (!meta?.encrypted) {
      return res.json({ success: true, message: 'La bóveda no está cifrada', locked: false, name: currentVault });
    }

    if (!password) {
      return res.status(400).json({ error: 'La contraseña es requerida' });
    }

    const salt = Buffer.from(meta.salt, 'hex');
    const derivedKey = deriveKey(password, salt);
    const actualHash = createVerificationHash(derivedKey);

    if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(meta.verificationHash, 'hex'))) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    activeVaultKey = derivedKey;
    activeVaultSalt = salt;

    res.json({ success: true, message: 'Bóveda desbloqueada con éxito', locked: false, name: currentVault });
  } catch (err) {
    res.status(500).json({ error: 'Error al desbloquear bóveda', details: err.message });
  }
});

// Bloquear bóveda activa (eliminar clave en memoria)
app.post('/api/vault/lock', (req, res) => {
  activeVaultKey = null;
  activeVaultSalt = null;
  const currentVault = path.basename(VAULT_DIR);
  res.json({ success: true, message: 'Bóveda bloqueada', locked: true, name: currentVault });
});

// Cifrar físicamente la bóveda activa con AES-256-GCM
app.post('/api/vault/encrypt', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    const currentVault = path.basename(VAULT_DIR);
    const meta = config.vaultsMeta?.[currentVault];
    if (meta?.encrypted) {
      return res.status(400).json({ error: 'La bóveda ya se encuentra cifrada' });
    }

    const salt = crypto.randomBytes(16);
    const derivedKey = deriveKey(password, salt);
    const verificationHash = createVerificationHash(derivedKey);

    // Cifrar físicamente todos los archivos en disco
    await encryptDirectory(VAULT_DIR, derivedKey, salt);

    if (!config.vaultsMeta) config.vaultsMeta = {};
    config.vaultsMeta[currentVault] = {
      encrypted: true,
      salt: salt.toString('hex'),
      verificationHash
    };
    saveConfig(config);

    activeVaultKey = derivedKey;
    activeVaultSalt = salt;

    res.json({
      success: true,
      message: `Bóveda "${currentVault}" cifrada con AES-256-GCM`,
      encrypted: true,
      locked: false
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al cifrar la bóveda', details: err.message });
  }
});

// Descifrar físicamente la bóveda activa a texto plano
app.post('/api/vault/decrypt', async (req, res) => {
  try {
    const { password } = req.body;
    const currentVault = path.basename(VAULT_DIR);
    const meta = config.vaultsMeta?.[currentVault];

    if (!meta?.encrypted) {
      return res.status(400).json({ error: 'La bóveda no está cifrada' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Se requiere la contraseña para descifrar' });
    }

    const salt = Buffer.from(meta.salt, 'hex');
    const derivedKey = deriveKey(password, salt);
    const actualHash = createVerificationHash(derivedKey);

    if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(meta.verificationHash, 'hex'))) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    // Descifrar físicamente todos los archivos en disco a texto plano
    await decryptDirectory(VAULT_DIR, derivedKey);

    delete config.vaultsMeta[currentVault];
    saveConfig(config);

    activeVaultKey = null;
    activeVaultSalt = null;

    res.json({
      success: true,
      message: `Bóveda "${currentVault}" descifrada a texto plano`,
      encrypted: false,
      locked: false
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al descifrar la bóveda', details: err.message });
  }
});

// Listar todas las bóvedas disponibles
app.get('/api/vaults', async (req, res) => {
  try {
    if (!Array.isArray(config.vaults)) {
      config.vaults = [path.basename(VAULT_DIR)];
    }
    const parentDir = path.dirname(VAULT_DIR);
    const result = [];

    for (const vName of config.vaults) {
      const vPath = path.isAbsolute(vName) ? vName : path.join(parentDir, vName);
      try {
        const stat = await fs.stat(vPath);
        if (stat.isDirectory()) {
          let fileCount = 0;
          try {
            const files = await fs.readdir(vPath);
            fileCount = files.length;
          } catch {}
          const vMeta = config.vaultsMeta?.[vName];
          const isCurrent = path.resolve(vPath).toLowerCase() === path.resolve(VAULT_DIR).toLowerCase();
          result.push({
            name: path.basename(vPath),
            path: vPath,
            filesCount: fileCount,
            isActive: isCurrent,
            isEncrypted: !!vMeta?.encrypted,
            isLocked: !!vMeta?.encrypted && (!isCurrent || !activeVaultKey)
          });
        }
      } catch {}
    }

    const currentVault = path.basename(VAULT_DIR);
    const currentMeta = config.vaultsMeta?.[currentVault];

    res.json({
      active: currentVault,
      encrypted: !!currentMeta?.encrypted,
      locked: !!currentMeta?.encrypted && !activeVaultKey,
      vaults: result
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar las bóvedas', details: err.message });
  }
});

// Crear una nueva bóveda
app.post('/api/vaults', async (req, res) => {
  try {
    const { name, switchNow = true } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'El nombre de la nueva bóveda es requerido' });
    }
    const cleanName = name.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'El nombre contiene caracteres inválidos' });
    }

    const parentDir = path.dirname(VAULT_DIR);
    const newVaultDir = path.join(parentDir, cleanName);

    // Crear directorio si no existe
    let isNew = false;
    try {
      await fs.access(newVaultDir);
    } catch {
      await fs.mkdir(newVaultDir, { recursive: true });
      isNew = true;
    }

    // Si es nueva, crear una nota inicial de bienvenida
    if (isNew) {
      const welcomeContent = `# Bóveda: ${cleanName}\n\n¡Bienvenido a tu nueva bóveda **${cleanName}**!\n\n- Comienza creando notas nuevas con el botón **+** en la barra lateral.\n- Conecta ideas utilizando enlaces de doble corchete como [[Ideas]].\n- Arrastra imágenes, documentos o archivos de audio directamente a la aplicación.\n`;
      await fs.writeFile(path.join(newVaultDir, 'Bienvenida.md'), welcomeContent, 'utf-8');
    }

    if (!Array.isArray(config.vaults)) {
      config.vaults = [path.basename(VAULT_DIR)];
    }
    if (!config.vaults.includes(cleanName)) {
      config.vaults.push(cleanName);
    }

    if (switchNow) {
      VAULT_DIR = newVaultDir;
      config.vaultDir = cleanName;
      config.vaultName = cleanName;
    }
    saveConfig(config);

    res.json({
      success: true,
      name: cleanName,
      path: newVaultDir,
      switched: switchNow,
      active: path.basename(VAULT_DIR),
      vaults: config.vaults
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear la bóveda', details: err.message });
  }
});

// Eliminar una bóveda y sus archivos
app.delete('/api/vaults', async (req, res) => {
  try {
    const name = req.query.name || req.body.name;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'El nombre de la bóveda es requerido' });
    }

    const cleanName = name.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Nombre de bóveda inválido' });
    }

    const parentDir = path.dirname(VAULT_DIR);
    const targetDir = path.join(parentDir, cleanName);

    // Evitar eliminación de directorios raíz del sistema
    if (path.resolve(targetDir) === path.resolve(parentDir) || path.resolve(targetDir) === path.resolve(__dirname)) {
      return res.status(400).json({ error: 'No se puede eliminar este directorio del sistema' });
    }

    // Eliminar físicamente los archivos del directorio en disco
    try {
      await fs.access(targetDir);
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      // Si la carpeta no existía físicamente, continuamos para depurar la configuración
    }

    // Remover de la lista de bóvedas
    if (Array.isArray(config.vaults)) {
      config.vaults = config.vaults.filter(v => v !== cleanName);
    }
    // Remover metadatos de cifrado si existían
    if (config.vaultsMeta?.[cleanName]) {
      delete config.vaultsMeta[cleanName];
    }

    const wasActive = path.resolve(targetDir).toLowerCase() === path.resolve(VAULT_DIR).toLowerCase();

    // Si la bóveda eliminada era la activa, alternar a otra disponible o reiniciar una por defecto
    if (wasActive) {
      activeVaultKey = null;
      activeVaultSalt = null;

      if (config.vaults && config.vaults.length > 0) {
        const nextVault = config.vaults[0];
        VAULT_DIR = path.join(parentDir, nextVault);
        config.vaultDir = nextVault;
        config.vaultName = nextVault;
      } else {
        const defaultVault = 'vault';
        VAULT_DIR = path.join(parentDir, defaultVault);
        await fs.mkdir(VAULT_DIR, { recursive: true });
        config.vaultDir = defaultVault;
        config.vaultName = defaultVault;
        config.vaults = [defaultVault];
      }
      tryAutoUnlock();
    }

    saveConfig(config);

    res.json({
      success: true,
      message: `Bóveda "${cleanName}" eliminada con éxito`,
      wasActive,
      active: path.basename(VAULT_DIR),
      vaults: config.vaults
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar la bóveda', details: err.message });
  }
});

// Cambiar la bóveda activa
app.post('/api/vault/switch', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'El nombre de la bóveda es requerido' });
    }
    const cleanName = name.replace(/[<>:"/\\|?*]/g, '').trim();
    const parentDir = path.dirname(VAULT_DIR);
    const targetDir = path.join(parentDir, cleanName);

    try {
      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'La ruta especificada no es un directorio' });
      }
    } catch {
      return res.status(404).json({ error: `La bóveda "${cleanName}" no existe en el disco` });
    }

    VAULT_DIR = targetDir;
    config.vaultDir = cleanName;
    config.vaultName = cleanName;
    if (!Array.isArray(config.vaults)) {
      config.vaults = [];
    }
    if (!config.vaults.includes(cleanName)) {
      config.vaults.push(cleanName);
    }
    saveConfig(config);

    activeVaultKey = null;
    activeVaultSalt = null;
    tryAutoUnlock();

    const targetMeta = config.vaultsMeta?.[cleanName];
    const isEncrypted = !!targetMeta?.encrypted;
    const isLocked = isEncrypted && !activeVaultKey;

    res.json({
      success: true,
      name: cleanName,
      path: VAULT_DIR,
      encrypted: isEncrypted,
      locked: isLocked
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar de bóveda', details: err.message });
  }
});

// Renombrar la bóveda activa
app.post('/api/vault/rename', async (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName || typeof newName !== 'string') {
      return res.status(400).json({ error: 'El nombre de la bóveda es requerido' });
    }
    const cleanName = newName.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'El nombre contiene caracteres inválidos' });
    }

    const oldVaultDir = VAULT_DIR;
    const oldName = path.basename(oldVaultDir);
    const parentDir = path.dirname(oldVaultDir);
    const newVaultDir = path.join(parentDir, cleanName);

    // Si el nombre no cambió en absoluto
    if (oldName === cleanName) {
      return res.json({ success: true, name: cleanName, path: VAULT_DIR });
    }

    // Verificar si el destino ya existe (diferenciando colisión con otra carpeta)
    if (path.resolve(oldVaultDir).toLowerCase() !== path.resolve(newVaultDir).toLowerCase()) {
      try {
        await fs.access(newVaultDir);
        return res.status(400).json({ error: `Ya existe una carpeta o bóveda llamada "${cleanName}"` });
      } catch (err) {
        // No existe, proceed
      }

      await fs.rename(oldVaultDir, newVaultDir);
    } else {
      // Cambio únicamente de mayúsculas/minúsculas en sistemas de archivos case-insensitive (como Windows)
      const tempVaultDir = path.join(parentDir, `__temp_vault_${Date.now()}`);
      await fs.rename(oldVaultDir, tempVaultDir);
      await fs.rename(tempVaultDir, newVaultDir);
    }

    VAULT_DIR = newVaultDir;
    config.vaultDir = cleanName;
    config.vaultName = cleanName;
    if (Array.isArray(config.vaults)) {
      const idx = config.vaults.indexOf(oldName);
      if (idx !== -1) {
        config.vaults[idx] = cleanName;
      } else if (!config.vaults.includes(cleanName)) {
        config.vaults.push(cleanName);
      }
    }
    if (config.vaultsMeta?.[oldName]) {
      config.vaultsMeta[cleanName] = config.vaultsMeta[oldName];
      delete config.vaultsMeta[oldName];
    }
    saveConfig(config);

    res.json({ success: true, name: cleanName, path: VAULT_DIR });
  } catch (err) {
    res.status(500).json({ error: 'Error al renombrar bóveda', details: err.message });
  }
});

// 1. Obtener todos los archivos de la bóveda (notas y multimedia)
app.get('/api/notes', checkVaultLock, async (req, res) => {
  try {
    const files = await getAllVaultFiles();
    files.sort((a, b) => b.mtime - a.mtime);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar los archivos', details: err.message });
  }
});

// 2. Obtener lista de todas las subcarpetas existentes
app.get('/api/folders', checkVaultLock, async (req, res) => {
  try {
    const folders = await getAllFolders();
    folders.sort();
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: 'Error al listar carpetas', details: err.message });
  }
});

// 3. Crear una nueva subcarpeta
app.post('/api/folders', checkVaultLock, async (req, res) => {
  try {
    let { folder } = req.body;
    if (!folder) {
      return res.status(400).json({ error: 'El nombre de la carpeta es requerido' });
    }

    // Normalizar y sanitizar ruta
    const cleanFolder = folder.replace(/[<>:"|?*]/g, '').trim();
    const fullPath = resolveVaultPath(cleanFolder);

    await fs.mkdir(fullPath, { recursive: true });
    res.json({ success: true, folder: cleanFolder.replace(/\\/g, '/') });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear carpeta', details: err.message });
  }
});

// 4. Eliminar una subcarpeta
app.delete('/api/folders', checkVaultLock, async (req, res) => {
  try {
    const folder = req.query.folder || req.body.folder;
    if (!folder) {
      return res.status(400).json({ error: 'La ruta de la carpeta es requerida' });
    }

    const fullPath = resolveVaultPath(folder);
    await fs.rm(fullPath, { recursive: true, force: true });
    res.json({ success: true, message: `Carpeta ${folder} eliminada.` });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar carpeta', details: err.message });
  }
});

// 5. Servir archivo estático/multimedia de la bóveda de forma segura
app.get('/api/vault-raw/:path(*)', checkVaultLock, async (req, res) => {
  try {
    const rawPath = req.params.path;
    const fullPath = resolveVaultPath(rawPath);
    await fs.access(fullPath);
    const buf = await readVaultFileBuffer(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.setHeader('Cache-Control', 'public, max-age=86400');
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

// 6. Subir archivo multimedia o documento a la bóveda
app.post('/api/upload', checkVaultLock, async (req, res) => {
  try {
    const { filename, folder, base64 } = req.body;
    if (!filename || !base64) {
      return res.status(400).json({ error: 'Se requiere nombre de archivo y contenido en base64' });
    }

    const cleanFolder = (folder || '').replace(/\\/g, '/').replace(/[<>:"|?*]/g, '').trim();
    const cleanName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '').trim();
    const relativePath = cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
    const fullPath = resolveVaultPath(relativePath);

    // Asegurar directorio padre
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Guardar buffer binario (con cifrado si la bóveda está protegida)
    const buffer = Buffer.from(base64, 'base64');
    await writeVaultFile(fullPath, buffer);

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
app.get('/api/note', checkVaultLock, async (req, res) => {
  try {
    let notePath = req.query.path;
    const title = req.query.title;

    if (!notePath && title) {
      const allFiles = await getAllVaultFiles();
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

    const fullPath = resolveVaultPath(notePath);
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

    const content = await readVaultFileText(fullPath);

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
app.get('/api/notes/:path(*)', checkVaultLock, async (req, res) => {
  try {
    let notePath = req.params.path;
    if (!path.extname(notePath)) notePath += '.md';

    let fullPath;
    try {
      fullPath = resolveVaultPath(notePath);
      await fs.access(fullPath);
    } catch {
      const allFiles = await getAllVaultFiles();
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

    const content = await readVaultFileText(fullPath);

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

// 6. Crear o actualizar una nota (con soporte para subcarpetas y mover de carpeta)
app.post('/api/notes', checkVaultLock, async (req, res) => {
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

    const fullPath = resolveVaultPath(relativePath);

    // Si se renombró o se movió de carpeta, borrar el archivo anterior
    if (oldPath && oldPath !== relativePath) {
      try {
        const oldFullPath = resolveVaultPath(oldPath);
        await fs.unlink(oldFullPath);
      } catch (err) {
        // Ignorar si el anterior no existía
      }
    }

    // Asegurar que la subcarpeta destino exista
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Guardar archivo (cifrado si la bóveda está protegida)
    await writeVaultFile(fullPath, content ?? '');

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
app.delete(['/api/notes', '/api/notes/:path(*)'], checkVaultLock, async (req, res) => {
  try {
    let notePath = req.query.path || req.params.path;
    if (!notePath) {
      return res.status(400).json({ error: 'Ruta de archivo requerida' });
    }
    if (!path.extname(notePath)) notePath += '.md';

    const fullPath = resolveVaultPath(notePath);
    await fs.unlink(fullPath);
    res.json({ success: true, message: `Archivo ${notePath} eliminado.` });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar el archivo', details: err.message });
  }
});

// 9. Datos para el Grafo (Nodos y Enlaces con soporte de subcarpetas y multimedia)
app.get('/api/graph', checkVaultLock, async (req, res) => {
  try {
    const allFiles = await getAllVaultFiles();
    const mdFiles = allFiles.filter(f => f.type === 'note');
    const nodesMap = new Map();
    const links = [];

    // Registrar todos los nodos existentes (notas y multimedia)
    for (const file of allFiles) {
      nodesMap.set(file.title, {
        id: file.title,
        name: file.name,
        filename: file.filename,
        folder: file.folder,
        type: file.type,
        exists: true
      });
      // Registrar también por nombre completo con extensión
      if (file.name !== file.title) {
        nodesMap.set(file.name, nodesMap.get(file.title));
      }
    }

    // Extraer enlaces [[Wikilinks]] e incrustaciones ![[Archivo]]
    for (const file of mdFiles) {
      const sourceTitle = file.title;
      const content = await readVaultFileText(file.fullPath);
      const matches = [...content.matchAll(WIKI_LINK_REGEX)];

      for (const match of matches) {
        let rawTarget = match[1].trim();
        if (!rawTarget) continue;
        // Soporte para ![[archivo.png|300]]
        if (rawTarget.includes('|')) {
          rawTarget = rawTarget.split('|')[0].trim();
        }
        const targetTitle = rawTarget;
        if (!targetTitle) continue;

        // Si el destino no existe físicamente en ninguna carpeta, marcarlo como nodo pendiente
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
app.get('/api/backlinks/:title', checkVaultLock, async (req, res) => {
  try {
    const targetTitle = req.params.title.replace(/\.md$/, '');
    const mdFiles = await getAllMdFiles();
    const backlinks = [];
    const searchTarget = `[[${targetTitle}]]`;

    for (const file of mdFiles) {
      if (file.title.toLowerCase() === targetTitle.toLowerCase()) continue;

      const content = await readVaultFileText(file.fullPath);
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
app.get('/api/search', checkVaultLock, async (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase().trim();
    if (!query) {
      return res.json([]);
    }

    const mdFiles = await getAllMdFiles();
    const results = [];

    for (const file of mdFiles) {
      const content = await readVaultFileText(file.fullPath);
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

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n===========================================`);
  console.log(`🧠 Servidor Kortexa corriendo en:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`📂 Bóveda de notas: ${VAULT_DIR}`);
  console.log(`===========================================\n`);
});
