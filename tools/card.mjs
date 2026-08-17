/**
 * card.mjs — la tarjeta de imagen que acompaña cada publicación.
 *
 * Misma estética que el logo y el banner: tinta azulada, oro Hextech con bisel,
 * retícula hexagonal, esquinas cortadas y el rombo del cliente. La paleta es la
 * de la página, que ya es la de League.
 *
 * Se dibuja acá y no en el navegador por una razón concreta: las fotos de
 * jugadores y los logos vienen de static.lolesports.com, que no manda cabeceras
 * CORS. En el navegador eso CONTAMINA el canvas y no se puede exportar la imagen;
 * en Node se descargan como bytes y no hay tal restricción.
 *
 * Todo lo de acá es opcional: si falla, el bot publica igual con las imágenes
 * sueltas. Una tarjeta que no sale no puede impedir que salga el análisis.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';

const W = 1200;
const H = 675;

const INK = '#080b12';
const GLOW = '#16213a';
const GOLD_LITE = '#f0e6d2';
const GOLD = '#e0b64a';
const GOLD_DARK = '#785a28';
const ACCENT = '#4da3ff';
const CREAM = '#cdc6b6';
const GREEN = '#3ecf8e';
const RED = '#ff6b6b';

/* ------------------------------------------------------------------ *
 * primitivas
 * ------------------------------------------------------------------ */

/** Texto en mayúsculas con tracking, que es como titula el cliente. */
function tracked(ctx, text, x, y, tracking = 2) {
  let cx = x;
  for (const ch of String(text)) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
  return cx;
}

function trackedWidth(ctx, text, tracking = 2) {
  let w = 0;
  for (const ch of String(text)) w += ctx.measureText(ch).width + tracking;
  return w - tracking;
}

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    const px = cx + r * Math.cos(a);
    const py = cy - r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function diamond(ctx, cx, cy, r, fill) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Fondo completo: halo, retícula hexagonal, marco cortado y rombos. */
function background(ctx) {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);

  const g = ctx.createRadialGradient(W * 0.62, H * 0.34, 40, W * 0.62, H * 0.34, W * 0.78);
  g.addColorStop(0, GLOW);
  g.addColorStop(1, INK);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(224,182,74,0.06)';
  ctx.lineWidth = 1.2;
  const r = 40;
  const dx = Math.sqrt(3) * r;
  const dy = 1.5 * r;
  for (let row = -1; row * dy < H + dy; row++) {
    for (let col = -1; col * dx < W + dx; col++) {
      hexPath(ctx, col * dx + (row % 2 ? dx / 2 : 0), row * dy, r);
      ctx.stroke();
    }
  }

  // Marco de esquinas cortadas.
  const m = 26;
  const cut = 30;
  ctx.strokeStyle = GOLD_DARK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(m + cut, m);
  ctx.lineTo(W - m - cut, m);
  ctx.lineTo(W - m, m + cut);
  ctx.lineTo(W - m, H - m - cut);
  ctx.lineTo(W - m - cut, H - m);
  ctx.lineTo(m + cut, H - m);
  ctx.lineTo(m, H - m - cut);
  ctx.lineTo(m, m + cut);
  ctx.closePath();
  ctx.stroke();

  for (const cy of [m, H - m]) {
    diamond(ctx, W / 2, cy, 15, INK);
    diamond(ctx, W / 2, cy, 11, GOLD);
    diamond(ctx, W / 2, cy, 5, INK);
  }
}

/** Título en oro con degradado y sombra grabada. */
function goldTitle(ctx, text, x, y, size, tracking = 4) {
  ctx.font = `bold ${size}px serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  tracked(ctx, text, x + 2, y + 3, tracking);
  const g = ctx.createLinearGradient(x, y - size, x, y + 6);
  g.addColorStop(0, GOLD_LITE);
  g.addColorStop(0.55, GOLD);
  g.addColorStop(1, GOLD_DARK);
  ctx.fillStyle = g;
  return tracked(ctx, text, x, y, tracking);
}

/** Regla con rombo, la separación estándar del cliente. */
function rule(ctx, x, y, w) {
  ctx.fillStyle = GOLD_DARK;
  ctx.fillRect(x, y, w, 2);
  diamond(ctx, x + 8, y + 1, 7, GOLD);
}

async function drawImageSafe(ctx, url, x, y, w, h, { circle = false } = {}) {
  if (!url) return false;
  try {
    const img = await loadImage(url);
    ctx.save();
    if (circle) {
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      ctx.clip();
      // Las fotos oficiales vienen con mucho aire arriba: se recorta al centro
      // superior para que la cara quede dentro del círculo.
      const s = Math.max(w, h) * 1.25;
      ctx.drawImage(img, x + w / 2 - s / 2, y - s * 0.1, s, s);
    } else {
      ctx.drawImage(img, x, y, w, h);
    }
    ctx.restore();
    if (circle) {
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    return true;
  } catch {
    return false;
  }
}

/** Barra horizontal con etiqueta, valor y relleno proporcional. */
function statBar(ctx, x, y, w, label, value, frac, color = GOLD) {
  ctx.font = '18px sans-serif';
  ctx.fillStyle = CREAM;
  ctx.fillText(label, x, y);
  ctx.textAlign = 'right';
  ctx.fillStyle = GOLD_LITE;
  ctx.font = 'bold 19px sans-serif';
  ctx.fillText(value, x + w, y);
  ctx.textAlign = 'left';

  const by = y + 10;
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(x, by, w, 7);
  ctx.fillStyle = color;
  ctx.fillRect(x, by, Math.max(2, w * Math.max(0, Math.min(1, frac))), 7);
}

/* ------------------------------------------------------------------ *
 * tarjetas
 * ------------------------------------------------------------------ */

/** Arranque de mapa: los dos equipos, la probabilidad y la clave. */
export async function preMatchCard(d) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  background(ctx);

  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = RED;
  const wTag = trackedWidth(ctx, 'EN VIVO', 3);
  tracked(ctx, 'EN VIVO', 60, 92, 3);
  ctx.fillStyle = CREAM;
  ctx.font = '19px sans-serif';
  ctx.fillText(`${d.league ?? ''}${d.gameNumber ? `  ·  Mapa ${d.gameNumber}` : ''}`, 60 + wTag + 26, 92);

  // Equipos con sus logos.
  await drawImageSafe(ctx, d.blueLogo, 70, 140, 120, 120);
  await drawImageSafe(ctx, d.redLogo, W - 190, 140, 120, 120);
  goldTitle(ctx, d.blue, 70, 315, 46, 3);
  ctx.font = 'bold 46px serif';
  const wRed = trackedWidth(ctx, d.red, 3);
  goldTitle(ctx, d.red, W - 70 - wRed, 315, 46, 3);

  // Probabilidad como barra enfrentada.
  const bx = 70;
  const bw = W - 140;
  const by = 370;
  const pBlue = Math.max(0.04, Math.min(0.96, d.pBlue ?? 0.5));
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(bx, by, bw, 26);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(bx, by, bw * pBlue, 26);
  ctx.fillStyle = GOLD_DARK;
  ctx.fillRect(bx + bw * pBlue - 1, by - 5, 2, 36);

  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = INK;
  ctx.fillText(`${Math.round(pBlue * 100)}%`, bx + 12, by + 19);
  ctx.fillStyle = CREAM;
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round((1 - pBlue) * 100)}%`, bx + bw - 12, by + 19);
  ctx.textAlign = 'left';

  ctx.font = '17px sans-serif';
  ctx.fillStyle = CREAM;
  ctx.fillText('PROBABILIDAD DE VICTORIA', bx, by - 16);

  rule(ctx, 70, 455, W - 140);
  ctx.font = '22px sans-serif';
  ctx.fillStyle = GOLD_LITE;
  if (d.draftLine) ctx.fillText(String(d.draftLine).slice(0, 74), 70, 505);
  ctx.fillStyle = CREAM;
  ctx.font = '21px sans-serif';
  if (d.keyLine) ctx.fillText(String(d.keyLine).slice(0, 78), 70, 545);

  ctx.font = '16px sans-serif';
  ctx.fillStyle = GOLD_DARK;
  tracked(ctx, 'CHECKMATCH LOL', 70, H - 60, 3);
  return canvas.toBuffer('image/png');
}

/**
 * Cierre de mapa: resultado y MVP con sus números.
 *
 * La calificación se muestra CON sus componentes, no sola. Un 8.4 sin desglose
 * es una opinión; con las cinco barras al lado se ve en qué se destacó y se puede
 * discutir. Es la misma regla que rige el resto del proyecto.
 */
export async function postMatchCard(d) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  background(ctx);

  // La etiqueta se mide antes de escribir lo que va al lado: con la posición
  // fija, en el runner la serif es otra y los textos se montan.
  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = GREEN;
  const wTag = trackedWidth(ctx, 'RESULTADO', 3);
  tracked(ctx, 'RESULTADO', 60, 92, 3);
  ctx.fillStyle = CREAM;
  ctx.font = '19px sans-serif';
  ctx.fillText(
    `${d.league ?? ''}${d.gameNumber ? `  ·  Mapa ${d.gameNumber}` : ''}${d.minute ? `  ·  ${Math.round(d.minute)} min` : ''}`,
    60 + wTag + 26, 92
  );

  // Ganador.
  await drawImageSafe(ctx, d.winnerLogo, 68, 128, 96, 96);
  const endX = goldTitle(ctx, `GANA ${d.winner}`, 186, 200, 52, 3);
  ctx.font = '20px sans-serif';
  ctx.fillStyle = CREAM;
  ctx.fillText(d.scoreLine ?? '', 190, 236);

  rule(ctx, 68, 268, W - 136);

  // --- MVP ---
  const mvp = d.mvp;
  let barsEnd = 0;
  if (mvp) {
    const px = 90;
    const py = 296;
    await drawImageSafe(ctx, mvp.photo, px, py, 170, 170, { circle: true });

    ctx.font = 'bold 17px sans-serif';
    ctx.fillStyle = GOLD;
    tracked(ctx, 'MVP', px + 52, py + 205, 4);

    const tx = px + 210;
    goldTitle(ctx, mvp.name, tx, py + 46, 42, 2);
    ctx.font = '23px sans-serif';
    ctx.fillStyle = CREAM;
    ctx.fillText(`${mvp.champion}  ·  ${mvp.team}`, tx, py + 82);

    // Nota grande, a la derecha.
    const rx = W - 210;
    ctx.textAlign = 'center';
    ctx.font = 'bold 92px serif';
    const gr = ctx.createLinearGradient(rx, py + 10, rx, py + 100);
    gr.addColorStop(0, GOLD_LITE);
    gr.addColorStop(1, GOLD_DARK);
    ctx.fillStyle = gr;
    ctx.fillText(mvp.rating.toFixed(1), rx, py + 92);
    ctx.font = '19px sans-serif';
    ctx.fillStyle = CREAM;
    ctx.fillText('SOBRE 10', rx, py + 122);
    ctx.font = '15px sans-serif';
    ctx.fillStyle = GOLD_DARK;
    ctx.fillText('rendimiento e impacto', rx, py + 146);
    ctx.textAlign = 'left';

    // Las cinco barras: en qué se destacó.
    const sx = tx;
    const sw = 380;
    let sy = py + 124;
    for (const s of mvp.bars ?? []) {
      statBar(ctx, sx, sy, sw, s.label, s.value, s.frac, s.color ?? GOLD);
      sy += 40;
    }
    barsEnd = sy;   // el bloque crece con la cantidad de barras
  }

  // La clave va DEBAJO de las barras, no a una altura fija: con cinco barras la
  // línea caía justo encima de la última.
  if (d.keyFact) {
    const y = Math.max(barsEnd + 24, H - 52);
    if (y < H - 26) {
      ctx.font = '19px sans-serif';
      ctx.fillStyle = CREAM;
      ctx.fillText(d.keyFact.slice(0, 84), 68, y);
    }
  }

  ctx.font = '16px sans-serif';
  ctx.fillStyle = GOLD_DARK;
  ctx.textAlign = 'right';
  tracked(ctx, 'CHECKMATCH LOL', W - 250, H - 62, 3);
  ctx.textAlign = 'left';
  return canvas.toBuffer('image/png');
}
