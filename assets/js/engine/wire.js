/**
 * wire.js — vigila las 6 ligas y arma los tweets solo.
 *
 * Corre pegado al poll que ya existe (cada 20 s). Por cada mapa detecta dos
 * transiciones y encola una publicación en cada una:
 *
 *   sin datos -> con draft   → tweet de arranque
 *   en curso  -> terminado   → tweet de cierre, con MVP
 *
 * La cola vive en localStorage, así que sobrevive a recargas y no se duplica: un
 * mapa que ya generó su tweet de arranque no lo vuelve a generar aunque el poll
 * pase cien veces.
 *
 * PUBLICAR NO PASA ACÁ. Esto deja el texto listo y avisa. El paso final es un
 * click tuyo, o un worker con tus credenciales — ver la nota en tweet.js.
 */

import {
  LEAGUES, getLive, getSchedule, getEventDetails, getWindow, getDetails, feedTimestamp, secure,
  getRosterIndex,
} from '../api.js';
import { scoreDraft } from './index-score.js';
import { structuralAxes, concentrationAndWindow } from './structural.js';
import { readState, gameMinute } from './live.js';
import { mergePlayers, roleGoldDiff, goldConcentration } from './checkpoints.js';
import { buildProbability } from './probability.js';
import { preMatchTweet, postMatchTweet, keyFactOf, mvpOf, compProfile } from './tweet.js';

const KEY = 'cml:wire:v1';
const MAX_QUEUE = 60;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : { posts: {}, seen: {} };
  } catch {
    return { posts: {}, seen: {} };
  }
}

function write(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* cuota llena */ }
}

export function queue() {
  const v = read();
  return Object.values(v.posts).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export function markPosted(id, posted = true) {
  const v = read();
  if (v.posts[id]) {
    v.posts[id].posted = posted;
    v.posts[id].postedAt = posted ? new Date().toISOString() : null;
    write(v);
  }
}

export function removePost(id) {
  const v = read();
  delete v.posts[id];
  write(v);
}

export function clearQueue() {
  write({ posts: {}, seen: {} });
}

function push(id, entry) {
  const v = read();
  if (v.posts[id]) return false;         // idempotente: una vez por mapa y momento
  v.posts[id] = { id, createdAt: new Date().toISOString(), posted: false, ...entry };
  const ids = Object.keys(v.posts);
  if (ids.length > MAX_QUEUE) {
    ids.sort((a, b) => (v.posts[a].createdAt ?? '').localeCompare(v.posts[b].createdAt ?? ''));
    for (const old of ids.slice(0, ids.length - MAX_QUEUE)) delete v.posts[old];
  }
  write(v);
  return true;
}

/** Mapea el evento a un lado con equipo, imagen y jugadores. */
function buildSides(ev, meta, rosterIndex) {
  const teams = ev.match?.teams ?? [];
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const mk = (metaSide, side) => {
    const t = byId[metaSide.esportsTeamId];
    const roster = rosterIndex?.[metaSide.esportsTeamId];
    return {
      side,
      teamId: metaSide.esportsTeamId,
      team: t?.code ?? '—',
      name: t?.name ?? '',
      image: secure(t?.image),
      players: (metaSide.participantMetadata ?? []).map((p) => {
        const listed = roster?.players?.find((r) => r.id === p.esportsPlayerId);
        return {
          participantId: p.participantId,
          playerId: p.esportsPlayerId,
          name: p.summonerName,
          champion: p.championId,
          role: p.role,
          photo: secure(listed?.image ?? null),
        };
      }),
    };
  };
  return { a: mk(meta.blueTeamMetadata, 'blue'), b: mk(meta.redTeamMetadata, 'red') };
}

/**
 * Resuelve un id que puede ser de SERIE o de MAPA.
 *
 * El panel del sitio muestra ids de mapa (`{gameId}:post`), así que es lo que uno
 * tiene a mano al querer probar con un partido puntual — pero getEventDetails
 * solo entiende ids de serie y con un id de mapa devuelve vacío, sin error. El
 * resultado era una corrida "exitosa" que no generaba nada y no explicaba por qué.
 *
 * La relación está documentada: gameId = matchId + N, con N el número de mapa.
 * Así que si el id directo no da partido, se prueban los cinco anteriores y se
 * acepta el que contenga ese mapa.
 *
 * Se usa BigInt porque estos ids pasan los 9·10¹⁵ y con Number la resta pierde
 * precisión.
 */
async function resolveMatch(rawId) {
  const fetchEvent = async (id) => {
    try {
      const d = await getEventDetails(id);
      return d?.data?.event?.match ? d.data.event : null;
    } catch { return null; }
  };

  const direct = await fetchEvent(rawId);
  if (direct) return { matchId: String(rawId), ev: direct, gameId: null };

  let n;
  try { n = BigInt(String(rawId)); } catch { return null; }
  for (let back = 1n; back <= 5n; back++) {
    const candidate = String(n - back);
    const ev = await fetchEvent(candidate);
    if (ev && (ev.match.games ?? []).some((g) => String(g.id) === String(rawId))) {
      return { matchId: candidate, ev, gameId: String(rawId) };
    }
  }
  return null;
}

/**
 * Una pasada del vigilante. Devuelve cuántas publicaciones nuevas encoló.
 *
 * @param {object} opts.standingsFor  (tournamentId) => standings, para la calidad de equipos
 */
export async function tick({
  leagues = LEAGUES, recordFor = null, backfillHours = 0, matchIds = [], onlyKind = null,
} = {}) {
  let added = 0;
  const wanted = new Set(leagues.map((l) => l.id));

  // Qué partidos mirar. En operación normal alcanza con los que están en vivo,
  // pero para probar hace falta poder alcanzar uno que ya terminó: cuando el
  // evento sale de getLive, el mapa deja de ser visible para siempre.
  const ids = new Set(matchIds.filter(Boolean));

  if (!matchIds.length) {
    try {
      const live = await getLive();
      for (const e of live?.data?.schedule?.events ?? []) {
        if (wanted.has(e.league?.id) && e.match?.id) ids.add(e.match.id);
      }
    } catch { /* seguimos con el backfill si lo hay */ }

    if (backfillHours > 0) {
      const since = Date.now() - backfillHours * 3600_000;
      for (const l of leagues) {
        try {
          const sched = await getSchedule(l.id);
          for (const e of sched?.data?.schedule?.events ?? []) {
            if (!e.match?.id || e.state === 'unstarted') continue;
            if (new Date(e.startTime).getTime() >= since) ids.add(e.match.id);
          }
        } catch { /* una liga que falla no frena al resto */ }
      }
    }
  }

  if (!ids.size) return 0;
  const rosterIndex = await getRosterIndex().catch(() => ({}));

  for (const rawId of ids) {
    const resolved = await resolveMatch(rawId);
    if (!resolved) continue;
    const { matchId, ev, gameId: forcedGameId } = resolved;
    // La liga sale del propio detalle: así funciona igual venga el partido del
    // feed en vivo, del backfill o de un id pasado a mano.
    const league = LEAGUES.find((l) => l.id === ev.league?.id);
    if (!league || (!matchIds.length && !wanted.has(league.id))) continue;

    for (const game of ev.match.games ?? []) {
      if (game.state === 'unstarted' || game.state === 'unneeded') continue;
      // Si se pidió por id de MAPA, solo ese mapa.
      if (forcedGameId && String(game.id) !== forcedGameId) continue;

      // --- draft disponible: tweet de arranque ---
      const preId = `${game.id}:pre`;
      const postId = `${game.id}:post`;
      const already = read().posts;
      const needPre = !already[preId] && onlyKind !== 'post';
      const needPost = game.state === 'completed' && !already[postId] && onlyKind !== 'pre';
      if (!needPre && !needPost) continue;

      let win;
      try { win = await getWindow(game.id); } catch { continue; }
      const meta = win?.gameMetadata;
      if (!meta) continue;

      const sides = buildSides(ev, meta, rosterIndex);
      const score = scoreDraft(
        { team: sides.a.team, champions: sides.a.players.map((p) => p.champion) },
        { team: sides.b.team, champions: sides.b.players.map((p) => p.champion) }
      );
      const axes = structuralAxes(sides.a, sides.b);
      const { edges } = concentrationAndWindow(sides.a, sides.b, axes);

      if (needPre) {
        const rec = recordFor ? recordFor(sides.a.teamId, sides.b.teamId) : null;
        const prob = buildProbability({
          recordA: rec?.a ?? null,
          recordB: rec?.b ?? null,
          tfDelta: score.tfDelta,
          goldDiff: null,
          minute: null,
        });
        const t = preMatchTweet({ league, ev, game, blue: sides.a, red: sides.b, score, prob, edges });
        if (push(preId, {
          gameId: game.id, matchId: ev.id ?? matchId, league: league?.key,
          teams: `${sides.a.team} vs ${sides.b.team}`, gameNumber: game.number,
          logos: [sides.a.image, sides.b.image],
          // Datos para dibujar la tarjeta fuera del navegador.
          card: {
            kind: 'pre',
            league: league?.name, gameNumber: game.number,
            blue: sides.a.team, red: sides.b.team,
            blueLogo: sides.a.image, redLogo: sides.b.image,
            pBlue: prob.p,
            draftLine: Math.abs(score.tfDelta) >= 0.5
              ? `Draft: ${score.tfFavors} +${Math.abs(score.tfDelta).toFixed(2)} sd en teamfight`
              : 'Draft parejo: el índice no elige lado',
            keyLine: edges?.[0] ? `Clave: ${edges[0].label} (${edges[0].side})` : null,
            // Perfil de cada comp, para el bloque comparativo de abajo.
            blueProfile: compProfile(score.sides[0], axes, 'a'),
            redProfile: compProfile(score.sides[1], axes, 'b'),
          },
          ...t,
        })) added++;
      }

      // --- mapa terminado: tweet de cierre con MVP ---
      if (needPost) {
        const ts = feedTimestamp(90);
        let w2 = null;
        let d2 = null;
        try {
          [w2, d2] = await Promise.all([
            getWindow(game.id, ts, 600_000),
            getDetails(game.id, ts, 600_000).catch(() => null),
          ]);
        } catch { /* sin frame final no hay tweet de cierre */ }
        const frame = w2?.frames?.slice(-1)[0] ?? null;
        if (!frame) continue;

        const startTs = win.frames?.[0]?.rfc460Timestamp ?? null;
        const minute = startTs ? gameMinute(startTs, frame.rfc460Timestamp) : null;
        const st = readState(frame, sides, minute);
        if (!st) continue;

        // El ganador sale del estado final, igual que en el índice de meta.
        const winner = st.a.gold === st.b.gold
          ? (st.a.towers > st.b.towers ? 'a' : 'b')
          : (st.a.gold > st.b.gold ? 'a' : 'b');

        const merged = mergePlayers(frame, d2?.frames?.slice(-1)[0] ?? null, sides);
        const roleGold = merged ? roleGoldDiff(merged, sides) : null;
        const mvp = mvpOf(merged, sides, winner);
        if (mvp) {
          const src = (winner === 'a' ? sides.a : sides.b).players
            .find((p) => p.participantId === mvp.participantId);
          mvp.photo = src?.photo ?? null;
        }
        const keyFact = keyFactOf({
          roleGold, goldConc: roleGold ? goldConcentration(roleGold) : null, st, minute, edges,
        });

        const t = postMatchTweet({ league, blue: sides.a, red: sides.b, winner, st, minute, mvp, keyFact });
        if (push(postId, {
          gameId: game.id, matchId: ev.id ?? matchId, league: league?.key,
          teams: `${sides.a.team} vs ${sides.b.team}`, gameNumber: game.number,
          logos: [sides.a.image, sides.b.image],
          mvp: mvp ? {
            name: mvp.name, champion: mvp.champion, photo: mvp.photo, team: mvp.team,
            kda: `${mvp.kills}/${mvp.deaths}/${mvp.assists}`,
            gold: mvp.gold, damageShare: mvp.shareDamage, killParticipation: mvp.shareKills,
            rating: mvp.rating, components: mvp.components, bars: mvp.bars,
            goldVsOpp: mvp.goldVsOpp, opponent: mvp.opponent,
          } : null,
          result: { winner: winner === 'a' ? sides.a.team : sides.b.team, minute },
          card: {
            kind: 'post',
            league: league?.name, gameNumber: game.number, minute,
            winner: (winner === 'a' ? sides.a : sides.b).team,
            winnerLogo: (winner === 'a' ? sides.a : sides.b).image,
            scoreLine: `Kills ${winner === 'a' ? st.a.kills : st.b.kills}-${winner === 'a' ? st.b.kills : st.a.kills}` +
              ` · oro ${Math.abs(st.a.gold - st.b.gold).toLocaleString('es')} para ${st.a.gold > st.b.gold ? sides.a.team : sides.b.team}`,
            keyFact,
            mvp: mvp ? {
              name: mvp.name.replace(/^\S+\s+/, ''), champion: mvp.champion,
              team: mvp.team, photo: mvp.photo, rating: mvp.rating, bars: mvp.bars,
            } : null,
          },
          ...t,
        })) added++;
      }
    }
  }
  return added;
}
