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

const { aggregatePlayers, computeSlayerScore } = require('./records');

const DEFAULT_MEAN = 40; // habilidad neutra si aún no hay datos en ese formato

/**
 * Índice de habilidad por jugador desde las partidas de un formato.
 * @returns {{ byLower: Map<string,{name,score,games}>, mean: number }}
 */
function computeSkillIndex(games) {
    const agg = aggregatePlayers(games);
    const byLower = new Map();
    let sum = 0;
    for (const p of agg) {
        const score = computeSlayerScore(p);
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
 * @returns {{ ok: boolean, error?: string, roster?: string[] }}
 */
function validateRoster(names) {
    // Dedup case-insensitive conservando el primero
    const seen = new Set();
    const roster = [];
    for (const n of names) {
        const k = n.toLowerCase();
        if (!seen.has(k)) { seen.add(k); roster.push(n); }
    }
    if (roster.length < 4) return { ok: false, error: 'Necesito al menos 4 jugadores. Sepáralos por comas:\n!equipos Jugador 1, Jugador 2, Jugador 3, Jugador 4' };
    if (roster.length > 16) return { ok: false, error: 'Máximo 16 jugadores.' };
    if (roster.length % 2 !== 0) return { ok: false, error: `Diste ${roster.length} jugadores (impar). Deben ser pares (4, 6, 8...).` };
    return { ok: true, roster };
}

function balanceLabel(pct) {
    if (pct >= 97) return 'muy parejo ⚖️';
    if (pct >= 90) return 'parejo';
    if (pct >= 80) return 'aceptable';
    return 'algo disparejo';
}

/**
 * Mensaje de WhatsApp con el resultado del balanceo.
 */
function formatTeamsMessage(format, roster, result) {
    const estimated = roster.filter(p => p.estimated).map(p => p.name);
    const lines = [
        `⚖️ *EQUIPOS PAREJOS* · ${format}`,
        '',
        `🔵 ${result.teamA.join(' · ')}`,
        `   _fuerza ${Math.round(result.strengthA)}_`,
        `🔴 ${result.teamB.join(' · ')}`,
        `   _fuerza ${Math.round(result.strengthB)}_`,
        '',
        `Balance: *${result.balancePct}%* — ${balanceLabel(result.balancePct)}`,
    ];
    if (estimated.length) {
        lines.push(`ⓘ Skill estimado (pocas/sin partidas): ${estimated.join(', ')}`);
    }
    return lines.join('\n');
}

module.exports = {
    balanceTeams, shrinkSkill, parsePlayerList, halfSubsetsWithZero, SHRINK_K,
    computeSkillIndex, resolveRoster, validateRoster, formatTeamsMessage
};
