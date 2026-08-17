/**
 * tweet.js — compone los tweets del partido.
 *
 * Dos momentos:
 *   - Al arrancar el mapa: draft, enfrentamiento clave y probabilidad.
 *   - Al terminar: resultado, la clave del mapa y el MVP con sus números.
 *
 * LO QUE ESTE MÓDULO NO HACE, Y NO PUEDE HACER
 *
 * Publicar. Un sitio estático en GitHub Pages no puede postear en X: la API pide
 * OAuth con secretos de servidor, y cualquier cosa que se embarque en el bundle
 * la lee quien abra el código. Acá se arma el texto y se juntan las URLs de las
 * imágenes; publicar es un click tuyo o un worker con tus credenciales.
 *
 * SOBRE LA CALIFICACIÓN DEL MVP
 *
 * Es un número inventado, y en este proyecto eso se declara. Los pesos son juicio
 * propio, no están validados contra nada, y la tarjeta muestra los componentes
 * para que se puedan discutir. La diferencia con el resto del sitio es que acá el
 * número es una etiqueta editorial, no una predicción: no entra en ninguna
 * probabilidad ni se registra para calibrar.
 */

const MAX = 280;

/**
 * Hashtags de liga. Son los que usan las cuentas oficiales, pero cambian de
 * split en split y ninguna API los expone, así que esto es una tabla a mano.
 */
export const LEAGUE_TAGS = {
  LCK: ['#LCK'],
  LCKC: ['#LCKCL'],
  LPL: ['#LPL'],
  LEC: ['#LEC'],
  LCS: ['#LCS'],
  CBLOL: ['#CBLOL'],
};

/**
 * Hashtags de equipo.
 *
 * Por defecto se usa el código del equipo (#T1, #GEN). Los que están acá abajo
 * son los que las cuentas oficiales vienen usando, pero se renuevan cada split
 * y NO hay endpoint que los publique: es una lista curada a mano y conviene
 * revisarla al empezar cada temporada. Editala acá.
 */
export const TEAM_TAGS = {
  T1: '#T1Fighting',
  GEN: '#GENWIN',
  HLE: '#HLEWIN',
  DK: '#DKWIN',
  KT: '#KTRolster',
  BRO: '#BRONWIN',
  NS: '#NonghyupNS',
  DNS: '#DNSWIN',
  BFX: '#BFXWIN',
  KRX: '#KRXWIN',
  G2: '#G2WIN',
  FNC: '#FNCWIN',
  MKOI: '#KOIWIN',
  NAVI: '#NAVINation',
  TL: '#LetsGoLiquid',
  C9: '#C9WIN',
  FLY: '#FLYWIN',
  TES: '#TESWIN',
  BLG: '#BLGWIN',
  JDG: '#JDGWIN',
  WBG: '#WBGWIN',
  LNG: '#LNGWIN',
  LOUD: '#LOUDWIN',
  PAIN: '#PAINWIN',
};

export const teamTag = (code) => TEAM_TAGS[code] ?? `#${String(code ?? '').replace(/[^A-Za-z0-9]/g, '')}`;

const pct = (p) => `${Math.round(p * 100)}%`;

/* ------------------------------------------------------------------ *
 * MVP
 * ------------------------------------------------------------------ */

/**
 * Elige el MVP del lado ganador y le pone una calificación de 0 a 10.
 *
 * Componentes, todos del feed de detalle:
 *   - participación en el daño de su equipo
 *   - participación en kills
 *   - participación en el oro (recursos que le dieron)
 *   - KDA
 * Menos una penalización por muertes, que es lo que la participación sola no ve.
 *
 * Los pesos son juicio. Están acá arriba y no escondidos en una fórmula larga
 * justamente para que se puedan discutir y cambiar.
 */
export const MVP_WEIGHTS = { damage: 3.4, kills: 2.3, gold: 1.5, kda: 1.9, deathPenalty: 0.22 };

export function mvpOf(merged, sides, winnerSide) {
  if (!merged) return null;
  const side = winnerSide === 'a' ? merged.a : merged.b;
  const rival = winnerSide === 'a' ? merged.b : merged.a;
  const team = winnerSide === 'a' ? sides.a : sides.b;
  const rows = side.filter((p) => p.hasDetails);
  if (!rows.length) return null;

  const teamGold = side.reduce((s, p) => s + (p.gold ?? 0), 0) || 1;
  const scored = rows.map((p) => {
    const dmg = p.damageShare ?? 0;
    const kp = p.killParticipation ?? 0;
    const gold = (p.gold ?? 0) / teamGold;
    const kda = (p.kills + p.assists) / Math.max(1, p.deaths);

    // Normalizaciones: 30% de daño, 70% de KP, 25% del oro y KDA 6 son valores
    // altos pero no extremos en profesional. Se acotan para que un caso raro no
    // se lleve la calificación puesta.
    const n = (v, ref) => Math.min(1.5, v / ref);
    const raw =
      MVP_WEIGHTS.damage * n(dmg, 0.30) +
      MVP_WEIGHTS.kills * n(kp, 0.70) +
      MVP_WEIGHTS.gold * n(gold, 0.25) +
      MVP_WEIGHTS.kda * n(kda, 6) -
      MVP_WEIGHTS.deathPenalty * Math.max(0, p.deaths - 3);

    // Se divide por el máximo ALCANZABLE (cada componente tope 1.5), no por la
    // suma de pesos: dividiendo por la suma, una partida buena pero no
    // excepcional ya daba 10.0 y la escala se volvía inútil. Así un 10 es
    // prácticamente inalcanzable y un MVP típico cae entre 6.5 y 8.5.
    const total = (MVP_WEIGHTS.damage + MVP_WEIGHTS.kills + MVP_WEIGHTS.gold + MVP_WEIGHTS.kda) * 1.5;
    const rating = Math.max(0, Math.min(10, (raw / total) * 10));
    // Contra su rival directo: es la medida de impacto más limpia que hay, porque
    // compara con quien tuvo el mismo trabajo en el mismo mapa.
    const opp = rival.find((r) => r.role === p.role) ?? null;
    const goldVsOpp = opp?.gold != null && p.gold != null ? p.gold - opp.gold : null;

    return {
      ...p,
      team: team.team,
      teamId: team.teamId,
      shareDamage: dmg,
      shareKills: kp,
      shareGold: gold,
      kda,
      rating,
      opponent: opp ? { champion: opp.champion, name: opp.name, gold: opp.gold } : null,
      goldVsOpp,
      components: [
        { label: 'Daño del equipo', value: pct(dmg), weight: MVP_WEIGHTS.damage },
        { label: 'Participación en kills', value: pct(kp), weight: MVP_WEIGHTS.kills },
        { label: 'Oro del equipo', value: pct(gold), weight: MVP_WEIGHTS.gold },
        { label: 'KDA', value: kda.toFixed(1), weight: MVP_WEIGHTS.kda },
        { label: 'Penalización por muertes', value: `${p.deaths}`, weight: -MVP_WEIGHTS.deathPenalty },
      ],
      // Lo que va en la tarjeta: cada eje con su fracción, para que se vea EN QUÉ
      // se destacó y no solo cuánto sacó en total.
      bars: [
        { label: 'Daño del equipo', value: pct(dmg), frac: dmg / 0.45 },
        { label: 'Participación en kills', value: pct(kp), frac: kp },
        { label: 'Oro del equipo', value: pct(gold), frac: gold / 0.35 },
        { label: 'KDA', value: `${p.kills}/${p.deaths}/${p.assists}`, frac: Math.min(1, kda / 10) },
        goldVsOpp != null
          ? {
              label: `Oro sobre ${opp.champion}`,
              value: `${goldVsOpp >= 0 ? '+' : ''}${goldVsOpp.toLocaleString('es')}`,
              frac: Math.min(1, Math.abs(goldVsOpp) / 6000),
              color: goldVsOpp >= 0 ? '#3ecf8e' : '#ff6b6b',
            }
          : null,
      ].filter(Boolean),
    };
  });

  scored.sort((x, y) => y.rating - x.rating);
  return scored[0];
}

/* ------------------------------------------------------------------ *
 * perfil de una comp
 * ------------------------------------------------------------------ */

const AXIS_ES = {
  teamfight: 'Teamfight',
  pick: 'Pick',
  split: 'Split',
  siege: 'Asedio',
  scaling: 'Escalado',
};

/**
 * En qué es fuerte y en qué es floja una composición.
 *
 * Se mide contra la REFERENCIA, no contra el rival: es la pregunta "¿qué clase de
 * comp es esta?", que es distinta de "¿quién gana el matchup?". Para lo segundo
 * está el Δ del índice, que ya va en el texto.
 *
 * El umbral de 0.4 sd existe para no llamar "fuerte" a algo que está en el
 * promedio. Un eje que no se despega no dice nada y es mejor callarlo.
 */
export function compProfile(sideScore, axes, sideKey) {
  const z = sideScore?.z ?? {};
  const ranked = Object.entries(z)
    .map(([axis, v]) => ({ axis, z: v, label: AXIS_ES[axis] ?? axis }))
    .sort((a, b) => b.z - a.z);

  const strong = ranked.filter((r) => r.z >= 0.4).slice(0, 2);
  const weak = ranked.filter((r) => r.z <= -0.4).slice(-2).reverse();

  // Hechos binarios de la tabla, que se leen mejor que cualquier z-score.
  const flags = [];
  const get = (id) => axes.find((a) => a.id === id);
  const fl = get('frontline');
  const eng = get('engage');
  if (fl) {
    const mine = sideKey === 'a' ? fl.a : fl.b;
    if (mine === 0) flags.push('sin tanque');
  }
  if (eng) {
    const mine = sideKey === 'a' ? eng.a : eng.b;
    if (mine === 0) flags.push('sin inicio duro');
  }

  return {
    strong: strong.map((r) => r.label),
    weak: weak.map((r) => r.label),
    flags,
    primary: ranked[0]?.label ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * composición
 * ------------------------------------------------------------------ */

const trim = (s) => s.replace(/[ \t]+/g, ' ').trim();

/** Recorta líneas de menor a mayor prioridad hasta entrar en 280 caracteres. */
function fit(required, optional, tags) {
  const tagLine = tags.join(' ');
  let lines = [...optional];
  for (;;) {
    const text = [...required, ...lines, '', tagLine].filter((l) => l !== null).join('\n');
    if (text.length <= MAX || !lines.length) return trim(text.slice(0, MAX));
    lines.pop();
  }
}

/**
 * Tweet de arranque de mapa.
 * @param {object} ctx  { league, ev, game, blue, red, score, prob, edges, lanes }
 */
export function preMatchTweet(ctx) {
  const { league, blue, red, score, prob, edges, game } = ctx;
  const pBlue = prob?.p ?? 0.5;
  const fav = pBlue >= 0.5 ? blue : red;
  const favP = pBlue >= 0.5 ? pBlue : 1 - pBlue;

  const tags = [
    ...(LEAGUE_TAGS[league?.key] ?? []),
    teamTag(blue.team),
    teamTag(red.team),
    '#LoLEsports',
  ];

  const edge = edges?.[0];
  const keyLine = edge
    ? `Clave: ${edge.label.toLowerCase()} (${edge.side})`
    : null;
  const bandLine = Math.abs(score?.tfDelta ?? 0) >= 1
    ? `Draft: ${score.tfFavors} +${Math.abs(score.tfDelta).toFixed(2)} sd en teamfight`
    : 'Draft parejo: el índice no elige lado';

  return {
    kind: 'pre',
    text: fit(
      [
        `🔴 EN VIVO · ${blue.team} vs ${red.team}${game?.number ? ` · Mapa ${game.number}` : ''}`,
        `Probabilidad: ${fav.team} ${pct(favP)}`,
      ],
      [bandLine, keyLine],
      tags
    ),
    media: [blue.image, red.image].filter(Boolean),
  };
}

/**
 * Tweet de cierre de mapa.
 * @param {object} ctx  { league, blue, red, winner:'a'|'b', st, minute, mvp, edges }
 */
export function postMatchTweet(ctx) {
  const { league, blue, red, winner, st, minute, mvp, keyFact } = ctx;
  const win = winner === 'a' ? blue : red;
  const lose = winner === 'a' ? red : blue;

  const tags = [
    ...(LEAGUE_TAGS[league?.key] ?? []),
    teamTag(win.team),
    teamTag(lose.team),
    '#LoLEsports',
  ];

  // Kills en el orden ganador-perdedor: "6-11" sin decir de quién es cada número
  // se lee al revés cuando el que ganó tuvo menos kills, que pasa seguido.
  const kw = winner === 'a' ? st?.a.kills : st?.b.kills;
  const kl = winner === 'a' ? st?.b.kills : st?.a.kills;
  const kills = st ? `Kills ${win.team} ${kw}-${kl}` : null;
  const goldLead = st ? Math.abs(st.a.gold - st.b.gold) : 0;
  const goldTeam = st ? (st.a.gold > st.b.gold ? blue.team : red.team) : null;
  const mvpLine = mvp
    ? `MVP ${mvp.name.replace(/^\S+\s+/, '')} (${mvp.champion}) ${mvp.kills}/${mvp.deaths}/${mvp.assists} · ${pct(mvp.shareDamage)} del daño · ${mvp.rating.toFixed(1)}/10`
    : null;
  const oppLine = mvp?.goldVsOpp != null && Math.abs(mvp.goldVsOpp) >= 1500
    ? `${mvp.goldVsOpp >= 0 ? '+' : ''}${mvp.goldVsOpp.toLocaleString('es')} de oro sobre ${mvp.opponent.champion}`
    : null;

  return {
    kind: 'post',
    text: fit(
      [
        `✅ Gana ${win.team}${minute ? ` en ${Math.round(minute)} min` : ''}`,
        kills ? `${kills} · oro ${goldTeam} +${goldLead.toLocaleString('es')}` : null,
      ].filter(Boolean),
      [keyFact, mvpLine, oppLine],
      tags
    ),
    media: [mvp?.photo, win.image].filter(Boolean),
  };
}

/**
 * La clave del mapa en una línea, sacada de lo que el sitio ya midió y no de una
 * impresión. Si nada supera su umbral, devuelve null y el tweet sale sin esa
 * línea en vez de rellenarla con una frase vacía.
 */
export function keyFactOf({ roleGold, goldConc, st, minute, edges }) {
  if (goldConc?.top?.length) {
    const top = goldConc.top[0];
    if (top.diff != null && Math.abs(top.diff) >= 2000) {
      const who = top.diff > 0 ? top.a : top.b;
      if (who?.champion) {
        return `La decidió ${who.champion} en ${top.role}: ${Math.abs(top.diff).toLocaleString('es')} de oro sobre su rival`;
      }
    }
  }
  if (st && Math.abs(st.a.towers - st.b.towers) >= 4) {
    const side = st.a.towers > st.b.towers ? st.a : st.b;
    return `Control de mapa: ${side.team} cerró con ${side.towers} torres contra ${st.a.towers > st.b.towers ? st.b.towers : st.a.towers}`;
  }
  if (edges?.[0]) return `El draft lo anticipaba: ${edges[0].label.toLowerCase()} para ${edges[0].side}`;
  return null;
}

/** URL de intención de X. Abre el compositor con el texto ya puesto. */
export const intentUrl = (text) =>
  `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
