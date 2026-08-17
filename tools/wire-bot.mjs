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

// api.twitter.com REDIRIGE a api.x.com, y fetch descarta la cabecera
// Authorization al seguir una redirección de otro origen. La firma se pierde en
// el camino y la respuesta es 401 aunque las credenciales sean perfectas. Se
// apunta directo al host final para que no haya salto.
const API = 'https://api.x.com';

/** Avisa si hubo redirección: ahí es donde se pierde la firma. */
function warnIfRedirected(res, url) {
  if (res.redirected && res.url !== url) {
    console.warn(`  ojo: ${url} redirigió a ${res.url}. En un salto de origen se pierde la firma OAuth.`);
  }
}

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

/** Tipo de imagen por sus bytes de cabecera, sin confiar en la extensión. */
function sniffType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  if (buf.length > 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'image/png';
}

/** Sube un buffer y devuelve su media_id. */
async function uploadBuffer(buf, creds) {
  if (buf.length > 4_800_000) throw new Error('imagen demasiado grande');
  const mediaType = sniffType(buf);

  const post = async (endpoint) => {
    const boundary = `----cml${crypto.randomBytes(12).toString('hex')}`;
    const field = (name, value) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    // El endpoint v2 EXIGE media_category; el v1.1 lo aceptaba omitido. Van como
    // partes del multipart, que no entran en la firma OAuth: no hay que
    // recalcular nada por agregarlos.
    const body = Buffer.concat([
      field('media_category', 'tweet_image'),
      field('media_type', mediaType),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="i"\r\nContent-Type: ${mediaType}\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    // El cuerpo multipart NO entra en la firma: OAuth 1.0a solo firma los
    // parámetros de query y los oauth_.
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authHeader('POST', endpoint, {}, creds),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    warnIfRedirected(r, endpoint);
    return { status: r.status, ok: r.ok, txt: await r.text() };
  };

  // v2 primero; el endpoint v1.1 de subida quedó en retirada.
  let res = await post(`${API}/2/media/upload`);
  if (res.status === 404 || res.status === 410) {
    res = await post('https://upload.twitter.com/1.1/media/upload.json');
  }
  if (!res.ok) throw new Error(`media ${res.status}: ${res.txt.slice(0, 300)}`);
  const j = JSON.parse(res.txt);
  return j.media_id_string ?? j?.data?.id ?? j.id;
}

/** Sube una imagen remota y devuelve su media_id. */
async function uploadMedia(url, creds) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`imagen ${res.status}: ${url}`);
  return uploadBuffer(Buffer.from(await res.arrayBuffer()), creds);
}

// PNG transparente de 1x1. Sirve de sonda: subirlo no publica nada.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Comprueba las credenciales SIN publicar nada.
 *
 * Sube un pixel transparente a media/upload y descarta el media_id. Puede sonar
 * raro, pero es la comprobación correcta y la primera versión la tenía mal:
 * usaba GET /2/users/me, que SOLO acepta OAuth 2.0 y devuelve 401 con OAuth 1.0a
 * aunque las credenciales sean impecables. Estaba probando la puerta equivocada.
 *
 * Subir un medio, en cambio, ejercita exactamente lo que hace falta: la firma
 * OAuth 1.0a y el permiso de ESCRITURA. Un token emitido antes de poner la app en
 * Read and Write falla acá, que es justo lo que se quiere detectar. Y un medio
 * que no se adjunta a ningún tweet caduca solo en unas horas: no publica nada ni
 * queda a la vista de nadie.
 */
async function verifyCredentials(creds) {
  const mediaId = await uploadBuffer(PIXEL, creds);
  return { mediaId };
}

async function postTweet(text, mediaIds, creds) {
  const endpoint = `${API}/2/tweets`;
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
  warnIfRedirected(r, endpoint);
  const txt = await r.text();
  if (!r.ok) throw new Error(`tweet ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

/* ------------------------------------------------------------------ *
 * salidas gratuitas
 * ------------------------------------------------------------------ *
 *
 * La API de X cobra por publicar. Publicar VOS, en cambio, no cuesta nada: lo
 * que se cobra es el robot, no el mensaje. Y avisarte que hay algo listo es
 * gratis en cualquier lado.
 *
 * Así que el bot puede entregarte el tweet ya armado por Telegram o Discord —los
 * dos sin cuota— con el enlace que abre el compositor de X con todo puesto. Queda
 * a un toque de publicarse, sin gastar un crédito.
 *
 * No es un rodeo a la cuota de X: es no usar la API para algo que no la necesita.
 */

const INTENT = (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/** El pie con el enlace a X. Con Discord como destino final, sobra. */
const intentFooter = (text) =>
  String(process.env.WIRE_INTENT ?? 'true').toLowerCase() === 'false'
    ? ''
    : `\n[Publicar en X](${INTENT(text)})`;

async function sendTelegram(post, token, chatId, card) {
  const linkX = String(process.env.WIRE_INTENT ?? 'true').toLowerCase() === 'false'
    ? '' : `\n\n▸ Publicar: ${INTENT(post.text)}`;
  const caption = `${post.text}${linkX}`;

  if (card) {
    const boundary = `----cml${crypto.randomBytes(12).toString('hex')}`;
    const field = (n, v) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
    const body = Buffer.concat([
      field('chat_id', chatId),
      // Telegram corta los pies de foto en 1024: el texto entra cómodo.
      field('caption', caption.slice(0, 1024)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="checkmatch.png"\r\nContent-Type: image/png\r\n\r\n`),
      card,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return;
  }

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: caption }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

async function sendDiscord(post, webhook, card) {
  const payload = { content: `\`\`\`\n${post.text}\n\`\`\`${intentFooter(post.text)}` };

  // Con tarjeta va como archivo adjunto, que Discord muestra grande. Sin ella,
  // se cae a los logos sueltos como antes.
  if (card) {
    const boundary = `----cml${crypto.randomBytes(12).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="checkmatch.png"\r\nContent-Type: image/png\r\n\r\n`),
      card,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!r.ok) throw new Error(`discord ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return;
  }

  payload.embeds = (post.media ?? []).filter(Boolean).slice(0, 2).map((u) => ({ image: { url: u } }));
  const r = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`discord ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

/**
 * Entrega por los canales gratuitos lo que todavía no se entregó.
 *
 * Lleva su propia marca, separada de `posted`: que te haya llegado el aviso no
 * significa que ya esté publicado en X.
 */
/**
 * Dibuja la tarjeta si se puede. Nunca tira: una tarjeta que no sale no puede
 * impedir que salga el análisis, así que el bot sigue con las imágenes sueltas.
 */
async function renderCard(post) {
  if (!post.card || String(process.env.WIRE_CARD ?? 'true').toLowerCase() === 'false') return null;
  try {
    const { preMatchCard, postMatchCard } = await import('./card.mjs');
    return post.card.kind === 'post' ? await postMatchCard(post.card) : await preMatchCard(post.card);
  } catch (e) {
    console.warn(`  sin tarjeta (${e.message.slice(0, 90)})`);
    return null;
  }
}

async function deliverFree(pending) {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const discord = process.env.DISCORD_WEBHOOK;
  if (!((tgToken && tgChat) || discord)) return 0;

  const KEY = 'cml:wire:notified';
  let sent;
  try { sent = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { sent = {}; }

  let n = 0;
  for (const p of pending) {
    if (sent[p.id]) continue;
    try {
      const card = await renderCard(p);
      if (tgToken && tgChat) await sendTelegram(p, tgToken, tgChat, card);
      if (discord) await sendDiscord(p, discord, card);
      sent[p.id] = new Date().toISOString();
      n++;
      console.log(`avisado ${p.id}`);
    } catch (e) {
      console.warn(`  no se pudo avisar ${p.id}: ${e.message}`);
    }
  }
  localStorage.setItem(KEY, JSON.stringify(sent));
  return n;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

/**
 * Número desde una variable de entorno.
 *
 * Cuidado con la cadena vacía: Actions pasa "" cuando la variable no existe, y
 * Number("") es 0, que es finito. La versión ingenua devolvía 0 en vez del valor
 * por defecto — así la pausa por cuota agotada terminó siendo "0 h", o sea
 * ninguna pausa. Un default que nunca se aplica es peor que no tenerlo.
 */
const num = (v, def) => {
  const s = String(v ?? '').trim();
  if (!s) return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
};

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

  // Los valores que la documentación usa como marcador de "sin filtro" terminan
  // cargados como si fueran un valor real. Ya pasó con "todas" y con "Default",
  // así que se aceptan todos en vez de fallar por un malentendido de la tabla.
  const all = ['todas', 'todos', 'all', '*', 'default', 'defecto', 'ninguna', '-'];
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

/**
 * Describe las credenciales SIN mostrarlas.
 *
 * Un 401 no distingue "la firma está mal" de "pegaste un valor que no era". Esto
 * resuelve la segunda mitad: las cuatro credenciales de X tienen formas muy
 * distintas y reconocibles, así que con la longitud y un par de rasgos alcanza
 * para ver si alguna está en el casillero equivocado.
 *
 * No imprime ningún valor, ni siquiera parcial.
 */
function describeCreds(creds) {
  const shape = (v) => ({
    largo: v.length,
    espacios: /\s/.test(v),
    guion: v.includes('-'),
  });
  const s = {
    X_API_KEY: shape(creds.key),
    X_API_SECRET: shape(creds.secret),
    X_ACCESS_TOKEN: shape(creds.token),
    X_ACCESS_TOKEN_SECRET: shape(creds.tokenSecret),
  };

  // Largos típicos de cada credencial de X. Son estables y muy distintos entre
  // sí, así que alcanzan para detectar un valor puesto en el casillero de otro.
  const ESPERADO = {
    X_API_KEY: 25,
    X_API_SECRET: 50,
    X_ACCESS_TOKEN: null,          // varía; lo que lo identifica es el guion
    X_ACCESS_TOKEN_SECRET: 45,
  };

  console.log('\nForma de las credenciales (no se muestra ningún valor):');
  for (const [k, v] of Object.entries(s)) {
    const esp = ESPERADO[k];
    const marca = esp && v.largo !== esp ? `  ⚠ se esperaban ${esp}` : '';
    console.log(`  ${k.padEnd(23)} ${String(v.largo).padStart(3)} caracteres${v.espacios ? '  ⚠ TIENE ESPACIOS' : ''}${v.guion ? '  (contiene "-")' : ''}${marca}`);
  }

  const avisos = [];
  for (const [k, v] of Object.entries(s)) {
    if (v.espacios) avisos.push(`${k} tiene espacios o saltos de línea: se pegó de más.`);
  }
  // 34 caracteres es la firma del Client ID de OAuth 2.0, que está en OTRA
  // sección de la misma pantalla y es la confusión más fácil de cometer.
  if (s.X_API_KEY.largo === 34) {
    avisos.push(
      'X_API_KEY mide 34: ese es el largo del CLIENT ID de OAuth 2.0, no de la API Key. ' +
      'En "Keys and tokens" hay dos bloques distintos; el que sirve acá es "Consumer Keys ' +
      '-> API Key and Secret" (la API Key mide 25). El bloque "OAuth 2.0 Client ID and ' +
      'Client Secret" no se usa en este bot.'
    );
  } else if (s.X_API_KEY.largo !== ESPERADO.X_API_KEY) {
    avisos.push(`X_API_KEY mide ${s.X_API_KEY.largo} y una API Key de X mide ${ESPERADO.X_API_KEY}. Revisá de qué bloque la copiaste.`);
  }
  if (s.X_API_SECRET.largo !== ESPERADO.X_API_SECRET) {
    avisos.push(`X_API_SECRET mide ${s.X_API_SECRET.largo} y se esperan ${ESPERADO.X_API_SECRET}. Si la API Key salió del bloque equivocado, el secreto probablemente también.`);
  }
  if (s.X_ACCESS_TOKEN_SECRET.largo !== ESPERADO.X_ACCESS_TOKEN_SECRET) {
    avisos.push(`X_ACCESS_TOKEN_SECRET mide ${s.X_ACCESS_TOKEN_SECRET.largo} y se esperan ${ESPERADO.X_ACCESS_TOKEN_SECRET}.`);
  }
  // El Access Token siempre empieza con el id numérico de la cuenta y un guion.
  if (!s.X_ACCESS_TOKEN.guion) {
    avisos.push('X_ACCESS_TOKEN no contiene "-". Un Access Token de X tiene la forma "<id>-<...>". Revisá que no sea el Client ID ni el Bearer Token.');
  }
  if (s.X_API_KEY.guion) {
    avisos.push('X_API_KEY contiene "-", cosa rara en una API Key. ¿No será el Access Token puesto en el casillero equivocado?');
  }
  if (avisos.length) {
    console.warn('\nPosibles problemas:');
    for (const a of avisos) console.warn(`  - ${a}`);
  } else {
    console.log('  Las cuatro tienen la forma esperada.');
  }
  return avisos.length;
}

async function main() {
  // Modo comprobación: no toca las ligas ni la cola, solo valida las llaves.
  if (String(process.env.WIRE_VERIFY ?? '').toLowerCase() === 'true') {
    const creds = readCreds();
    describeCreds(creds);
    try {
      const { mediaId } = await verifyCredentials(creds);
      console.log(`Credenciales OK: firma válida y permiso de ESCRITURA confirmado (media_id ${mediaId}).`);
      console.log('No se publicó nada: el medio queda huérfano y caduca solo.');
      console.log('Poné WIRE_VERIFY en false para ver simulacros, y WIRE_LIVE en true para publicar.');
    } catch (e) {
      console.error(`\nFALLÓ la comprobación: ${e.message}\n`);
      if (/\b401\b/.test(e.message)) {
        console.error(
          'Un 401 es firma o llaves. Mirá primero la forma de arriba; si las cuatro\n' +
          'están bien, lo más común es, en orden:\n' +
          '  1. Las 4 credenciales no son de la MISMA app (API Key de una, Access Token de otra).\n' +
          '  2. Se regeneró alguna en el portal y quedó desactualizada en los secrets.\n' +
          '  3. La app no está dentro de un Proyecto, que los endpoints v2 exigen.'
        );
      } else if (/\b403\b/.test(e.message)) {
        console.error(
          'Un 403 es permisos. El Access Token se generó ANTES de poner la app en\n' +
          '"Read and Write". Cambiá el permiso y REGENERÁ el token: el viejo queda de\n' +
          'solo lectura para siempre.'
        );
      } else if (/\b429\b/.test(e.message)) {
        console.error('Un 429 es límite de frecuencia. Esperá a que se renueve la ventana.');
      } else if (/\b402\b/.test(e.message)) {
        console.error(
          'Un 402 son CRÉDITOS agotados, no un problema de configuración. Ojo que esta\n' +
          'comprobación también consume: cada corrida sube una imagen de prueba. Una vez\n' +
          'que dio OK, no hace falta repetirla.'
        );
      }
      process.exitCode = 1;
    }
    return;
  }

  const store = installStorage();

  // El motor se importa DESPUÉS de instalar el storage: index-score.js lee sus
  // clasificaciones manuales al cargarse.
  const wire = await import('../assets/js/engine/wire.js');
  const { LEAGUES } = await import('../assets/js/api.js');

  // Para PROBAR hace falta alcanzar un partido que ya terminó: en operación
  // normal el vigilante solo ve lo que está en vivo, y cuando el evento sale del
  // feed en vivo ese mapa queda fuera de alcance para siempre.
  const backfillHours = num(process.env.WIRE_BACKFILL, 0);
  const matchIds = (process.env.WIRE_MATCH ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  // Con partidos forzados la liga no filtra nada, así que no tiene sentido que un
  // WIRE_LEAGUES mal escrito haga fallar una prueba que no lo usa.
  const leagues = matchIds.length ? LEAGUES : resolveLeagues(process.env.WIRE_LEAGUES, LEAGUES);
  const onlyKind = (process.env.WIRE_ONLY ?? '').trim().toLowerCase() || null;
  if (onlyKind && !['pre', 'post'].includes(onlyKind)) {
    throw new Error(`WIRE_ONLY="${onlyKind}" no vale. Usá "pre", "post", o dejala vacía.`);
  }

  console.log(`Vigilando: ${leagues.map((l) => l.key).join(', ')}`);
  if (matchIds.length) console.log(`Partidos forzados: ${matchIds.join(', ')}`);
  if (backfillHours) console.log(`Backfill: ${backfillHours} h hacia atrás`);
  if (onlyKind) console.log(`Solo tweets de tipo: ${onlyKind}`);

  const added = await wire.tick({ leagues, recordFor: null, backfillHours, matchIds, onlyKind });
  console.log(`Nuevas publicaciones en cola: ${added}`);
  if (!added && matchIds.length) {
    console.warn(
      'No se generó nada para los ids forzados. Puede ser que ya estuvieran en la cola\n' +
      '(el estado vive en tools/wire-state.json y es idempotente), que el mapa no haya\n' +
      'terminado todavía si pediste WIRE_ONLY=post, o que el id no exista.'
    );
  }

  const live = String(process.env.WIRE_LIVE ?? '').toLowerCase() === 'true';
  const maxPerRun = num(process.env.WIRE_MAX_PER_RUN, 4);
  const withMedia = String(process.env.WIRE_MEDIA ?? 'true').toLowerCase() === 'true';

  const pending = wire.queue().filter((p) => !p.posted).reverse(); // más viejas primero
  console.log(`Pendientes: ${pending.length}`);

  // Los canales gratuitos van SIEMPRE, publique o no en X: son la red de
  // seguridad cuando la cuota se agota, y no cuestan nada.
  const avisados = await deliverFree(pending);
  if (avisados) console.log(`Avisos enviados: ${avisados}`);

  if (!live) {
    for (const p of pending.slice(0, maxPerRun)) {
      console.log(`\n--- [SIMULACRO] ${p.id} ---\n${p.text}\n(${p.text.length} caracteres, ${(p.media ?? []).length} imágenes)`);
    }
    console.log('\nWIRE_LIVE no es "true": no se publicó nada.');
    store.flush();
    return;
  }

  // Con X fuera de juego, que falten sus credenciales no es un error: los canales
  // gratuitos ya entregaron arriba y el trabajo está hecho.
  const faltan = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']
    .filter((k) => !process.env[k]);
  if (faltan.length) {
    console.warn(
      `\nWIRE_LIVE está en true pero faltan ${faltan.length} de las 4 credenciales de X, ` +
      'así que no se publica ahí. Si X ya no es un destino, poné WIRE_LIVE en false y ' +
      'este aviso desaparece.'
    );
    store.flush();
    return;
  }
  const creds = readCreds();

  // Freno por cuota agotada.
  //
  // Un 402 no se arregla reintentando: la cuota se repone con el tiempo o
  // pagando. Sin esto, el cron cada 10 minutos hace 144 intentos fallidos por
  // día, y cada intento puede consumir crédito. Se anota la pausa en el mismo
  // estado que la cola, así sobrevive entre corridas.
  const PAUSE_KEY = 'cml:wire:paused-until';
  const pausedUntil = Number(localStorage.getItem(PAUSE_KEY) ?? 0);
  if (pausedUntil > Date.now()) {
    const faltan = Math.ceil((pausedUntil - Date.now()) / 60000);
    console.warn(
      `\nPublicación en pausa por cuota agotada (402). Se reanuda en ~${faltan} min.\n` +
      'La cola se siguió llenando: nada se pierde, solo se pospone.\n' +
      `Para forzar antes, borrá "${PAUSE_KEY}" de tools/wire-state.json.`
    );
    store.flush();
    return;
  }

  let posted = 0;
  for (const p of pending.slice(0, maxPerRun)) {
    try {
      let mediaIds = [];
      if (withMedia) {
        // La tarjeta va primero y sola: lleva los logos, la foto y los números
        // ya compuestos, así que adjuntar además las imágenes sueltas sería
        // repetir lo mismo peor y gastar una llamada por cada una.
        const card = await renderCard(p);
        if (card) {
          try { mediaIds.push(await uploadBuffer(card, creds)); }
          catch (e) { console.warn(`  tarjeta no subida: ${e.message}`); }
        }
        if (!mediaIds.length) {
          for (const url of (p.media ?? []).filter(Boolean).slice(0, 4)) {
            try { mediaIds.push(await uploadMedia(url, creds)); }
            catch (e) { console.warn(`  imagen omitida: ${e.message}`); }
          }
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

      if (/\b402\b/.test(e.message) || /credits.depleted/i.test(e.message)) {
        const horas = num(process.env.WIRE_PAUSE_HOURS, 6);
        localStorage.setItem(PAUSE_KEY, String(Date.now() + horas * 3600_000));
        console.error(
          `\nCUOTA AGOTADA. Se pausa la publicación ${horas} h para no quemar más crédito.\n` +
          'Esto no es un error del bot: la API de X trabaja con créditos y los de esta\n' +
          'cuenta se terminaron. Mirá "Uso" y "Créditos" en el portal de desarrollador.\n' +
          'Mientras tanto:\n' +
          '  - WIRE_MEDIA=false abarata cada publicación: subir imágenes también consume.\n' +
          '  - WIRE_LEAGUES con una sola liga baja mucho el volumen.\n' +
          '  - Con WIRE_LIVE=false la cola se sigue llenando y publicás a mano desde #/wire.'
        );
        break;   // no seguir con el resto de la cola en esta corrida
      }
      if (/\b429\b/.test(e.message)) {
        console.error('429: límite de frecuencia. La próxima corrida lo reintenta.');
        break;
      }
    }
  }
  console.log(`\nPublicados: ${posted}`);
  store.flush();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
