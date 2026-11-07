# Kortexa 🧠 + Servidor MCP para IA 🤖

Un segundo cerebro ligero, rápido y visual construido con **Node.js**, **Express**, **JavaScript** y soporte oficial de **Model Context Protocol (MCP)** para conectarse con Inteligencias Artificiales. Permite gestionar notas en Markdown hipervinculadas, explorar redes de ideas en un grafo 2D y conectar tu base de conocimiento a tus modelos de lenguaje preferidos.

---

## 🚀 Características Principales

- **Archivos locales en Markdown (`.md`):** Las notas se guardan directamente como archivos de texto plano dentro de la carpeta `vault/`.
- **Enlaces bidireccionales (`[[Nombre]]`):** Sintaxis wiki para interconectar notas. Al hacer clic en un enlace a una nota inexistente, se crea automáticamente.
- **Vista de Grafo interactiva:** Representación de tu red de conocimientos en 2D con física de nodos (`force-graph`).
- **Detección de Backlinks:** Visualiza qué notas mencionan a la nota actual.
- **Buscador de texto completo:** Búsqueda en tiempo real tanto por títulos como por contenido.
- **Auto-guardado inteligente** y atajo `Ctrl+S`.
- **Servidor MCP integrado:** Permite a asistentes de IA leer, buscar, crear notas y navegar el grafo.

---

## 🛠️ Ejecución del Servidor Web

1. Abre tu terminal en esta carpeta:
   ```bash
   cd "C:\Users\Guillermo Jimenez\Downloads\obsidian-node"
   ```
2. Inicia la app:
   ```bash
   npm start
   ```
3. Abre tu navegador web en:
   👉 **http://localhost:3000**

---

## 🤖 Conexión con IA vía MCP (Model Context Protocol)

El archivo `mcp-server.js` implementa el estándar MCP con las siguientes herramientas (*tools*):

| Herramienta | Descripción |
| :--- | :--- |
| `list_notes` | Lista todos los títulos y archivos en la bóveda. |
| `read_note` | Lee el Markdown completo de cualquier nota. |
| `search_notes` | Busca por palabra clave en títulos y cuerpos de notas. |
| `create_or_update_note` | Crea o actualiza notas respetando la sintaxis `[[wikilinks]]`. |
| `append_to_note` | Agrega nuevo texto al final de una nota existente. |
| `get_graph_connections` | Muestra enlaces entrantes (*backlinks*) y salientes (*outlinks*). |

### Configuración en clientes de IA (ej. Claude Desktop, Cursor, Antigravity)

Agrega esto a tu archivo de configuración de MCP (ej. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kortexa": {
      "command": "node",
      "args": [
        "C:\\Users\\Guillermo Jimenez\\Downloads\\obsidian-node\\mcp-server.js"
      ],
      "env": {
        "VAULT_API_URL": "http://localhost:3000/api"
      }
    }
  }
}
```

> **Nota para servidores en la nube:** Si despliegas tu servidor web en un hosting (como Render, Fly.io, VPS, etc.), solo cambia `VAULT_API_URL` por tu dominio público (ej. `"https://mi-kortexa.mi-dominio.com/api"`). Además, si el servidor web está apagado, el script MCP tiene un modo *fallback* que lee directamente la carpeta local `vault/`.
