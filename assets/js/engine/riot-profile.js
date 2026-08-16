/**
 * riot-profile.js — segunda fuente sobre los campeones, de primera mano.
 *
 * Hasta acá todo lo estructural salía de UNA tabla de juicio propio, y cinco ejes
 * del Paso 2 se declaraban no computables porque esa tabla no los cubría. Eso era
 * honesto pero terminal: sin otra fuente, no había forma de comprobarlos nunca.
 *
 * Community Dragon publica los datos del cliente de LoL, y ahí Riot expone su
 * propia caracterización de cada campeón (verificado con CORS abierto desde el
 * navegador el 16/08/2026):
 *
 *   playstyleInfo: { damage, durability, crowdControl, mobility, utility }  0-3
 *   tacticalInfo:  { damageType: kPhysical|kMagic|kMixed, attackType: melee|ranged }
 *   roles:         [fighter, tank, mage, marksman, assassin, support]
 *
 * Qué cambia:
 *
 *  1. "Neutral a rango" deja de ser no computable: cuerpo a cuerpo contra rango es
 *     un hecho, no un juicio.
 *  2. "Peel" y "desenganche" pasan de no computables a MEDIDOS POR PROXY con el eje
 *     de control de masas de Riot. Proxy no es identidad y se dice así.
 *  3. Aparece un eje que antes no existía en ninguna forma: la mezcla de daño
 *     físico/mágico, que es lo que decide si el rival puede apilar una sola
 *     resistencia. Es dato puro.
 *  4. La tabla congelada consigue por fin un CONTRASTE independiente: el eje `fl`
 *     (frontline) se puede comparar contra `durability` de Riot. Donde discrepan,
 *     hay algo que mirar.
 *
 * Lo que NO resuelve, y hay que seguir diciéndolo: waveclear y velocidad de
 * objetivo no están acá tampoco.
 */

const BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/';
const CACHE_KEY = 'cml:riot:v1';
const CACHE_TTL = 14 * 24 * 3600 * 1000;

let summary = null;         // alias normalizado -> id numérico
let profiles = {};          // alias normalizado -> perfil
let loaded = false;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Date.now() - v.at > CACHE_TTL) return null;
    return v;
  } catch {
    return null;
  }
}

function writeCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), summary, profiles }));
  } catch { /* cuota llena: vale para esta sesión */ }
}

/** Índice de campeones. Una sola petición para los 237. */
export async function initRiotProfiles() {
  if (loaded) return true;
  const cached = readCache();
  if (cached) {
    summary = cached.summary;
    profiles = cached.profiles ?? {};
    loaded = true;
    return true;
  }
  try {
    const list = await fetch(BASE + 'champion-summary.json').then((r) => r.json());
    summary = {};
    for (const c of list) {
      if (!c?.id || c.id < 0) continue;
      summary[norm(c.alias)] = c.id;
      summary[norm(c.name)] = c.id;
    }
    loaded = true;
    writeCache();
    return true;
  } catch {
    // Sin esta fuente el sitio funciona igual, con los ejes declarados como antes.
    loaded = false;
    return false;
  }
}

export const riotAvailable = () => loaded;

/** Perfil de un campeón. Una petición por campeón, cacheada 14 días. */
export async function fetchProfile(champion) {
  if (!loaded) return null;
  const k = norm(champion);
  if (profiles[k] !== undefined) return profiles[k];
  const id = summary[k];
  if (!id) {
    profiles[k] = null;
    return null;
  }
  try {
    const j = await fetch(`${BASE}champions/${id}.json`).then((r) => r.json());
    profiles[k] = {
      id,
      name: j.name,
      roles: j.roles ?? [],
      damage: j.playstyleInfo?.damage ?? null,
      durability: j.playstyleInfo?.durability ?? null,
      crowdControl: j.playstyleInfo?.crowdControl ?? null,
      mobility: j.playstyleInfo?.mobility ?? null,
      utility: j.playstyleInfo?.utility ?? null,
      damageType: (j.tacticalInfo?.damageType ?? '').replace(/^k/, '').toLowerCase() || null,
      attackType: j.tacticalInfo?.attackType ?? null,
      difficulty: j.tacticalInfo?.difficulty ?? null,
      spells: (j.spells ?? []).map((s) => ({ key: s.spellKey, name: s.name })),
    };
  } catch {
    profiles[k] = null;
  }
  writeCache();
  return profiles[k];
}

/** Perfiles de los diez del draft, en paralelo. */
export async function fetchProfiles(champions) {
  if (!loaded) return {};
  const out = {};
  await Promise.all(
    [...new Set(champions)].map(async (c) => { out[norm(c)] = await fetchProfile(c); })
  );
  return out;
}

export const profileFor = (map, champion) => map?.[norm(champion)] ?? null;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Ejes de composición derivados de la fuente de Riot.
 *
 * Todos declaran su naturaleza: `hecho` cuando se cuenta algo que no admite
 * discusión (cuántos son a distancia), `proxy` cuando el eje de Riot se usa para
 * aproximar un concepto que no es exactamente el mismo (control de masas por peel).
 */
export function riotAxes(sideA, sideB, map) {
  const prof = (side) => side.players.map((p) => ({ p, r: profileFor(map, p.champion) }));
  const A = prof(sideA);
  const B = prof(sideB);
  const known = (arr) => arr.filter((x) => x.r);
  const cov = { a: known(A).length, b: known(B).length };
  if (!cov.a || !cov.b) return { available: false, coverage: cov, axes: [] };

  const axes = [];
  const val = (arr, k) => sum(known(arr).map((x) => x.r[k] ?? 0));
  const count = (arr, fn) => known(arr).filter((x) => fn(x.r)).length;

  // 1. Cuerpo a cuerpo contra rango — "neutral a rango" del Paso 2.
  const rangedA = count(A, (r) => r.attackType === 'ranged');
  const rangedB = count(B, (r) => r.attackType === 'ranged');
  axes.push({
    id: 'range',
    label: 'Neutral a rango',
    kind: 'hecho',
    a: rangedA,
    b: rangedB,
    unit: 'campeones a distancia (de 5)',
    favors: rangedA === rangedB ? null : rangedA > rangedB ? sideA.team : sideB.team,
    note:
      Math.abs(rangedA - rangedB) >= 2
        ? `${rangedA > rangedB ? sideA.team : sideB.team} gana el pulso alrededor de un objetivo si nadie inicia: ` +
          `puede castigar sin entrar. Es el eje que antes se declaraba no computable.`
        : 'Reparto parejo entre cuerpo a cuerpo y distancia.',
  });

  // 2. Control de masas — proxy de peel y de contra-inicio.
  const ccA = val(A, 'crowdControl');
  const ccB = val(B, 'crowdControl');
  axes.push({
    id: 'cc',
    label: 'Control de masas (peel y contra-inicio)',
    kind: 'proxy',
    a: ccA,
    b: ccB,
    unit: 'suma del eje de CC de Riot (0-3 por campeón)',
    favors: ccA === ccB ? null : ccA > ccB ? sideA.team : sideB.team,
    note:
      'Proxy, no identidad: el eje de Riot mide cuánto CC tiene el kit, no si ese CC sirve para ' +
      'proteger al carry. Un support con mucho CC ofensivo puntúa igual que uno con CC de peel.',
  });

  // 3. Movilidad — acceso, reposicionamiento y desenganche.
  const mobA = val(A, 'mobility');
  const mobB = val(B, 'mobility');
  axes.push({
    id: 'mobility',
    label: 'Movilidad',
    kind: 'proxy',
    a: mobA,
    b: mobB,
    unit: 'suma del eje de movilidad de Riot',
    favors: mobA === mobB ? null : mobA > mobB ? sideA.team : sideB.team,
    note: 'Acceso a la línea trasera y capacidad de salir de una pelea que se pierde.',
  });

  // 4. Mezcla de daño — esto no existía en ninguna forma y es dato puro.
  const mix = (arr) => {
    const k = known(arr);
    return {
      physical: k.filter((x) => x.r.damageType === 'physical').length,
      magic: k.filter((x) => x.r.damageType === 'magic').length,
      mixed: k.filter((x) => x.r.damageType === 'mixed').length,
    };
  };
  const mA = mix(A);
  const mB = mix(B);
  const lopsided = (m) => {
    const t = m.physical + m.magic + m.mixed;
    if (!t) return null;
    if (m.physical >= 4) return 'físico';
    if (m.magic >= 4) return 'mágico';
    return null;
  };
  const lopA = lopsided(mA);
  const lopB = lopsided(mB);
  axes.push({
    id: 'damage-mix',
    label: 'Mezcla de daño',
    kind: 'hecho',
    a: `${mA.physical}F / ${mA.magic}M / ${mA.mixed}X`,
    b: `${mB.physical}F / ${mB.magic}M / ${mB.mixed}X`,
    unit: 'físico / mágico / mixto',
    favors: lopA && !lopB ? sideB.team : lopB && !lopA ? sideA.team : null,
    note:
      lopA || lopB
        ? `${lopA ? sideA.team : sideB.team} concentra el daño en ${lopA ?? lopB}: el rival puede ` +
          `apilar una sola resistencia y anular la mitad de la comp con un ítem. Es el eje más ` +
          `barato de explotar y no estaba en el análisis hasta ahora.`
        : 'Las dos comps mezclan tipos de daño: nadie puede apilar una sola resistencia.',
  });

  return { available: true, coverage: cov, axes };
}

/**
 * Contraste entre la tabla congelada y la de Riot.
 *
 * El eje `fl` (frontline, juicio propio) y `durability` (Riot) miden cosas muy
 * parecidas, así que donde discrepan fuerte hay una de dos: o la tabla congelada
 * tiene un error, o el campeón cambió de rol desde que se escribió. Las dos cosas
 * valen la pena de mirar, y hasta ahora no había con qué mirarlas.
 *
 * No corrige nada solo. Solo muestra dónde no coinciden.
 */
export function crossCheck(champions, map, profileRow) {
  const rows = [];
  for (const c of [...new Set(champions)]) {
    const mine = profileRow(c);
    const riot = profileFor(map, c);
    if (!mine || !riot || riot.durability == null) continue;
    const delta = mine.fl - riot.durability;
    rows.push({
      champion: c,
      fl: mine.fl,
      durability: riot.durability,
      delta,
      disagrees: Math.abs(delta) >= 2,
      roles: riot.roles,
    });
  }
  const disagreements = rows.filter((r) => r.disagrees);
  return {
    rows,
    disagreements,
    agreement: rows.length ? 1 - disagreements.length / rows.length : null,
  };
}

/**
 * Sugerencia de arquetipo para un campeón que no está en ninguna tabla.
 *
 * Traduce los ejes de Riot a los siete de la tabla. Es una TRADUCCIÓN, no una
 * medición: los ejes no significan lo mismo y el mapeo es discutible. Por eso el
 * sitio la ofrece como punto de partida en el editor y no la aplica sola. Un
 * número inventado que se aplica solo es exactamente lo que este proyecto trata
 * de no hacer.
 */
export function suggestArchetype(riot) {
  if (!riot) return null;
  const r = riot.roles ?? [];
  const has = (x) => r.includes(x);
  const clamp = (v) => Math.max(0, Math.min(3, Math.round(v)));

  const fl = clamp(riot.durability ?? 0);
  // El daño de área no está en la fuente: se aproxima por clase, y flojo.
  const aoe = clamp(has('mage') ? 2 : has('tank') ? 1 : has('marksman') ? 1 : 1);
  const eng = clamp(Math.min(riot.crowdControl ?? 0, riot.durability ?? 0) + (has('tank') ? 1 : 0));
  const pick = clamp(has('assassin') ? 3 : (riot.crowdControl ?? 0) >= 3 ? 2 : 1);
  const poke = clamp(riot.attackType === 'ranged' && has('mage') ? 2 : riot.attackType === 'ranged' ? 1 : 0);
  const split = clamp(has('fighter') ? 2 : has('marksman') ? 0 : 1);
  const scale = clamp(has('marksman') ? 3 : has('mage') ? 2 : 1);

  return {
    fl, aoe, eng, pick, poke, split, scale,
    basis:
      `Traducido de los ejes de Riot (durabilidad ${riot.durability}, CC ${riot.crowdControl}, ` +
      `movilidad ${riot.mobility}, ${riot.attackType}, ${riot.damageType}) y de las clases ` +
      `${(riot.roles ?? []).join('/') || 'sin clase'}. Es una traducción entre escalas distintas, ` +
      `no una medición: revisalo antes de guardar.`,
  };
}
