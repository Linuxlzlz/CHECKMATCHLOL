/**
 * evidence.js — cuánto acierta cada cosa que el sitio afirma.
 *
 * Medido sobre el corpus indexado el 17/08/2026: 424 mapas de LCK, LCK CL, LPL,
 * LEC, LCS y CBLOL, 414 con ganador resuelto. Cada número es la tasa de acierto
 * de "gana el lado que este eje favorece", con su IC95 de Wilson.
 *
 * Existe por una razón simple: el sitio afirma cosas como "LYON escala mejor" y
 * hasta ahora las afirmaba con el mismo tono tuviera respaldo o no. Con esto,
 * cada afirmación puede llevar al lado cuánto vale.
 *
 * NO se toca a mano para que un eje "mejore". Se regenera desde la tarjeta de
 * validación del sitio cuando el corpus crece, y se copia acá con su fecha.
 */

export const EVIDENCE = {
  medidoEl: '2026-08-17',
  mapas: 414,
  ligas: ['LCK', 'LCK CL', 'LPL', 'LEC', 'LCS', 'CBLOL'],

  /**
   * La ventaja de lado azul. Estuvo mal medida y acá está la corrección.
   *
   * El 57% global sobre los 414 mapas era real como número y falso como causa.
   * Al partirlo por número de mapa aparece de dónde sale:
   *
   *   mapa 1   89/175 = 51% [44, 58]   ~
   *   mapa 2  112/170 = 66% [58, 73]   ***
   *   mapa 3   35/69  = 51% [39, 62]   ~
   *
   * Todo el efecto vive en el mapa 2, y el mapa 2 es justo donde el lado NO se
   * sortea: el azul es el ganador del mapa 1 en 149/170 = 88% de las series.
   * O sea que "gana el azul" en el mapa 2 es casi la misma frase que "gana el
   * que viene de ganar", y ese suele ser el equipo mejor. No es el lado: es
   * fuerza de equipo entrando por la puerta de atrás.
   *
   * La única medición limpia es la del mapa 1, donde el lado sí viene dado de
   * antes: 51%, con el intervalo cruzando el 50%. Eso es lo que el modelo usa.
   * Aporta ~1 punto y está bien que aporte ~1 punto.
   */
  ladoAzul: {
    p: 0.509, n: 175, low: 0.436, high: 0.582, solido: false,
    global: { p: 0.570, n: 414, nota: 'confundido con el sorteo del mapa 2, no usar' },
    porMapa: { 1: { p: 0.509, n: 175 }, 2: { p: 0.659, n: 170 }, 3: { p: 0.507, n: 69 } },
    azulEsGanadorDelMapa1: { p: 0.876, n: 170 },
  },

  /**
   * Resultado NEGATIVO, anotado para que no se vuelva a agregar.
   *
   * Si el lado del mapa 2 era en realidad "viene de ganar", lo natural es meter
   * eso como componente propio. Medido, el ganador del mapa anterior gana el
   * siguiente 136/239 = 57% [51, 63]. Parece señal. No lo es: partiéndolo por
   * quién era el equipo más fuerte del corpus,
   *
   *   el ganador previo era el MÁS DÉBIL   20/70  = 29% [19, 40]
   *   parejos                                9/28  = 32% [18, 51]
   *   el ganador previo era el MÁS FUERTE   94/122 = 77% [69, 84]
   *
   * Cuando gana el débil, el siguiente mapa lo gana el rival el 71% de las
   * veces. No hay inercia: hay regresión a la media. El 57% es fuerza de equipo
   * al 100%, y la fuerza de equipo ya entra por `record` y por el corpus.
   */
  inerciaDeSerie: { p: 0.569, n: 239, explicadoPorFuerza: true, usar: false },

  /**
   * El récord de cada equipo, en prueba PROSPECTIVA: para cada mapa se calcula
   * solo con los anteriores, que es como se usaría en vivo. Es, después del
   * lado, lo único que mejora la predicción de forma clara.
   *
   * El barrido de pesos tiene mínimo entre 3 y 4, y empeora a partir de 5 — que
   * la curva tenga fondo es la señal de que el efecto es real y no un artefacto
   * de dejarlo crecer. El peso del modelo es 2.2 y queda cerca del óptimo sin
   * llegar a apostar por él.
   */
  record: {
    base: { brier: 0.2500, n: 142, nota: 'predecir 50-50' },
    conRecord: { brier: 0.2268, peso: 3.5, prior: { k: 4, c: 4 } },
    optimo: { peso: 5.0, brier: 0.2248 },

    /**
     * Por qué el winrate entra suavizado y no crudo.
     *
     * Con `victorias/partidas` a secas, un 1-0 vale 1.00 y el modelo movía más
     * puntos con un 1-0 contra 0-1 (+10.8) que con un 3-2 contra 2-3 (+6.1).
     * El suavizado bayesiano corrige el valor y el encogido por n corrige la
     * incertidumbre; hacen falta los dos, porque solo con el primero un 1-0 le
     * sigue ganando a un 3-2 (la misma diferencia de una partida dividida por
     * un denominador más chico).
     *
     * Cuesta 0.0015 de Brier contra la fórmula vieja y a cambio el orden queda
     * bien. La confianza extra se va a donde hay evidencia: un 9-1 contra 1-9
     * sube de 78% a 85%.
     */
    formulaVieja: { brier: 0.2253, peso: 2.2, patologia: '1-0 pesaba más que 3-2' },
    casos: {
      '1-0 vs 0-1': { antes: 0.608, ahora: 0.567 },
      '3-2 vs 2-3': { antes: 0.561, ahora: 0.578 },
      '9-1 vs 1-9': { antes: 0.779, ahora: 0.846 },
    },

    /**
     * OJO CON LA UNIDAD. El récord de los standings viene en SERIES, no en
     * mapas: un "2-3" son 5 series, ~11 mapas. Una versión anterior de esto
     * mezcló las dos unidades y puso un piso de 6 comparando series contra un
     * umbral medido en mapas — el efecto era amortiguar justo la banda que
     * mejor funciona. Estos números son todos por SERIE.
     */
    porHistoria: {
      '1-2': { n: 61, brier: 0.2360, gana: 0.014, acierto: 0.59 },
      '3-5': { n: 62, brier: 0.2179, gana: 0.032, acierto: 0.65 },
      '6+': { n: 19, brier: 0.2171, gana: 0.033, acierto: 0.59 },
    },

    /**
     * No hay piso. Aporta en los tres tramos, y el barrido de pesos tiene fondo
     * en 3.4 tanto en el conjunto entero como en el tramo de historia baja, así
     * que el 2.2 que usa el modelo está corto, no pasado. Lo que hace falta con
     * muestras chicas lo hace el encogido por n, no un umbral.
     */
    minimoUtil: null,
    unidad: 'series',
  },

  /** Acierto de cada eje del índice, cara a cara. */
  ejes: {
    teamfight: { p: 0.50, n: 400, low: 0.45, high: 0.55 },
    pick: { p: 0.52, n: 391, low: 0.47, high: 0.57 },
    split: { p: 0.50, n: 323, low: 0.45, high: 0.56 },
    siege: { p: 0.49, n: 354, low: 0.43, high: 0.54 },
    scaling: { p: 0.54, n: 330, low: 0.49, high: 0.59 },
  },

  /**
   * El test que define si el eje de escalado mide lo que dice medir: tendría que
   * acertar MÁS en partidas largas que en cortas. Acierta igual. Eso no es "mide
   * poco", es que no está midiendo escalado.
   */
  escalado: { largas: 0.53, cortas: 0.55, nLargas: 166, nCortas: 163 },

  /**
   * Qué campeón está fuerte de verdad en este meta (parches 16.14 a 16.16).
   *
   * El winrate crudo por campeón engaña: si a un campeón lo eligen los buenos
   * equipos, su winrate es del equipo. Así que cada campeón se compara contra
   * lo que se ESPERABA por la diferencia de fuerza de los equipos que lo
   * jugaron, y sobre 63 campeones con 15+ mapas se corrige por comparaciones
   * múltiples (Benjamini-Hochberg).
   *
   * Resultado: uno solo, y en el filo. El resto es ruido con forma de tier list.
   */
  campeones: {
    parches: ['16.14', '16.15', '16.16'],
    probados: 63,
    minMapas: 15,
    sobrevivenFDR: [
      { nombre: 'Cassiopeia', n: 87, wr: 0.69, esperado: 0.51, neto: 0.18, nota: 'justo en el umbral' },
    ],
    // Se listan para vigilarlos, NO como hallazgos: ninguno sobrevive la corrección.
    aVigilar: {
      favor: [
        { nombre: 'Olaf', n: 82, neto: 0.07 },
        { nombre: 'Karma', n: 51, neto: 0.07 },
        { nombre: 'Ezreal', n: 125, neto: 0.06 },
        { nombre: 'Shen', n: 126, neto: 0.06 },
      ],
      contra: [
        { nombre: 'Jayce', n: 90, neto: -0.11 },
        { nombre: 'Viktor', n: 95, neto: -0.10 },
        { nombre: 'Milio', n: 75, neto: -0.09 },
        { nombre: 'Ambessa', n: 107, neto: -0.08 },
      ],
    },
  },

  /**
   * Qué TIPO de composición gana más. Cada comp se etiqueta por su eje
   * dominante (el de z más alto, si llega a 0.5 sd) y se mide su winrate.
   *
   * Ninguno separa: los seis intervalos cruzan el 50%. El orden sugiere que el
   * asedio puro es el peor plan y el escalado el mejor, pero con estos n eso es
   * una corazonada, no un dato — y va en la misma dirección que el resto: el
   * tipo de comp no predice quién gana.
   */
  composiciones: {
    escalado: { p: 0.56, n: 93, low: 0.46, high: 0.66 },
    picks: { p: 0.54, n: 222, low: 0.47, high: 0.60 },
    split: { p: 0.52, n: 67, low: 0.40, high: 0.64 },
    teamfight: { p: 0.49, n: 184, low: 0.42, high: 0.56 },
    sinPerfil: { p: 0.47, n: 163, low: 0.39, high: 0.54 },
    asedio: { p: 0.42, n: 99, low: 0.33, high: 0.52 },
    algunoSepara: false,
  },

  /**
   * El estado de forma de los jugadores, medido como winrate de sus últimos 5
   * mapas y promediado por alineación (prospectivo, solo con lo anterior).
   *
   * Crudo parece señal: gana el lado con mejor forma en 153/255 = 60% [54, 66].
   * Pero correlaciona 0.87 con el récord del equipo —lógico: solo 7 jugadores
   * de todo el corpus cambiaron de equipo—, y el barrido conjunto lo confirma:
   *
   *   solo récord de equipo      Brier 0.2380
   *   solo forma de jugadores    Brier 0.2405
   *   los dos juntos             Brier 0.2380   (peso de forma: 0.25, o sea nada)
   *
   * Agregar forma individual encima del récord no mejora ni un punto. No es una
   * señal nueva: es el récord del equipo con otro nombre. Para que aportara
   * habría que medir rendimiento (daño, oro, KDA ajustado por rol y rival), no
   * victorias — y eso pide el feed de detalle por mapa, que hoy no se indexa.
   */
  formaJugadores: {
    crudo: { p: 0.60, n: 255, low: 0.54, high: 0.66 },
    correlacionConRecord: 0.87,
    brier: { soloRecord: 0.2380, soloForma: 0.2405, juntos: 0.2380 },
    aportaSobreElRecord: false,
    jugadoresQueCambiaronDeEquipo: 7,
  },

  /**
   * Ejes que Riot publica por campeón, medidos con el mismo método. Ninguno
   * sobrevive a la corrección por comparaciones múltiples (12 pruebas), así que
   * son hipótesis a vigilar y no hallazgos. La movilidad invertida es la más
   * marcada y la más rara: el lado con más movilidad gana menos.
   */
  riot: {
    crowdControl: { p: 0.56, n: 312 },
    durability: { p: 0.53, n: 326 },
    mobility: { p: 0.43, n: 344, nota: 'invertido, no sobrevive a la corrección' },
    damage: { p: 0.47, n: 341 },
    ranged: { p: 0.47, n: 248 },
  },
};

/** Etiqueta corta para poner al lado de una afirmación de eje. */
export function axisEvidenceLabel(axis) {
  const e = EVIDENCE.ejes[axis];
  if (!e) return null;
  return `${Math.round(e.p * 100)}%`;
}

/** ¿Este eje tiene respaldo medido, o es solo la tabla? */
export const axisSupported = (axis) => {
  const e = EVIDENCE.ejes[axis];
  return !!e && e.low > 0.5;
};
