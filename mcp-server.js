import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// URL de la API de la aplicación web (por defecto localhost:3000/api, o tu URL en producción)
const VAULT_API_URL = process.env.VAULT_API_URL || 'http://localhost:3000/api';
const MAGIC = Buffer.from('KENC');

function isEncrypted(buffer) {
  if (!buffer || buffer.length < 4 + 1 + 16 + 12 + 16) return false;
  return buffer.subarray(0, 4).equals(MAGIC);
}

function decryptBuffer(packet, password) {
  if (!isEncrypted(packet)) return packet;
  if (!password) {
    throw new Error('La bóveda está cifrada físicamente con AES-256. Configure VAULT_PASSWORD en su entorno o desbloquee la bóveda desde la interfaz web.');
  }

  const salt = packet.subarray(5, 21);
  const iv = packet.subarray(21, 33);
  const tag = packet.subarray(33, 49);
  const ciphertext = packet.subarray(49);

  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function getLocalVaultDir() {
  try {
    const configPath = path.join(__dirname, 'kortexa.config.json');
    if (fsSync.existsSync(configPath)) {
      const cfg = JSON.parse(fsSync.readFileSync(configPath, 'utf-8'));
      if (cfg.vaultDir) {
        return path.isAbsolute(cfg.vaultDir) ? cfg.vaultDir : path.join(__dirname, cfg.vaultDir);
      }
    }
  } catch {}
  return path.join(__dirname, 'vault');
}

// Crear la instancia del servidor MCP
const server = new McpServer({
  name: "kortexa-mcp",
  version: "1.0.0"
});

// Función auxiliar para escanear recursivamente en modo fallback local
async function localScanFiles(dir = null, base = null) {
  const vaultDir = getLocalVaultDir();
  const currentDir = dir || vaultDir;
  const baseDir = base || vaultDir;
  try {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) return [];
          return localScanFiles(fullPath, baseDir);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          const folderRel = path.dirname(relPath).replace(/\\/g, '/');
          return [{
            filename: relPath,
            title: path.basename(entry.name, '.md'),
            folder: folderRel === '.' ? '' : folderRel,
            fullPath
          }];
        }
        return [];
      })
    );
    return results.flat();
  } catch {
    return [];
  }
}

// Función auxiliar para consultar la API web con fallback al sistema de archivos local
async function fetchApi(endpoint, options = {}) {
  try {
    const url = `${VAULT_API_URL}${endpoint}`;
    let res = await fetch(url, options);

    // Si la bóveda está bloqueada y tenemos VAULT_PASSWORD configurado, intentamos auto-desbloquear
    if (res.status === 423 && process.env.VAULT_PASSWORD) {
      const unlockRes = await fetch(`${VAULT_API_URL}/vault/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: process.env.VAULT_PASSWORD })
      });
      if (unlockRes.ok) {
        // Reintentar la petición original
        res = await fetch(url, options);
      }
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (netErr) {
    // Si la API web remota/local no está encendida, intentamos fallback local directo a vault/
    return fallbackLocal(endpoint, options, netErr);
  }
}

// Fallback directo a disco recursivo en caso de que el servidor web no esté levantado
async function fallbackLocal(endpoint, options, originalError) {
  if (endpoint === '/notes' && (!options.method || options.method === 'GET')) {
    return await localScanFiles();
  }

  if (endpoint.startsWith('/notes/') && (!options.method || options.method === 'GET')) {
    const titleOrPath = decodeURIComponent(endpoint.replace('/notes/', ''));
    const allFiles = await localScanFiles();
    const cleanName = titleOrPath.replace(/\.md$/, '').toLowerCase();
    
    // Buscar por ruta exacta o por título
    const found = allFiles.find(f => 
      f.filename.toLowerCase() === titleOrPath.toLowerCase() || 
      f.title.toLowerCase() === cleanName
    );

    if (found) {
      const raw = await fs.readFile(found.fullPath);
      const content = decryptBuffer(raw, process.env.VAULT_PASSWORD).toString('utf-8');
      return { title: found.title, filename: found.filename, folder: found.folder, content };
    }
    throw new Error(`Nota "${titleOrPath}" no encontrada en la bóveda.`);
  }

  if (endpoint === '/notes' && options.method === 'POST') {
    const { title, folder, content } = JSON.parse(options.body);
    const cleanFolder = (folder || '').replace(/\\/g, '/').trim();
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, '').trim();
    const relPath = cleanFolder ? `${cleanFolder}/${safeTitle}.md` : `${safeTitle}.md`;
    const fullPath = path.join(getLocalVaultDir(), relPath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content ?? '', 'utf-8');
    return { title: safeTitle, filename: relPath, folder: cleanFolder, content };
  }

  throw new Error(`No se pudo conectar a la API (${VAULT_API_URL}): ${originalError.message}`);
}

// ==========================================
// HERRAMIENTAS (TOOLS) PARA LA IA
// ==========================================

// 1. Listar notas
server.tool(
  "list_notes",
  "Lista todas las notas existentes en la bóveda de conocimiento (Kortexa Vault) incluyendo sus carpetas y rutas",
  {},
  async () => {
    const notes = await fetchApi('/notes');
    const textList = notes.map(n => {
      const folderTag = n.folder ? ` [📁 ${n.folder}]` : ' [📁 Raíz]';
      return `- **${n.title}** (${n.filename})${folderTag}`;
    }).join('\n');

    return {
      content: [
        {
          type: "text",
          text: `Total de notas: ${notes.length}\n\n${textList}`
        }
      ]
    };
  }
);

// 2. Listar carpetas
server.tool(
  "list_folders",
  "Lista todas las carpetas y subcarpetas organizativas de la bóveda",
  {},
  async () => {
    const folders = await fetchApi('/folders').catch(() => []);
    if (folders.length === 0) {
      return { content: [{ type: "text", text: "No hay subcarpetas creadas aún (todas las notas están en la raíz)." }] };
    }
    const folderList = folders.map(f => `- 📁 **${f}**`).join('\n');
    return {
      content: [
        {
          type: "text",
          text: `Carpetas en la bóveda (${folders.length}):\n\n${folderList}`
        }
      ]
    };
  }
);

// 3. Leer contenido de una nota
server.tool(
  "read_note",
  "Lee el contenido completo en Markdown de una nota específica por su título o ruta relativa (ej. 'Diario' o 'Proyectos/Kortexa')",
  {
    title: z.string().describe("Título o ruta de la nota a leer (ej. 'Segundo Cerebro' o 'Personal/Diario')")
  },
  async ({ title }) => {
    const data = await fetchApi(`/notes/${encodeURIComponent(title)}`);
    const folderInfo = data.folder ? `Carpeta: **${data.folder}**\n\n` : '';
    return {
      content: [
        {
          type: "text",
          text: `# ${data.title}\n${folderInfo}${data.content}`
        }
      ]
    };
  }
);

// 4. Buscar notas por palabra clave o contenido
server.tool(
  "search_notes",
  "Busca notas en todas las carpetas que contengan una palabra clave en su título o contenido",
  {
    query: z.string().describe("Término o concepto a buscar")
  },
  async ({ query }) => {
    const results = await fetchApi(`/search?q=${encodeURIComponent(query)}`);
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No se encontraron notas con el término: "${query}".` }]
      };
    }

    const summary = results.map(r => {
      const folderInfo = r.folder ? ` [📁 ${r.folder}]` : '';
      return `### [[${r.title}]]${folderInfo}\n${r.snippet}\n`;
    }).join('\n---\n');

    return {
      content: [
        {
          type: "text",
          text: `Se encontraron ${results.length} coincidencias para "${query}":\n\n${summary}`
        }
      ]
    };
  }
);

// 5. Crear o sobrescribir una nota (con soporte para subcarpetas)
server.tool(
  "create_or_update_note",
  "Crea una nueva nota o sobrescribe una existente. Puedes especificar una subcarpeta organizativa y enlazar otras notas usando [[Nombre]].",
  {
    title: z.string().describe("Título de la nota (sin extensión .md)"),
    folder: z.string().optional().describe("Subcarpeta opcional donde guardar la nota (ej. 'Proyectos' o 'Personal/Ideas')"),
    content: z.string().describe("Contenido en Markdown. Usa [[Nombre]] para conectar con otras ideas.")
  },
  async ({ title, folder, content }) => {
    const result = await fetchApi('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, folder, content })
    });

    const folderMsg = result.folder ? ` en la carpeta "${result.folder}"` : ' en la raíz';
    return {
      content: [
        {
          type: "text",
          text: `Nota "[[${result.title}]]" guardada con éxito${folderMsg} (${result.filename}).`
        }
      ]
    };
  }
);

// 6. Agregar texto al final de una nota existente (Append)
server.tool(
  "append_to_note",
  "Añade contenido al final de una nota existente sin borrar lo anterior",
  {
    title: z.string().describe("Título o ruta de la nota a modificar"),
    text_to_append: z.string().describe("Texto o sección en Markdown para agregar al final")
  },
  async ({ title, text_to_append }) => {
    let existingContent = '';
    let targetFolder = '';
    try {
      const existing = await fetchApi(`/notes/${encodeURIComponent(title)}`);
      existingContent = existing.content;
      targetFolder = existing.folder || '';
    } catch {
      existingContent = `# ${title}\n`;
    }

    const newContent = `${existingContent.trim()}\n\n${text_to_append.trim()}\n`;

    await fetchApi('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, folder: targetFolder, content: newContent })
    });

    return {
      content: [
        {
          type: "text",
          text: `Se ha añadido la información correctamente a "[[${title}]]".`
        }
      ]
    };
  }
);

// 7. Obtener conexiones y backlinks de una nota (Exploración del grafo)
server.tool(
  "get_graph_connections",
  "Obtiene las conexiones de una nota: qué otras notas la mencionan (backlinks) y a cuáles enlaza",
  {
    title: z.string().describe("Título de la nota a inspeccionar")
  },
  async ({ title }) => {
    const backlinks = await fetchApi(`/backlinks/${encodeURIComponent(title)}`);
    
    // Obtener también enlaces salientes leyendo la nota
    let outlinks = [];
    try {
      const note = await fetchApi(`/notes/${encodeURIComponent(title)}`);
      const matches = [...note.content.matchAll(/\[\[(.*?)\]\]/g)];
      outlinks = matches.map(m => m[1].trim());
    } catch {}

    const backlinksText = backlinks.length > 0 
      ? backlinks.map(b => `- [[${b.title}]] ${b.folder ? `(📁 ${b.folder})` : ''}`).join('\n') 
      : '_Ninguna_';

    const outlinksText = outlinks.length > 0 
      ? [...new Set(outlinks)].map(o => `- [[${o}]]`).join('\n') 
      : '_Ninguno_';

    return {
      content: [
        {
          type: "text",
          text: `### Conexiones de [[${title}]]:\n\n**Notas que enlazan hacia aquí (Backlinks):**\n${backlinksText}\n\n**Notas a las que enlaza (Outlinks):**\n${outlinksText}`
        }
      ]
    };
  }
);

// Iniciar servidor MCP en stdio
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Servidor MCP de Kortexa iniciado correctamente vía Stdio.");
}

main().catch(err => {
  console.error("Error fatal en servidor MCP:", err);
  process.exit(1);
});
