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
  `);

  // Migraciones / Columnas adicionales
  try {
    db.exec(`ALTER TABLE users ADD COLUMN mcp_enabled INTEGER DEFAULT 1;`);
  } catch {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN mcp_token TEXT;`);
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
    mcp_token: row.mcp_token || null
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


