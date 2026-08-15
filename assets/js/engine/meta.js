/**
 * meta.js — Pasos 4 y 5: capa de campeón y capa de jugador.
 *
 * gol.gg no se puede consultar desde el navegador (no manda cabeceras CORS), así
 * que en vez de scrapearlo estas dos capas se reconstruyen desde la fuente
 * primaria: el feed oficial. Se recorren los partidos terminados del torneo, se
 * lee el draft de cada mapa y se acumulan picks por campeón y por jugador.
 *
 * LIMITACIÓN QUE NO SE PUEDE TAPAR: la API expone el marcador de la SERIE, no el
 * ganador de cada mapa. Entonces:
 *   - Los PICKS se cuentan siempre (dato limpio).
 *   - El WINRATE solo se puede atribuir en series barridas (2-0, 3-0, 1-0),
 *     donde todos los mapas fueron del mismo equipo.
 * Ese subconjunto está sesgado hacia series decisivas y el sitio lo dice en vez
 * de presentar el winrate como si fuera del torneo completo.
 */

import { getSchedule, getEventDetails, getWindow, pool } from '../api.js';
import { norm } from './index-score.js';

const CACHE_KEY = (tid) => `cml:meta:${tid}`;
const CACHE_TTL = 6 * 3600 * 1000;

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

/**
 * Recorre el torneo vigente y arma el índice.
 * @param {string} leagueId
 * @param {{onProgress?:Function, maxMatches?:number, signal?:AbortSignal}} opts
 */
export async function buildTournamentIndex(leagueId, tournament, opts = {}) {
  const { onProgress = () => {}, maxMatches = 120, signal } = opts;
  const tid = tournament?.id ?? leagueId;

  const cached = readCache(tid);
  if (cached) return cached;

  // 1. Juntar eventos terminados del torneo, paginando hacia atrás.
  onProgress({ phase: 'schedule', done: 0, total: 0, label: 'Buscando partidos del torneo…' });
  const events = [];
  let token = null;
  const startDate = tournament?.startDate ?? '0000-00-00';
  for (let page = 0; page < 8; page++) {
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
    const data = await getSchedule(leagueId, token);
    const evs = data?.data?.schedule?.events ?? [];
    if (!evs.length) break;
    for (const e of evs) {
      if (e.state === 'completed' && e.startTime?.slice(0, 10) >= startDate && e.match?.id) {
        events.push(e);
      }
    }
    const oldest = evs[0]?.startTime?.slice(0, 10) ?? '';
    token = data?.data?.schedule?.pages?.older;
    if (!token || oldest < startDate) break;
  }

  const matches = events.slice(-maxMatches);
  if (!matches.length) {
    return emptyIndex(tid, tournament, 'No se encontraron partidos terminados en este torneo.');
  }

  // 2. Detalles de cada partido: mapas y marcador de serie.
  onProgress({ phase: 'matches', done: 0, total: matches.length, label: 'Leyendo series…' });
  let done = 0;
  const { results: details, failures: matchFailures } = await pool(matches, 6, async (e) => {
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
    const d = await getEventDetails(e.match.id);
    onProgress({ phase: 'matches', done: ++done, total: matches.length, label: 'Leyendo series…' });
    return d?.data?.event ?? null;
  });

  // 3. Aplanar mapas y marcar cuáles tienen ganador atribuible.
  const games = [];
  for (const ev of details) {
    if (!ev?.match) continue;
    const teams = ev.match.teams ?? [];
    const wins = teams.map((t) => t.result?.gameWins ?? 0);
    const loserSwept = wins.length === 2 && Math.min(...wins) === 0 && Math.max(...wins) > 0;
    const winnerTeamId = loserSwept
      ? teams[wins[0] > wins[1] ? 0 : 1]?.id ?? null
      : null;
    for (const g of ev.match.games ?? []) {
      if (g.state !== 'completed') continue;
      games.push({ gameId: g.id, winnerTeamId, attributable: !!winnerTeamId });
    }
  }

  // 4. Draft de cada mapa desde el feed.
  onProgress({ phase: 'games', done: 0, total: games.length, label: 'Leyendo drafts…' });
  let gdone = 0;
  const { results: drafts, failures: gameFailures } = await pool(games, 8, async (g) => {
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
    const w = await getWindow(g.gameId);
    onProgress({ phase: 'games', done: ++gdone, total: games.length, label: 'Leyendo drafts…' });
    if (!w?.gameMetadata) return null;
    const mk = (meta) =>
      (meta?.participantMetadata ?? []).map((p) => ({
        champion: p.championId,
        playerId: p.esportsPlayerId,
        name: p.summonerName,
        role: p.role,
        teamId: meta.esportsTeamId,
      }));
    return {
      ...g,
      patch: w.gameMetadata.patchVersion,
      players: [...mk(w.gameMetadata.blueTeamMetadata), ...mk(w.gameMetadata.redTeamMetadata)],
    };
  });

  // 5. Acumular.
  const champions = new Map();
  const players = new Map();
  let gamesCounted = 0;
  let gamesAttributable = 0;

  for (const d of drafts) {
    if (!d?.players?.length) continue;
    gamesCounted++;
    if (d.attributable) gamesAttributable++;
    for (const p of d.players) {
      const won = d.attributable ? p.teamId === d.winnerTeamId : null;
      const ck = norm(p.champion);
      if (!champions.has(ck)) {
        champions.set(ck, { key: ck, name: p.champion, picks: 0, wins: 0, attributed: 0 });
      }
      const c = champions.get(ck);
      c.picks++;
      if (won !== null) {
        c.attributed++;
        if (won) c.wins++;
      }

      const pk = p.playerId ?? p.name;
      if (!players.has(pk)) {
        players.set(pk, { id: pk, name: p.name, games: 0, byChampion: new Map() });
      }
      const pl = players.get(pk);
      pl.name = p.name;
      pl.games++;
      if (!pl.byChampion.has(ck)) {
        pl.byChampion.set(ck, { key: ck, name: p.champion, games: 0, wins: 0, attributed: 0 });
      }
      const pc = pl.byChampion.get(ck);
      pc.games++;
      if (won !== null) {
        pc.attributed++;
        if (won) pc.wins++;
      }
    }
  }

  // Los mapas que no se pudieron leer se cuentan y se muestran. Un torneo con
  // 7 mapas caídos no puede reportarse como si tuviera 7 mapas menos y ya.
  const emptyDrafts = drafts.filter((d) => !d?.players?.length).length;

  const index = {
    tournamentId: tid,
    tournamentSlug: tournament?.slug ?? null,
    builtAt: Date.now(),
    gamesCounted,
    gamesAttributable,
    gamesTotal: games.length,
    matchesRead: matches.length,
    failures: {
      matches: matchFailures.length,
      games: gameFailures.length,
      emptyDrafts,
      any: matchFailures.length + gameFailures.length + emptyDrafts > 0,
    },
    champions: Object.fromEntries(champions),
    players: Object.fromEntries(
      [...players.entries()].map(([k, v]) => [
        k,
        { ...v, byChampion: Object.fromEntries(v.byChampion) },
      ])
    ),
  };

  writeCache(tid, index);
  return index;
}

function emptyIndex(tid, tournament, reason) {
  return {
    tournamentId: tid,
    tournamentSlug: tournament?.slug ?? null,
    builtAt: Date.now(),
    gamesCounted: 0,
    gamesAttributable: 0,
    gamesTotal: 0,
    matchesRead: 0,
    failures: { matches: 0, games: 0, emptyDrafts: 0, any: false },
    champions: {},
    players: {},
    reason,
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

/**
 * Paso 4 — capa de campeón. Solo entra con 10+ picks; con menos es ruido.
 * Un campeón con cero picks es SIN DATOS, no "pick sorpresa".
 */
export function championLayer(index, champions) {
  return champions.map((champion) => {
    const c = index.champions[norm(champion)];
    if (!c || c.picks === 0) {
      return {
        champion,
        picks: 0,
        admits: false,
        status: 'sin-datos',
        reason: 'Cero picks en el torneo. Es sin datos, no "pick sorpresa": ni vos ni el equipo pueden estimarlo.',
      };
    }
    const pk = (n) => `${n} ${n === 1 ? 'pick' : 'picks'}`;
    if (c.picks < MIN_PICKS) {
      return {
        champion,
        picks: c.picks,
        admits: false,
        status: 'excluido',
        reason: `${pk(c.picks)}, por debajo de ${MIN_PICKS}. Con menos es ruido y no entra.`,
      };
    }
    const ci = c.attributed >= MIN_PICKS ? wilson(c.wins, c.attributed) : null;
    // Un IC que cruza el 50% no distingue al campeón de una moneda.
    const straddles = ci ? ci.low <= 0.5 && ci.high >= 0.5 : null;
    return {
      champion,
      picks: c.picks,
      attributed: c.attributed,
      wins: c.wins,
      wr: ci && !straddles ? ci.p : null,
      ci,
      straddles,
      admits: true,
      status: 'admitido',
      reason: ci
        ? `${pk(c.picks)} · winrate ${(ci.p * 100).toFixed(0)}% sobre ${c.attributed} mapas con ` +
          `resultado atribuible, IC95 [${(ci.low * 100).toFixed(0)}, ${(ci.high * 100).toFixed(0)}]` +
          (straddles ? ' — el IC cruza el 50%, así que no distingue al campeón de una moneda.' : '')
        : `${pk(c.picks)} · winrate no reportable: solo ${c.attributed} mapas con resultado atribuible.`,
    };
  });
}

/**
 * Paso 5 — capa de jugador. El filtro existe porque cada una de estas señales
 * ya falló al menos una vez.
 */
export function playerLayer(index, players) {
  return players.map((p) => {
    const rec = index.players[p.playerId] ?? index.players[p.name] ?? null;
    if (!rec) {
      return {
        ...p,
        seasonGames: 0,
        champGames: 0,
        admits: false,
        status: 'sin-datos',
        reason: 'Sin partidas registradas en el índice de este torneo.',
      };
    }
    const pc = rec.byChampion[norm(p.champion)] ?? null;
    const champGames = pc?.games ?? 0;
    const ci = pc && pc.attributed >= MIN_PICKS ? wilson(pc.wins, pc.attributed) : null;

    // Winrate solo si n>=10 y el IC no cruza el 50%.
    const wrAdmits = !!ci && (ci.low > 0.5 || ci.high < 0.5);

    return {
      ...p,
      seasonGames: rec.games,
      champGames,
      attributed: pc?.attributed ?? 0,
      ci,
      admits: wrAdmits,
      status: wrAdmits ? 'admitido' : champGames > 0 ? 'observacion' : 'sin-partidas',
      reason: wrAdmits
        ? `${champGames} partidas · winrate ${(ci.p * 100).toFixed(0)}%, IC95 [${(ci.low * 100).toFixed(0)}, ${(ci.high * 100).toFixed(0)}] — no cruza el 50%.`
        : ci
          ? `${champGames} partidas · IC95 [${(ci.low * 100).toFixed(0)}, ${(ci.high * 100).toFixed(0)}] cruza el 50%: no predice nada.`
          : champGames === 0
            ? rec.games >= 20
              ? `0 partidas con ${p.champion} en ${rec.games} del torneo. Con 20+ partidas de muestra, la ausencia es observable.`
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
