import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'kortexa_auth.db');

let dbInstance = null;

export function getAuthDb() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    initTables(dbInstance);
  }
  return dbInstance;
}

function initTables(db) {
  // Tabla de usuarios
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombres TEXT NOT NULL,
      apellido_paterno TEXT NOT NULL,
      apellido_materno TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_vaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      is_active BOOLEAN DEFAULT 0,
      encrypted BOOLEAN DEFAULT 0,
      salt TEXT,
      verification_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_vaults ON user_vaults(user_id);

    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL, -- 'file', 'folder', 'vault'
      vault_name TEXT NOT NULL,
      resource_path TEXT,          -- ruta relativa o '' si es vault
      resource_title TEXT NOT NULL,
      shared_with_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL si es enlace público
      share_token TEXT UNIQUE,     -- token único para enlaces públicos
      permission TEXT NOT NULL DEFAULT 'read', -- 'read' o 'write'
      password_hash TEXT,
      password_salt TEXT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);
    CREATE INDEX IF NOT EXISTS idx_shares_shared_with ON shares(shared_with_user_id);
    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(share_token);
    CREATE INDEX IF NOT EXISTS idx_shares_resource ON shares(owner_id, vault_name, resource_path);

    CREATE TABLE IF NOT EXISTS friendships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'accepted', 'rejected'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sender_id, receiver_id)
    );

    CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(sender_id, receiver_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_receiver ON friendships(receiver_id, status);

    CREATE TABLE IF NOT EXISTS direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_direct_messages_pair ON direct_messages(sender_id, receiver_id, created_at);
  `);

  // Migraciones / Columnas adicionales
  try {
    db.exec(`ALTER TABLE users ADD COLUMN mcp_enabled INTEGER DEFAULT 1;`);
  } catch {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN mcp_token TEXT;`);
  } catch {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN active_shared_vault_id INTEGER;`);
  } catch {}
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, storedHash) {
  const hash = hashPassword(password, salt);
  const hashBuf = Buffer.from(hash, 'hex');
  const storedBuf = Buffer.from(storedHash, 'hex');
  if (hashBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, storedBuf);
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombres: row.nombres,
    apellido_paterno: row.apellido_paterno,
    apellido_materno: row.apellido_materno,
    nombre_completo: `${row.nombres} ${row.apellido_paterno} ${row.apellido_materno}`.trim(),
    email: row.email,
    username: row.username,
    created_at: row.created_at,
    mcp_enabled: row.mcp_enabled === undefined || row.mcp_enabled === null || Number(row.mcp_enabled) === 1,
    mcp_token: row.mcp_token || null,
    active_shared_vault_id: row.active_shared_vault_id || null
  };
}

export function registerUser({ nombres, apellido_paterno, apellido_materno, email, username, password }) {
  const db = getAuthDb();

  const cleanNombres = String(nombres || '').trim();
  const cleanPaterno = String(apellido_paterno || '').trim();
  const cleanMaterno = String(apellido_materno || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanUsername = String(username || '').trim().toLowerCase();

  // Validaciones
  if (!cleanNombres || !cleanPaterno || !cleanMaterno) {
    throw new Error('Todos los campos de nombre y apellidos son requeridos.');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!cleanEmail || !emailRegex.test(cleanEmail)) {
    throw new Error('El correo electrónico no tiene un formato válido.');
  }

  if (!cleanUsername || cleanUsername.length < 3 || !/^[a-z0-9._-]+$/i.test(cleanUsername)) {
    throw new Error('El nombre de usuario debe tener al menos 3 caracteres y solo contener letras, números, puntos, guiones o guiones bajos.');
  }

  if (!password || String(password).length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres.');
  }

  // Comprobar existencia previa de email
  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existingEmail) {
    throw new Error('El correo electrónico ya se encuentra registrado.');
  }

  // Comprobar existencia previa de username
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existingUser) {
    throw new Error('El nombre de usuario ya está en uso. Por favor elige otro.');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);

  const insert = db.prepare(`
    INSERT INTO users (nombres, apellido_paterno, apellido_materno, email, username, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    cleanNombres,
    cleanPaterno,
    cleanMaterno,
    cleanEmail,
    cleanUsername,
    passwordHash,
    salt
  );

  const user = safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid));
  const session = createSession(user.id);

  return { user, token: session.token, expires_at: session.expires_at };
}

export function loginUser({ usernameOrEmail, password }) {
  const db = getAuthDb();
  const cleanIdentifier = String(usernameOrEmail || '').trim().toLowerCase();

  if (!cleanIdentifier || !password) {
    throw new Error('Por favor ingresa tu usuario/correo y contraseña.');
  }

  const row = db.prepare(`
    SELECT * FROM users WHERE email = ? OR username = ?
  `).get(cleanIdentifier, cleanIdentifier);

  if (!row) {
    throw new Error('Credenciales incorrectas. Verifica tu usuario/correo y contraseña.');
  }

  const isValid = verifyPassword(password, row.password_salt, row.password_hash);
  if (!isValid) {
    throw new Error('Credenciales incorrectas. Verifica tu usuario/correo y contraseña.');
  }

  const user = safeUser(row);
  const session = createSession(user.id);

  return { user, token: session.token, expires_at: session.expires_at };
}

export function createSession(userId, daysValid = 7) {
  const db = getAuthDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, userId, expiresAt);

  return { token, expires_at: expiresAt };
}

export function validateSession(token) {
  if (!token || typeof token !== 'string') return null;
  const db = getAuthDb();

  const row = db.prepare(`
    SELECT s.token, s.expires_at, u.*
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
  `).get(token);

  if (!row) return null;
  return safeUser(row);
}

export function deleteSession(token) {
  if (!token) return false;
  const db = getAuthDb();
  const res = db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return res.changes > 0;
}

export function getUserCount() {
  const db = getAuthDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return row ? Number(row.count) : 0;
}

// ==========================================
// OPERACIONES DE BÓVEDAS POR USUARIO
// ==========================================

export function getUserVaults(userId) {
  const db = getAuthDb();
  return db.prepare(`
    SELECT id, user_id, name, is_active, encrypted, salt, verification_hash, created_at
    FROM user_vaults
    WHERE user_id = ?
    ORDER BY created_at ASC
  `).all(userId);
}

export function getUserActiveVault(userId) {
  const db = getAuthDb();
  let row = db.prepare(`
    SELECT id, user_id, name, is_active, encrypted, salt, verification_hash
    FROM user_vaults
    WHERE user_id = ? AND is_active = 1
    LIMIT 1
  `).get(userId);

  if (!row) {
    row = db.prepare(`
      SELECT id, user_id, name, is_active, encrypted, salt, verification_hash
      FROM user_vaults
      WHERE user_id = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(userId);

    if (row) {
      db.prepare('UPDATE user_vaults SET is_active = 1 WHERE id = ?').run(row.id);
      row.is_active = 1;
    }
  }

  return row || null;
}

export function setUserActiveVault(userId, vaultName) {
  const db = getAuthDb();
  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare('UPDATE user_vaults SET is_active = 0 WHERE user_id = ?').run(userId);
    const res = db.prepare('UPDATE user_vaults SET is_active = 1 WHERE user_id = ? AND name = ?').run(userId, vaultName);
    db.exec('COMMIT');
    return res.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function addUserVault(userId, vaultName, isActive = false, encrypted = false, salt = null, verificationHash = null) {
  const db = getAuthDb();
  const cleanName = String(vaultName || '').replace(/[<>:"/\\|?*]/g, '').trim();
  if (!cleanName) throw new Error('Nombre de bóveda inválido');

  const existing = db.prepare('SELECT id FROM user_vaults WHERE user_id = ? AND name = ?').get(userId, cleanName);
  if (existing) {
    throw new Error(`La bóveda "${cleanName}" ya existe para este usuario.`);
  }

  if (isActive) {
    db.prepare('UPDATE user_vaults SET is_active = 0 WHERE user_id = ?').run(userId);
  }

  const insert = db.prepare(`
    INSERT INTO user_vaults (user_id, name, is_active, encrypted, salt, verification_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const res = insert.run(userId, cleanName, isActive ? 1 : 0, encrypted ? 1 : 0, salt, verificationHash);
  return db.prepare('SELECT * FROM user_vaults WHERE id = ?').get(res.lastInsertRowid);
}

export function removeUserVault(userId, vaultName) {
  const db = getAuthDb();
  const row = db.prepare('SELECT id, is_active FROM user_vaults WHERE user_id = ? AND name = ?').get(userId, vaultName);
  if (!row) return false;

  db.prepare('DELETE FROM user_vaults WHERE id = ?').run(row.id);

  if (row.is_active) {
    const next = db.prepare('SELECT id FROM user_vaults WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId);
    if (next) {
      db.prepare('UPDATE user_vaults SET is_active = 1 WHERE id = ?').run(next.id);
    }
  }
  return true;
}

export function renameUserVault(userId, oldName, newName) {
  const db = getAuthDb();
  const cleanNew = String(newName || '').replace(/[<>:"/\\|?*]/g, '').trim();
  if (!cleanNew) throw new Error('Nombre nuevo inválido');

  const existing = db.prepare('SELECT id FROM user_vaults WHERE user_id = ? AND name = ?').get(userId, cleanNew);
  if (existing) throw new Error(`Ya existe una bóveda llamada "${cleanNew}".`);

  const res = db.prepare('UPDATE user_vaults SET name = ? WHERE user_id = ? AND name = ?').run(cleanNew, userId, oldName);

  // Actualizar referencias a la bóveda en la tabla de recursos compartidos (shares)
  try {
    db.prepare('UPDATE shares SET vault_name = ? WHERE owner_id = ? AND vault_name = ?').run(cleanNew, userId, oldName);
  } catch {}

  return res.changes > 0;
}

export function updateUserVaultEncryption(userId, vaultName, encrypted, salt = null, verificationHash = null) {
  const db = getAuthDb();
  const res = db.prepare(`
    UPDATE user_vaults
    SET encrypted = ?, salt = ?, verification_hash = ?
    WHERE user_id = ? AND name = ?
  `).run(encrypted ? 1 : 0, salt, verificationHash, userId, vaultName);
  return res.changes > 0;
}

export function changeUserPassword(userId, currentPassword, newPassword) {
  const db = getAuthDb();

  if (!currentPassword) {
    throw new Error('Debes ingresar tu contraseña actual.');
  }

  if (!newPassword || String(newPassword).length < 8) {
    throw new Error('La nueva contraseña debe tener al menos 8 caracteres.');
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) {
    throw new Error('Usuario no encontrado.');
  }

  const isValid = verifyPassword(currentPassword, row.password_salt, row.password_hash);
  if (!isValid) {
    throw new Error('La contraseña actual es incorrecta.');
  }

  if (currentPassword === newPassword) {
    throw new Error('La nueva contraseña debe ser diferente a la contraseña actual.');
  }

  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = hashPassword(newPassword, newSalt);

  db.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newHash, newSalt, userId);

  return true;
}

// ==========================================
// CONFIGURACIÓN MCP (MODEL CONTEXT PROTOCOL)
// ==========================================

export function getUserMcpSettings(userId) {
  const db = getAuthDb();
  const row = db.prepare('SELECT id, username, mcp_enabled, mcp_token FROM users WHERE id = ?').get(userId);
  if (!row) throw new Error('Usuario no encontrado.');

  let mcp_token = row.mcp_token;
  if (!mcp_token) {
    mcp_token = 'kortexa_mcp_' + crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE users SET mcp_token = ? WHERE id = ?').run(mcp_token, userId);
  }

  const mcp_enabled = row.mcp_enabled === undefined || row.mcp_enabled === null || Number(row.mcp_enabled) === 1;
  return {
    mcp_enabled,
    mcp_token
  };
}

export function setUserMcpEnabled(userId, enabled) {
  const db = getAuthDb();
  const val = enabled ? 1 : 0;
  db.prepare('UPDATE users SET mcp_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(val, userId);
  return { mcp_enabled: Boolean(enabled) };
}

export function regenerateUserMcpToken(userId) {
  const db = getAuthDb();
  const newToken = 'kortexa_mcp_' + crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE users SET mcp_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newToken, userId);
  return { mcp_token: newToken };
}

export function validateMcpToken(token) {
  if (!token || typeof token !== 'string') return null;
  const db = getAuthDb();
  const row = db.prepare('SELECT * FROM users WHERE mcp_token = ?').get(token);
  if (!row) return null;
  return safeUser(row);
}

// ==========================================
// SISTEMA PARA COMPARTIR (RECURSOS, NOTAS, BÓVEDAS)
// ==========================================

export function getUserById(userId) {
  const db = getAuthDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return safeUser(row);
}

export function searchUsers(query, excludeUserId = null) {
  const db = getAuthDb();
  const qStr = (query || '').trim();
  if (!qStr) return [];
  const pattern = `%${qStr}%`;
  const stmt = db.prepare(`
    SELECT id, nombres, apellido_paterno, apellido_materno, email, username
    FROM users
    WHERE (username LIKE ? OR email LIKE ? OR nombres LIKE ? OR apellido_paterno LIKE ?)
      AND (? IS NULL OR id != ?)
    LIMIT 10
  `);
  const rows = stmt.all(pattern, pattern, pattern, pattern, excludeUserId, excludeUserId);
  return rows.map(r => safeUser(r));
}

export function createOrUpdatePublicShare({ owner_id, vault_name, resource_type, resource_path, resource_title, password = null, expires_at = null }) {
  const db = getAuthDb();
  const cleanPath = (resource_path || '').trim();
  
  // Buscar si ya existe enlace público para este recurso
  const existing = db.prepare(`
    SELECT id, share_token, password_hash, password_salt FROM shares
    WHERE owner_id = ? AND vault_name = ? AND resource_path = ? AND shared_with_user_id IS NULL
  `).get(owner_id, vault_name, cleanPath);

  let token = existing ? existing.share_token : crypto.randomBytes(16).toString('hex');
  let pwdHash = existing ? existing.password_hash : null;
  let pwdSalt = existing ? existing.password_salt : null;

  if (password !== undefined) {
    if (password && password.trim().length > 0) {
      pwdSalt = crypto.randomBytes(16).toString('hex');
      pwdHash = hashPassword(password.trim(), pwdSalt);
    } else {
      pwdSalt = null;
      pwdHash = null;
    }
  }

  if (existing) {
    db.prepare(`
      UPDATE shares
      SET resource_title = ?, password_hash = ?, password_salt = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(resource_title, pwdHash, pwdSalt, expires_at || null, existing.id);
  } else {
    db.prepare(`
      INSERT INTO shares (owner_id, resource_type, vault_name, resource_path, resource_title, shared_with_user_id, share_token, permission, password_hash, password_salt, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 'read', ?, ?, ?)
    `).run(owner_id, resource_type, vault_name, cleanPath, resource_title, token, pwdHash, pwdSalt, expires_at || null);
  }

  return {
    share_token: token,
    has_password: Boolean(pwdHash),
    expires_at
  };
}

export function removePublicShare({ owner_id, vault_name, resource_path }) {
  const db = getAuthDb();
  const cleanPath = (resource_path || '').trim();
  db.prepare(`
    DELETE FROM shares
    WHERE owner_id = ? AND vault_name = ? AND resource_path = ? AND shared_with_user_id IS NULL
  `).run(owner_id, vault_name, cleanPath);
  return true;
}

export function createOrUpdateUserShare({ owner_id, vault_name, resource_type, resource_path, resource_title, shared_with_user_id, permission = 'read' }) {
  const db = getAuthDb();
  const cleanPath = (resource_path || '').trim();
  const perm = permission === 'write' ? 'write' : 'read';

  if (owner_id === shared_with_user_id) {
    throw new Error('No puedes compartir un recurso contigo mismo.');
  }

  const existing = db.prepare(`
    SELECT id FROM shares
    WHERE owner_id = ? AND vault_name = ? AND resource_path = ? AND shared_with_user_id = ?
  `).get(owner_id, vault_name, cleanPath, shared_with_user_id);

  if (existing) {
    db.prepare(`
      UPDATE shares
      SET permission = ?, resource_title = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(perm, resource_title, existing.id);
  } else {
    db.prepare(`
      INSERT INTO shares (owner_id, resource_type, vault_name, resource_path, resource_title, shared_with_user_id, permission)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(owner_id, resource_type, vault_name, cleanPath, resource_title, shared_with_user_id, perm);
  }

  return true;
}

export function removeShareById(share_id, owner_id) {
  const db = getAuthDb();
  const res = db.prepare('DELETE FROM shares WHERE id = ? AND owner_id = ?').run(share_id, owner_id);
  return res.changes > 0;
}

export function getSharesForResource(owner_id, vault_name, resource_path) {
  const db = getAuthDb();
  const cleanPath = (resource_path || '').trim();

  // Enlace público
  const publicShare = db.prepare(`
    SELECT id, share_token, permission, password_hash IS NOT NULL as has_password, expires_at, created_at
    FROM shares
    WHERE owner_id = ? AND vault_name = ? AND resource_path = ? AND shared_with_user_id IS NULL
  `).get(owner_id, vault_name, cleanPath);

  // Compartido con usuarios
  const userShares = db.prepare(`
    SELECT s.id, s.permission, s.created_at, u.id as user_id, u.username, u.email, u.nombres, u.apellido_paterno, u.apellido_materno
    FROM shares s
    JOIN users u ON s.shared_with_user_id = u.id
    WHERE s.owner_id = ? AND s.vault_name = ? AND s.resource_path = ? AND s.shared_with_user_id IS NOT NULL
    ORDER BY s.created_at DESC
  `).all(owner_id, vault_name, cleanPath).map(row => ({
    id: row.id,
    permission: row.permission,
    created_at: row.created_at,
    user: {
      id: row.user_id,
      username: row.username,
      email: row.email,
      nombre_completo: `${row.nombres} ${row.apellido_paterno} ${row.apellido_materno}`.trim()
    }
  }));

  return {
    publicShare: publicShare ? {
      id: publicShare.id,
      share_token: publicShare.share_token,
      permission: publicShare.permission,
      has_password: Boolean(publicShare.has_password),
      expires_at: publicShare.expires_at,
      created_at: publicShare.created_at
    } : null,
    userShares
  };
}

export function getSharesSharedWithUser(user_id) {
  const db = getAuthDb();
  const rows = db.prepare(`
    SELECT s.id, s.resource_type, s.vault_name, s.resource_path, s.resource_title, s.permission, s.created_at,
           u.id as owner_id, u.username as owner_username, u.email as owner_email, u.nombres as owner_nombres, u.apellido_paterno as owner_apellido_paterno
    FROM shares s
    JOIN users u ON s.owner_id = u.id
    WHERE s.shared_with_user_id = ?
    ORDER BY s.updated_at DESC, s.created_at DESC
  `).all(user_id);

  return rows.map(r => ({
    id: r.id,
    resource_type: r.resource_type,
    vault_name: r.vault_name,
    resource_path: r.resource_path,
    resource_title: r.resource_title,
    permission: r.permission,
    created_at: r.created_at,
    owner: {
      id: r.owner_id,
      username: r.owner_username,
      email: r.owner_email,
      nombre_completo: `${r.owner_nombres} ${r.owner_apellido_paterno}`.trim()
    }
  }));
}

export function getShareByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const db = getAuthDb();
  const row = db.prepare(`
    SELECT s.*, u.username as owner_username, u.nombres as owner_nombres, u.apellido_paterno as owner_apellido_paterno
    FROM shares s
    JOIN users u ON s.owner_id = u.id
    WHERE s.share_token = ?
  `).get(token);

  if (!row) return null;

  // Comprobar expiración
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { expired: true };
  }

  return {
    id: row.id,
    owner_id: row.owner_id,
    owner_username: row.owner_username,
    owner_fullname: `${row.owner_nombres} ${row.owner_apellido_paterno}`.trim(),
    resource_type: row.resource_type,
    vault_name: row.vault_name,
    resource_path: row.resource_path,
    resource_title: row.resource_title,
    permission: row.permission,
    has_password: Boolean(row.password_hash),
    password_hash: row.password_hash,
    password_salt: row.password_salt,
    expires_at: row.expires_at,
    created_at: row.created_at
  };
}

export function verifySharePassword(token, password) {
  const share = getShareByToken(token);
  if (!share || share.expired) return false;
  if (!share.has_password) return true;
  if (!password) return false;
  return verifyPassword(password.trim(), share.password_salt, share.password_hash);
}

export function checkUserResourceAccess(user_id, owner_id, vault_name, resource_path) {
  if (user_id === owner_id) return { hasAccess: true, permission: 'write' };
  const db = getAuthDb();
  const cleanPath = (resource_path || '').trim();

  // 1. Acceso directo a este recurso
  let match = db.prepare(`
    SELECT permission FROM shares
    WHERE owner_id = ? AND vault_name = ? AND resource_path = ? AND shared_with_user_id = ?
  `).get(owner_id, vault_name, cleanPath, user_id);

  if (match) return { hasAccess: true, permission: match.permission };

  // 2. Acceso a nivel bóveda completa (resource_path = '')
  match = db.prepare(`
    SELECT permission FROM shares
    WHERE owner_id = ? AND vault_name = ? AND (resource_path IS NULL OR resource_path = '') AND shared_with_user_id = ?
  `).get(owner_id, vault_name, user_id);

  if (match) return { hasAccess: true, permission: match.permission };

  return { hasAccess: false, permission: null };
}

export function getUserSharedVaults(userId) {
  const db = getAuthDb();
  const rows = db.prepare(`
    SELECT s.id as share_id, s.vault_name, s.permission, s.created_at,
           u.id as owner_id, u.username as owner_username, u.email as owner_email,
           u.nombres as owner_nombres, u.apellido_paterno as owner_apellido_paterno,
           uv.encrypted as vault_encrypted, uv.salt as vault_salt, uv.verification_hash as vault_verification_hash
    FROM shares s
    JOIN users u ON s.owner_id = u.id
    LEFT JOIN user_vaults uv ON uv.user_id = s.owner_id AND uv.name = s.vault_name
    WHERE s.shared_with_user_id = ? AND s.resource_type = 'vault'
    ORDER BY s.created_at DESC
  `).all(userId);

  return rows.map(r => ({
    share_id: r.share_id,
    vault_name: r.vault_name,
    permission: r.permission,
    created_at: r.created_at,
    vault_encrypted: r.vault_encrypted,
    vault_salt: r.vault_salt,
    vault_verification_hash: r.vault_verification_hash,
    owner: {
      id: r.owner_id,
      username: r.owner_username,
      email: r.owner_email,
      nombre_completo: `${r.owner_nombres} ${r.owner_apellido_paterno}`.trim()
    }
  }));
}

export function setUserActiveSharedVault(userId, shareId) {
  const db = getAuthDb();
  if (shareId) {
    db.prepare('UPDATE user_vaults SET is_active = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE users SET active_shared_vault_id = ? WHERE id = ?').run(shareId, userId);
  } else {
    db.prepare('UPDATE users SET active_shared_vault_id = NULL WHERE id = ?').run(userId);
    const firstVault = db.prepare('SELECT id FROM user_vaults WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId);
    if (firstVault) {
      db.prepare('UPDATE user_vaults SET is_active = 1 WHERE id = ?').run(firstVault.id);
    }
  }
}

export function getSharedVaultById(shareId, userId) {
  const db = getAuthDb();
  const row = db.prepare(`
    SELECT s.*, u.id as owner_id, u.username as owner_username, u.email as owner_email,
           u.nombres as owner_nombres, u.apellido_paterno as owner_apellido_paterno,
           uv.encrypted as vault_encrypted, uv.salt as vault_salt, uv.verification_hash as vault_verification_hash
    FROM shares s
    JOIN users u ON s.owner_id = u.id
    LEFT JOIN user_vaults uv ON uv.user_id = s.owner_id AND uv.name = s.vault_name
    WHERE s.id = ? AND s.shared_with_user_id = ? AND s.resource_type = 'vault'
  `).get(shareId, userId);
  return row || null;
}

// ==========================================
// SISTEMA DE AMISTAD (FRIENDSHIPS)
// ==========================================

export function areFriends(userA, userB) {
  const db = getAuthDb();
  const u1 = parseInt(userA, 10);
  const u2 = parseInt(userB, 10);
  if (!u1 || !u2 || u1 === u2) return false;

  const row = db.prepare(`
    SELECT id FROM friendships
    WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
      AND status = 'accepted'
  `).get(u1, u2, u2, u1);

  return Boolean(row);
}

export function sendFriendRequest(senderId, receiverId) {
  const db = getAuthDb();
  const sId = parseInt(senderId, 10);
  const rId = parseInt(receiverId, 10);

  if (sId === rId) {
    throw new Error('No puedes enviarte una solicitud de amistad a ti mismo.');
  }

  const receiver = getUserById(rId);
  if (!receiver) {
    throw new Error('El usuario destinatario no existe.');
  }

  // Comprobar si ya existe relación en cualquier sentido
  const existing = db.prepare(`
    SELECT * FROM friendships
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
  `).get(sId, rId, rId, sId);

  if (existing) {
    if (existing.status === 'accepted') {
      throw new Error(`Ya eres amigo de @${receiver.username}.`);
    }
    if (existing.status === 'pending') {
      if (existing.sender_id === sId) {
        throw new Error('Ya enviaste una solicitud de amistad a este usuario. Está pendiente de respuesta.');
      } else {
        // El otro usuario ya le había enviado una solicitud -> Aceptar automáticamente
        db.prepare(`
          UPDATE friendships
          SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(existing.id);

        return {
          id: existing.id,
          autoAccepted: true,
          status: 'accepted',
          friend: receiver
        };
      }
    }
    // Si fue rechazada anteriormente, reactivarla
    db.prepare(`
      UPDATE friendships
      SET sender_id = ?, receiver_id = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(sId, rId, existing.id);

    return {
      id: existing.id,
      autoAccepted: false,
      status: 'pending',
      friend: receiver
    };
  }

  // Crear nueva solicitud
  const info = db.prepare(`
    INSERT INTO friendships (sender_id, receiver_id, status)
    VALUES (?, ?, 'pending')
  `).run(sId, rId);

  return {
    id: info.lastInsertRowid,
    autoAccepted: false,
    status: 'pending',
    friend: receiver
  };
}

export function respondFriendRequest(requestId, receiverId, action) {
  const db = getAuthDb();
  const reqId = parseInt(requestId, 10);
  const rId = parseInt(receiverId, 10);

  const reqRow = db.prepare(`
    SELECT f.*, u.username as sender_username, u.nombres as sender_nombres, u.apellido_paterno as sender_paterno
    FROM friendships f
    JOIN users u ON f.sender_id = u.id
    WHERE f.id = ? AND f.receiver_id = ? AND f.status = 'pending'
  `).get(reqId, rId);

  if (!reqRow) {
    throw new Error('La solicitud de amistad no existe o ya fue respondida.');
  }

  const newStatus = action === 'accept' ? 'accepted' : 'rejected';

  db.prepare(`
    UPDATE friendships
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newStatus, reqId);

  return {
    id: reqId,
    sender_id: reqRow.sender_id,
    receiver_id: reqRow.receiver_id,
    status: newStatus,
    sender_username: reqRow.sender_username
  };
}

export function removeFriend(userId, friendId) {
  const db = getAuthDb();
  const uId = parseInt(userId, 10);
  const fId = parseInt(friendId, 10);

  const res = db.prepare(`
    DELETE FROM friendships
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
  `).run(uId, fId, fId, uId);

  return res.changes > 0;
}

export function getFriendships(userId) {
  const db = getAuthDb();
  const uId = parseInt(userId, 10);

  // 1. Amigos confirmados (status = 'accepted')
  const friendsRows = db.prepare(`
    SELECT f.id as friendship_id, f.created_at as friendship_date,
           u.id as user_id, u.username, u.nombres, u.apellido_paterno, u.apellido_materno, u.email
    FROM friendships f
    JOIN users u ON (CASE WHEN f.sender_id = ? THEN f.receiver_id ELSE f.sender_id END) = u.id
    WHERE (f.sender_id = ? OR f.receiver_id = ?) AND f.status = 'accepted'
    ORDER BY u.username ASC
  `).all(uId, uId, uId);

  const friends = friendsRows.map(r => ({
    friendship_id: r.friendship_id,
    friendship_date: r.friendship_date,
    user: {
      id: r.user_id,
      username: r.username,
      nombre_completo: `${r.nombres} ${r.apellido_paterno} ${r.apellido_materno || ''}`.trim(),
      email: r.email
    }
  }));

  // 2. Solicitudes entrantes (pendientes dirigidas a este usuario)
  const incomingRows = db.prepare(`
    SELECT f.id as request_id, f.created_at,
           u.id as user_id, u.username, u.nombres, u.apellido_paterno, u.email
    FROM friendships f
    JOIN users u ON f.sender_id = u.id
    WHERE f.receiver_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(uId);

  const incomingRequests = incomingRows.map(r => ({
    request_id: r.request_id,
    created_at: r.created_at,
    from_user: {
      id: r.user_id,
      username: r.username,
      nombre_completo: `${r.nombres} ${r.apellido_paterno}`.trim(),
      email: r.email
    }
  }));

  // 3. Solicitudes salientes (enviadas por este usuario)
  const outgoingRows = db.prepare(`
    SELECT f.id as request_id, f.created_at,
           u.id as user_id, u.username, u.nombres, u.apellido_paterno, u.email
    FROM friendships f
    JOIN users u ON f.receiver_id = u.id
    WHERE f.sender_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(uId);

  const outgoingRequests = outgoingRows.map(r => ({
    request_id: r.request_id,
    created_at: r.created_at,
    to_user: {
      id: r.user_id,
      username: r.username,
      nombre_completo: `${r.nombres} ${r.apellido_paterno}`.trim(),
      email: r.email
    }
  }));

  return {
    friends,
    incomingRequests,
    outgoingRequests
  };
}

/**
 * Retorna los IDs de todos los amigos confirmados de un usuario
 */
export function getFriendIds(userId) {
  const db = getAuthDb();
  const uId = parseInt(userId, 10);
  const rows = db.prepare(`
    SELECT (CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END) as friend_id
    FROM friendships
    WHERE (sender_id = ? OR receiver_id = ?) AND status = 'accepted'
  `).all(uId, uId, uId);
  return rows.map(r => r.friend_id);
}

/**
 * Retorna los IDs de todos los usuarios con derecho a ver la presencia de un usuario
 * (Amigos mutuos + colaboradores con quienes comparte recursos o bóvedas)
 */
export function getPresenceSubscriberIds(userId) {
  const uId = parseInt(userId, 10);
  const friendIds = getFriendIds(uId);
  const db = getAuthDb();
  const shareRows = db.prepare(`
    SELECT DISTINCT shared_with_user_id as uid FROM shares WHERE owner_id = ? AND shared_with_user_id IS NOT NULL
    UNION
    SELECT DISTINCT owner_id as uid FROM shares WHERE shared_with_user_id = ?
  `).all(uId, uId);
  const shareUserIds = shareRows.map(r => r.uid);
  return Array.from(new Set([...friendIds, ...shareUserIds]));
}

/**
 * Retorna los IDs de los colaboradores que tienen acceso a un recurso o bóveda específica
 */
export function getCollaboratorsForResource(owner_id, vault_name, resource_path = null) {
  const db = getAuthDb();
  const oId = parseInt(owner_id, 10);
  const cleanPath = (resource_path || '').replace(/\\/g, '/').trim();
  
  let rows;
  if (cleanPath) {
    rows = db.prepare(`
      SELECT DISTINCT shared_with_user_id as uid
      FROM shares
      WHERE owner_id = ? AND vault_name = ? AND (resource_path = ? OR resource_type = 'vault') AND shared_with_user_id IS NOT NULL
    `).all(oId, vault_name, cleanPath);
  } else {
    rows = db.prepare(`
      SELECT DISTINCT shared_with_user_id as uid
      FROM shares
      WHERE owner_id = ? AND vault_name = ? AND shared_with_user_id IS NOT NULL
    `).all(oId, vault_name);
  }
  return rows.map(r => r.uid).filter(Boolean);
}

// ==========================================
// CHAT DIRECTO PRIVADO (DIRECT MESSAGES)
// ==========================================

export function sendDirectMessage(senderId, receiverId, content) {
  const db = getAuthDb();
  const sId = parseInt(senderId, 10);
  const rId = parseInt(receiverId, 10);

  if (!areFriends(sId, rId)) {
    throw new Error('Solo puedes enviar mensajes a usuarios que estén en tu lista de amigos.');
  }

  const cleanContent = String(content || '').trim();
  if (!cleanContent) {
    throw new Error('El mensaje no puede estar vacío.');
  }
  if (cleanContent.length > 3000) {
    throw new Error('El mensaje excede el límite de 3000 caracteres.');
  }

  const info = db.prepare(`
    INSERT INTO direct_messages (sender_id, receiver_id, content)
    VALUES (?, ?, ?)
  `).run(sId, rId, cleanContent);

  const message = db.prepare(`
    SELECT id, sender_id, receiver_id, content, created_at, read_at
    FROM direct_messages
    WHERE id = ?
  `).get(info.lastInsertRowid);

  return message;
}

export function getDirectMessages(userA, userB, limit = 100) {
  const db = getAuthDb();
  const u1 = parseInt(userA, 10);
  const u2 = parseInt(userB, 10);

  if (!areFriends(u1, u2)) {
    throw new Error('Deben ser amigos para ver esta conversación.');
  }

  const rows = db.prepare(`
    SELECT id, sender_id, receiver_id, content, created_at, read_at
    FROM direct_messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(u1, u2, u2, u1, limit);

  return rows;
}

export function markMessagesAsRead(senderId, receiverId) {
  const db = getAuthDb();
  const sId = parseInt(senderId, 10);
  const rId = parseInt(receiverId, 10);

  const res = db.prepare(`
    UPDATE direct_messages
    SET read_at = CURRENT_TIMESTAMP
    WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL
  `).run(sId, rId);

  return res.changes;
}

export function getUnreadMessagesSummary(userId) {
  const db = getAuthDb();
  const uId = parseInt(userId, 10);

  const rows = db.prepare(`
    SELECT sender_id, COUNT(*) as unread_count
    FROM direct_messages
    WHERE receiver_id = ? AND read_at IS NULL
    GROUP BY sender_id
  `).all(uId);

  const summary = {};
  let total = 0;
  rows.forEach(r => {
    summary[r.sender_id] = r.unread_count;
    total += r.unread_count;
  });

  return { total, bySender: summary };
}



