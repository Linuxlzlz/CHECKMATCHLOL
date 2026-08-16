/**
 * index-score.js — port de scripts/score_draft.py.
 *
 * Paridad exacta con el script: mismas fórmulas, misma normalización de
 * nombres, misma desviación estándar POBLACIONAL (divide por N, no por N-1) y
 * el mismo fallback `sd || 1.0`. Cualquier divergencia numérica acá rompe la
 * comparación con el backtest, así que las fórmulas están congeladas.
 */

import { ARCHETYPES_CSV, EXTENSION_CSV, REFERENCE_CSV, CHAMPION_ALIASES } from '../data/tables.js';

export const AXES = ['fl', 'aoe', 'eng', 'pick', 'poke', 'split', 'scale'];
export const INDEX_AXES = ['teamfight', 'pick', 'split', 'siege', 'scaling'];

// CONGELADAS. Cambiarlas después de ver resultados invalida el backtest.
const FORMULAS = {
  teamfight: (v) => v.aoe + 0.5 * v.fl + 0.5 * v.eng,
  pick: (v) => v.pick + 0.5 * v.eng,
  split: (v) => v.split,
  siege: (v) => v.poke,
  scaling: (v) => v.scale,
};

/** Normaliza nombres: "K'Sante", "KSante", "k sante" -> "ksante". */
export function norm(name) {
  const k = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return CHAMPION_ALIASES[k] ?? k;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

function loadCSV(text) {
  const t = {};
  for (const row of parseCSV(text)) {
    const v = {};
    for (const a of AXES) v[a] = parseFloat(row[a]);
    v.champion = row.champion;
    t[norm(row.champion)] = v;
  }
  return t;
}

/** Tabla congelada. Define la escala y NO se toca. */
const FROZEN = loadCSV(ARCHETYPES_CSV);

/** Extensión: campeones que faltaban en la congelada. Ver tables.js. */
const EXTENSION = loadCSV(EXTENSION_CSV);

/**
 * Clasificaciones manuales del usuario, guardadas en el navegador.
 *
 * Un campeón que no está en ninguna tabla suma cero y deja el draft sin
 * diagnóstico. En vez de inventarle un perfil, el sitio lo declara y ofrece
 * puntuarlo a mano; lo que se puntúa acá queda marcado como "manual" en todas
 * las lecturas, para que nunca se confunda con la tabla congelada.
 */
const MANUAL_KEY = 'cml:archetypes:v1';
let MANUAL = (() => {
  try {
    const raw = localStorage.getItem(MANUAL_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
})();

export function manualTable() {
  return MANUAL;
}

/** Guarda (o borra, con `null`) el perfil manual de un campeón. */
export function setManualProfile(champion, values) {
  const k = norm(champion);
  if (!values) delete MANUAL[k];
  else {
    const v = { champion };
    for (const a of AXES) v[a] = Math.max(0, Math.min(3, Number(values[a]) || 0));
    MANUAL[k] = v;
  }
  try {
    localStorage.setItem(MANUAL_KEY, JSON.stringify(MANUAL));
  } catch { /* cuota llena: vale para esta sesión */ }
  return MANUAL[k] ?? null;
}

export function clearManualProfiles() {
  MANUAL = {};
  try { localStorage.removeItem(MANUAL_KEY); } catch { /* nada */ }
}

/** Fila vigente de un campeón, mirando manual → extensión → congelada. */
export function profileRow(champion) {
  const k = norm(champion);
  return MANUAL[k] ?? EXTENSION[k] ?? FROZEN[k] ?? null;
}

/**
 * De dónde salió la clasificación: 'congelado' | 'extension' | 'manual' | null.
 * Se muestra en la UI porque las tres tienen distinto peso epistémico.
 */
export function classificationOf(champion) {
  const k = norm(champion);
  if (MANUAL[k]) return 'manual';
  if (EXTENSION[k]) return 'extension';
  if (FROZEN[k]) return 'congelado';
  return null;
}

export const isClassified = (champion) => classificationOf(champion) !== null;

const REFERENCE_COMPS = parseCSV(REFERENCE_CSV).map((r) => r.champions.split('|'));

/** Suma cruda de ejes sobre 5 campeones. Los no clasificados suman 0, como el script. */
export function rawScores(champions, { table = null } = {}) {
  const v = Object.fromEntries(AXES.map((a) => [a, 0]));
  const missing = [];
  for (const c of champions) {
    const row = table ? table[norm(c)] : profileRow(c);
    if (row) {
      for (const a of AXES) v[a] += row[a];
    } else {
      missing.push(c);
    }
  }
  const scores = {};
  for (const [name, fn] of Object.entries(FORMULAS)) scores[name] = fn(v);
  return { scores, axes: v, missing };
}

/**
 * Media y sd poblacional de la distribución de referencia (62 comps).
 *
 * Se calcula con la tabla CONGELADA a propósito, ignorando la extensión: la
 * escala tiene que seguir siendo la del backtest. "Locke" aparece en las comps
 * de referencia y no está clasificado, así que cuenta cero acá igual que en
 * score_draft.py. Mover esto cambia lo que significan las bandas de 0.5 y 1 sd.
 */
export const REFERENCE_STATS = (() => {
  const cols = Object.fromEntries(INDEX_AXES.map((k) => [k, []]));
  for (const champs of REFERENCE_COMPS) {
    const { scores } = rawScores(champs, { table: FROZEN });
    for (const k of INDEX_AXES) cols[k].push(scores[k]);
  }
  const stats = {};
  for (const k of INDEX_AXES) {
    const xs = cols[k];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
    stats[k] = { mean, sd: Math.sqrt(variance) || 1.0 };
  }
  return stats;
})();

/**
 * Banda de la diferencia de índice de teamfight.
 * El texto sale del script para que el lenguaje no se infle acá.
 */
export function band(delta) {
  const a = Math.abs(delta);
  if (a < 0.5) return { label: 'chica', meaning: 'moneda al aire — NO usar como señal', tier: 'coin' };
  if (a < 1.0) return { label: 'media', meaning: 'lean débil', tier: 'weak' };
  return {
    label: 'grande',
    meaning: 'lean con respaldo (74% en backtest n=31, IC [57, 86])',
    tier: 'strong',
  };
}

/**
 * Umbral de narrabilidad en puntos crudos.
 *
 * Lección de calibración del 15/08: se construyó una narrativa entera de
 * "ventana con fecha de vencimiento" sobre 1 punto crudo de diferencia en
 * escalado, que es un campeón puntuado 2 en vez de 3 por juicio propio. Los
 * z-scores amplifican los ejes de dispersión estrecha, así que por debajo de
 * ~1 punto crudo el eje no se narra por alto que sea el z.
 *
 * El umbral se compara con ESTRICTAMENTE MAYOR: el fallo registrado ocurrió
 * sobre exactamente 1.0 punto, así que 1.0 no alcanza para narrar.
 */
export const RAW_NARRATABLE_MIN = 1.0;

/**
 * Umbrales MEDIDOS sobre el corpus indexado, por eje.
 *
 * El 1.0 de arriba es una regla de dedo que salió de un fallo concreto y se
 * aplica igual a los cinco ejes, aunque tengan dispersiones muy distintas.
 * engine/validation.js lo mide: para cada eje, a partir de cuántos puntos crudos
 * el lado favorecido gana más seguido.
 *
 * La medición solo puede ENDURECER el umbral, nunca aflojarlo. Aflojar porque un
 * corpus chico lo permite es el error que este proyecto trata de no cometer;
 * endurecer de más solo te vuelve más callado, que es barato.
 */
let measuredThresholds = null;

export function setMeasuredThresholds(map) {
  measuredThresholds = map ?? null;
}

/**
 * Resolución medida del confusor de asedio, para que la advertencia diga lo que
 * el corpus muestra en vez de repetir "ambigüedad declarada" para siempre.
 */
let siegeVerdict = null;

export function setSiegeVerdict(v) {
  siegeVerdict = v ?? null;
}

/** Umbral vigente para un eje, y de dónde salió. */
export function thresholdFor(axis) {
  const m = axis ? measuredThresholds?.[axis]?.applied : null;
  if (m != null && m > RAW_NARRATABLE_MIN) {
    return { value: m, source: 'medido', measured: measuredThresholds[axis].measured };
  }
  return { value: RAW_NARRATABLE_MIN, source: 'por defecto', measured: measuredThresholds?.[axis]?.measured ?? null };
}

/** Único punto de decisión sobre si un eje es narrable. */
export const isNarratable = (rawDelta, axis = null) =>
  Math.abs(rawDelta) > thresholdFor(axis).value;

/**
 * Puntúa dos drafts. Devuelve la misma estructura que `score_draft.py --json`
 * más los campos derivados que la UI necesita.
 *
 * @param {{team:string, champions:string[]}} a
 * @param {{team:string, champions:string[]}} b
 */
export function scoreDraft(a, b) {
  const sides = [a, b].map((side) => {
    const { scores, axes, missing } = rawScores(side.champions);
    const z = {};
    for (const k of INDEX_AXES) {
      z[k] = (scores[k] - REFERENCE_STATS[k].mean) / REFERENCE_STATS[k].sd;
    }
    let primary = INDEX_AXES[0];
    for (const k of INDEX_AXES) if (z[k] > z[primary]) primary = k;
    const sources = side.champions.map((c) => ({ champion: c, source: classificationOf(c) }));
    return {
      team: side.team,
      champions: side.champions,
      raw: scores,
      axes,
      z,
      primary,
      missing,
      sources,
      extended: sources.filter((s) => s.source === 'extension').map((s) => s.champion),
      manual: sources.filter((s) => s.source === 'manual').map((s) => s.champion),
    };
  });

  const warnings = [];
  for (const s of sides) {
    if (s.missing.length) {
      warnings.push(
        `${s.team}: sin clasificar ${s.missing.join(', ')} — cuentan como cero y sesgan el ` +
          `índice hacia abajo. Tratá ese lado como incertidumbre, no como debilidad. ` +
          `Se pueden puntuar a mano desde el panel de diagnóstico.`
      );
    }
    if (s.manual.length) {
      warnings.push(
        `${s.team}: ${s.manual.join(', ')} usa${s.manual.length === 1 ? '' : 'n'} una ` +
          `clasificación manual tuya, no la tabla congelada. El índice de este lado depende de ` +
          `ese juicio.`
      );
    }
  }

  const [A, B] = sides;
  const tfDelta = A.z.teamfight - B.z.teamfight;
  const tfBand = band(tfDelta);

  // Por eje: diferencia en z y en puntos crudos, más el gate de narrabilidad.
  const perAxis = INDEX_AXES.map((k) => {
    const dz = A.z[k] - B.z[k];
    const dRaw = A.raw[k] - B.raw[k];
    const th = thresholdFor(k);
    return {
      axis: k,
      dz,
      dRaw,
      sd: REFERENCE_STATS[k].sd,
      favors: dRaw === 0 ? null : dRaw > 0 ? A.team : B.team,
      narratable: isNarratable(dRaw, k),
      threshold: th,
    };
  });

  const belowAverageRegime = A.z.teamfight < 0 && B.z.teamfight < 0;
  if (belowAverageRegime) {
    warnings.push(
      'Las dos comps están por debajo del promedio en teamfight: el mapa cae fuera del ' +
        'régimen donde el hallazgo es limpio.'
    );
  }

  // Confusor abierto del backtest: el índice podría estar midiendo "el asedio
  // está flojo en este parche" en vez de "el teamfight es mejor". Solo se
  // nombra cuando hay poke real de por medio, que es cuando la ambigüedad importa.
  const pokePresent = Math.max(A.raw.siege, B.raw.siege) >= 4;
  if (pokePresent) {
    warnings.push(
      'Hay asedio/poke apreciable en el mapa: no está descartado que el índice mida ' +
        '"el poke está flojo en este parche" en vez de "el teamfight es mejor". ' +
        (siegeVerdict
          ? siegeVerdict.resolved
            ? `Medido sobre el corpus indexado: ${siegeVerdict.verdict}`
            : `Todavía sin resolver con datos: ${siegeVerdict.verdict}`
          : 'Ambigüedad declarada, no resuelta: hace falta corpus indexado para separarla.')
    );
  }

  return {
    sides,
    warnings,
    perAxis,
    tfDelta,
    tfFavors: tfDelta > 0 ? A.team : B.team,
    tfBand,
    belowAverageRegime,
    pokePresent,
  };
}
