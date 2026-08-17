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
  mapas: 2066,
  series: 867,
  ligas: ['LCK', 'LCK CL', 'LPL', 'LEC', 'LCS', 'CBLOL'],

  /**
   * El corpus pasó de 414 a 2066 mapas al indexar tres splits por liga en vez
   * de solo el vigente. No es un detalle de tamaño: cambió conclusiones.
   *
   * Con 414 mapas, el récord de equipo medido por liga daba LPL 74% (la
   * estrella) y LCK 39% (predecía al revés). Con 2066, LPL quedó ÚLTIMO con
   * 61% y LCK subió a 68%. Las dos cosas eran ruido, y la muestra grande las
   * deshizo. Vale como recordatorio de qué tan poco pesa un ranking armado
   * sobre 23 series.
   */
  corpusAnterior: { mapas: 414, series: 142, nota: 'solo el split vigente por liga' },

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
    p: 0.517, n: 867, low: 0.483, high: 0.550, solido: false,
    global: { p: 0.547, n: 2066, nota: 'confundido con el sorteo del mapa 2, no usar' },
    porMapa: {
      1: { p: 0.517, n: 867, low: 0.483, high: 0.550 },
      2: { p: 0.597, n: 752, low: 0.562, high: 0.632 },
      3: { p: 0.531, n: 360, low: 0.479, high: 0.582 },
      4: { p: 0.475, n: 59, low: 0.353, high: 0.600 },
    },
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
    /**
     * Prueba FUERA DE MUESTRA sobre el corpus grande: se elige el peso con las
     * 583 series viejas y se evalúa con las 250 nuevas, que el modelo no vio.
     * Es el único componente del sitio que pasa esta prueba.
     */
    base: { brier: 0.2500, n: 250, nota: 'predecir 50-50' },
    conRecord: { brier: 0.2146, acierto: 0.68, low: 0.62, high: 0.73, peso: 3.5, prior: { k: 4, c: 4 } },
    optimo: { peso: 5.0, brier: 0.2134 },
    seriesUsables: 833,

    /**
     * OJO: todo lo de arriba es POR SERIE. El modelo predice un MAPA, y un mapa
     * suelto es más ruidoso que una serie al mejor de tres. Medido por mapa
     * sobre 570 no vistos, el mismo componente da Brier 0.2292 y 62% [58, 66]
     * —no el 68%—, con peso óptimo 3.75, cerca del 3.5 que usa el modelo.
     *
     * Es la segunda vez que la confusión serie/mapa mete un error acá. La
     * primera fue un piso de 6 partidas medido en mapas y aplicado a series.
     */
    porMapa: { brier: 0.2292, acierto: 0.62, low: 0.58, high: 0.66, n: 570, pesoOptimo: 3.75 },

    /**
     * Por liga, sobre el corpus entero. Las seis separan del 50%, cosa que con
     * el corpus chico no pasaba en ninguna salvo LPL.
     *
     * Comparar con lo que decían las mismas ligas medidas sobre 142 series:
     * LPL daba 74% (el mejor) y ahora da 61% (el peor); LCK daba 39% —predecía
     * al revés— y ahora da 68%. Ninguna de las dos diferencias era real.
     */
    porLiga: {
      LCS: { n: 69, gana: 0.0508, acierto: 0.67, low: 0.55, high: 0.77 },
      'LCK CL': { n: 156, gana: 0.0402, acierto: 0.69, low: 0.62, high: 0.76 },
      LCK: { n: 159, gana: 0.0393, acierto: 0.68, low: 0.60, high: 0.75 },
      LEC: { n: 155, gana: 0.0268, acierto: 0.65, low: 0.57, high: 0.72 },
      LPL: { n: 200, gana: 0.0178, acierto: 0.61, low: 0.54, high: 0.67 },
      CBLOL: { n: 94, gana: 0.0175, acierto: 0.63, low: 0.53, high: 0.72 },
    },

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

  /**
   * Acierto de cada eje del índice, cara a cara, sobre el corpus grande.
   *
   * Pick (52.2%) y escalado (52.6%) rozan el umbral, pero con cinco ejes
   * probados ninguno sobrevive la corrección por comparaciones múltiples. El
   * peso del draft sigue en cero, ahora por medición ajustada y no por falta
   * de muestra.
   */
  ejes: {
    teamfight: { p: 0.500, n: 1993, low: 0.478, high: 0.522 },
    pick: { p: 0.522, n: 1947, low: 0.500, high: 0.544 },
    split: { p: 0.490, n: 1610, low: 0.466, high: 0.514 },
    siege: { p: 0.482, n: 1746, low: 0.458, high: 0.505 },
    scaling: { p: 0.526, n: 1701, low: 0.502, high: 0.549 },
  },

  /**
   * La afirmación que originó todo este sitio, ya sin margen de duda.
   *
   * El backtest original decía que con Δ de teamfight ≥ 1 sd —la "banda
   * grande"— el índice acertaba 74% (n=31, IC [57, 86]). Sobre 1256 mapas de
   * banda grande acierta 49.4%, con el intervalo entero por debajo del 53%.
   *
   * Con 218 mapas esto era "no alcanza la muestra". Con 1256 y este intervalo,
   * ya no: la regla no separa ganadores. Queda como lectura del draft, que es
   * para lo que sirve, y no como pronóstico.
   */
  bandaGrande: { p: 0.494, n: 1256, low: 0.467, high: 0.522, afirmacionOriginal: 0.74 },

  /**
   * El test que define si el eje de escalado mide lo que dice medir: tendría que
   * acertar MÁS en partidas largas que en cortas.
   *
   * Con 414 mapas fallaba: 53% en largas contra 55% en cortas, o sea al revés.
   * Con 2065 lo pasa, y de forma monotónica:
   *
   *   cortas (tercio más corto)   51.5% [47.4, 55.5]
   *   medias                      50.3% [46.1, 54.5]
   *   largas (tercio más largo)   55.7% [51.6, 59.7]   ***
   *
   * Es el único eje del índice que sobrevive una prueba de este tipo, y es una
   * prueba fuerte: no es "acierta algo", es "acierta más justo donde la teoría
   * dice que debería". Pero NO se puede usar para mover la probabilidad previa,
   * porque la duración no se sabe antes de jugar. Sirve como lo que la tarjeta
   * ya dice en el RELOJ: si esto se estira, tal equipo tiene la ventaja.
   */
  escalado: {
    cortas: 0.515, nCortas: 575,
    medias: 0.503, nMedias: 545,
    largas: 0.557, nLargas: 580, largasLow: 0.516, largasHigh: 0.597,
    pasaElTest: true,
    usarComo: 'condicional a la duración, nunca como probabilidad previa',
  },

  /**
   * La curva de oro, medida en vez de supuesta.
   *
   * Se bajaron los frames del feed de 320 partidas del corpus en los minutos
   * 10, 15, 20, 25, 30 y 35 —1551 observaciones, cero fallos— y se ajustó el
   * coeficiente del oro en cada minuto, con el Elo dentro del modelo para no
   * atribuirle al oro la fuerza del equipo.
   *
   * El modelo suponía que el mismo oro pesa MÁS tarde (una rampa de 0.06 a
   * 0.55 entre los minutos 8 y 25). Es al revés, y por una razón simple: el
   * oro total crece. 2000 de ventaja sobre 32 000 al minuto 10 es una brecha
   * enorme; sobre 128 000 al minuto 35 es ruido.
   *
   * Por eso la variable correcta es la PROPORCIÓN. Con ella el coeficiente deja
   * de depender del minuto: su variación cae de 0.33 a 0.137.
   */
  oro: {
    observaciones: 1551,
    partidas: 320,
    porMinuto: {
      10: { coef: 0.88, coefViejo: 0.06, oroTotalMedio: 32380, ganaElQueVaArriba: 0.74 },
      15: { coef: 0.62, coefViejo: 0.23, oroTotalMedio: 50915, ganaElQueVaArriba: 0.75 },
      20: { coef: 0.50, coefViejo: 0.39, oroTotalMedio: 71058, ganaElQueVaArriba: 0.79 },
      25: { coef: 0.46, coefViejo: 0.55, oroTotalMedio: 90734, ganaElQueVaArriba: 0.85 },
      30: { coef: 0.46, coefViejo: 0.55, oroTotalMedio: 110055, ganaElQueVaArriba: 0.80 },
      35: { coef: 0.31, coefViejo: 0.55, oroTotalMedio: 128092, ganaElQueVaArriba: 0.75 },
    },
    variacionDelCoeficiente: { absoluto: 0.33, proporcion: 0.137 },
    fueraDeMuestra: { n: 466, formulaVieja: 0.1431, proporcion: 0.1312, mejora: 0.0119 },
    params: { base: 15, porMinuto: 1.1, tope: 50 },
  },

  /**
   * Elo: fuerza de equipo que pondera contra quién jugaste.
   *
   * Medido POR MAPA, que es la unidad en la que el modelo predice. La primera
   * versión ajustó la escala sobre SERIES y quedó sobre-confiada de verdad
   * (donde decía 91% ganaba 78%). Con la escala por mapa la calibración cierra.
   *
   * Fuera de muestra sobre 570 mapas no vistos, hiperparámetros elegidos dentro
   * del entrenamiento:
   *
   *   base 50-50   0.2500
   *   Elo          0.2285   61% [57, 65]
   *   récord       0.2292   62% [58, 66]
   *
   * Empatan. El Elo se usa igual porque existe sin standings y porque prediciendo
   * SERIES sí gana (0.2066 contra 0.2095 sobre 261 series).
   */
  elo: {
    porMapa: { brier: 0.2285, acierto: 0.61, low: 0.57, high: 0.65, n: 570 },
    porSerie: { brier: 0.2066, acierto: 0.68, low: 0.62, high: 0.74, n: 261 },
    params: { K: 12, escala: 90, inicial: 1500 },
    reemplazaAlRecord: true,
    diferenciaTipica: { mediana: 39, p90: 111, max: 255 },
  },

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
