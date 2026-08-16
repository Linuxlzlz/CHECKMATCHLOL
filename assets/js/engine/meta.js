/**
 * meta.js — Pasos 4 y 5: capa de campeón y capa de jugador.
 *
 * gol.gg no se puede consultar desde el navegador (no manda cabeceras CORS), así
 * que en vez de scrapearlo estas dos capas se reconstruyen desde la fuente
 * primaria: el feed oficial. Se recorren los partidos terminados del torneo, se
 * lee el draft de cada mapa y se acumulan picks, winrate, rol y parche.
 *
 * El ganador de cada mapa NO viene en la API. Sale de outcome.js: estado final
 * del mapa verificado contra el marcador de la serie. Los mapas cuya serie no
 * verifica se cuentan como pick pero no reciben resultado, y el sitio dice
 * cuántos son en vez de presentar el winrate como si fuera del torneo completo.
 */

import { getSchedule, getEventDetails, getFinalWindow, getWindow, pool } from '../api.js';
import { norm } from './index-score.js';
import { finalStateOf, resolveSeries } from './outcome.js';

const CACHE_PREFIX = 'cml:meta:';
const CACHE_KEY = (tid) => `${CACHE_PREFIX}${tid}`;
const CACHE_TTL = 6 * 3600 * 1000;
const INDEX_VERSION = 2;

/** Intervalo de Wilson al 95%. Se usa para el filtro "el IC no cruza el 50%". */
export function wilson(wins, n) {
  if (!n) return null;
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: (centre - margin) / d, high: (centre + margin) / d, p };
}

const shortPatch = (v) => (v ? String(v).split('.').slice(0, 2).join('.') : null);

/* ------------------------------------------------------------------ *
 * construcción del índice
 * ------------------------------------------------------------------ */

/**
 * Recorre el torneo vigente y arma el índice.
 *
 * @param {string} leagueId
 * @param {object} tournament
 * @param {{onProgress?:Function, maxMatches?:number, signal?:AbortSignal,
 *          withDuration?:boolean, force?:boolean}} opts
 */
export async function buildTournamentIndex(leagueId, tournament, opts = {}) {
  const {
    onProgress = () => {},
    maxMatches = 200,
    signal,
    withDuration = true,
    force = false,
    league = null,
  } = opts;
  const tid = tournament?.id ?? leagueId;

  if (!force) {
    const cached = readCache(tid);
    if (cached) return cached;
  }

  // 1. Eventos terminados del torneo, paginando hacia atrás.
  onProgress({ phase: 'schedule', done: 0, total: 0, label: 'Buscando partidos del torneo…' });
  const events = [];
  const seen = new Set();
  let token = null;
  const startDate = tournament?.startDate ?? '0000-00-00';
  for (let page = 0; page < 12; page++) {
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
    const data = await getSchedule(leagueId, token);
    const evs = data?.data?.schedule?.events ?? [];
    if (!evs.length) break;
    for (const e of evs) {
      if (e.state === 'completed' && e.startTime?.slice(0, 10) >= startDate && e.match?.id && !seen.has(e.match.id)) {
        seen.add(e.match.id);
        events.push(e);
      }
    }
    const oldest = evs[0]?.startTime?.slice(0, 10) ?? '';
    token = data?.data?.schedule?.pages?.older;
    onProgress({ phase: 'schedule', done: events.length, total: 0, label: `Buscando partidos del torneo… (${events.length})` });
    if (!token || oldest < startDate) break;
  }

  const matches = events.slice(-maxMatches);
  if (!matches.length) {
    return emptyIndex(tid, tournament, leagueId, league, 'No se encontraron partidos terminados en este torneo.');
  }

  // 2. Detalles de cada serie: mapas, lados y marcador.
  onProgress({ phase: 'matches', done: 0, total: matches.length, label: 'Leyendo series…' });
  let done = 0;
  const { results: details, failures: matchFailures } = await pool(matches, 6, async (e) => {
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
    const d = await getEventDetails(e.match.id);
    onProgress({ phase: 'matches', done: ++done, total: matches.length, label: 'Leyendo series…' });
    return d?.data?.event ?? null;
  });

  // 3. Aplanar mapas completados. El lado viene del propio evento, así que no
  //    hace falta el feed para saber quién jugó de azul.
  const series = [];
  const games = [];
  for (const ev of details) {
    if (!ev?.match) continue;
    const teams = (ev.match.teams ?? []).map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      wins: t.result?.gameWins ?? 0,
    }));
    const gs = (ev.match.games ?? [])
      .filter((g) => g.state === 'completed')
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .map((g) => ({
        gameId: g.id,
        number: g.number,
        blueTeamId: g.teams?.find((t) => t.side === 'blue')?.id ?? null,
        redTeamId: g.teams?.find((t) => t.side === 'red')?.id ?? null,
        final: null,
      }));
    if (!gs.length) continue;
    series.push({ matchId: ev.match.id, teams, games: gs, startTime: ev.startTime });
    games.push(...gs);
  }

  // 4. Un pedido por mapa al frame final: trae draft, parche Y estado final.
  onProgress({ phase: 'games', done: 0, total: games.length, label: 'Leyendo drafts y estado final…' });
  let gdone = 0;
  const { results: drafts, failures: gameFailures } = await pool(games, 8, async (g) => {
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
    const w = await getFinalWindow(g.gameId);
    onProgress({ phase: 'games', done: ++gdone, total: games.length, label: 'Leyendo drafts y estado final…' });
    if (!w?.gameMetadata) return null;
    g.final = finalStateOf(w);
    const mk = (meta) =>
      (meta?.participantMetadata ?? []).map((p) => ({
        champion: p.championId,
        playerId: p.esportsPlayerId,
        name: p.summonerName,
        role: p.role,
        teamId: meta.esportsTeamId,
      }));
    return {
      gameId: g.gameId,
      patch: shortPatch(w.gameMetadata.patchVersion),
      blueTeamId: w.gameMetadata.blueTeamMetadata?.esportsTeamId ?? g.blueTeamId,
      redTeamId: w.gameMetadata.redTeamMetadata?.esportsTeamId ?? g.redTeamId,
      endTs: g.final?.endTs ?? null,
      players: [...mk(w.gameMetadata.blueTeamMetadata), ...mk(w.gameMetadata.redTeamMetadata)],
    };
  });

  const draftById = {};
  for (const d of drafts) if (d?.gameId) draftById[d.gameId] = d;

  // El lado real lo dice el feed; el del evento se usa solo de respaldo.
  for (const g of games) {
    const d = draftById[g.gameId];
    if (d) {
      g.blueTeamId = d.blueTeamId ?? g.blueTeamId;
      g.redTeamId = d.redTeamId ?? g.redTeamId;
    }
  }

  // 5. Duración: hace falta el frame inicial, que es una llamada más por mapa.
  const durations = {};
  if (withDuration) {
    const withEnd = games.filter((g) => draftById[g.gameId]?.endTs);
    onProgress({ phase: 'duration', done: 0, total: withEnd.length, label: 'Midiendo duración de los mapas…' });
    let ddone = 0;
    await pool(withEnd, 8, async (g) => {
      if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
      const w = await getWindow(g.gameId, undefined, 6 * 3600_000);
      onProgress({ phase: 'duration', done: ++ddone, total: withEnd.length, label: 'Midiendo duración de los mapas…' });
      const start = w?.frames?.[0]?.rfc460Timestamp;
      if (!start) return null;
      const mins = (new Date(draftById[g.gameId].endTs) - new Date(start)) / 60000;
      if (mins > 5 && mins < 120) durations[g.gameId] = mins;
      return mins;
    });
  }

  // 6. Resolver ganadores serie por serie.
  let seriesVerified = 0;
  const winnerOf = {};
  const methodOf = {};
  for (const s of series) {
    const playable = s.games.filter((g) => g.final);
    const res = resolveSeries(s.teams, playable.length === s.games.length ? s.games : playable);
    if (res.verified) seriesVerified++;
    for (const [gid, v] of Object.entries(res.byGame)) {
      winnerOf[gid] = v.winnerTeamId;
      methodOf[gid] = v.method;
    }
  }

  // 7. Acumular.
  const champions = new Map();
  const players = new Map();
  const teams = new Map();
  const patches = {};
  const methods = {};
  let gamesCounted = 0;
  let gamesAttributable = 0;

  const bump = (obj, key, won) => {
    obj[key] = obj[key] ?? { picks: 0, wins: 0, attributed: 0 };
    obj[key].picks++;
    if (won !== null) {
      obj[key].attributed++;
      if (won) obj[key].wins++;
    }
  };

  for (const g of games) {
    const d = draftById[g.gameId];
    if (!d?.players?.length) continue;
    gamesCounted++;
    const winner = winnerOf[g.gameId] ?? null;
    if (winner) gamesAttributable++;
    if (methodOf[g.gameId]) methods[methodOf[g.gameId]] = (methods[methodOf[g.gameId]] ?? 0) + 1;
    if (d.patch) patches[d.patch] = (patches[d.patch] ?? 0) + 1;

    for (const teamId of [g.blueTeamId, g.redTeamId]) {
      if (!teamId) continue;
      if (!teams.has(teamId)) {
        teams.set(teamId, { id: teamId, games: 0, wins: 0, attributed: 0, blue: { games: 0, wins: 0 }, red: { games: 0, wins: 0 } });
      }
      const t = teams.get(teamId);
      const side = teamId === g.blueTeamId ? t.blue : t.red;
      t.games++;
      side.games++;
      if (winner) {
        t.attributed++;
        if (winner === teamId) { t.wins++; side.wins++; }
      }
    }

    for (const p of d.players) {
      const won = winner ? p.teamId === winner : null;
      const ck = norm(p.champion);

      if (!champions.has(ck)) {
        champions.set(ck, {
          key: ck, name: p.champion, picks: 0, wins: 0, attributed: 0,
          byRole: {}, byPatch: {}, teams: {},
        });
      }
      const c = champions.get(ck);
      c.picks++;
      if (won !== null) { c.attributed++; if (won) c.wins++; }
      bump(c.byRole, p.role, won);
      if (d.patch) bump(c.byPatch, d.patch, won);
      if (p.teamId) c.teams[p.teamId] = (c.teams[p.teamId] ?? 0) + 1;

      const pk = p.playerId ?? p.name;
      if (!players.has(pk)) {
        players.set(pk, { id: pk, name: p.name, teamId: p.teamId, roles: {}, games: 0, wins: 0, attributed: 0, byChampion: {} });
      }
      const pl = players.get(pk);
      pl.name = p.name;
      pl.teamId = p.teamId ?? pl.teamId;
      pl.roles[p.role] = (pl.roles[p.role] ?? 0) + 1;
      pl.games++;
      if (won !== null) { pl.attributed++; if (won) pl.wins++; }
      if (!pl.byChampion[ck]) pl.byChampion[ck] = { key: ck, name: p.champion, games: 0, wins: 0, attributed: 0 };
      const pc = pl.byChampion[ck];
      pc.games++;
      if (won !== null) { pc.attributed++; if (won) pc.wins++; }
    }
  }

  // Los mapas que no se pudieron leer se cuentan y se muestran. Un torneo con
  // 7 mapas caídos no puede reportarse como si tuviera 7 mapas menos y ya.
  const emptyDrafts = games.length - gamesCounted - gameFailures.length;

  const durList = Object.values(durations).sort((a, b) => a - b);
  const index = {
    version: INDEX_VERSION,
    tournamentId: tid,
    tournamentSlug: tournament?.slug ?? null,
    leagueId,
    leagueName: league?.name ?? null,
    builtAt: Date.now(),
    gamesCounted,
    gamesAttributable,
    gamesTotal: games.length,
    matchesRead: matches.length,
    seriesTotal: series.length,
    seriesVerified,
    methods,
    patches,
    duration: durList.length
      ? {
          n: durList.length,
          mean: durList.reduce((a, b) => a + b, 0) / durList.length,
          median: durList[Math.floor(durList.length / 2)],
          p25: durList[Math.floor(durList.length * 0.25)],
          p75: durList[Math.floor(durList.length * 0.75)],
        }
      : null,
    failures: {
      matches: matchFailures.length,
      games: gameFailures.length,
      emptyDrafts: Math.max(0, emptyDrafts),
      any: matchFailures.length + gameFailures.length + Math.max(0, emptyDrafts) > 0,
    },
    champions: Object.fromEntries(champions),
    players: Object.fromEntries(players),
    teams: Object.fromEntries(teams),
  };

  writeCache(tid, index);
  return index;
}

function emptyIndex(tid, tournament, leagueId, league, reason) {
  return {
    version: INDEX_VERSION,
    tournamentId: tid,
    tournamentSlug: tournament?.slug ?? null,
    leagueId,
    leagueName: league?.name ?? null,
    builtAt: Date.now(),
    gamesCounted: 0,
    gamesAttributable: 0,
    gamesTotal: 0,
    matchesRead: 0,
    seriesTotal: 0,
    seriesVerified: 0,
    methods: {},
    patches: {},
    duration: null,
    failures: { matches: 0, games: 0, emptyDrafts: 0, any: false },
    champions: {},
    players: {},
    teams: {},
    reason,
  };
}

/* ------------------------------------------------------------------ *
 * agregado entre torneos
 * ------------------------------------------------------------------ */

/** Índices ya construidos que quedaron guardados en el navegador. */
export function cachedIndices() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(CACHE_PREFIX)) continue;
      const v = JSON.parse(localStorage.getItem(k));
      if (v?.version === INDEX_VERSION) out.push(v);
    }
  } catch { /* nada que hacer */ }
  return out.sort((a, b) => (b.builtAt ?? 0) - (a.builtAt ?? 0));
}

/**
 * Une varios índices en uno solo. Sirve de respaldo cuando el torneo vigente no
 * tiene n suficiente: un campeón con 6 picks en LCK puede tener 20 sumando las
 * ligas ya indexadas.
 *
 * El agregado NO reemplaza al del torneo: el skill pide winrate del campeón en
 * ESE torneo. Se muestra aparte y etiquetado, porque mezclar ligas mezcla metas.
 */
export function aggregateIndices(indices) {
  if (!indices.length) return null;
  const champions = {};
  const players = {};
  let gamesCounted = 0;
  let gamesAttributable = 0;

  for (const idx of indices) {
    gamesCounted += idx.gamesCounted ?? 0;
    gamesAttributable += idx.gamesAttributable ?? 0;
    for (const [k, c] of Object.entries(idx.champions ?? {})) {
      if (!champions[k]) champions[k] = { key: k, name: c.name, picks: 0, wins: 0, attributed: 0, byRole: {} };
      const t = champions[k];
      t.picks += c.picks;
      t.wins += c.wins;
      t.attributed += c.attributed;
      for (const [r, v] of Object.entries(c.byRole ?? {})) {
        t.byRole[r] = t.byRole[r] ?? { picks: 0, wins: 0, attributed: 0 };
        t.byRole[r].picks += v.picks;
        t.byRole[r].wins += v.wins;
        t.byRole[r].attributed += v.attributed;
      }
    }
    for (const [k, p] of Object.entries(idx.players ?? {})) {
      if (!players[k]) players[k] = { id: k, name: p.name, games: 0, wins: 0, attributed: 0, byChampion: {} };
      const t = players[k];
      t.games += p.games;
      t.wins += p.wins;
      t.attributed += p.attributed;
      for (const [ck, v] of Object.entries(p.byChampion ?? {})) {
        t.byChampion[ck] = t.byChampion[ck] ?? { key: ck, name: v.name, games: 0, wins: 0, attributed: 0 };
        t.byChampion[ck].games += v.games;
        t.byChampion[ck].wins += v.wins;
        t.byChampion[ck].attributed += v.attributed;
      }
    }
  }

  return {
    aggregate: true,
    sources: indices.map((i) => ({
      slug: i.tournamentSlug, league: i.leagueName, games: i.gamesCounted, builtAt: i.builtAt,
    })),
    gamesCounted,
    gamesAttributable,
    champions,
    players,
  };
}

/**
 * Compara los cinco que juegan contra el roster listado del equipo.
 *
 * Un suplente y un pick raro se ven igual en la capa de jugador ("0 partidas")
 * y son cosas muy distintas para leer un mapa. Esto los separa.
 *
 * Salvedad: getTeams devuelve el roster VIGENTE, no el del día del partido, así
 * que en partidos viejos puede marcar como suplente a quien entonces era titular.
 */
export function rosterCheck(rosterIndex, side) {
  const team = rosterIndex?.[side.teamId] ?? null;
  if (!team || !team.players?.length) {
    return { known: false, rows: side.players.map((p) => ({ ...p, starter: null })) };
  }
  const byId = new Set(team.players.map((p) => p.id));
  const byName = new Set(team.players.map((p) => (p.name ?? '').toLowerCase()));
  const rows = side.players.map((p) => {
    // El feed antepone el tag del equipo: "TLAW Morgan" -> "morgan".
    const bare = (p.name ?? '').replace(/^\S+\s+/, '').toLowerCase();
    const starter = byId.has(p.playerId) || byName.has(bare) || byName.has((p.name ?? '').toLowerCase());
    const listed = team.players.find((r) => r.id === p.playerId);
    return {
      ...p,
      starter,
      // Un titular jugando fuera de su rol también es información.
      offRole: !!listed && listed.role !== p.role ? listed.role : null,
    };
  });
  return { known: true, rows, subs: rows.filter((r) => !r.starter) };
}

function readCache(tid) {
  try {
    const raw = localStorage.getItem(CACHE_KEY(tid));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v.version !== INDEX_VERSION) return null;
    if (Date.now() - v.builtAt > CACHE_TTL) return null;
    return v;
  } catch {
    return null;
  }
}

function writeCache(tid, index) {
  try {
    localStorage.setItem(CACHE_KEY(tid), JSON.stringify(index));
  } catch {
    // Cuota llena: el índice sigue sirviendo en memoria esta sesión.
  }
}

export function clearIndexCache(tid) {
  try {
    localStorage.removeItem(CACHE_KEY(tid));
  } catch { /* nada que hacer */ }
}

/* ------------------------------------------------------------------ *
 * Filtros del skill
 * ------------------------------------------------------------------ */

export const MIN_PICKS = 10;

const pk = (n) => `${n} ${n === 1 ? 'pick' : 'picks'}`;
const pct = (v) => `${(v * 100).toFixed(0)}%`;

/** Winrate con su IC de Wilson, o null si no llega al mínimo de muestra. */
function rate(wins, attributed, min = MIN_PICKS) {
  if (attributed < min) return null;
  const ci = wilson(wins, attributed);
  return { ...ci, straddles: ci.low <= 0.5 && ci.high >= 0.5, n: attributed };
}

/**
 * Paso 4 — capa de campeón. Solo entra con 10+ picks; con menos es ruido.
 * Un campeón con cero picks es SIN DATOS, no "pick sorpresa".
 *
 * @param index      índice del torneo
 * @param champions  los cinco campeones del lado
 * @param opts.role  rol por campeón, para el desglose por posición
 * @param opts.patch parche corto del mapa ("16.16")
 * @param opts.global índice agregado de otros torneos, como respaldo
 */
export function championLayer(index, champions, opts = {}) {
  const { roles = {}, patch = null, global = null } = opts;

  return champions.map((champion) => {
    const key = norm(champion);
    const c = index.champions[key];
    const role = roles[champion] ?? null;
    const g = global?.champions?.[key] ?? null;
    const fallback = g && g.picks >= MIN_PICKS
      ? { picks: g.picks, wr: rate(g.wins, g.attributed), sources: global.sources?.length ?? 0 }
      : null;

    if (!c || c.picks === 0) {
      return {
        champion, role, picks: 0, admits: false, status: 'sin-datos', fallback,
        reason: 'Cero picks en el torneo. Es sin datos, no "pick sorpresa": ni vos ni el equipo pueden estimarlo.',
      };
    }

    const presence = index.gamesCounted ? c.picks / index.gamesCounted : null;
    const roleRow = role ? c.byRole?.[role] ?? null : null;
    const patchRow = patch ? c.byPatch?.[patch] ?? null : null;

    if (c.picks < MIN_PICKS) {
      return {
        champion, role, picks: c.picks, presence, admits: false, status: 'excluido', fallback,
        reason: `${pk(c.picks)}, por debajo de ${MIN_PICKS}. Con menos es ruido y no entra.`,
      };
    }

    const wr = rate(c.wins, c.attributed);
    const roleWr = roleRow ? rate(roleRow.wins, roleRow.attributed) : null;
    const patchWr = patchRow ? rate(patchRow.wins, patchRow.attributed) : null;

    return {
      champion, role, picks: c.picks, presence, attributed: c.attributed, wins: c.wins,
      wr: wr && !wr.straddles ? wr.p : null,
      ci: wr,
      straddles: wr?.straddles ?? null,
      roleRow, roleWr, patchRow, patchWr, patch,
      admits: true,
      status: 'admitido',
      fallback,
      reason: wr
        ? `${pk(c.picks)} · winrate ${pct(wr.p)} sobre ${c.attributed} mapas con resultado, ` +
          `IC95 [${pct(wr.low)}, ${pct(wr.high)}]` +
          (wr.straddles ? ' — el IC cruza el 50%, así que no distingue al campeón de una moneda.' : '')
        : `${pk(c.picks)} · winrate no reportable: solo ${c.attributed} mapas con resultado atribuible.`,
    };
  });
}

/**
 * Paso 5 — capa de jugador. El filtro existe porque cada una de estas señales
 * ya falló al menos una vez.
 */
export function playerLayer(index, players, opts = {}) {
  const { global = null } = opts;

  return players.map((p) => {
    const rec = index.players[p.playerId] ?? index.players[p.name] ?? null;
    const g = global?.players?.[p.playerId] ?? global?.players?.[p.name] ?? null;
    const gc = g?.byChampion?.[norm(p.champion)] ?? null;
    const fallback = gc && gc.games >= MIN_PICKS
      ? { games: gc.games, wr: rate(gc.wins, gc.attributed) }
      : null;

    if (!rec) {
      return {
        ...p, seasonGames: 0, champGames: 0, admits: false, status: 'sin-datos', fallback,
        reason: 'Sin partidas registradas en el índice de este torneo. Puede ser un debut, un ' +
          'suplente o un jugador que llegó del split anterior: el índice no los distingue.',
      };
    }

    const pc = rec.byChampion[norm(p.champion)] ?? null;
    const champGames = pc?.games ?? 0;
    const ci = pc ? rate(pc.wins, pc.attributed) : null;
    const wrAdmits = !!ci && !ci.straddles;
    // Mismo umbral que todo lo demás: no hay razón para ser más laxo acá.
    const overall = rate(rec.wins, rec.attributed);

    return {
      ...p,
      seasonGames: rec.games,
      champGames,
      attributed: pc?.attributed ?? 0,
      ci,
      overall,
      admits: wrAdmits,
      status: wrAdmits ? 'admitido' : champGames > 0 ? 'observacion' : 'sin-partidas',
      fallback,
      reason: wrAdmits
        ? `${champGames} partidas · winrate ${pct(ci.p)}, IC95 [${pct(ci.low)}, ${pct(ci.high)}] — no cruza el 50%.`
        : ci
          ? `${champGames} partidas · IC95 [${pct(ci.low)}, ${pct(ci.high)}] cruza el 50%: no predice nada.`
          : champGames === 0
            ? rec.games >= 20
              ? `0 partidas con ${p.champion} en ${rec.games} del torneo. Con 20+ de muestra, la ausencia es observable.`
              : `0 partidas con ${p.champion}, pero solo ${rec.games} en total: su cero no informa.`
            : `${champGames} ${champGames === 1 ? 'partida' : 'partidas'}. Conteo = observación, no regla: acertó 5 veces seguidas y después falló en las dos direcciones el mismo día.`,
    };
  });
}

/**
 * Riesgo apilado: campeón sin picks + jugador sin partidas. No es señal
 * negativa, es varianza no estimable, y hay que decirlo así.
 */
export function stackedRisk(champLayer, playerLayerRows) {
  const out = [];
  for (const pl of playerLayerRows) {
    const cl = champLayer.find((c) => norm(c.champion) === norm(pl.champion));
    if (cl && cl.picks === 0 && pl.champGames === 0) {
      out.push(
        `${pl.name} con ${pl.champion}: campeón sin picks en el torneo y jugador sin partidas con él. ` +
          `Eso no es una señal negativa, es varianza no estimable.`
      );
    }
  }
  return out;
}
