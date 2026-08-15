/**
 * patchdiff.js — qué campeones del draft cambiaron entre dos parches.
 *
 * El sitio no mantiene un changelog a mano, así que en vez de afirmar nada
 * sobre balance compara los datos de Data Dragon entre la versión del parche
 * vigente y la anterior, para los diez campeones del mapa.
 *
 * COBERTURA PARCIAL, Y HAY QUE DECIRLO. Data Dragon expone stats base,
 * crecimiento por nivel y los valores numéricos de las habilidades. No expone
 * cambios de comportamiento, de interacción ni de hitbox, y a veces un ajuste
 * de balance no toca ninguno de estos campos. Entonces:
 *   - "cambió" es un hecho verificable.
 *   - "no cambió" significa "no cambió NADA DE LO QUE DATA DRAGON MUESTRA",
 *     que no es lo mismo que "no lo tocaron".
 */

import { listDDragonVersions, championDetail, ddragonKey, pool } from '../api.js';

const STAT_LABEL = {
  hp: 'vida base', hpperlevel: 'vida por nivel', mp: 'maná base', mpperlevel: 'maná por nivel',
  movespeed: 'velocidad', armor: 'armadura', armorperlevel: 'armadura por nivel',
  spellblock: 'resistencia mágica', spellblockperlevel: 'RM por nivel',
  attackrange: 'rango', hpregen: 'regeneración de vida', hpregenperlevel: 'regen. por nivel',
  mpregen: 'regeneración de maná', mpregenperlevel: 'regen. maná por nivel',
  crit: 'crítico', critperlevel: 'crítico por nivel',
  attackdamage: 'daño de ataque', attackdamageperlevel: 'daño por nivel',
  attackspeedperlevel: 'velocidad de ataque por nivel', attackspeed: 'velocidad de ataque',
};

const SLOT = ['Q', 'W', 'E', 'R'];

/**
 * Resuelve las dos versiones de Data Dragon a comparar a partir del parche del
 * feed ("16.16.805.442" -> mayor.menor "16.16").
 */
export async function resolveVersions(patchVersion) {
  const versions = await listDDragonVersions();
  if (!Array.isArray(versions) || !versions.length) return null;
  const mm = String(patchVersion ?? '').split('.').slice(0, 2).join('.');
  const current = versions.find((v) => v.startsWith(mm + '.')) ?? versions[0];
  const idx = versions.indexOf(current);
  const previous = versions[idx + 1] ?? null;
  if (!previous) return null;
  return { current, previous, matchedFeedPatch: current.startsWith(mm + '.') };
}

function numeric(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function diffStats(a, b) {
  const out = [];
  for (const k of Object.keys(a ?? {})) {
    const x = numeric(a[k]);
    const y = numeric(b?.[k]);
    if (x === null || y === null) continue;
    if (Math.abs(x - y) > 1e-9) {
      out.push({ kind: 'stat', field: STAT_LABEL[k] ?? k, from: y, to: x, delta: x - y });
    }
  }
  return out;
}

function diffSpells(a, b) {
  const out = [];
  const sa = a?.spells ?? [];
  const sb = b?.spells ?? [];
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const slot = SLOT[i] ?? `H${i}`;
    const A = sa[i];
    const B = sb[i];
    if (A?.cooldownBurn && B?.cooldownBurn && A.cooldownBurn !== B.cooldownBurn) {
      out.push({ kind: 'spell', field: `${slot} · enfriamiento`, from: B.cooldownBurn, to: A.cooldownBurn });
    }
    if (A?.costBurn && B?.costBurn && A.costBurn !== B.costBurn) {
      out.push({ kind: 'spell', field: `${slot} · costo`, from: B.costBurn, to: A.costBurn });
    }
    if (A?.rangeBurn && B?.rangeBurn && A.rangeBurn !== B.rangeBurn) {
      out.push({ kind: 'spell', field: `${slot} · rango`, from: B.rangeBurn, to: A.rangeBurn });
    }
    const ea = A?.effectBurn ?? [];
    const eb = B?.effectBurn ?? [];
    for (let j = 1; j < Math.max(ea.length, eb.length); j++) {
      if (ea[j] && eb[j] && ea[j] !== eb[j]) {
        out.push({ kind: 'spell', field: `${slot} · valores (${j})`, from: eb[j], to: ea[j] });
      }
    }
  }
  return out;
}

/**
 * Compara los campeones dados entre dos versiones.
 * @returns {{versions, rows, failures, unresolved}}
 */
export async function diffChampions(championIds, patchVersion, onProgress) {
  const versions = await resolveVersions(patchVersion);
  if (!versions) {
    return { versions: null, rows: [], failures: 0, unresolved: championIds.slice() };
  }

  const unresolved = [];
  const targets = [];
  for (const id of championIds) {
    const key = ddragonKey(id);
    if (!key) unresolved.push(id);
    else targets.push({ id, key });
  }

  let done = 0;
  const { results, failures } = await pool(targets, 4, async (t) => {
    const [cur, prev] = await Promise.all([
      championDetail(versions.current, t.key),
      championDetail(versions.previous, t.key),
    ]);
    onProgress?.(++done, targets.length);
    const A = cur?.data?.[t.key];
    const B = prev?.data?.[t.key];
    if (!A || !B) return { ...t, missing: true, changes: [] };
    return {
      ...t,
      missing: false,
      changes: [...diffStats(A.stats, B.stats), ...diffSpells(A, B)],
    };
  });

  return {
    versions,
    rows: results.filter(Boolean),
    failures: failures.length,
    unresolved,
  };
}
