/**
 * api.js — cliente de los feeds oficiales de LoL Esports.
 *
 * Dos hosts, los dos con CORS abierto (verificado desde origen github.io):
 *   esports-api.lolesports.com  — calendario, partidos, standings. Requiere x-api-key.
 *   feed.lolesports.com         — draft, parche y estado en vivo. Sin headers.
 *
 * gol.gg NO es accesible desde el navegador (sin CORS). Por eso las capas de
 * campeón y jugador se reconstruyen desde el feed oficial en meta.js en vez de
 * scrapear gol.gg.
 */

// Clave pública del cliente web de lolesports. No es un secreto: viaja en cada
// request del sitio oficial.
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const GW = 'https://esports-api.lolesports.com/persisted/gw/';
const FEED = 'https://feed.lolesports.com/livestats/v1/';

export const LEAGUES = [
  { key: 'LCK', id: '98767991310872058', name: 'LCK', region: 'Corea' },
  { key: 'LCKC', id: '98767991335774713', name: 'LCK Challengers', region: 'Corea' },
  { key: 'LPL', id: '98767991314006698', name: 'LPL', region: 'China' },
  { key: 'LEC', id: '98767991302996019', name: 'LEC', region: 'EMEA' },
  { key: 'LCS', id: '98767991299243165', name: 'LCS', region: 'Norteamérica' },
  { key: 'CBLOL', id: '98767991332355509', name: 'CBLOL', region: 'Brasil' },
];

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} en ${url}`);
    this.status = status;
    this.url = url;
  }
}

// Caché en memoria con TTL. Evita repegarle al feed en cada render.
const cache = new Map();

async function getJSON(url, { headers = {}, ttl = 0 } = {}) {
  const now = Date.now();
  if (ttl > 0) {
    const hit = cache.get(url);
    if (hit && now - hit.t < ttl) return hit.v;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new HttpError(res.status, url);
  const text = await res.text();
  // El feed devuelve cuerpo vacío cuando el mapa todavía no arrancó.
  const value = text.trim() === '' ? null : JSON.parse(text);
  if (ttl > 0) cache.set(url, { t: now, v: value });
  return value;
}

const gw = (path, ttl) => getJSON(GW + path, { headers: { 'x-api-key': API_KEY }, ttl });

/* ------------------------------------------------------------------ *
 * esports-api
 * ------------------------------------------------------------------ */

export const getSchedule = (leagueId, pageToken) =>
  gw(
    `getSchedule?hl=es-ES&leagueId=${leagueId}` + (pageToken ? `&pageToken=${pageToken}` : ''),
    60_000
  );

export const getLive = () => gw('getLive?hl=es-ES', 20_000);

export const getEventDetails = (matchId) => gw(`getEventDetails?hl=es-ES&id=${matchId}`, 30_000);

export const getTournamentsForLeague = (leagueId) =>
  gw(`getTournamentsForLeague?hl=es-ES&leagueId=${leagueId}`, 3_600_000);

export const getStandings = (tournamentId) =>
  gw(`getStandingsV3?hl=es-ES&tournamentId=${tournamentId}`, 600_000);

export const getTeams = (slug) => gw(`getTeams?hl=es-ES&id=${slug}`, 3_600_000);

/**
 * Roster de todos los equipos, indexado por id. Sin `id` el endpoint devuelve
 * ~1500 equipos con sus jugadores, que es la única vía para saber quién es
 * titular: los equipos que vienen en el evento no traen slug.
 *
 * Ojo: es el roster VIGENTE, no el del día del partido. Para un partido viejo
 * puede marcar como suplente a alguien que entonces era titular.
 */
let rosterIndex = null;
export async function getRosterIndex() {
  if (rosterIndex) return rosterIndex;
  try {
    const data = await gw('getTeams?hl=es-ES', 3_600_000);
    rosterIndex = {};
    for (const t of data?.data?.teams ?? []) {
      if (!t?.id) continue;
      rosterIndex[t.id] = {
        name: t.name,
        code: t.code,
        slug: t.slug,
        image: secure(t.image),
        players: (t.players ?? []).map((p) => ({
          id: p.id,
          name: p.summonerName,
          role: p.role,
          // La foto oficial del jugador viene en este mismo endpoint. No hace
          // falta Leaguepedia, que además responde con rate limit desde acá.
          image: secure(p.image),
          firstName: p.firstName,
          lastName: p.lastName,
        })),
      };
    }
  } catch {
    rosterIndex = {};
  }
  return rosterIndex;
}

/** Torneo vigente de una liga: el de startDate más reciente que ya empezó. */
export async function getCurrentTournament(leagueId) {
  const data = await getTournamentsForLeague(leagueId);
  const list = data?.data?.leagues?.[0]?.tournaments ?? [];
  if (!list.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const started = list
    .filter((t) => t.startDate <= today)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  // Si ninguno empezó (pretemporada), devolvemos el más próximo.
  return started[0] ?? list.sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
}

/* ------------------------------------------------------------------ *
 * feed.lolesports.com
 * ------------------------------------------------------------------ */

/**
 * startingTime válido para el feed: UTC, segundos redondeados a múltiplos de
 * 10 y ~90 s de atraso respecto al reloj real. Sin esto el feed devuelve el
 * frame de inicio con todo en cero, que es el error clásico de leer un partido
 * en curso como si estuviera 0-0.
 */
export function feedTimestamp(offsetSeconds = 90, from = Date.now()) {
  const d = new Date(from - offsetSeconds * 1000);
  d.setUTCSeconds(d.getUTCSeconds() - (d.getUTCSeconds() % 10), 0);
  d.setUTCMilliseconds(0);
  return d.toISOString().slice(0, 19) + 'Z';
}

/**
 * Draft, parche y metadatos. Sin startingTime: frame de inicio.
 *
 * `ttl` se puede forzar: el estado de un minuto ya pasado es inmutable y
 * conviene cachearlo largo, mientras que el frame en vivo debe caducar rápido.
 */
export const getWindow = (gameId, startingTime, ttl) =>
  getJSON(
    `${FEED}window/${gameId}` + (startingTime ? `?startingTime=${startingTime}` : ''),
    { ttl: ttl ?? (startingTime ? 8_000 : 300_000) }
  );

/**
 * Frame FINAL de un mapa terminado.
 *
 * Pedirle al feed un startingTime posterior al fin del mapa devuelve los últimos
 * frames con `gameState: "finished"` — oro, torres e inhibidores finales — y
 * además el gameMetadata completo con el draft. O sea que esta llamada trae todo
 * lo que traía `getWindow(gameId)` MÁS el estado final, al mismo costo.
 *
 * Si el startingTime cae en el futuro el feed responde 400, por eso el atraso.
 */
export const getFinalWindow = (gameId, ttl) => getWindow(gameId, feedTimestamp(90), ttl ?? 3_600_000);

/** Stats por jugador: ítems, runas, damage share, participación en kills, wards. */
export const getDetails = (gameId, startingTime, ttl) =>
  getJSON(
    `${FEED}details/${gameId}` + (startingTime ? `?startingTime=${startingTime}` : ''),
    { ttl: ttl ?? 8_000 }
  );

/* ------------------------------------------------------------------ *
 * Data Dragon (retratos de campeón)
 * ------------------------------------------------------------------ */

let ddragonVersion = null;
let ddragonKeys = null;
let ddragonNames = null;

export async function initDDragon() {
  if (ddragonKeys) return;
  try {
    const versions = await getJSON('https://ddragon.leagueoflegends.com/api/versions.json', {
      ttl: 86_400_000,
    });
    ddragonVersion = versions[0];
    const champs = await getJSON(
      `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/es_ES/champion.json`,
      { ttl: 86_400_000 }
    );
    ddragonKeys = {};
    ddragonNames = {};
    for (const c of Object.values(champs.data)) {
      const byId = c.id.toLowerCase().replace(/[^a-z]/g, '');
      const byName = c.name.toLowerCase().replace(/[^a-z]/g, '');
      ddragonKeys[byId] = c.id;
      ddragonKeys[byName] = c.id;
      ddragonNames[byId] = c.name;
      ddragonNames[byName] = c.name;
    }
  } catch {
    // Sin Data Dragon el sitio funciona igual, solo sin retratos ni nombres bonitos.
    ddragonKeys = {};
    ddragonNames = {};
  }
}

/**
 * Nombre visible del campeón. El feed devuelve la clave de Data Dragon
 * ("KSante", "XinZhao"), que se ve mal en pantalla. La coincidencia con la
 * tabla congelada se hace aparte con norm(), así que esto es solo presentación.
 */
export function championName(championId) {
  if (!ddragonNames) return championId;
  const k = String(championId ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return ddragonNames[k] ?? championId;
}

export function championIcon(championId) {
  if (!ddragonVersion || !ddragonKeys) return null;
  const k = String(championId ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const key = ddragonKeys[k];
  if (!key) return null;
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${key}.png`;
}

/** Clave de Data Dragon para un championId del feed ("KSante" -> "KSante"). */
export function ddragonKey(championId) {
  if (!ddragonKeys) return null;
  return ddragonKeys[String(championId ?? '').toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

export function itemIcon(id) {
  if (!ddragonVersion || !id) return null;
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png`;
}

export const listDDragonVersions = () =>
  getJSON('https://ddragon.leagueoflegends.com/api/versions.json', { ttl: 86_400_000 });

/** Ficha completa de un campeón en una versión dada (stats y habilidades). */
export const championDetail = (version, key) =>
  getJSON(`https://ddragon.leagueoflegends.com/cdn/${version}/data/es_ES/champion/${key}.json`, {
    ttl: 86_400_000,
  });

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

/**
 * Corre tareas con concurrencia limitada; no revienta el feed con 200 requests.
 *
 * Devuelve además la lista de fallos. Antes los tragaba y devolvía null, con lo
 * cual un torneo con 7 mapas caídos se reportaba como si tuviera 7 mapas menos
 * y nadie se enteraba: exactamente "dejar que la ausencia de datos se convierta
 * en un número". Ahora el que llama tiene que decidir qué hacer con los fallos.
 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  const failures = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        // Una cancelación no es un fallo de datos: hay que dejarla propagar.
        if (e?.name === 'AbortError') throw e;
        results[idx] = null;
        failures.push({ index: idx, error: e?.message ?? String(e) });
      }
    }
  });
  await Promise.all(runners);
  return { results, failures };
}

/** Las imágenes de equipo vienen en http://; forzamos https para no romper Pages. */
export const secure = (url) => (url ? url.replace(/^http:\/\//, 'https://') : url);
