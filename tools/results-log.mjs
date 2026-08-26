/**
 * results-log.mjs — el histórico que la cola no puede guardar.
 *
 * POR QUÉ EXISTE
 *
 * `wire-state.json` es una cola de ENTREGA, no un registro: tiene
 * `MAX_QUEUE = 60` y descarta lo más viejo. El 26/08 se quiso medir el
 * acumulado y los datos del 22 ya no estaban — hubo que recuperarlos de una
 * medición anterior que por suerte se había anotado.
 *
 * Eso rompe lo único que hace útil a todo esto: para distinguir un modelo de
 * 64% de uno de 50% hacen falta 30-40 series, y con la cola recortándose cada
 * dos días esa muestra nunca se junta. Un registro que se borra solo no calibra
 * nada.
 *
 * Este archivo es APPEND-ONLY: una línea por mapa resuelto, nunca se recorta.
 * Guarda lo que hace falta para puntuar después sin volver a pedirle nada a la
 * API: qué dijo el modelo, con qué componentes, qué decía cada regla candidata
 * y quién ganó.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, 'results-log.json');

export function load() {
  try {
    const v = JSON.parse(fs.readFileSync(LOG, 'utf8'));
    return Array.isArray(v.mapas) ? v : { version: 1, mapas: [] };
  } catch {
    return { version: 1, mapas: [] };
  }
}

function save(log) {
  log.mapas.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  fs.writeFileSync(LOG, JSON.stringify(log, null, 0) + '\n');
}

const wr = (r) => (r && r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : null);

/**
 * Vuelca a disco los mapas de la cola que ya tienen resultado y todavía no
 * estaban registrados. Idempotente: se puede llamar en cada sondeo.
 *
 * @param {object[]} posts  cola completa (`wire.queue()`)
 * @returns {{added:number, total:number}}
 */
export function registrar(posts) {
  const log = load();
  const yaEsta = new Set(log.mapas.map((m) => m.gameId));

  const por = {};
  for (const p of posts) (por[p.gameId] ??= {})[p.kind] = p;

  let added = 0;
  for (const [gameId, x] of Object.entries(por)) {
    if (yaEsta.has(gameId)) continue;
    const pre = x.pre;
    const ganador = x.post?.result?.winner ?? null;
    if (!pre?.card || !ganador) continue;

    const c = pre.card;
    const tf = (c.compare ?? []).find((a) => a.axis === 'teamfight') ?? null;
    const tfTeam = tf?.favors === 'blue' ? c.blue : tf?.favors === 'red' ? c.red : null;
    const pick = c.pBlue > 0.5 ? c.blue : c.pBlue < 0.5 ? c.red : null;

    log.mapas.push({
      gameId,
      t: pre.createdAt,
      liga: pre.league ?? null,
      serie: pre.matchId ?? null,
      mapa: pre.gameNumber ?? null,
      azul: c.blue,
      rojo: c.red,
      pBlue: c.pBlue,
      pick,
      ganador,
      acerto: pick ? pick === ganador : null,
      // Insumos, para poder re-medir sin volver a pedirle nada a la API.
      tfRaw: tf?.dRaw ?? null,
      tfTeam,
      tfNarrable: tf?.narratable ?? null,
      wrAzul: wr(c.form?.blue),
      wrRojo: wr(c.form?.red),
      // Qué habría dicho cada regla candidata, congelado.
      reglas: {
        modelo: pick,
        ladoAzul: c.blue,
        teamfight: tf && Math.abs(tf.dRaw ?? 0) >= 1 ? tfTeam : null,
        teamfightParejo:
          tf && Math.abs(tf.dRaw ?? 0) >= 1 &&
          wr(c.form?.blue) != null && wr(c.form?.red) != null &&
          Math.abs(wr(c.form.blue) - wr(c.form.red)) < 0.15
            ? tfTeam
            : null,
      },
    });
    yaEsta.add(gameId);
    added++;
  }

  if (added) save(log);
  return { added, total: log.mapas.length };
}

/** Wilson al 95%, para no reportar un porcentaje sin su intervalo. */
export function wilson(w, n) {
  if (!n) return null;
  const z = 1.96;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, n, low: (c - m) / d, high: (c + m) / d };
}

/** Resumen del acumulado: el modelo contra las reglas candidatas. */
export function resumen(log = load()) {
  const con = log.mapas.filter((m) => m.ganador);
  const pct = (x) => (x ? `${(x.p * 100).toFixed(0)}% [${(x.low * 100).toFixed(0)},${(x.high * 100).toFixed(0)}] n=${x.n}` : '—');
  const regla = (k) => {
    const rs = con.filter((m) => m.reglas?.[k]);
    return pct(wilson(rs.filter((m) => m.reglas[k] === m.ganador).length, rs.length));
  };
  const brier = con.length
    ? con.reduce((a, m) => a + (m.pBlue - (m.ganador === m.azul ? 1 : 0)) ** 2, 0) / con.length
    : null;
  return {
    mapas: con.length,
    series: new Set(con.map((m) => m.serie)).size,
    desde: con[0]?.t ?? null,
    hasta: con.at(-1)?.t ?? null,
    modelo: regla('modelo'),
    ladoAzul: regla('ladoAzul'),
    teamfight: regla('teamfight'),
    teamfightParejo: regla('teamfightParejo'),
    brier: brier != null ? +brier.toFixed(4) : null,
  };
}
