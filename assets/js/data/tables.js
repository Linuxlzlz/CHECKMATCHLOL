/**
 * tables.js — tablas CONGELADAS portadas desde el skill de predicción.
 *
 * Se guardan como CSV literal, byte a byte igual a
 * scripts/champion_archetypes.csv y scripts/reference_comps.csv, para que el
 * índice calculado en el navegador sea numéricamente idéntico al de
 * score_draft.py. No editar para "arreglar" un campeón después de ver un
 * resultado: eso invalida la comparación con el backtest (n=31, 74%).
 *
 * Si falta un campeón, el motor lo reporta como no clasificado y lo cuenta
 * como cero — igual que el script. Eso sesga ese lado hacia abajo y debe
 * leerse como incertidumbre, no como debilidad.
 *
 * Nota deliberada: "Locke" aparece en reference_comps.csv pero no está en la
 * tabla de arquetipos. En el script original también cuenta como cero, así que
 * la distribución de referencia hereda ese comportamiento. Se replica a
 * propósito para no mover la escala.
 */

export const ARCHETYPES_CSV = `champion,fl,aoe,eng,pick,poke,split,scale
Aatrox,2,2,1,0,0,2,1
Ahri,0,1,1,2,1,0,2
Akali,0,1,0,3,0,1,2
Alistar,3,1,3,1,0,0,0
Ambessa,2,2,2,1,0,2,1
Amumu,3,3,3,0,0,0,1
Anivia,1,3,1,0,2,0,3
Annie,0,2,2,2,0,0,1
Aphelios,0,1,0,0,1,0,3
Ashe,0,2,2,2,1,0,2
Aurelion Sol,0,3,0,0,2,0,3
Aurora,0,2,1,2,0,1,2
Azir,0,3,2,0,1,0,3
Bard,0,1,1,3,1,0,1
Bel'Veth,1,1,0,2,0,2,3
Blitzcrank,1,0,1,3,0,0,0
Braum,3,1,1,1,0,0,1
Briar,1,1,2,2,0,1,2
Caitlyn,0,0,0,1,2,0,2
Camille,1,0,1,3,0,3,2
Cassiopeia,0,3,0,1,1,0,3
Cho'Gath,3,2,0,1,0,1,2
Corki,0,1,0,1,2,1,2
Darius,2,0,0,2,0,3,1
Diana,1,3,2,2,0,1,2
Draven,0,0,0,1,0,0,2
Dr. Mundo,3,0,0,0,0,2,2
Elise,0,0,1,3,0,0,0
Evelynn,0,1,0,3,0,0,2
Ezreal,0,1,0,0,2,0,2
Fiora,1,0,0,2,0,3,2
Galio,3,3,3,0,0,0,1
Gangplank,1,3,0,1,2,2,3
Garen,2,0,0,2,0,2,1
Gnar,3,3,3,0,1,1,1
Gragas,2,3,3,1,0,1,1
Graves,1,0,0,2,0,2,2
Gwen,1,1,0,1,0,3,2
Hecarim,2,1,3,1,0,1,1
Hwei,0,3,1,1,2,0,2
Illaoi,2,1,0,1,0,3,1
Irelia,1,1,1,1,0,3,2
Ivern,1,1,2,0,0,0,1
Janna,0,1,0,0,1,0,1
Jarvan IV,2,2,3,1,0,1,1
Jax,1,0,0,1,0,3,3
Jayce,0,0,0,1,3,2,1
Jhin,0,1,0,2,3,0,2
Jinx,0,1,0,0,1,0,3
Kai'Sa,0,1,0,2,0,0,3
Kalista,0,0,1,1,0,0,2
Karma,0,1,0,1,2,0,1
Karthus,0,3,0,0,2,0,3
Kassadin,0,1,0,3,0,0,3
Katarina,0,2,0,3,0,0,2
Kennen,1,3,3,0,1,1,1
Kha'Zix,0,0,0,3,0,1,1
Kindred,0,1,0,1,1,1,3
Kled,1,1,2,1,0,2,1
Kog'Maw,0,0,0,0,1,0,3
K'Sante,3,2,2,1,0,1,2
LeBlanc,0,0,0,3,0,0,1
Lee Sin,1,0,2,2,0,1,0
Leona,3,1,3,2,0,0,0
Lillia,1,3,2,0,0,1,2
Lissandra,1,2,3,1,0,0,1
Lucian,0,0,0,1,0,0,1
Lulu,0,1,0,0,1,0,2
Lux,0,2,0,2,2,0,2
Malphite,3,3,3,0,0,1,1
Malzahar,0,1,0,3,0,0,2
Maokai,3,2,2,1,0,0,1
Milio,0,1,0,0,1,0,2
Miss Fortune,0,3,0,0,1,0,2
Mordekaiser,2,1,0,3,0,3,2
Morgana,0,2,0,2,1,0,1
Naafiri,0,0,1,3,0,1,1
Nami,0,1,0,0,1,0,2
Nautilus,3,1,3,3,0,0,0
Neeko,1,3,3,1,0,0,1
Nidalee,0,0,0,2,2,0,1
Nilah,1,1,0,0,0,0,3
Nocturne,1,0,2,3,0,1,1
Nunu,2,2,3,0,0,0,1
Olaf,2,0,1,2,0,2,1
Orianna,0,3,2,0,1,0,3
Ornn,3,3,3,0,0,0,2
Pantheon,1,1,2,2,0,1,0
Poppy,3,1,2,1,0,1,1
Pyke,0,0,1,3,0,0,0
Qiyana,0,2,2,3,0,1,1
Rakan,1,2,3,1,0,0,1
Rek'Sai,1,0,2,2,0,1,1
Rell,3,3,3,1,0,0,1
Renata Glasc,0,2,2,1,0,0,1
Renekton,2,0,1,2,0,2,0
Rengar,0,0,0,3,0,1,1
Riven,1,1,1,2,0,3,1
Rumble,1,3,0,0,1,2,1
Ryze,0,2,0,1,0,1,3
Samira,0,1,0,1,0,0,2
Sejuani,3,3,3,0,0,0,1
Senna,0,1,0,1,2,0,3
Seraphine,0,3,1,0,1,0,2
Sett,2,1,2,1,0,2,1
Shen,2,1,1,0,0,1,1
Shyvana,2,1,1,1,0,1,2
Sion,3,2,3,0,1,1,2
Sivir,0,1,0,0,0,0,2
Skarner,3,2,3,1,0,0,1
Smolder,0,1,0,0,1,0,3
Sona,0,2,1,0,1,0,2
Soraka,0,0,0,0,1,0,2
Swain,2,2,1,1,1,0,2
Sylas,1,2,1,2,0,1,2
Syndra,0,2,1,3,1,0,3
Taliyah,0,3,2,0,1,0,2
Taric,2,1,0,0,0,0,1
Thresh,1,1,2,3,0,0,1
Tristana,0,0,0,2,0,1,2
Trundle,2,0,1,1,0,2,1
Tryndamere,0,0,0,1,0,3,2
Twisted Fate,0,1,0,2,0,1,2
Twitch,0,1,0,1,0,0,3
Urgot,2,0,0,2,0,2,1
Varus,0,1,1,1,3,0,2
Vayne,0,0,0,1,0,1,3
Veigar,0,2,1,2,1,0,3
Vex,0,2,2,2,1,0,2
Vi,2,0,3,3,0,0,1
Viego,1,1,1,2,0,2,2
Viktor,0,3,1,0,1,0,3
Volibear,2,1,2,2,0,2,1
Warwick,2,0,2,2,0,1,1
Wukong,2,3,3,0,0,1,1
Xayah,0,1,0,1,0,0,3
Xerath,0,2,0,1,3,0,2
Xin Zhao,2,1,3,2,0,1,0
Yasuo,0,2,0,1,0,2,2
Yone,1,2,1,2,0,2,2
Yorick,2,0,0,1,0,3,2
Yuumi,0,1,0,0,0,0,2
Zac,3,3,3,0,0,0,1
Zed,0,0,0,3,0,1,1
Zeri,0,0,0,0,0,0,3
Ziggs,0,3,0,0,3,0,3
Zilean,0,1,0,1,1,0,2
Zoe,0,1,0,3,1,0,2
Zyra,0,3,1,1,2,0,2
Vladimir,1,3,0,1,1,1,3`;

export const REFERENCE_CSV = `gameid,side,team,result,champions
80183,Blue,EDG,0,Lee Sin|Cassiopeia|Ziggs|Gnar|Camille
80183,Red,LGD,1,Syndra|Skarner|Ambessa|Kai'Sa|Rell
80186,Blue,TES,1,Jarvan IV|Ezreal|Karma|K'Sante|Ahri
80186,Red,WE,0,Jayce|Lucian|Milio|Aurora|Gnar
80189,Blue,JDG,1,Syndra|Shen|Lee Sin|Gnar|Jhin
80189,Red,AL,0,Camille|Naafiri|Cassiopeia|Ziggs|Ambessa
80192,Blue,BLG,1,Cassiopeia|Jarvan IV|Ryze|Yorick|Shen
80192,Red,TT,0,Jayce|Xin Zhao|Akali|Ziggs|Nautilus
80195,Blue,LGD,0,Ambessa|Qiyana|Syndra|Jhin|Shen
80195,Red,AL,1,Gnar|Naafiri|Orianna|Ziggs|Camille
80198,Blue,WE,1,Rumble|Trundle|Ryze|Varus|Alistar
80198,Red,JDG,0,K'Sante|Vi|Anivia|Ziggs|Camille
80201,Blue,BLG,0,Ambessa|Jarvan IV|Cassiopeia|Lucian|Milio
80201,Red,EDG,1,Vayne|Lee Sin|Syndra|Ziggs|Rell
80204,Blue,WE,1,Rumble|Qiyana|Ryze|Ezreal|Nautilus
80204,Red,LGD,0,Yorick|Xin Zhao|Anivia|Lucian|Milio
80207,Blue,IG,0,Ziggs|Lee Sin|Locke|Camille|Ambessa
80207,Red,WBG,1,Jarvan IV|Cassiopeia|Shen|Sivir|Jax
80210,Blue,TT,0,Ambessa|Jarvan IV|Ryze|Kai'Sa|Nautilus
80210,Red,TES,1,Rumble|Vi|Ahri|Sivir|Alistar
80213,Blue,NIP,1,Yorick|Naafiri|Cassiopeia|Xayah|Rakan
80213,Red,LNG,0,Jayce|Pantheon|Syndra|Lucian|Milio
80216,Blue,EDG,0,Jayce|Trundle|Ryze|Ziggs|Nautilus
80216,Red,TT,1,Olaf|Jarvan IV|Syndra|Sivir|Shen
80219,Blue,AL,0,Ryze|Lucian|Milio|Gnar|Vi
80219,Red,BLG,1,Ambessa|Naafiri|Anivia|Ezreal|Karma
80591,Blue,AL,1,Yorick|Jarvan IV|Galio|Viktor|Shen
80591,Red,TES,0,Jayce|Lee Sin|Ryze|Cassiopeia|Alistar
80594,Blue,LGD,0,Jayce|Nocturne|Syndra|Locke|Shen
80594,Red,BLG,1,Yorick|Naafiri|Cassiopeia|Vladimir|Camille
80597,Blue,WBG,0,Ambessa|Nocturne|Syndra|Kai'Sa|Shen
80597,Red,NIP,1,Gnar|Trundle|Cassiopeia|Ezreal|Alistar
80600,Blue,WE,1,Ornn|Wukong|Ahri|Varus|Rakan
80600,Red,EDG,0,Rumble|Naafiri|Ryze|Jhin|Rell
80603,Blue,JDG,0,Ambessa|Jarvan IV|Locke|Sivir|Camille
80603,Red,TT,1,Rumble|Pantheon|Orianna|Draven|Nautilus
80612,Blue,TT,0,Rumble|Jarvan IV|Viktor|Corki|Alistar
80612,Red,AL,1,Ambessa|Naafiri|Ryze|Ziggs|Shen
80615,Blue,TES,0,Rumble|Jarvan IV|Orianna|Jhin|Nautilus
80615,Red,LGD,1,Gnar|Naafiri|Akali|Corki|Shen
80618,Blue,BLG,1,Ambessa|Lee Sin|Akali|Orianna|Shen
80618,Red,JDG,0,Olaf|Nocturne|Locke|Ziggs|Alistar
80621,Blue,WE,0,Rumble|Naafiri|Ahri|Varus|Rakan
80621,Red,TT,1,K'Sante|Jarvan IV|Ryze|Ziggs|Shen
80624,Blue,LNG,0,Rumble|Naafiri|Galio|Zeri|Nautilus
80624,Red,IG,1,Jayce|Trundle|Cassiopeia|Sivir|Bard
80627,Blue,JDG,0,Yorick|Jarvan IV|Viktor|Ezreal|Shen
80627,Red,TES,1,Rumble|Vi|Cassiopeia|Varus|Nautilus
80981,Blue,JDG,1,Rumble|Jarvan IV|Cassiopeia|Corki|Alistar
80981,Red,LGD,0,Yorick|Naafiri|Akali|Lucian|Shen
80984,Blue,EDG,0,Gnar|Jarvan IV|Ryze|Ezreal|Rell
80984,Red,TES,1,Rumble|Vi|Ahri|Varus|Nautilus
80987,Blue,TT,0,Jayce|Lee Sin|Orianna|Ziggs|Nautilus
80987,Red,LGD,1,Rumble|Naafiri|Cassiopeia|Corki|Rell
80990,Blue,NIP,0,Varus|Vi|Locke|Kai'Sa|Shen
80990,Red,IG,1,Rumble|Naafiri|Orianna|Corki|Bard
80993,Blue,AL,0,Olaf|Naafiri|Ahri|Ziggs|Shen
80993,Red,WE,1,Dr. Mundo|Pantheon|Ryze|Jhin|Neeko
81002,Blue,TES,1,Vi|Rumble|Ahri|Jhin|Alistar
81002,Red,BLG,0,Jarvan IV|Camille|Ambessa|Lissandra|Corki
81017,Blue,TES,1,Rumble|Jarvan IV|Syndra|Ezreal|Alistar
81017,Red,TT,0,Ambessa|Lee Sin|Ryze|Xerath|Shen`;

/**
 * Alias de nombres. El feed de lolesports devuelve `championId` que a veces es
 * la clave de Data Dragon y no el nombre visible. norm() ya resuelve casi todo
 * (K'Sante -> ksante, KSante -> ksante), así que acá solo van los casos donde
 * la clave y el nombre difieren de verdad.
 */
export const CHAMPION_ALIASES = {
  monkeyking: 'wukong',
  renata: 'renataglasc',
  nunuwillump: 'nunu',
  drmundo: 'drmundo',
  aurelionsol: 'aurelionsol',
};
