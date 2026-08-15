/**
 * live.js — Paso 9: señales de verificación en vivo (min 14-20).
 *
 * Todas son falsables y se leen del feed, no del ojo. El objetivo es poder
 * anotar el estado del minuto ~16 y del ~20 ANTES de saber el resultado: es lo
 * único que después permite calibrar.
 */

const DRAGON_LABEL = {
  infernal: 'infernal',
  ocean: 'océano',
  cloud: 'nube',
  mountain: 'montaña',
  hextech: 'hextech',
  chemtech: 'chemtech',
  elder: 'ancestral',
};

/** Minuto de juego a partir del frame inicial y el actual. */
export function gameMinute(startFrameTs, currentFrameTs) {
  if (!startFrameTs || !currentFrameTs) return null;
  const ms = new Date(currentFrameTs) - new Date(startFrameTs);
  return ms > 0 ? ms / 60000 : null;
}

/**
 * Construye el estado del mapa desde el último frame del window feed.
 * @param {object} frame  último frame de window
 * @param {object} sides  {a:{team,side,players}, b:{...}}
 */
export function readState(frame, sides, minute) {
  if (!frame) return null;
  const teamOf = (s) => (s.side === 'blue' ? frame.blueTeam : frame.redTeam);
  const ta = teamOf(sides.a);
  const tb = teamOf(sides.b);
  if (!ta || !tb) return null;

  const partsOf = (t) => t.participants ?? [];
  const byId = {};
  for (const p of [...partsOf(ta), ...partsOf(tb)]) byId[p.participantId] = p;

  const attach = (side, team) => ({
    team: side.team,
    side: side.side,
    gold: team.totalGold,
    kills: team.totalKills,
    towers: team.towers,
    inhibitors: team.inhibitors,
    barons: team.barons,
    dragons: team.dragons ?? [],
    players: side.players.map((p) => ({ ...p, live: byId[p.participantId] ?? null })),
  });

  return { minute, state: frame.gameState, a: attach(sides.a, ta), b: attach(sides.b, tb) };
}

/**
 * Señales del Paso 9. Cada una devuelve {label, value, reading} donde `reading`
 * es la interpretación con su umbral explícito, para que sea falsable.
 */
export function liveSignals(st) {
  if (!st) return [];
  const out = [];
  const { a, b, minute } = st;
  const m = minute ?? 0;

  // 1. Oro total. Diferencia < ~1k al minuto 20 es empate.
  const dg = a.gold - b.gold;
  const leader = dg === 0 ? null : dg > 0 ? a.team : b.team;
  out.push({
    id: 'gold',
    label: 'Diferencia de oro',
    value: `${Math.abs(dg).toLocaleString('es')} para ${leader ?? '—'}`,
    reading:
      Math.abs(dg) < 1000
        ? m >= 20
          ? 'Menos de 1k al minuto 20: es empate, y el empate favorece a quien tiene mejor tardío.'
          : 'Menos de 1k: empate por ahora.'
        : `Ventaja real de ${leader}.`,
    ok: Math.abs(dg) >= 1000,
  });

  // 2. Kills sin oro: pico gastado sin convertir.
  const dk = a.kills - b.kills;
  const killLeader = dk === 0 ? null : dk > 0 ? a.team : b.team;
  const mismatch = killLeader && leader && killLeader !== leader;
  out.push({
    id: 'kills-vs-gold',
    label: 'Kills contra oro',
    value: `${a.kills}-${b.kills} kills · oro para ${leader ?? 'nadie'}`,
    reading: mismatch
      ? `${killLeader} lidera en kills pero no en oro: pico gastado sin convertir.`
      : 'Kills y oro apuntan al mismo lado.',
    ok: !mismatch,
  });

  // 3. Nivel del ADC contra el ADC. Pesa más que dos kills en el tramo 15-20.
  const adc = (s) => s.players.find((p) => p.role === 'bottom');
  const aa = adc(a);
  const ab = adc(b);
  if (aa?.live && ab?.live) {
    const dl = aa.live.level - ab.live.level;
    out.push({
      id: 'adc-level',
      label: 'Nivel de ADC',
      value: `${aa.champion} nv.${aa.live.level} · ${ab.champion} nv.${ab.live.level}`,
      reading:
        dl === 0
          ? 'Parejo.'
          : `Un nivel de diferencia en el tramo 15-20 pesa más que dos kills. Favorece a ${dl > 0 ? a.team : b.team}.`,
      ok: dl !== 0,
    });
  }

  // 4. CS alto con asistencias bajas: farmeando fuera de las peleas que deciden.
  const absent = [];
  for (const side of [a, b]) {
    for (const p of side.players) {
      if (!p.live || p.role === 'support') continue;
      const kp = p.live.kills + p.live.assists;
      if (m >= 14 && p.live.creepScore >= 8 * m * 0.85 && kp <= 2) {
        absent.push(`${p.champion} (${side.team}) cs ${p.live.creepScore}, ${kp} en kills+asist.`);
      }
    }
  }
  out.push({
    id: 'cs-vs-assists',
    label: 'CS alto con participación baja',
    value: absent.length ? absent.join(' · ') : 'Nadie destacado',
    reading: absent.length
      ? 'Ese jugador está farmeando fuera de las peleas que deciden.'
      : 'Sin desconexión evidente entre farmeo y peleas.',
    ok: absent.length === 0,
  });

  // 5. Primer dragón y ritmo de alma.
  const dr = (s) => (s.dragons ?? []).map((d) => DRAGON_LABEL[d] ?? d);
  const da = dr(a);
  const db = dr(b);
  const soulLeader = da.length >= 3 || db.length >= 3 ? (da.length > db.length ? a.team : b.team) : null;
  out.push({
    id: 'dragons',
    label: 'Dragones y ritmo de alma',
    value: `${a.team} ${da.length} (${da.join(', ') || '—'}) · ${b.team} ${db.length} (${db.join(', ') || '—'})`,
    reading: soulLeader
      ? `${soulLeader} está a ${4 - Math.max(da.length, db.length)} de alma.`
      : 'Todavía sin ritmo de alma definido.',
    ok: !!soulLeader,
  });

  // 6. Torres e inhibidores: acceso al mapa.
  out.push({
    id: 'structures',
    label: 'Estructuras',
    value: `Torres ${a.towers}-${b.towers} · inhibidores ${a.inhibitors}-${b.inhibitors} · barones ${a.barons}-${b.barons}`,
    reading:
      Math.abs(a.towers - b.towers) >= 3
        ? `${a.towers > b.towers ? a.team : b.team} controla el mapa por estructuras.`
        : 'Mapa parejo en estructuras.',
    ok: Math.abs(a.towers - b.towers) >= 3,
  });

  return out;
}

/** Instantáneas del min ~16 y ~20, que son las que permiten calibrar después. */
export function snapshotLabel(minute) {
  if (minute == null) return null;
  if (minute >= 14 && minute < 18) return 'Ventana de verificación del minuto ~16';
  if (minute >= 18 && minute < 22) return 'Ventana de verificación del minuto ~20';
  return null;
}
