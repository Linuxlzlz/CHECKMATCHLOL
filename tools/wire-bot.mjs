/**
 * wire-bot.mjs — el proceso que sí puede publicar.
 *
 * Corre en GitHub Actions, fuera del navegador, que es la única forma de tener
 * credenciales sin embarcarlas en el bundle. Reutiliza EL MISMO motor que usa el
 * sitio: importa engine/wire.js tal cual, con un localStorage de mentira apoyado
 * en un archivo. Así no hay dos versiones del análisis que se puedan desincronizar.
 *
 *   node tools/wire-bot.mjs
 *
 * Por defecto NO publica. Hace falta WIRE_LIVE=true para que postee de verdad;
 * sin eso imprime lo que habría publicado y termina. Un bot que empieza a tuitear
 * en la primera corrida es un bot que tuitea algo roto en la primera corrida.
 *
 * Autenticación: OAuth 1.0a de usuario, firmado a mano con crypto. Es lo que pide
 * la subida de imágenes (media/upload sigue siendo v1.1) y además no caduca, a
 * diferencia de OAuth 2.0 con refresh token, que habría que renovar y persistir.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'wire-state.json');

/* ------------------------------------------------------------------ *
 * localStorage de mentira, para poder reusar el motor del sitio
 * ------------------------------------------------------------------ */

function installStorage() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { data = {}; }
  let dirty = false;
  globalThis.localStorage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); dirty = true; },
    removeItem: (k) => { delete data[k]; dirty = true; },
    key: (i) => Object.keys(data)[i] ?? null,
    get length() { return Object.keys(data).length; },
  };
  return {
    flush() {
      if (!dirty) return false;
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
      return true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * OAuth 1.0a
 * ------------------------------------------------------------------ */

// encodeURIComponent deja pasar !'()* y la firma se rompe: RFC 3986 los exige.
const enc = (s) =>
  encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function authHeader(method, url, queryParams, creds) {
  const oauth = {
    oauth_consumer_key: creds.key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  // Solo se firman los parámetros de query y los oauth_. El cuerpo JSON y el
  // multipart quedan fuera, que es justamente por qué se usa multipart abajo.
  const all = { ...queryParams, ...oauth };
  const base = [
    method.toUpperCase(),
    enc(url),
    enc(Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&')),
  ].join('&');
  const signingKey = `${enc(creds.secret)}&${enc(creds.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return `OAuth ${Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ')}`;
}

/** Sube una imagen remota y devuelve su media_id. */
async function uploadMedia(url, creds) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`imagen ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4_800_000) throw new Error('imagen demasiado grande');

  const endpoint = 'https://upload.twitter.com/1.1/media/upload.json';
  const boundary = `----cml${crypto.randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader('POST', endpoint, {}, creds),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`media ${r.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt).media_id_string;
}

/**
 * Comprueba las credenciales SIN publicar nada.
 *
 * Es la primera corrida que conviene hacer: si la firma OAuth está mal o los
 * tokens se generaron antes de darle permiso de escritura a la app, esto lo dice
 * en dos segundos en vez de descubrirlo con un tweet fallido.
 */
async function verifyCredentials(creds) {
  const endpoint = 'https://api.twitter.com/2/users/me';
  const r = await fetch(endpoint, {
    headers: { Authorization: authHeader('GET', endpoint, {}, creds) },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`users/me ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt)?.data;
}

async function postTweet(text, mediaIds, creds) {
  const endpoint = 'https://api.twitter.com/2/tweets';
  const payload = { text };
  if (mediaIds?.length) payload.media = { media_ids: mediaIds.slice(0, 4) };
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader('POST', endpoint, {}, creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`tweet ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);

/**
 * Resuelve WIRE_LEAGUES contra las ligas conocidas.
 *
 * Acepta vacío y también "todas" / "all" / "*", porque la documentación decía
 * 'Default: todas' y eso se lee como un valor a escribir. Una variable de
 * configuración que por un malentendido deja al bot mirando NADA, y encima en
 * silencio, es peor que una que falla: acá se resuelve o se grita.
 */
function resolveLeagues(raw, LEAGUES) {
  const wanted = String(raw ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const all = ['todas', 'todos', 'all', '*'];
  if (!wanted.length || wanted.some((w) => all.includes(w.toLowerCase()))) return LEAGUES;

  const known = new Map(LEAGUES.map((l) => [l.key.toUpperCase(), l]));
  const hits = wanted.map((w) => known.get(w.toUpperCase())).filter(Boolean);
  const misses = wanted.filter((w) => !known.has(w.toUpperCase()));

  if (misses.length) {
    console.warn(`WIRE_LEAGUES: no reconozco ${misses.join(', ')}. Válidas: ${[...known.keys()].join(', ')}`);
  }
  if (!hits.length) {
    throw new Error(
      `WIRE_LEAGUES="${raw}" no coincide con ninguna liga, así que no habría nada que vigilar. ` +
      `Usá una lista de ${[...known.keys()].join(', ')}, o borrá la variable para vigilarlas todas.`
    );
  }
  return hits;
}

function readCreds() {
  const creds = {
    key: process.env.X_API_KEY,
    secret: process.env.X_API_SECRET,
    token: process.env.X_ACCESS_TOKEN,
    tokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `Faltan credenciales (${missing.length} de 4). Los secrets se llaman ` +
      `X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN y X_ACCESS_TOKEN_SECRET. Ver el README, sección Wire.`
    );
  }
  return creds;
}

async function main() {
  // Modo comprobación: no toca las ligas ni la cola, solo valida las llaves.
  if (String(process.env.WIRE_VERIFY ?? '').toLowerCase() === 'true') {
    const me = await verifyCredentials(readCreds());
    console.log(`Credenciales OK. Cuenta: @${me?.username} (${me?.name}, id ${me?.id})`);
    console.log('Poné WIRE_VERIFY en false y WIRE_LIVE en true cuando quieras que publique.');
    return;
  }

  const store = installStorage();

  // El motor se importa DESPUÉS de instalar el storage: index-score.js lee sus
  // clasificaciones manuales al cargarse.
  const wire = await import('../assets/js/engine/wire.js');
  const { LEAGUES } = await import('../assets/js/api.js');

  const leagues = resolveLeagues(process.env.WIRE_LEAGUES, LEAGUES);
  console.log(`Vigilando: ${leagues.map((l) => l.key).join(', ')}`);
  const added = await wire.tick({ leagues });
  console.log(`Nuevas publicaciones en cola: ${added}`);

  const live = String(process.env.WIRE_LIVE ?? '').toLowerCase() === 'true';
  const maxPerRun = num(process.env.WIRE_MAX_PER_RUN, 4);
  const withMedia = String(process.env.WIRE_MEDIA ?? 'true').toLowerCase() === 'true';

  const pending = wire.queue().filter((p) => !p.posted).reverse(); // más viejas primero
  console.log(`Pendientes: ${pending.length}`);

  if (!live) {
    for (const p of pending.slice(0, maxPerRun)) {
      console.log(`\n--- [SIMULACRO] ${p.id} ---\n${p.text}\n(${p.text.length} caracteres, ${(p.media ?? []).length} imágenes)`);
    }
    console.log('\nWIRE_LIVE no es "true": no se publicó nada.');
    store.flush();
    return;
  }

  const creds = readCreds();
  let posted = 0;
  for (const p of pending.slice(0, maxPerRun)) {
    try {
      let mediaIds = [];
      if (withMedia && p.media?.length) {
        for (const url of p.media.filter(Boolean).slice(0, 4)) {
          try { mediaIds.push(await uploadMedia(url, creds)); }
          catch (e) { console.warn(`  imagen omitida: ${e.message}`); }
        }
      }
      const res = await postTweet(p.text, mediaIds, creds);
      wire.markPosted(p.id, true);
      posted++;
      console.log(`publicado ${p.id} -> ${res?.data?.id ?? '?'}`);
    } catch (e) {
      // Un fallo no debe bloquear la cola entera ni reintentar en bucle: se deja
      // sin marcar y la próxima corrida lo vuelve a intentar.
      console.error(`FALLÓ ${p.id}: ${e.message}`);
    }
  }
  console.log(`\nPublicados: ${posted}`);
  store.flush();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
