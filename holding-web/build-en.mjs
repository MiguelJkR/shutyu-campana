// Genera /en/index.html a partir de index.html (fuente de verdad, en español)
// aplicando el diccionario de i18n.en.json.
//
// Por qué prerenderizar en vez de traducir en el navegador: antes el inglés solo
// existía después de que corriera el JS, así que los buscadores indexaban una
// única página en español. Una empresa de Florida que se presenta a inversores y
// partners angloparlantes no puede ser invisible para ellos.
//
// Uso:  node build-en.mjs        (idempotente; correr antes de cada deploy)

import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(RAIZ, 'index.html');
const DIC = path.join(RAIZ, 'i18n.en.json');
const SALIDA_DIR = path.join(RAIZ, 'en');
const SALIDA = path.join(SALIDA_DIR, 'index.html');

const BASE = 'https://maclorianxgroup.com';

// Los textos de <head> no son contenido de la página, así que no llevan
// data-i18n; se declaran acá y se sustituyen por su valor exacto.
const HEAD = {
  title: {
    es: 'MacLorian X Group · Empresa de tecnología',
    en: 'MacLorian X Group · Technology company',
  },
  description: {
    es: 'MacLorian X Group LLC — Empresa de tecnología con sede en Florida (EE. UU.). Desarrollo de aplicaciones móviles y plataformas digitales en educación financiera, logística y servicios.',
    en: 'MacLorian X Group LLC — Technology company headquartered in Florida, USA. Mobile applications and digital platforms in financial education, logistics, and services.',
  },
  ogDescription: {
    es: 'Empresa de tecnología con sede en Florida (EE. UU.). Desarrollo de aplicaciones móviles y plataformas digitales en educación financiera, logística y servicios.',
    en: 'Technology company headquartered in Florida, USA. Mobile applications and digital platforms in financial education, logistics, and services.',
  },
  twitterDescription: {
    es: 'Empresa de tecnología con sede en Florida (EE. UU.). Aplicaciones móviles y plataformas digitales.',
    en: 'Technology company headquartered in Florida, USA. Mobile applications and digital platforms.',
  },
};

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex del elemento que lleva data-i18n="clave".
 * El contenido es no-voraz y el cierre exige la MISMA etiqueta capturada, así
 * que un <em> o <strong> anidado no rompe el emparejamiento. Con la bandera `g`
 * cubre las claves que aparecen en más de un sitio (p. ej. el mismo badge de
 * mercado en dos tarjetas).
 */
const reDe = (clave) =>
  new RegExp(
    `(<([a-zA-Z][\\w-]*)\\b[^>]*\\bdata-i18n="${escaparRegex(clave)}"[^>]*>)([\\s\\S]*?)(</\\2>)`,
    'g',
  );

function sustituirUna(html, buscar, reemplazar, etiqueta) {
  if (!html.includes(buscar)) throw new Error(`no encuentro en el HTML: ${etiqueta}`);
  return html.replace(buscar, reemplazar);
}

const src = fs.readFileSync(SRC, 'utf8');
const dic = JSON.parse(fs.readFileSync(DIC, 'utf8'));

let out = src;
let aplicadas = 0;
const sinUsar = [];

for (const [clave, valor] of Object.entries(dic)) {
  let veces = 0;
  out = out.replace(reDe(clave), (_m, abre, _tag, _dentro, cierra) => {
    veces++;
    return abre + valor + cierra;
  });
  if (veces === 0) sinUsar.push(clave);
  else aplicadas += veces;
}

// Idioma del documento: lo leen el lector de pantalla, el corrector del
// navegador y el script del banner de cookies (que elige su idioma con esto).
out = sustituirUna(out, '<html lang="es">', '<html lang="en">', 'atributo lang');

// <head>
out = sustituirUna(out, `<title>${HEAD.title.es}</title>`, `<title>${HEAD.title.en}</title>`, 'title');
out = sustituirUna(out, HEAD.description.es, HEAD.description.en, 'meta description');
out = sustituirUna(out, HEAD.ogDescription.es, HEAD.ogDescription.en, 'og:description');
out = sustituirUna(out, HEAD.twitterDescription.es, HEAD.twitterDescription.en, 'twitter:description');
out = out.split(`content="${HEAD.title.es}"`).join(`content="${HEAD.title.en}"`); // og:title y twitter:title
out = sustituirUna(out, 'content="es_US"', 'content="en_US"', 'og:locale');
out = sustituirUna(out, `<link rel="canonical" href="${BASE}/">`, `<link rel="canonical" href="${BASE}/en">`, 'canonical');
out = sustituirUna(out, `<meta property="og:url" content="${BASE}/">`, `<meta property="og:url" content="${BASE}/en">`, 'og:url');

// Selector de idioma: en la versión inglesa el activo es EN.
out = sustituirUna(out, '<a id="btn-es" class="active" href="/"', '<a id="btn-es" href="/"', 'toggle ES');
out = sustituirUna(out, '<a id="btn-en" href="/en"', '<a id="btn-en" class="active" href="/en"', 'toggle EN');

out = out.replace(
  '<!DOCTYPE html>',
  '<!DOCTYPE html>\n<!-- GENERADO por build-en.mjs desde index.html + i18n.en.json. No editar a mano. -->',
);

fs.mkdirSync(SALIDA_DIR, { recursive: true });
fs.writeFileSync(SALIDA, out, 'utf8');

// Verificación: ningún elemento traducible puede haber quedado con el texto
// original. Compara contra el HTML de partida en lugar de confiar en el conteo.
const pendientes = [];
for (const clave of Object.keys(dic)) {
  const origen = [...src.matchAll(reDe(clave))].map((m) => m[3]);
  const final = [...out.matchAll(reDe(clave))].map((m) => m[3]);
  final.forEach((txt, i) => {
    if (txt === origen[i] && txt !== dic[clave]) pendientes.push(clave);
  });
}

console.log(`en/index.html generado — ${aplicadas} elementos traducidos (${Object.keys(dic).length} claves)`);
if (sinUsar.length) console.log(`  claves del diccionario que no aparecen en el HTML: ${sinUsar.join(', ')}`);
if (pendientes.length) {
  console.error(`  ERROR: quedaron en español: ${[...new Set(pendientes)].join(', ')}`);
  process.exit(1);
}
console.log('  sin texto en español pendiente');
