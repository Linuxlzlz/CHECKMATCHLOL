/**
 * ledger.js — registro de predicciones.
 *
 * "La calibración solo se construye con predicciones escritas antes del
 * resultado." Hasta ahora cada número que producía el sitio se evaporaba al
 * recargar, así que el sitio no podía medirse a sí mismo. Esto lo arregla.
 *
 * Reglas de integridad, para que el registro no se pueda maquillar:
 *  - La predicción se congela la PRIMERA vez que se ve el mapa. Reabrirlo no
 *    la reescribe, aunque el modelo ahora diga otra cosa.
 *  - Los snapshots del minuto 15 y 20 se guardan una sola vez.
 *  - El resultado se acepta solo después de que existe una predicción.
 */

const KEY = 'cml:ledger:v1';

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function write(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export const loadLedger = () => read();

export function getEntry(gameId) {
  return read()[gameId] ?? null;
}

/**
 * Congela la predicción previa de un mapa. Idempotente: si ya existe, no la
 * toca — ese es justamente el punto.
 */
export function recordPrediction(gameId, data) {
  const all = read();
  if (all[gameId]?.prediction) return all[gameId];
  all[gameId] = {
    gameId,
    matchId: data.matchId ?? null,
    league: data.league ?? null,
    tournament: data.tournament ?? null,
    teamA: data.teamA,
    teamB: data.teamB,
    sideA: data.sideA ?? 'blue',
    gameNumber: data.gameNumber ?? null,
    createdAt: new Date().toISOString(),
    gameStateAtRecord: data.gameState ?? null,
    prediction: {
      p: data.p,
      tfDelta: data.tfDelta ?? null,
      band: data.band ?? null,
      layers: data.layers ?? [],
      hadQuality: !!data.hadQuality,
      // Si el mapa ya estaba en curso al registrarlo, la predicción no es
      // limpiamente previa y no debería contar igual en la calibración.
      preGame: data.gameState !== 'completed' && !data.startedBefore,
    },
    // Qué eligió cada regla candidata, congelado junto con la predicción.
    reglas: data.reglas ?? null,
    market: [],
    snapshots: {},
    result: null,
    ...(all[gameId] ?? {}),
  };
  write(all);
  return all[gameId];
}

/** Guarda el estado de un checkpoint. No pisa uno ya guardado. */
export function recordSnapshot(gameId, minute, snapshot) {
  const all = read();
  const e = all[gameId];
  if (!e || e.snapshots[minute]) return false;
  e.snapshots[minute] = { at: new Date().toISOString(), ...snapshot };
  write(all);
  return true;
}

/**
 * Observación de precio de mercado, como probabilidad implícita del equipo A.
 * Se guardan todas para poder medir el movimiento entre la primera y la última.
 */
export function recordMarket(gameId, p, note) {
  const all = read();
  const e = all[gameId];
  if (!e) return false;
  e.market.push({ at: new Date().toISOString(), p, note: note ?? null });
  write(all);
  return true;
}

export function recordResult(gameId, winner, source = 'manual') {
  const all = read();
  const e = all[gameId];
  if (!e || !e.prediction) return false;
  e.result = winner; // 'A' | 'B' | null
  e.resultSource = winner ? source : null;
  e.resolvedAt = winner ? new Date().toISOString() : null;
  write(all);
  return true;
}

/**
 * Carga el resultado que el sitio pudo resolver solo (frame final verificado
 * contra el marcador de la serie).
 *
 * Solo rellena lo que está vacío: un resultado cargado a mano nunca se pisa. Sin
 * esto el registro dependía de que el usuario volviera a cada mapa a marcar
 * quién ganó, y un registro que nadie completa no calibra nada.
 */
export function autoResolve(gameId, winner) {
  if (!winner) return false;
  const all = read();
  const e = all[gameId];
  if (!e || !e.prediction || e.result) return false;
  e.result = winner;
  e.resultSource = 'auto';
  e.resolvedAt = new Date().toISOString();
  write(all);
  return true;
}

export function deleteEntry(gameId) {
  const all = read();
  delete all[gameId];
  write(all);
}

export function clearLedger() {
  try { localStorage.removeItem(KEY); } catch { /* nada */ }
}

/* ------------------------------------------------------------------ *
 * métricas
 * ------------------------------------------------------------------ */

/**
 * Brier score. Más bajo es mejor; 0.25 es lo que saca predecir 50% siempre.
 * Como referencia, el backtest del usuario dio 0.2368 propio contra 0.2353 del
 * mercado, y eso significó que el juicio propio no aportaba.
 */
export function brier(entries) {
  const scored = entries.filter((e) => e.result && e.prediction?.p != null);
  if (!scored.length) return null;
  const sum = scored.reduce((s, e) => {
    const outcome = e.result === 'A' ? 1 : 0;
    return s + (e.prediction.p - outcome) ** 2;
  }, 0);
  return { brier: sum / scored.length, n: scored.length };
}

/** Aciertos: correcto no es lo mismo que informativo, pero se reporta igual. */
export function hitRate(entries) {
  // Un 50% exacto no elige lado: contarlo como acierto o como error sería
  // inventar una predicción que el modelo no hizo.
  const scored = entries.filter((e) => e.result && e.prediction?.p != null && e.prediction.p !== 0.5);
  if (!scored.length) return null;
  const hits = scored.filter((e) => {
    const pickedA = e.prediction.p > 0.5;
    return (pickedA && e.result === 'A') || (!pickedA && e.result === 'B');
  }).length;
  return { hits, n: scored.length, rate: hits / scored.length };
}

/**
 * Comparación honesta contra el mercado.
 *
 * El Brier propio sobre TODAS las predicciones y el del mercado sobre las pocas
 * que tienen precio no son comparables: son muestras distintas. Esto los calcula
 * sobre el MISMO subconjunto — los mapas con resultado y con precio cargado — y
 * devuelve los dos números juntos, que es la única forma de leer si el análisis
 * propio aportó algo sobre el precio.
 *
 * La referencia del backtest del usuario es 0.2368 propio contra 0.2353 del
 * mercado, con λ*=0.
 */
export function pairedBrier(entries) {
  const usable = entries.filter(
    (e) => e.result && e.prediction?.p != null && (e.market?.length ?? 0) > 0
  );
  if (!usable.length) return null;
  let own = 0;
  let mkt = 0;
  for (const e of usable) {
    const outcome = e.result === 'A' ? 1 : 0;
    // La última observación es la más cercana al cierre, que es la que vale.
    const close = e.market[e.market.length - 1].p;
    own += (e.prediction.p - outcome) ** 2;
    mkt += (close - outcome) ** 2;
  }
  const n = usable.length;
  return { n, own: own / n, market: mkt / n, edge: mkt / n - own / n };
}

/**
 * Proxy de CLV. La métrica oficial es ganarle al cierre, así que lo que importa
 * no es acertar sino haber estado del lado correcto del movimiento del precio.
 *
 * Con la primera y la última observación de mercado: si el modelo veía a A más
 * alto que el precio de apertura y el precio de A subió hasta el cierre, la
 * lectura anticipó el movimiento.
 */
export function closingLineValue(entries) {
  const usable = entries.filter((e) => (e.market?.length ?? 0) >= 2 && e.prediction?.p != null);
  if (!usable.length) return null;
  let anticipated = 0;
  const rows = usable.map((e) => {
    const open = e.market[0].p;
    const close = e.market[e.market.length - 1].p;
    const move = close - open;
    const lean = e.prediction.p - open;
    const right = Math.sign(move) !== 0 && Math.sign(move) === Math.sign(lean);
    if (right) anticipated++;
    return { gameId: e.gameId, teamA: e.teamA, teamB: e.teamB, open, close, move, lean, right };
  });
  return { rows, anticipated, n: usable.length, rate: anticipated / usable.length };
}

export function summary() {
  const entries = Object.values(read());
  const preGame = entries.filter((e) => e.prediction?.preGame);
  return {
    total: entries.length,
    resolved: entries.filter((e) => e.result).length,
    autoResolved: entries.filter((e) => e.resultSource === 'auto').length,
    withSnapshots: entries.filter((e) => Object.keys(e.snapshots ?? {}).length).length,
    withMarket: entries.filter((e) => (e.market?.length ?? 0) > 0).length,
    brierAll: brier(entries),
    brierPreGame: brier(preGame),
    paired: pairedBrier(entries),
    hits: hitRate(entries),
    hitsPreGame: hitRate(preGame),
    clv: closingLineValue(entries),
    entries: entries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
  };
}

/* ------------------------------------------------------------------ *
 * exportación
 * ------------------------------------------------------------------ */

export function exportJSON() {
  return JSON.stringify(read(), null, 2);
}

export function exportCSV() {
  const rows = Object.values(read());
  const head = [
    'gameId', 'creado', 'liga', 'equipoA', 'equipoB', 'mapa', 'previa',
    'p_modelo', 'delta_indice', 'banda',
    'mercado_apertura', 'mercado_cierre',
    'oro_min15', 'oro_min20', 'resultado', 'origen_resultado',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((e) =>
    [
      e.gameId, e.createdAt, e.league, e.teamA, e.teamB, e.gameNumber,
      e.prediction?.preGame ? 'si' : 'no',
      e.prediction?.p?.toFixed(4), e.prediction?.tfDelta?.toFixed(2), e.prediction?.band,
      e.market?.[0]?.p?.toFixed(4), e.market?.[e.market.length - 1]?.p?.toFixed(4),
      e.snapshots?.['15']?.goldDiff, e.snapshots?.['20']?.goldDiff,
      e.result ?? '', e.resultSource ?? '',
    ].map(esc).join(',')
  );
  return [head.join(','), ...lines].join('\n');
}

/* ------------------------------------------------------------------ *
 * reglas candidatas — test pre-registrado
 * ------------------------------------------------------------------ */

/**
 * Reglas que compiten contra el modelo, registradas ANTES de conocer el
 * resultado y puntuadas con datos que ningún ajuste vio.
 *
 * Existe porque "ninguna señal se asciende a regla hasta que sobreviva un test
 * fuera de muestra pre-registrado", y porque medir retrospectivamente la misma
 * hipótesis en muchos cortes distintos termina encontrando lo que uno busca.
 * Acá el criterio queda fijado de antemano y solo se acumula.
 *
 * La regla del teamfight con récord parejo está acá por pedido explícito:
 * retrospectivamente da 50% [45,55] sobre 377 mapas, contra 56% de simplemente
 * elegir el lado azul. Si en vivo se comporta distinto, este registro lo va a
 * mostrar sin que haga falta discutirlo.
 */
export const REGLAS = [
  { id: 'modelo',        nombre: 'El modelo' },
  { id: 'lado-azul',     nombre: 'Siempre el lado azul' },
  { id: 'tf-siempre',    nombre: 'Siempre la mejor comp de teamfight' },
  { id: 'tf-parejo',     nombre: 'Teamfight, solo con récord parejo' },
];

/**
 * Calcula qué elige cada regla para un mapa. Devuelve 'A' | 'B' | null,
 * donde null significa que la regla no se pronuncia en este partido.
 */
export function evaluarReglas({ pModelo, tfRaw, tfFavorsA, wrA, wrB }) {
  const parejo = wrA != null && wrB != null && Math.abs(wrA - wrB) < 0.08;
  const tfElige = tfRaw != null && Math.abs(tfRaw) >= 1 ? (tfFavorsA ? 'A' : 'B') : null;
  return {
    'modelo': pModelo == null || pModelo === 0.5 ? null : (pModelo > 0.5 ? 'A' : 'B'),
    'lado-azul': 'A',
    'tf-siempre': tfElige,
    'tf-parejo': parejo ? tfElige : null,
  };
}

/** Puntúa cada regla sobre las entradas ya resueltas. */
export function scoreReglas(entries) {
  const out = [];
  for (const r of REGLAS) {
    const usables = entries.filter((e) => e.result && e.reglas && e.reglas[r.id]);
    const hits = usables.filter((e) => e.reglas[r.id] === e.result).length;
    const n = usables.length;
    let ic = null;
    if (n) {
      const z = 1.96, p = hits / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
      const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
      ic = [(c - m) / d, (c + m) / d];
    }
    out.push({ ...r, n, hits, p: n ? hits / n : null, ic });
  }
  return out;
}
