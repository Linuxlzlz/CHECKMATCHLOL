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
import { buildProbability, draftWeightConditional } from './probability.js';
import {
  preMatchTweet, postMatchTweet, keyFactOf, mvpOf, axisCompare, keyMatchup, winConditions,
  MVP_CRITERIA,
} from './tweet.js';
import { EVIDENCE } from '../data/evidence.js';

const AXIS_ES_SHORT = {
  teamfight: 'teamfight', pick: 'pick', split: 'split', siege: 'asedio', scaling: 'escalado',
};

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

/**
 * Encola una publicación.
 *
 * Idempotente por diseño: una vez por mapa y momento, para que el poll no
 * duplique nada. El costo de eso es que un cambio de formato NO llega a lo ya
 * encolado — la entrada queda congelada con el diseño del día que se creó. Por
 * eso existe `regenerate`, que la reescribe conservando si ya se publicó.
 */
function push(id, entry, regenerate = false) {
  const v = read();
  if (v.posts[id] && !regenerate) return false;
  if (v.posts[id] && regenerate) {
    const antes = v.posts[id];
    v.posts[id] = { ...antes, ...entry, id, posted: antes.posted, postedAt: antes.postedAt };
    write(v);
    return true;
  }
  v.posts[id] = { id, createdAt: new Date().toISOString(), posted: false, ...entry };
  const ids = Object.keys(v.posts);
  if (ids.length > MAX_QUEUE) {
    ids.sort((a, b) => (v.posts[a].createdAt ?? '').localeCompare(v.posts[b].createdAt ?? ''));
    for (const old of ids.slice(0, ids.length - MAX_QUEUE)) delete v.posts[old];
  }
  write(v);
  return true;
}

/**
 * Estado de forma de un equipo en el split: récord y últimos resultados.
 *
 * Sale del propio calendario, no de los standings: así se obtienen las dos cosas
 * de una, el acumulado y la RACHA, que es lo que uno mira de verdad. Un 9-3 que
 * viene de perder tres seguidas no es el mismo equipo que un 9-3 en alza.
 *
 * Importa además por una razón que no es estética: el bot venía construyendo la
 * probabilidad SIN el componente de calidad de equipos —el que más pesa— porque
 * nunca le pasaba los récords. Esto lo alimenta.
 *
 * CUIDADO CON LA CLAVE. Los dos endpoints describen al mismo equipo con campos
 * distintos, y no se solapan donde uno esperaría:
 *
 *   getSchedule       name, code, image, result, record   ← trae récord, NO trae id
 *   getEventDetails   id, name, code, image, result       ← trae id, NO trae récord
 *
 * Esto estuvo cruzando por `id` contra el calendario, que no lo tiene en ninguno
 * de sus 136 equipos, así que el mapa quedaba vacío y devolvía null siempre: el
 * componente de calidad de equipos nunca llegó a entrar en el bot ni una vez.
 * Se cruza por `code`, que es el único campo que los dos lados comparten.
 */
const formCache = new Map();
async function teamForm(leagueId, teamCodes, matchId = null) {
  const key = `${leagueId}`;
  if (!formCache.has(key)) {
    const porEquipo = new Map();
    const oficial = new Map();
    try {
      const sched = await getSchedule(leagueId);
      const evs = (sched?.data?.schedule?.events ?? [])
        .filter((e) => e.match?.teams?.length === 2)
        .sort((a, b) => String(a.startTime ?? '').localeCompare(String(b.startTime ?? '')));
      for (const e of evs) {
        const [t1, t2] = e.match.teams;
        // El récord que publica la liga para ESTE partido: es el que corresponde
        // al bloque en curso, no al año entero, y es el que ve cualquiera que
        // mire la tabla. Se guarda por partido para poder usar el del momento.
        if (e.match?.id) {
          oficial.set(String(e.match.id), Object.fromEntries(
            [t1, t2].filter((t) => t?.code && t.record).map((t) => [t.code, { ...t.record }])
          ));
        }
        if (e.state !== 'completed') continue;
        const w1 = t1.result?.gameWins ?? 0;
        const w2 = t2.result?.gameWins ?? 0;
        if (w1 === w2) continue;              // sin ganador claro no suma
        for (const [t, gano] of [[t1, w1 > w2], [t2, w2 > w1]]) {
          if (!t?.code) continue;
          if (!porEquipo.has(t.code)) porEquipo.set(t.code, { wins: 0, losses: 0, last: [] });
          const r = porEquipo.get(t.code);
          if (gano) r.wins++; else r.losses++;
          r.last.push(gano ? 'V' : 'D');
        }
      }
    } catch { /* sin calendario no hay forma, y el resto sigue */ }
    formCache.set(key, { porEquipo, oficial });
  }
  const { porEquipo, oficial } = formCache.get(key);
  const delPartido = matchId ? oficial.get(String(matchId)) : null;
  return teamCodes.map((code) => {
    const r = porEquipo.get(code);
    const of = delPartido?.[code];
    if (!r && !of) return null;
    // Récord: el oficial de la liga si está; si no, el contado del calendario.
    // La racha siempre sale del calendario, que es lo único que la tiene.
    return {
      wins: of?.wins ?? r.wins,
      losses: of?.losses ?? r.losses,
      last: (r?.last ?? []).slice(-5),
    };
  });
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
/** Winrate de un récord {wins,losses}; null si no hay historia. */
const wr = (r) => (r && r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : null);

export async function tick({
  leagues = LEAGUES, recordFor = null, eloFor = null, sideRate = null, backfillHours = 0, matchIds = [], onlyKind = null,
  regenerate = false,
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
      const needPre = (!already[preId] || regenerate) && onlyKind !== 'post';
      const needPost = game.state === 'completed' && (!already[postId] || regenerate) && onlyKind !== 'pre';
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
      const { edges, window: ventana } = concentrationAndWindow(sides.a, sides.b, axes);

      if (needPre) {
        // La forma del split alimenta el componente de calidad de equipos, que es
        // el que más pesa y que el bot venía dejando vacío.
        const [formA, formB] = await teamForm(
          league.id, [sides.a.team, sides.b.team], ev.match?.id ?? ev.id ?? null
        );
        const rec = recordFor ? recordFor(sides.a.teamId, sides.b.teamId) : null;
        // Fuerza de equipo medida contra quién jugó cada uno. Cuando está, el
        // récord no entra: buildProbability los trata como alternativas, no
        // como suma, porque miden lo mismo.
        const elo = eloFor ? eloFor(sides.a.teamId, sides.b.teamId) : null;
        const prob = buildProbability({
          recordA: rec?.a ?? formA ?? null,
          recordB: rec?.b ?? formB ?? null,
          tfDelta: score.tfDelta,
          goldDiff: null,
          minute: null,
          elo,
          // Tasa de lado medida en el corpus propio. Sin esto el bot caía al valor
          // congelado de EVIDENCE, igual que le pasaba al Elo.
          sideRate,
          // El draft entra con peso solo si los récords están parejos y la
          // ventaja de teamfight es narrable. Fuera de esa condición manda la
          // medición general, que da cero.
          draftWeight: draftWeightConditional({
            tfRaw: score.perAxis.find((a) => a.axis === 'teamfight')?.dRaw ?? null,
            wrA: wr(rec?.a ?? formA ?? null),
            wrB: wr(rec?.b ?? formB ?? null),
          }),
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
            // Quién es favorito, dicho sin que haya que interpretar la barra.
            //
            // Por debajo de 53% no se declara favorito: la tarjeta llegó a
            // imprimir "FAVORITO KRX 50%", que es una contradicción impresa en
            // pantalla. Si el modelo no separa, lo honesto es decir eso y no
            // coronar a alguien por el redondeo.
            favorite: Math.max(prob.p, 1 - prob.p) >= 0.53
              ? {
                team: prob.p >= 0.5 ? sides.a.team : sides.b.team,
                side: prob.p >= 0.5 ? 'blue' : 'red',
                p: Math.max(prob.p, 1 - prob.p),
              }
              : null,
            // Cuando ningún componente aportó, la tarjeta tiene que decirlo en
            // vez de publicar un 50-50 mudo que se lee como análisis.
            sinInsumos: prob.components.every((c) => !c.contrib) ? {
              motivo: prob.hasQuality
                ? 'Los ejes medidos no separan a estos dos equipos.'
                : 'Sin récord disponible para este torneo.',
            } : null,
            // Estado de forma: récord del split y racha reciente.
            form: { blue: formA, red: formB },
            // Cara a cara por eje: teamfight, pick, split, asedio, escalado.
            compare: axisCompare(score),
            // Qué tiene que pasar para que gane cada uno.
            plans: winConditions(axisCompare(score), axes, sides.a.team, sides.b.team),
            // Quién tiene que apurar y hasta cuándo.
            window: ventana?.declared
              ? { early: ventana.earlySide, late: ventana.lateSide, from: ventana.from, to: ventana.to }
              : null,
            keyMatchup: keyMatchup(edges, sides.a, sides.b),
            // Cuánto vale cada eje, medido. Va a la tarjeta para que ninguna
            // afirmación salga sin su respaldo al lado.
            evidence: {
              nota: `Acierto medido de estos ejes sobre ${EVIDENCE.mapas} mapas: ` +
                Object.entries(EVIDENCE.ejes)
                  .map(([k, v]) => `${AXIS_ES_SHORT[k] ?? k} ${Math.round(v.p * 100)}%`)
                  .join(' · '),
              lado: 'Ninguno separa por encima del azar. El lado tampoco: medido en primeros mapas ' +
                `da ${(EVIDENCE.ladoAzul.p * 100).toFixed(0)}%.`,
              escalado: `Escalado acierta ${Math.round(EVIDENCE.escalado.largas * 100)}% en partidas largas ` +
                `y ${Math.round(EVIDENCE.escalado.cortas * 100)}% en cortas: leelo como lectura, no como pronóstico.`,
            },
          },
          ...t,
        }, regenerate)) added++;
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
              criteria: MVP_CRITERIA,
            } : null,
          },
          ...t,
        }, regenerate)) added++;
      }
    }
  }
  return added;
}
