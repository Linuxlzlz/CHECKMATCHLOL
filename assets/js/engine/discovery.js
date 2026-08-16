/**
 * discovery.js — qué predice de verdad, medido sobre el corpus.
 *
 * El índice de arquetipos no reproduce su 74%: sobre 405 mapas da 51% [44, 58].
 * La reacción tentadora es retocar la tabla hasta que funcione, y sería el error
 * clásico: ajustar sobre los mismos datos con los que después se mide.
 *
 * Este módulo hace lo contrario. Propone features que salen de los datos, las
 * entrena SOLO con la parte vieja del corpus y las evalúa SOLO con la parte
 * nueva, cronológicamente. Todo lo que se reporta es fuera de muestra.
 *
 * Por qué el corte es por fecha y no aleatorio:
 *
 *   - Un corte aleatorio deja partidas del mismo día en train y test, y como los
 *     equipos y el meta persisten, eso filtra información del futuro.
 *   - El uso real es predecir el partido de mañana con lo de hasta hoy. El corte
 *     cronológico es el único que se parece a eso.
 *
 * Las tres preguntas que responde, que son las que el método venía contestando
 * con juicio:
 *
 *   1. ¿Qué campeones ganan de verdad, y cuánto de eso es el campeón y cuánto el
 *      equipo que lo elige?
 *   2. ¿Qué campeones escalan de verdad? (winrate en partidas largas contra cortas)
 *   3. ¿Alguna de estas señales le gana a la línea base?
 */

import { norm } from './index-score.js';
import { wilson } from './meta.js';

/** Reparto por defecto entre entrenamiento y evaluación. */
export const TEST_FRACTION = 0.3;

/* ------------------------------------------------------------------ *
 * utilidades
 * ------------------------------------------------------------------ */

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (p, lo = 0.02, hi = 0.98) => Math.max(lo, Math.min(hi, p));

/**
 * Winrate encogido hacia 50%. Con k=20, un campeón con 4 partidas y 100% queda
 * en 58% y no en 100%: es la diferencia entre una señal y una anécdota.
 */
function shrunk(wins, n, k = 20) {
  if (!n) return 0.5;
  return (wins + k * 0.5) / (n + k);
}

/** Ordena por fecha y parte en dos. El test es siempre lo más nuevo. */
export function chronoSplit(maps, testFraction = TEST_FRACTION) {
  const usable = maps
    .filter((m) => m.winner && m.blue?.length === 5 && m.red?.length === 5)
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  const cut = Math.floor(usable.length * (1 - testFraction));
  return { train: usable.slice(0, cut), test: usable.slice(cut), all: usable };
}

/* ------------------------------------------------------------------ *
 * 1. fuerza empírica por campeón
 * ------------------------------------------------------------------ */

/**
 * Winrate por campeón, y por campeón dentro de su rol.
 *
 * Con una salvedad que importa más de lo que parece: el winrate de un campeón
 * mide sobre todo QUIÉN LO ELIGE. Si un campeón lo pickea el mejor equipo de la
 * liga, va a tener 65% sin que el campeón tenga nada que ver. Por eso se calcula
 * también el winrate del campeón NETO del equipo: cuánto gana comparado con lo
 * que ese mismo equipo gana en general.
 */
export function championStrength(trainMaps) {
  const champ = new Map();
  const team = new Map();

  const touch = (map, key, won) => {
    if (!map.has(key)) map.set(key, { key, games: 0, wins: 0 });
    const r = map.get(key);
    r.games++;
    if (won) r.wins++;
  };

  for (const m of trainMaps) {
    const blueWon = m.winner === 'blue';
    touch(team, m.blueTeamId ?? 'blue', blueWon);
    touch(team, m.redTeamId ?? 'red', !blueWon);
    m.blue.forEach((c, i) => {
      touch(champ, norm(c), blueWon);
      const r = champ.get(norm(c));
      r.name = c;
      r.roles = r.roles ?? {};
      const role = m.blueRoles?.[i];
      if (role) {
        r.roles[role] = r.roles[role] ?? { games: 0, wins: 0 };
        r.roles[role].games++;
        if (blueWon) r.roles[role].wins++;
      }
      // Expectativa del equipo que lo eligió, para poder netear después.
      r.teamGames = (r.teamGames ?? []).concat(m.blueTeamId ?? 'blue');
    });
    m.red.forEach((c, i) => {
      touch(champ, norm(c), !blueWon);
      const r = champ.get(norm(c));
      r.name = c;
      r.roles = r.roles ?? {};
      const role = m.redRoles?.[i];
      if (role) {
        r.roles[role] = r.roles[role] ?? { games: 0, wins: 0 };
        r.roles[role].games++;
        if (!blueWon) r.roles[role].wins++;
      }
      r.teamGames = (r.teamGames ?? []).concat(m.redTeamId ?? 'red');
    });
  }

  const teamWr = (id) => {
    const t = team.get(id);
    return t ? shrunk(t.wins, t.games, 10) : 0.5;
  };

  const out = {};
  for (const [k, r] of champ) {
    const wr = shrunk(r.wins, r.games);
    // Lo que se esperaría del campeón solo por los equipos que lo eligieron.
    const expected = r.teamGames.length
      ? r.teamGames.reduce((a, id) => a + teamWr(id), 0) / r.teamGames.length
      : 0.5;
    const ci = r.games >= 10 ? wilson(r.wins, r.games) : null;
    out[k] = {
      key: k,
      name: r.name,
      games: r.games,
      wins: r.wins,
      wr,
      raw: r.games ? r.wins / r.games : null,
      ci,
      expected,
      // El aporte propio del campeón, ya descontado quién lo juega.
      net: wr - expected,
      roles: r.roles,
    };
  }
  return { champions: out, teams: Object.fromEntries([...team].map(([k, v]) => [k, { ...v, wr: teamWr(k) }])) };
}

/* ------------------------------------------------------------------ *
 * 2. escalado real por campeón
 * ------------------------------------------------------------------ */

/** Aproximación de la cola normal, para sacar p-valores sin dependencias. */
function normalTail(z) {
  // Zelen & Severo, error < 7.5e-8. Sobra para lo que se usa acá.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? p : 1 - p;
}

/**
 * Intervalo de Newcombe para la diferencia de dos proporciones.
 *
 * El error estándar clásico se rompe cerca de 0 y de 1: con 6 partidas ganadas de
 * 6 devuelve intervalos que se salen del rango posible (vimos un [65, 110]). Este
 * se construye sobre dos intervalos de Wilson y queda siempre dentro de [-1, 1].
 */
function newcombeDiff(w1, n1, w2, n2) {
  const p1 = w1 / n1;
  const p2 = w2 / n2;
  const a = wilson(w1, n1);
  const b = wilson(w2, n2);
  const lo = p1 - p2 - Math.sqrt((p1 - a.low) ** 2 + (b.high - p2) ** 2);
  const hi = p1 - p2 + Math.sqrt((a.high - p1) ** 2 + (p2 - b.low) ** 2);
  return { diff: p1 - p2, lo: Math.max(-1, lo), hi: Math.min(1, hi) };
}

/** z de dos proporciones con varianza agrupada, y su p-valor a dos colas. */
function twoPropP(w1, n1, w2, n2) {
  const p = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 1;
  const z = (w1 / n1 - w2 / n2) / se;
  return 2 * (1 - normalTail(Math.abs(z)));
}

/**
 * Corrección de Benjamini-Hochberg.
 *
 * Sin esto, medir 65 campeones al 95% produce ~3 "hallazgos" por puro azar, y
 * quedarse con los que cruzaron el umbral es exactamente convertir cinco
 * observaciones consistentes en una regla. BH controla la proporción esperada de
 * falsos entre los que se reportan, que es la pregunta que importa acá.
 */
function benjaminiHochberg(rows, q = 0.10) {
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  const m = sorted.length;
  let kMax = -1;
  sorted.forEach((r, i) => {
    if (r.p <= ((i + 1) / m) * q) kMax = i;
  });
  const cutoff = kMax >= 0 ? sorted[kMax].p : 0;
  for (const r of rows) r.survivesFDR = r.p <= cutoff && cutoff > 0;
  return { cutoff, survivors: rows.filter((r) => r.survivesFDR).length, m, q };
}

/**
 * Mide, para cada campeón, si su winrate cambia entre dos clases de partida.
 *
 * Es el motor de dos preguntas que la tabla congelada contesta con juicio:
 *
 *   - `scale`: ¿gana más cuando la partida se estira? (corte por duración)
 *   - teamfight: ¿gana más en las partidas de muchas peleas? (corte por kills)
 *
 * Ninguna de las dos es la definición literal del eje, y hay que decirlo: una
 * partida larga favorece al que escala pero también al que simplemente no perdió
 * temprano. Es un proxy medido, que es distinto de un juicio y distinto de una
 * medición directa.
 */
export function championSplitBy(maps, { value, label, highLabel, lowLabel, minPerSide = 8, q = 0.10 }) {
  const usable = maps.filter((m) => m.winner && value(m) != null);
  if (usable.length < 40) return { usable: false, n: usable.length, label };

  const values = usable.map(value).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];

  const rec = new Map();
  const bump = (c, high, won) => {
    const k = norm(c);
    if (!rec.has(k)) rec.set(k, { key: k, name: c, high: { g: 0, w: 0 }, low: { g: 0, w: 0 } });
    const r = rec.get(k);
    const b = high ? r.high : r.low;
    b.g++;
    if (won) b.w++;
  };

  for (const m of usable) {
    const high = value(m) >= median;
    const blueWon = m.winner === 'blue';
    for (const c of m.blue) bump(c, high, blueWon);
    for (const c of m.red) bump(c, high, !blueWon);
  }

  const rows = [];
  for (const r of rec.values()) {
    // Un mínimo por lado, no solo total: 20 partidas repartidas 18/2 no miden nada.
    if (r.high.g < minPerSide || r.low.g < minPerSide) continue;
    const ci = newcombeDiff(r.high.w, r.high.g, r.low.w, r.low.g);
    rows.push({
      key: r.key,
      name: r.name,
      total: r.high.g + r.low.g,
      high: r.high,
      low: r.low,
      highWr: r.high.w / r.high.g,
      lowWr: r.low.w / r.low.g,
      ...ci,
      p: twoPropP(r.high.w, r.high.g, r.low.w, r.low.g),
      excludesZero: ci.lo > 0 || ci.hi < 0,
    });
  }

  const fdr = benjaminiHochberg(rows, q);
  rows.sort((a, b) => b.diff - a.diff);

  return {
    usable: true,
    label,
    highLabel,
    lowLabel,
    median,
    n: usable.length,
    tested: rows.length,
    rows,
    fdr,
    // Cuántos "hallazgos" esperaría el azar solo, para poder comparar.
    expectedFalse: rows.length * 0.05,
    naive: rows.filter((r) => r.excludesZero).length,
  };
}

/** ¿Qué campeones escalan de verdad? Corte por duración. */
export const championScaling = (maps) =>
  championSplitBy(maps, {
    value: (m) => m.duration,
    label: 'Escalado',
    highLabel: 'partidas largas',
    lowLabel: 'partidas cortas',
  });

/** ¿Qué campeones ganan las partidas de muchas peleas? Corte por kills totales. */
export const championFighting = (maps) =>
  championSplitBy(maps, {
    value: (m) => m.kills,
    label: 'Peleas',
    highLabel: 'partidas de muchas kills',
    lowLabel: 'partidas de pocas kills',
  });

/* ------------------------------------------------------------------ *
 * 3. modelos candidatos, evaluados fuera de muestra
 * ------------------------------------------------------------------ */

/**
 * Cada modelo es una función que, dado un mapa, devuelve la probabilidad de que
 * gane el lado azul. Se entrenan con `train` y se evalúan con `test`.
 *
 * La línea base no es 50%: es el lado azul, que en profesional gana ~57%. Un
 * modelo que no le gana a "apostar siempre al azul" no aporta nada, y esa es una
 * vara mucho más honesta que el 50% que suele usarse.
 */
export function buildModels(train) {
  const { champions, teams } = championStrength(train);
  const blueWins = train.filter((m) => m.winner === 'blue').length;
  const sideRate = train.length ? blueWins / train.length : 0.5;

  // Rendimiento individual: winrate encogido por jugador. Es lo más cerca que se
  // puede llegar a "performance individual" sin bajar stats por partida, y tiene
  // la ventaja de que se puede usar ANTES del partido, que es cuando sirve.
  const players = new Map();
  for (const m of train) {
    const blueWon = m.winner === 'blue';
    for (const p of m.bluePlayers ?? []) {
      if (!players.has(p)) players.set(p, { games: 0, wins: 0 });
      const r = players.get(p);
      r.games++;
      if (blueWon) r.wins++;
    }
    for (const p of m.redPlayers ?? []) {
      if (!players.has(p)) players.set(p, { games: 0, wins: 0 });
      const r = players.get(p);
      r.games++;
      if (!blueWon) r.wins++;
    }
  }
  const playerWr = (id) => {
    const r = players.get(id);
    return r ? shrunk(r.wins, r.games, 10) : 0.5;
  };
  const sidePlayerWr = (ids) =>
    (ids ?? []).length ? ids.reduce((a, id) => a + playerWr(id), 0) / ids.length : 0.5;

  const champWr = (c) => champions[norm(c)]?.wr ?? 0.5;
  const champNet = (c) => champions[norm(c)]?.net ?? 0;
  const teamWr = (id) => teams[id]?.wr ?? 0.5;

  return {
    sideRate,
    champions,
    teams,
    models: [
      {
        id: 'side',
        label: 'Solo el lado',
        detail: 'Predice siempre al azul con la tasa del corpus. Es la vara a superar.',
        predict: () => sideRate,
      },
      {
        id: 'team',
        label: 'Fuerza de equipo',
        detail: 'Winrate encogido de cada equipo en el corpus de entrenamiento.',
        predict: (m) => clamp(sigmoid(logit(sideRate) + 2.2 * (teamWr(m.blueTeamId) - teamWr(m.redTeamId)))),
      },
      {
        id: 'champ',
        label: 'Winrate de campeón',
        detail: 'Suma de los winrates encogidos de los cinco campeones de cada lado.',
        predict: (m) => {
          const d = m.blue.reduce((a, c) => a + champWr(c) - 0.5, 0)
                  - m.red.reduce((a, c) => a + champWr(c) - 0.5, 0);
          return clamp(sigmoid(logit(sideRate) + 2.0 * d));
        },
      },
      {
        id: 'champ-net',
        label: 'Campeón neto de equipo',
        detail: 'Igual que el anterior pero descontando lo que gana el equipo que lo eligió.',
        predict: (m) => {
          const d = m.blue.reduce((a, c) => a + champNet(c), 0)
                  - m.red.reduce((a, c) => a + champNet(c), 0);
          return clamp(sigmoid(logit(sideRate) + 2.0 * d));
        },
      },
      {
        id: 'team+champ',
        label: 'Equipo + campeón neto',
        detail: 'Los dos juntos: la calidad del equipo más el aporte propio de los campeones.',
        predict: (m) => {
          const t = teamWr(m.blueTeamId) - teamWr(m.redTeamId);
          const c = m.blue.reduce((a, x) => a + champNet(x), 0)
                  - m.red.reduce((a, x) => a + champNet(x), 0);
          return clamp(sigmoid(logit(sideRate) + 2.2 * t + 1.2 * c));
        },
      },
      {
        id: 'player',
        label: 'Rendimiento individual',
        detail: 'Winrate encogido de los cinco jugadores de cada lado, sin mirar el equipo.',
        predict: (m) =>
          clamp(sigmoid(logit(sideRate) + 4.0 * (sidePlayerWr(m.bluePlayers) - sidePlayerWr(m.redPlayers)))),
      },
      {
        id: 'team+player',
        label: 'Equipo + individual',
        detail: 'Si el rendimiento individual aporta algo POR ENCIMA de la calidad del equipo.',
        predict: (m) => {
          const t = teamWr(m.blueTeamId) - teamWr(m.redTeamId);
          const p = sidePlayerWr(m.bluePlayers) - sidePlayerWr(m.redPlayers);
          return clamp(sigmoid(logit(sideRate) + 1.6 * t + 2.0 * p));
        },
      },
    ],
    players,
  };
}

/** Métricas fuera de muestra de un modelo. */
function score(model, test) {
  let brier = 0;
  let hits = 0;
  let n = 0;
  let logLoss = 0;
  for (const m of test) {
    const p = model.predict(m);
    if (p == null || !Number.isFinite(p)) continue;
    const y = m.winner === 'blue' ? 1 : 0;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if (p !== 0.5 && (p > 0.5) === (y === 1)) hits++;
    n++;
  }
  if (!n) return null;
  const ci = wilson(hits, n);
  return {
    id: model.id,
    label: model.label,
    detail: model.detail,
    n,
    brier: brier / n,
    logLoss: logLoss / n,
    hits,
    acc: hits / n,
    accLow: ci.low,
    accHigh: ci.high,
  };
}

/**
 * Evaluación completa. Devuelve una fila por modelo con sus métricas fuera de
 * muestra, ordenadas por Brier (menor es mejor).
 */
export function evaluate(maps, { testFraction = TEST_FRACTION } = {}) {
  const { train, test, all } = chronoSplit(maps, testFraction);
  if (train.length < 60 || test.length < 30) {
    return {
      usable: false,
      nTrain: train.length,
      nTest: test.length,
      reason:
        `Hacen falta al menos 60 mapas de entrenamiento y 30 de evaluación para que esto diga ` +
        `algo, y hay ${train.length} y ${test.length}. Indexá más ligas.`,
    };
  }

  const built = buildModels(train);
  const rows = built.models.map((mo) => score(mo, test)).filter(Boolean);
  rows.sort((a, b) => a.brier - b.brier);

  const base = rows.find((r) => r.id === 'side');
  for (const r of rows) {
    r.vsBase = base ? base.brier - r.brier : null;
    r.beatsBase = base ? r.brier < base.brier : null;
  }

  return {
    usable: true,
    nTrain: train.length,
    nTest: test.length,
    nAll: all.length,
    trainFrom: train[0]?.date ?? null,
    trainTo: train[train.length - 1]?.date ?? null,
    testFrom: test[0]?.date ?? null,
    testTo: test[test.length - 1]?.date ?? null,
    sideRate: built.sideRate,
    rows,
    champions: built.champions,
  };
}

/**
 * Lectura en palabras. La escribe el código y no el que mira la tabla, por la
 * misma razón de siempre: después de ver un número bueno la tentación de
 * describirlo mejor de lo que es resulta máxima.
 */
export function readEvaluation(ev) {
  if (!ev.usable) return { verdict: 'sin muestra', text: ev.reason };
  const best = ev.rows[0];
  const base = ev.rows.find((r) => r.id === 'side');
  if (!best || !base) return { verdict: 'sin resultado', text: 'No se pudo evaluar ningún modelo.' };

  if (best.id === 'side') {
    return {
      verdict: 'nada le gana al lado',
      text:
        `Ningún modelo mejora el Brier de predecir siempre al azul (${base.brier.toFixed(4)}) sobre ` +
        `los ${ev.nTest} mapas de evaluación. Con este corpus, todo lo que se agrega es ruido: la ` +
        `mejor predicción sigue siendo la ventaja de lado.`,
    };
  }

  const gain = base.brier - best.brier;
  const rel = (gain / base.brier) * 100;
  return {
    verdict: gain > 0.005 ? 'hay señal' : 'mejora marginal',
    text:
      `El mejor modelo fuera de muestra es "${best.label}": Brier ${best.brier.toFixed(4)} contra ` +
      `${base.brier.toFixed(4)} de la línea base, ${rel.toFixed(1)}% mejor, con ${best.acc * 100 >= 0 ? (best.acc * 100).toFixed(0) : '?'}% de acierto ` +
      `(IC95 [${(best.accLow * 100).toFixed(0)}, ${(best.accHigh * 100).toFixed(0)}]) en ${best.n} mapas que no vio al entrenarse. ` +
      (gain > 0.005
        ? `La mejora es chica en términos absolutos, como corresponde a un dominio donde el mercado ` +
          `ya tiene priceada casi toda la información. Pero es fuera de muestra y sobre la vara ` +
          `correcta, que es lo que la hace creíble.`
        : `La diferencia es tan chica que no conviene tratarla como señal: puede ser ruido del ` +
          `corte particular que tocó.`),
  };
}
