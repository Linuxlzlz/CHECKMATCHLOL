/**
 * index-score.js — port de scripts/score_draft.py.
 *
 * Paridad exacta con el script: mismas fórmulas, misma normalización de
 * nombres, misma desviación estándar POBLACIONAL (divide por N, no por N-1) y
 * el mismo fallback `sd || 1.0`. Cualquier divergencia numérica acá rompe la
 * comparación con el backtest, así que las fórmulas están congeladas.
 */

import { ARCHETYPES_CSV, REFERENCE_CSV, CHAMPION_ALIASES } from '../data/tables.js';

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

const TABLE = (() => {
  const t = {};
  for (const row of parseCSV(ARCHETYPES_CSV)) {
    const v = {};
    for (const a of AXES) v[a] = parseFloat(row[a]);
    t[norm(row.champion)] = v;
  }
  return t;
})();

const REFERENCE_COMPS = parseCSV(REFERENCE_CSV).map((r) => r.champions.split('|'));

/** ¿Está el campeón en la tabla congelada? */
export function isClassified(champion) {
  return Object.prototype.hasOwnProperty.call(TABLE, norm(champion));
}

/** Suma cruda de ejes sobre 5 campeones. Los no clasificados suman 0, como el script. */
export function rawScores(champions) {
  const v = Object.fromEntries(AXES.map((a) => [a, 0]));
  const missing = [];
  for (const c of champions) {
    const row = TABLE[norm(c)];
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

/** Media y sd poblacional de la distribución de referencia (62 comps). */
export const REFERENCE_STATS = (() => {
  const cols = Object.fromEntries(INDEX_AXES.map((k) => [k, []]));
  for (const champs of REFERENCE_COMPS) {
    const { scores } = rawScores(champs);
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

/** Único punto de decisión sobre si un eje es narrable. */
export const isNarratable = (rawDelta) => Math.abs(rawDelta) > RAW_NARRATABLE_MIN;

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
    return { team: side.team, champions: side.champions, raw: scores, axes, z, primary, missing };
  });

  const warnings = [];
  for (const s of sides) {
    if (s.missing.length) {
      warnings.push(
        `${s.team}: sin clasificar ${s.missing.join(', ')} — cuentan como cero y sesgan el ` +
          `índice hacia abajo. Tratá ese lado como incertidumbre, no como debilidad.`
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
    return {
      axis: k,
      dz,
      dRaw,
      sd: REFERENCE_STATS[k].sd,
      favors: dRaw === 0 ? null : dRaw > 0 ? A.team : B.team,
      narratable: isNarratable(dRaw),
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
        'Ambigüedad declarada, no resuelta.'
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
