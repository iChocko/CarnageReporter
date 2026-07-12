/**
 * Armador de equipos parejos (comando !equipos).
 *
 * Reparte N jugadores (par, 4–16) en dos equipos del mismo tamaño buscando el
 * mejor balance de habilidad. Como N es pequeño, se prueban TODAS las divisiones
 * posibles (fuerza bruta) y se elige la más pareja.
 *
 * Decisiones de diseño (importan para que se sienta "justo"):
 *  - Habilidad = Slayer Score (0-100), el mismo del ranking, del formato del grupo.
 *  - Shrinkage: los jugadores con pocas partidas se acercan a la media (un 5-0 con
 *    2 partidas no vale como un veterano; evita balances basados en ruido).
 *  - Objetivo: minimizar la diferencia de fuerza total, pero con un término que
 *    separa a los cracks (que la mejor estrella no caiga siempre en el mismo lado).
 *  - Variedad: entre las divisiones casi tan parejas como la óptima, elige una al
 *    azar, para que correr el comando otra vez ofrezca alternativas igual de justas.
 */

const SHRINK_K = 4;        // fuerza del shrinkage (partidas "virtuales" hacia la media)
const STAR_WEIGHT = 0.30;  // peso de "separar cracks" en el objetivo
const VARIETY_TOL = 0.04;  // 4%: divisiones dentro de este margen del óptimo son candidatas

/** Combinaciones de tamaño k de [0..n-1] que SIEMPRE incluyen el índice 0
 *  (evita contar dos veces la misma partición con los equipos intercambiados). */
function halfSubsetsWithZero(n, k) {
    const res = [];
    const rest = [];
    for (let i = 1; i < n; i++) rest.push(i);
    const pick = (start, chosen) => {
        if (chosen.length === k - 1) { res.push([0, ...chosen]); return; }
        for (let i = start; i < rest.length; i++) pick(i + 1, [...chosen, rest[i]]);
    };
    pick(0, []);
    return res;
}

/**
 * @param {Array<{name:string, skill:number}>} players - habilidad ya ajustada
 * @param {function} [rng] - generador 0..1 (inyectable para tests deterministas)
 * @returns {{teamA:string[], teamB:string[], strengthA:number, strengthB:number, balancePct:number}}
 */
function balanceTeams(players, rng = Math.random) {
    const n = players.length;
    const half = n / 2;
    const skills = players.map(p => p.skill);
    const total = skills.reduce((a, b) => a + b, 0);

    const subsets = halfSubsetsWithZero(n, half);
    const scored = subsets.map(idxA => {
        const inA = new Set(idxA);
        let sumA = 0, maxA = -Infinity, maxB = -Infinity;
        for (let i = 0; i < n; i++) {
            if (inA.has(i)) { sumA += skills[i]; if (skills[i] > maxA) maxA = skills[i]; }
            else { if (skills[i] > maxB) maxB = skills[i]; }
        }
        const sumB = total - sumA;
        // Objetivo: diferencia de fuerza total + castigo por juntar a las estrellas
        const cost = Math.abs(sumA - sumB) + STAR_WEIGHT * Math.abs(maxA - maxB);
        return { idxA, sumA, sumB, cost };
    });

    const best = Math.min(...scored.map(s => s.cost));
    // Candidatas: casi tan buenas como la óptima (para dar variedad al re-correr)
    const band = best + VARIETY_TOL * (total / 2);
    const candidates = scored.filter(s => s.cost <= band);
    const chosen = candidates[Math.floor(rng() * candidates.length)] || scored[0];

    const teamA = chosen.idxA.map(i => players[i].name);
    const teamB = players.filter((_, i) => !chosen.idxA.includes(i)).map(p => p.name);
    const a = chosen.sumA, b = chosen.sumB;
    const balancePct = (a + b) > 0 ? Math.round(100 * (1 - Math.abs(a - b) / (a + b))) : 100;

    return {
        teamA, teamB,
        strengthA: Math.round(a * 10) / 10,
        strengthB: Math.round(b * 10) / 10,
        balancePct
    };
}

/**
 * Aplica shrinkage bayesiano: acerca el score a la media según cuántas partidas tenga.
 * pocas partidas -> pesa más la media; muchas -> pesa más su score real.
 */
function shrinkSkill(rawScore, games, populationMean) {
    return (games * rawScore + SHRINK_K * populationMean) / (games + SHRINK_K);
}

/**
 * Quita los tokens "@<dígitos>" que WhatsApp inyecta en el texto por cada
 * mención (el dato real viene aparte, en mentionedIds). Sin esto, los tokens
 * se parsearían como gamertags falsos.
 */
function stripMentionTokens(text) {
    return String(text || '').replace(/@\d+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parsea la lista de jugadores del comando. Si hay comas, separa por comas
 * (soporta gamertags con espacios). Si no, separa por espacios pero intenta
 * casar gamertags de varias palabras contra los conocidos (match voraz).
 * @param {string} text - lo que sigue a "!equipos"
 * @param {Map<string,string>} knownByLower - gamertagLower -> gamertag canónico
 * @returns {string[]} nombres (canónicos si se reconocieron)
 */
function parsePlayerList(text, knownByLower) {
    const raw = (text || '').trim();
    if (!raw) return [];

    const canon = s => knownByLower.get(s.trim().toLowerCase()) || s.trim();

    if (raw.includes(',')) {
        return raw.split(',').map(canon).filter(Boolean);
    }

    // Sin comas: match voraz de gamertags de hasta 4 palabras
    const tokens = raw.split(/\s+/);
    const out = [];
    let i = 0;
    while (i < tokens.length) {
        let matched = null;
        for (let len = Math.min(4, tokens.length - i); len >= 1; len--) {
            const cand = tokens.slice(i, i + len).join(' ');
            if (knownByLower.has(cand.toLowerCase())) { matched = { name: knownByLower.get(cand.toLowerCase()), len }; break; }
        }
        if (matched) { out.push(matched.name); i += matched.len; }
        else { out.push(tokens[i]); i += 1; }
    }
    return out;
}

const { aggregatePlayers, computeSlayerScore, computeRecords } = require('./records');

const DEFAULT_MEAN = 40;   // habilidad neutra si aún no hay datos en ese formato
const WINRATE_WEIGHT = 0.3; // peso del win rate en el rating (el resto es Slayer Score)

/**
 * Índice de habilidad por jugador desde las partidas de un formato.
 * Rating = 70% Slayer Score + 30% win rate (prior bayesiano al 50% para
 * que pocas partidas no disparen ni hundan a nadie).
 * @returns {{ byLower: Map<string,{name,score,games}>, mean: number }}
 */
function computeSkillIndex(games) {
    const agg = aggregatePlayers(games);
    const records = computeRecords(games);
    const byLower = new Map();
    let sum = 0;
    for (const p of agg) {
        const rec = records.get(p.gamertag) || { wins: 0, losses: 0 };
        const winRate = (rec.wins + 2) / (rec.wins + rec.losses + 4);
        const score = (1 - WINRATE_WEIGHT) * computeSlayerScore(p) + WINRATE_WEIGHT * (winRate * 100);
        byLower.set(p.gamertag.toLowerCase(), { name: p.gamertag, score, games: p.total_games });
        sum += score;
    }
    const mean = agg.length ? sum / agg.length : DEFAULT_MEAN;
    return { byLower, mean };
}

/**
 * Resuelve la habilidad de cada nombre pedido, con fallback entre formatos.
 * @param {string[]} names
 * @param {object} primary - índice del formato del grupo (computeSkillIndex)
 * @param {object} secondary - índice del otro formato (fallback)
 * @returns {Array<{name, skill, estimated}>}
 */
function resolveRoster(names, primary, secondary) {
    const mean = primary.mean || DEFAULT_MEAN;
    return names.map(name => {
        const key = name.toLowerCase();
        const inPrimary = primary.byLower.get(key);
        if (inPrimary && inPrimary.games > 0) {
            return { name: inPrimary.name, skill: shrinkSkill(inPrimary.score, inPrimary.games, mean), estimated: inPrimary.games < 5 };
        }
        // Sin datos en este formato: usar el otro formato (marcado como estimado)
        const inSecondary = secondary?.byLower.get(key);
        if (inSecondary && inSecondary.games > 0) {
            return { name: inSecondary.name, skill: shrinkSkill(inSecondary.score, inSecondary.games, mean), estimated: true };
        }
        // Sin datos en ningún lado: media neutra
        return { name, skill: mean, estimated: true };
    });
}

/**
 * Valida el roster: cuenta par entre 4 y 16, sin duplicados.
 * Con { exact: 4 } exige exactamente 4 (flujo de menciones en 2v2).
 * @returns {{ ok: boolean, error?: string, roster?: string[] }}
 */
function validateRoster(names, { exact = null, hadDuplicates = false } = {}) {
    // Dedup case-insensitive conservando el primero
    const seen = new Set();
    const roster = [];
    for (const n of names) {
        const k = n.toLowerCase();
        if (!seen.has(k)) { seen.add(k); roster.push(n); }
    }
    const dups = hadDuplicates || roster.length < names.length;
    if (exact) {
        if (roster.length === exact) return { ok: true, roster };
        if (dups && roster.length < exact) {
            return { ok: false, error: `Hay jugadores repetidos. Necesito ${exact} distintos; me quedaron ${roster.length}.` };
        }
        if (roster.length < exact) {
            return { ok: false, error: `La reta 2v2 es de exactamente 4 jugadores. Diste ${roster.length}. Uso: !caracola @P1 @P2 @P3 @P4` };
        }
        return { ok: false, error: `Esto es 2v2: exactamente 4 jugadores, diste ${roster.length}.` };
    }
    if (roster.length < 4) return { ok: false, error: 'Mínimo 4 jugadores, separados por comas:\n!equipos Jugador 1, Jugador 2, Jugador 3, Jugador 4' };
    if (roster.length > 16) return { ok: false, error: 'Máximo 16 jugadores.' };
    if (roster.length % 2 !== 0) return { ok: false, error: `${roster.length} jugadores — número impar. Tienen que ser pares (4, 6, 8...).` };
    return { ok: true, roster };
}

function balanceLabel(pct) {
    if (pct >= 97) return 'muy parejo';
    if (pct >= 90) return 'parejo';
    if (pct >= 80) return 'aceptable';
    return 'algo disparejo';
}

/**
 * Cómo mostrar a un jugador en el mensaje: token de mención de WhatsApp
 * ("@<dígitos>", se pinta como el nombre del contacto y notifica) si tenemos
 * su JID, o el gamertag en texto plano si no (invitados escritos a mano).
 * @param {Map<string,string>} [mentionJidByLower] - gamertagLower -> JID
 */
function playerDisplay(name, mentionJidByLower) {
    const jid = mentionJidByLower?.get(String(name).toLowerCase());
    return jid ? `@${String(jid).split('@')[0]}` : name;
}

/**
 * Mensaje de WhatsApp con el resultado del balanceo.
 */
function formatTeamsMessage(format, roster, result, mentionJidByLower) {
    const show = n => playerDisplay(n, mentionJidByLower);
    const estimated = roster.filter(p => p.estimated).map(p => show(p.name));
    const lines = [
        `*EQUIPOS PAREJOS* · ${format}`,
        '',
        `🔵 ${result.teamA.map(show).join(' · ')}`,
        `   _fuerza ${Math.round(result.strengthA)}_`,
        `🔴 ${result.teamB.map(show).join(' · ')}`,
        `   _fuerza ${Math.round(result.strengthB)}_`,
        '',
        `Balance: *${result.balancePct}%* — ${balanceLabel(result.balancePct)}`,
    ];
    if (estimated.length) {
        lines.push(`Rating provisional (pocas o cero partidas): ${estimated.join(', ')}`);
    }
    return lines.join('\n');
}

const DUO_MIN_GAMES = 3;  // partidas juntos para que la dupla ajuste
const DUO_MAX_ADJ = 5;    // ajuste máximo (± puntos de fuerza)

/** Ajuste por historial de dupla: solo con historial real (≥3 juntos), ±5 máx. */
function duoAdjustment(p1, p2, duoRecords) {
    if (!duoRecords) return 0;
    const key = [p1.toLowerCase(), p2.toLowerCase()].sort().join('|');
    const duo = duoRecords.get(key);
    if (!duo || duo.games < DUO_MIN_GAMES) return 0;
    const rate = Math.max(-1, Math.min(1, (duo.wins - duo.losses) / duo.games));
    return rate * DUO_MAX_ADJ * Math.min(duo.games, 10) / 10;
}

/**
 * Enumera los 3 emparejamientos posibles de 4 jugadores y los ordena del
 * más parejo al menos, con ajuste por duplas con historial.
 * @param {Array<{name,skill,estimated}>} roster4 - exactamente 4 (resolveRoster)
 * @param {Map} [duoRecords] - de computeDuoRecords
 * @returns {Array<{teamA, teamB, strengthA, strengthB, balancePct, duoLines}>}
 */
function rankPairings(roster4, duoRecords) {
    const [p0, p1, p2, p3] = roster4;
    const splits = [
        [[p0, p1], [p2, p3]],
        [[p0, p2], [p1, p3]],
        [[p0, p3], [p1, p2]],
    ];

    const scored = splits.map(([ta, tb]) => {
        const adjA = duoAdjustment(ta[0].name, ta[1].name, duoRecords);
        const adjB = duoAdjustment(tb[0].name, tb[1].name, duoRecords);
        const sA = ta[0].skill + ta[1].skill + adjA;
        const sB = tb[0].skill + tb[1].skill + adjB;
        const maxA = Math.max(ta[0].skill, ta[1].skill);
        const maxB = Math.max(tb[0].skill, tb[1].skill);
        const cost = Math.abs(sA - sB) + STAR_WEIGHT * Math.abs(maxA - maxB);
        const balancePct = (sA + sB) > 0 ? Math.round(100 * (1 - Math.abs(sA - sB) / (sA + sB))) : 100;
        const duoLines = [];
        if (adjA !== 0) duoLines.push({ team: ta, adj: adjA });
        if (adjB !== 0) duoLines.push({ team: tb, adj: adjB });
        return {
            teamA: ta, teamB: tb,
            strengthA: Math.round(sA * 10) / 10,
            strengthB: Math.round(sB * 10) / 10,
            balancePct, cost, duoLines
        };
    });

    return scored.sort((a, b) => a.cost - b.cost);
}

/**
 * Mensaje de WhatsApp para el flujo de 4 jugadores: propuesta más pareja
 * + las otras 2 opciones con su balance. Si se pasa mentionJidByLower, los
 * jugadores con JID salen como mención real (@persona) en vez de gamertag.
 * @param {Array<{name,skill,estimated}>} roster4
 * @param {Array} ranked - de rankPairings
 * @param {Map} [duoRecords] - para la línea "van X-Y juntos"
 * @param {Map<string,string>} [mentionJidByLower] - gamertagLower -> JID
 */
function formatPairingsMessage(roster4, ranked, duoRecords, mentionJidByLower) {
    const best = ranked[0];
    const show = p => playerDisplay(p.name, mentionJidByLower);
    const rating = p => Math.round(p.skill);
    const teamLine = (emoji, [a, b], strength) =>
        `${emoji} ${show(a)} (${rating(a)}) + ${show(b)} (${rating(b)}) — fuerza ${Math.round(strength)}`;

    const lines = [
        '*RETA 2v2* · propuesta más pareja',
        '',
        teamLine('🔵', best.teamA, best.strengthA),
        teamLine('🔴', best.teamB, best.strengthB),
        `Balance: *${best.balancePct}%* — ${balanceLabel(best.balancePct)}`,
    ];

    for (const { team, adj } of best.duoLines) {
        const rounded = Math.round(adj);
        if (rounded === 0) continue; // ajuste insignificante: no ensuciar el mensaje
        const key = [team[0].name.toLowerCase(), team[1].name.toLowerCase()].sort().join('|');
        const duo = duoRecords?.get(key);
        if (duo) {
            const sign = rounded > 0 ? '+' : '';
            lines.push(`Dupla con historial: ${show(team[0])}+${show(team[1])} van ${duo.wins}-${duo.losses} juntos (${sign}${rounded})`);
        }
    }

    lines.push('', 'Otras opciones:');
    ranked.slice(1).forEach((opt, i) => {
        lines.push(`${i + 2}) ${show(opt.teamA[0])}+${show(opt.teamA[1])} vs ${show(opt.teamB[0])}+${show(opt.teamB[1])} — ${opt.balancePct}%`);
    });

    const estimated = roster4.filter(p => p.estimated).map(p => show(p));
    if (estimated.length) {
        lines.push('', `Rating provisional (pocas o cero partidas): ${estimated.join(', ')}`);
    }
    return lines.join('\n');
}

module.exports = {
    balanceTeams, shrinkSkill, parsePlayerList, halfSubsetsWithZero, SHRINK_K,
    computeSkillIndex, resolveRoster, validateRoster, formatTeamsMessage,
    rankPairings, formatPairingsMessage, duoAdjustment, stripMentionTokens,
    playerDisplay
};
