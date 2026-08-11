# HANDOFF v2 — MacLorian Innovation · Cuestionario de Validación (Vercel + Notion)

> **Contexto:** este documento es para retomar el trabajo en una sesión NUEVA de Claude Code (o cualquier agente AI), idealmente con MCPs adicionales habilitados para ser más autónomo. Pegá este archivo entero como primer mensaje y decí: *"Léelo y continúa donde quedó."*

**Última actualización:** 2026-05-01 23:50 UTC
**Último commit:** `aae13e9` (rama `claude/deploy-maclorian-vercel-41OrW`)
**Status del deploy:** ✅ Build OK · ⏳ Pendiente test end-to-end después del fix de database ID

---

## 1. Contexto del proyecto (resumen)

- **Founder:** Miguel Angel Balart Batlle, MacLorian X Group LLC, Cape Coral FL
- **Producto:** App de Membresías por Invitación — marketplace de servicios de property care en SW Florida con bundles multi-categoría (lawn + roof + pool + A/C + pressure washing). Comisión de $1,70 por socio y mes, con tope del 50% del cobro (sustituyó al 10% sobre GMV el 2026-08-03).
- **Stack:** vanilla HTML/CSS/JS frontend + Vercel Functions (Node 18+) + Notion API como DB
- **Estado:** validación pre-MVP, decisión go/no-go al día 15 con 20 entrevistas
- **Mercado piloto:** Cape Coral / SW Florida
- **Comunicación con el founder:** español, founder no-developer, prefiere acción concreta sobre teoría

---

## 2. Repositorio y archivos

```
Repo: MiguelJkR/Membership
Rama de trabajo: claude/deploy-maclorian-vercel-41OrW
Rama de producción: master (recibe via PR merge)
Path local en sandbox: /home/user/Membership/
Path local en Windows del founder: C:\Users\migue\OneDrive\Escritorio\cuestionario-web\

Estructura:
Membership/                       ← .NET MAUI app (NO TOCAR)
cuestionario-web/                 ← La parte que nos importa
├── index.html                    1825 lineas, bilingue ES/EN, 5 secciones x 20q (proveedor) o 19q (cliente)
├── api/submit.js                 Vercel Function, llama a Notion API
├── package.json                  type: module, sin deps
├── vercel.json                   maxDuration 10s + headers de seguridad
├── .env.example                  docs de env vars
├── .gitignore
├── README.md
└── 03-mensajes-outreach.md       plantillas ES/EN para outreach
```

**Commits relevantes:**
- `aae13e9` — Fix: database ID correcto (último, pendiente de test)
- `98a100e` — "1.0" (Miguel pusheó su versión original sobre la reconstrucción)
- `6334312` — Reconstrucción inicial generada por agente
- `61bd5d5` — Setup .NET MAUI inicial (no tocar)

---

## 3. Estado de Vercel

- **Account:** migueljkrs (Hobby plan)
- **Project:** project-6lklw
- **URL dashboard:** https://vercel.com/migueljkrs-projects/project-6lklw
- **Root Directory:** `cuestionario-web` ✅
- **Production Branch:** `master` ✅
- **Git connected to:** `MiguelJkR/Membership` ✅

**URLs activas:**
| URL | Para qué |
|---|---|
| `project-6lklw-git-master-migueljkrs-projects.vercel.app` | Alias estable de Production (master) |
| `project-6lklw-git-claude-deploy-maclorian-vercel-410rw-migueljkrs-projects.vercel.app` | Alias estable del Preview de la rama |
| `investigacion.maclorianxgroup.com` | Custom domain (DNS pendiente, ver §6) |

**Environment Variables status (¡IMPORTANTE!):**
- `NOTION_TOKEN` — ✅ existe, **scope debe ser** Production + Preview + Development y All Branches.
  - 🚨 Bug histórico: estaba scopeada solo a `claude/deploy-maclorian-vercel-410rW` branch. Verificar en próxima sesión.
- `NOTION_DATABASE_ID` — ❌ probablemente NO existe (usa fallback hardcoded). Si Miguel la agregó, debe valer `6d4735de-69f4-4d8b-b5ce-89bfcdb9f475` (NO `a5de9526-...`).

---

## 4. Notion — IDs críticos (¡cruciales, no confundir!)

```
Workspace: Espacio de Miguel Ba

Página padre: "App de Membresías por Invitación"
└── ID: 353a708e-4fb1-81d2-859e-f1b4f4bc7feb

Database "Entrevistas de Validación":
├── DATABASE ID (lo que la API REST necesita): 6d4735de-69f4-4d8b-b5ce-89bfcdb9f475
└── Data source / collection ID:               a5de9526-4375-41f4-bc7d-475dc16f0264

⚠️ EL HANDOFF ORIGINAL TENÍA ESTO CONFUNDIDO. Causó el bug de 404 en submit.

Integración: "MacLorian Cuestionario Web"
└── Conectada a la database: ✅ (Miguel confirmó en última sesión)
└── Token: Miguel lo tiene en clipboard / regenerable en notion.com/my-integrations
```

Schema de la database: 24 properties. Detalle completo en `cuestionario-web/README.md` o pidiendo al MCP de Notion `fetch` con id `6d4735de-69f4-4d8b-b5ce-89bfcdb9f475`.

12 categorías hardcoded actuales: A/C & HVAC, Pool service, Lawn care, Pest control, Roof maintenance, Pressure washing, Gutter cleaning, Exterior cleaning, Hurricane prep, Handyman, Generator service, Tree service.

---

## 5. Bugs ya identificados y arreglados (no repetir)

| # | Bug | Síntoma | Causa | Fix | Status |
|---|---|---|---|---|---|
| 1 | URL incorrecta de prueba | "Hubo un problema enviando" | Estaba probando `onyr634t7` (preview viejo) | Usar `git-master-...` o `git-claude-deploy-...` URLs | ✅ |
| 2 | NOTION_TOKEN missing | Log: `Missing NOTION_TOKEN env variable` | Variable scopeada a 1 sola rama | Editar en Vercel → marcar Production + Preview + Development + All Branches | ✅ |
| 3 | Notion API 404 | Log: `POST api.notion.com/v1/pages → 404` | Code usaba data source ID en vez de database ID | Commit `aae13e9` cambió el fallback | ✅ código, ⏳ pendiente test |

---

## 6. Dominio personalizado — situación actual

`maclorianxgroup.com`:
- **Registrar:** Squarespace Domains II LLC (vino de migración Google Domains 2024)
- **Aparece en:** Google Workspace Admin (admin.google.com) — Gmail activado
- **NO aparece en:** Squarespace consumer UI (account.squarespace.com/domains) — solo está `deduthacademy.com` ahí
- **DNS detectado por Vercel:** Google Cloud DNS

**Pendiente:** ubicar el panel de DNS correcto y agregar el CNAME:
```
Type:  CNAME
Name:  investigacion
Value: 30048d17151a8d19.vercel-dns-017.com
       (alternativa válida: cname.vercel-dns.com)
```

Probablemente el DNS se gestiona desde Google Workspace Domain Host Service. Click "Ver detalles" en admin.google.com → buscar sección DNS / Advanced.

---

## 7. Pendientes ordenados (qué hacer en la nueva sesión)

### 🔴 Inmediato — confirmar fix del database ID
1. Esperar que Vercel auto-deploye el commit `aae13e9` en preview de la rama
2. Probar el cuestionario en `project-6lklw-git-claude-deploy-maclorian-vercel-410rw-migueljkrs-projects.vercel.app`
3. Verificar via MCP de Notion que la entrada llegó a la database
4. Si funciona → mergear PR `claude/deploy-maclorian-vercel-41OrW` → `master` para que Production tenga el fix

### 🟡 Después del fix
5. Resolver DNS de `investigacion.maclorianxgroup.com` (probablemente Google Workspace)
6. Actualizar `03-mensajes-outreach.md` con la URL final cuando el dominio valide

### 🟢 Mejoras pedidas por el founder (post-funcional)
7. **Expandir categorías** más allá de home services. Agregar:
   - Barbería / Peluquería
   - Servicios para mascotas (pet grooming)
   - Auto detailing
   - Cleaning / Limpieza de hogar
   - Spa & wellness
   - Personal trainer / Fitness
   - **Otra (Personalizar)** — campo de texto libre
8. **Campo "LLC" requerido** cuando se elige "Personalizar" — la interpretación correcta (a confirmar con founder): cuando alguien marca categoría custom, se le pide el nombre legal de su LLC para validación de negocio formal.
9. Schema de Notion: probable que haya que agregar las nuevas opciones de categorías en las propiedades multi_select. Agregar property "LLC name" (rich_text).
10. Cargar 25 proveedores SW Florida en Notion (lista en sub-página "04 Lista de Proveedores Objetivo" del workspace de Notion). Top 5: Cape Strong Lawn Care, MK's Lawn/Pool/Maintenance, AHCM, Lawn Hunters Plus, Land-Art.

---

## 8. MCPs reales para configurar en la nueva sesión

**El "Windows MCP" no existe como tal.** Pero hay servidores MCP reales que cubren lo que el founder quiere (clickear en su lugar, automatizar UI, etc.). Ordenados por utilidad:

### 🥇 Top recomendaciones

| MCP | Qué hace | Utilidad para este proyecto |
|---|---|---|
| **`@playwright/mcp`** ([github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)) | Automatización de browser (Chromium/Firefox/WebKit). El agente abre páginas, hace login, click, extrae texto, fill forms. | 🔥 Alto. Permitiría automatizar Vercel UI, Squarespace, Notion (agregar conexiones), incluso llenar el cuestionario para tests. |
| **`@modelcontextprotocol/server-filesystem`** | Lectura/escritura del filesystem local (path configurable). | 🔥 Alto. Apuntalo a `C:\Users\migue\OneDrive\Escritorio\cuestionario-web\` y Claude puede editar los archivos del founder directamente. |
| **MCP de Vercel** (no oficial, hay forks comunitarios) | Wrap de la Vercel API (deployments, env vars, domains, logs). | 🟡 Medio. Sustituye los clicks de Vercel UI con llamadas a la API. |

### 🥈 Útiles pero secundarios

| MCP | Qué hace |
|---|---|
| **`@modelcontextprotocol/server-puppeteer`** | Alternativa a Playwright (Chromium-only) |
| **`@modelcontextprotocol/server-fetch`** | HTTP fetch genérico (mejor que `curl` desde un sandbox bloqueado) |
| **GitHub MCP** (ya estaba habilitado) | PRs, commits, branches, issues |
| **Notion MCP** (ya estaba habilitado) | Read/write Notion |

### 🥉 Opcionales para este proyecto

| MCP | Qué hace |
|---|---|
| **AutoHotkey / NutJS MCP** | Control real del mouse/teclado en Windows (riesgoso, requiere ejecutar localmente) |
| **`@modelcontextprotocol/server-google-drive`** | Si quieres conectar archivos de Drive |

### Cómo configurarlos

En tu `~/.claude/claude_desktop_config.json` (Claude Desktop) o equivalente para Claude Code, agregar:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp"]
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\migue\\OneDrive\\Escritorio\\cuestionario-web"
      ]
    }
  }
}
```

(La sintaxis exacta depende del cliente — checa la doc de tu Claude Code.)

---

## 9. Restricciones que NO se pueden saltar (incluso con más MCPs)

- Vercel deployments solo se disparan desde push o desde la API/CLI con un token válido
- Notion no permite que una integración acceda a databases que no le fueron conectadas explícitamente — la conexión solo se hace via UI o via OAuth (no via Internal Integration tokens)
- Las entradas en la database "Entrevistas de Validación" solo aparecen via:
  - El cuestionario submitting (camino oficial)
  - MCP / API directos (lo hace el agente para tests)
- DNS de `maclorianxgroup.com` requiere acceso al panel correcto que el founder maneje su login

---

## 10. Tono y estilo de comunicación (el founder)

- Responde en **español**
- Es **founder, no developer** — explicá pero no hables como ingeniero
- Prefiere acción concreta sobre teoría
- Si algo es ambiguo: **preguntar antes de adivinar**
- Cuando termina un paso, decir qué pasó y qué sigue. **No dejarlo esperando**
- Si hay error: diagnosticar con calma, proponer soluciones, no entrar en pánico

---

## 11. Para arrancar la sesión nueva — pegá este prompt

```
Hola. Pegado abajo está el HANDOFF v2 del proyecto MacLorian Innovation
Cuestionario de Validación. Léelo entero y empezá por el punto 7 (Pendientes
ordenados) — específicamente la sección "Inmediato".

Antes de cualquier acción que toque archivos o haga commits, confirmá conmigo
qué MCPs tenés disponibles en esta sesión (haceme un listado breve). Si tenés
Playwright + filesystem MCP, podés ser bastante autónomo. Si solo tenés
Notion + GitHub MCP, vamos a coordinar más con clicks míos en Vercel UI.

[PEGAR HANDOFF v2 ENTERO]
```

---

## 12. Acciones específicas que la nueva sesión debe ejecutar PRIMERO

1. `git pull` para tener `aae13e9`
2. Verificar via Notion MCP que la database tiene 1 entrada (`Test MCP — diagnostico Vercel error` creada por el agente anterior)
3. Pedir al founder que pruebe el cuestionario en la URL del preview de la rama
4. Verificar el resultado del submit via Notion MCP
5. Si OK → ofrecer crear la PR para mergear a master via GitHub MCP
6. Avanzar con DNS y categorías nuevas

---

**Fin del handoff.** Listo para retomar.
