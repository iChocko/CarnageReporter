/**
 * Torneo (round robin de equipos fijos, series Bo3 con mapa/modo por game).
 *
 * Módulo PURO: recibe la config del torneo (output/torneo.json, ver
 * domain/torneo.js) y las partidas desde su inicio — de cualquier formato y
 * también las anuladas — y calcula todo al vuelo: a qué serie y slot va cada
 * partida, el marcador de cada serie, la tabla por equipos, las stats
 * individuales y la lista de "candidatas" para que un admin revise.
 *
 * Reglas (cerradas con el usuario, ver el plan del torneo):
 *  - Un lado (team_id) es del equipo X si trae >= minTitulares (default 3)
 *    titulares de X; el resto del lado son suplentes. Ambos lados deben
 *    resolverse a equipos distintos y con una serie programada entre ellos.
 *  - Slot por mapa+modo (no por orden): en cada serie los 3 mapas son
 *    distintos. Mapa desconocido -> decide el modo; si el modo es ambiguo,
 *    el primer slot todavía sin resultado.
 *  - Varias partidas en el mismo slot: cuenta la ÚLTIMA que no sea empate
 *    (cubre reinicios por lag/desconexión). Los empates no suman y el slot
 *    espera la repetición.
 *  - Una serie termina al llegar a 2; partidas posteriores -> "revisar".
 *  - Sin corte por tiempo: una serie suspendida se reanuda otro día.
 *  - Overrides del admin: excluir, fijar (partida -> serie/slot, aunque
 *    esté anulada o en otro mapa), resultado manual de un slot, W.O. de
 *    serie, empate de serie (p.ej. 1-1 y no se jugó el G3), cancelar serie.
 *    Deshacer = borrar el override.
 *  - Tabla tipo Mundial: puntos por SERIE (victoria 3, empate 1, derrota 0,
 *    configurable). Desempate: dif. de games -> enfrentamiento directo
 *    (mini tabla entre los empatados) -> más games ganados -> partida extra.
 *  - Stats individuales: partidas que ocupan un slot + empates. NO cuentan
 *    reiniciadas, "revisar", resultados manuales ni W.O. (nadie las jugó
 *    frente al bot), ni series canceladas.
 */

'use strict';

const { teamOutcomes } = require('./records');

const MODOS = ['ctf', 'slayer', 'oddball', 'koth'];
const ESTADOS_SERIE = ['pendiente', 'en_curso', 'terminada', 'wo', 'empatada', 'cancelada'];
const OVERRIDE_TIPOS = ['excluir', 'fijar', 'resultado', 'wo', 'empate', 'cancelar'];

// Variantes de mapa: Onslaught es una variante de Foundry y el juego puede
// reportarla con el nombre del mapa base.
const MAP_ALIASES = {
    onslaught: ['onslaught', 'foundry'],
};

// Nombres que el server usa cuando no pudo resolver el mapa (utils/maps.js).
const UNKNOWN_MAPS = new Set(['', 'mapaporconfirmar', 'mapadesconocido', 'unknown']);

const lower = s => String(s == null ? '' : s).trim().toLowerCase();
const mapKey = s => lower(s).replace(/[^a-z0-9]/g, '');
const round2 = n => Math.round(n * 100) / 100;
const tsOf = g => new Date(g.timestamp).getTime();

/**
 * Modo de juego a partir de `game_type_name` ("HARDCORE CTF", "HARDCORE CON
 * TS", "HARDCORE BALL", "HARDCORE KING", "TEAM SLAYER BR"...).
 * @returns {'ctf'|'slayer'|'oddball'|'koth'|null}
 */
function modeOf(gameTypeName) {
    const t = String(gameTypeName || '').toUpperCase();
    if (/\bCTF\b|FLAG/.test(t)) return 'ctf';
    if (/BALL/.test(t)) return 'oddball';
    if (/KING|KOTH|HILL/.test(t)) return 'koth';
    if (/\bTS\b|SLAYER|SNIPERS|SWAT/.test(t)) return 'slayer';
    return null;
}

function isUnknownMap(mapName) {
    return UNKNOWN_MAPS.has(mapKey(mapName));
}

/** ¿El mapa reportado corresponde al mapa programado del slot? */
function mapMatches(reported, scheduled) {
    const want = mapKey(scheduled);
    const accepted = (MAP_ALIASES[want] || [want]).map(mapKey);
    return accepted.includes(mapKey(reported));
}

/**
 * Valida y normaliza la config. Lanza Error con mensaje legible (en español)
 * si algo no cuadra — el admin la sube a mano.
 */
function normalizeConfig(raw) {
    const fail = msg => { throw new Error(msg); };
    if (!raw || typeof raw !== 'object') fail('La config del torneo debe ser un objeto JSON');
    const nombre = String(raw.nombre || '').trim();
    if (!nombre) fail('Falta "nombre"');
    const inicioTs = Date.parse(raw.inicio);
    if (!Number.isFinite(inicioTs)) fail('"inicio" debe ser una fecha ISO válida');
    const finTs = raw.fin ? Date.parse(raw.fin) : null;
    if (raw.fin && !Number.isFinite(finTs)) fail('"fin" debe ser una fecha ISO válida o null');

    const bo = Number(raw.bo || 3);
    if (![1, 3, 5].includes(bo)) fail('"bo" debe ser 1, 3 o 5');
    const minTitulares = Number(raw.minTitulares || 3);

    if (!Array.isArray(raw.equipos) || raw.equipos.length < 2) fail('Se necesitan al menos 2 equipos');
    const tagOwner = new Map();
    const equipos = raw.equipos.map((e, i) => {
        const id = lower(e?.id);
        if (!id) fail(`Equipo #${i + 1} sin "id"`);
        if (!Array.isArray(e.jugadores) || e.jugadores.length === 0) fail(`Equipo "${id}" sin jugadores`);
        const jugadores = e.jugadores.map((j, k) => {
            const jn = String(j?.nombre || '').trim();
            if (!jn) fail(`Equipo "${id}", jugador #${k + 1} sin "nombre"`);
            const gamertags = (Array.isArray(j.gamertags) ? j.gamertags : [])
                .map(t => String(t || '').trim()).filter(Boolean);
            for (const t of gamertags) {
                const prev = tagOwner.get(lower(t));
                if (prev) fail(`El gamertag "${t}" está en dos jugadores (${prev} y ${id}/${jn})`);
                tagOwner.set(lower(t), `${id}/${jn}`);
            }
            return { nombre: jn, gamertags, capitan: !!j.capitan };
        });
        return { id, nombre: String(e.nombre || id).trim(), color: e.color || null, jugadores };
    });
    const teamIds = new Set(equipos.map(e => e.id));
    if (teamIds.size !== equipos.length) fail('Hay ids de equipo repetidos');
    if (minTitulares < 1 || minTitulares > Math.min(...equipos.map(e => e.jugadores.length))) {
        fail('"minTitulares" fuera de rango');
    }

    if (!Array.isArray(raw.series) || raw.series.length === 0) fail('Faltan "series"');
    const pairSeen = new Set();
    const series = raw.series.map((s, i) => {
        const n = Number(s?.n ?? i + 1);
        const a = lower(s?.a), b = lower(s?.b);
        if (!teamIds.has(a) || !teamIds.has(b) || a === b) fail(`Serie ${n}: equipos inválidos`);
        const pk = [a, b].sort().join('|');
        if (pairSeen.has(pk)) fail(`Serie ${n}: ${a} vs ${b} ya está programada`);
        pairSeen.add(pk);
        if (!Array.isArray(s.games) || s.games.length !== bo) fail(`Serie ${n}: debe tener ${bo} games`);
        const games = s.games.map((g, k) => {
            const modo = lower(g?.modo);
            if (!MODOS.includes(modo)) fail(`Serie ${n}, game ${k + 1}: modo inválido (${MODOS.join('/')})`);
            const mapa = String(g?.mapa || '').trim();
            if (!mapa) fail(`Serie ${n}, game ${k + 1}: falta "mapa"`);
            return { mapa, modo };
        });
        return { n, a, b, games };
    });
    if (new Set(series.map(s => s.n)).size !== series.length) fail('Números de serie repetidos');

    const puntos = {
        victoria: Number(raw.puntos?.victoria ?? 3),
        empate: Number(raw.puntos?.empate ?? 1),
        derrota: Number(raw.puntos?.derrota ?? 0),
    };
    if (Object.values(puntos).some(v => !Number.isFinite(v))) fail('"puntos" debe tener números (victoria/empate/derrota)');

    const objetivos = {};
    for (const m of MODOS) {
        const v = raw.objetivos?.[m];
        if (v !== undefined && v !== null) objetivos[m] = Number(v);
    }

    const overrides = (Array.isArray(raw.overrides) ? raw.overrides : [])
        .filter(o => o && OVERRIDE_TIPOS.includes(o.tipo));

    return {
        id: String(raw.id || nombre).trim(),
        nombre,
        activo: raw.activo !== false,
        inicio: new Date(inicioTs).toISOString(),
        fin: finTs ? new Date(finTs).toISOString() : null,
        bo,
        minTitulares,
        admins: (Array.isArray(raw.admins) ? raw.admins : []).map(t => String(t).trim()).filter(Boolean),
        puntos,
        objetivos,
        equipos,
        series,
        overrides,
    };
}

/** Índice gamertag(lower) -> { teamId, persona } */
function buildTagIndex(cfg) {
    const idx = new Map();
    for (const e of cfg.equipos) {
        for (const j of e.jugadores) {
            const persona = `${e.id}:${j.nombre}`;
            for (const t of j.gamertags) idx.set(lower(t), { teamId: e.id, persona, nombre: j.nombre });
        }
    }
    return idx;
}

/**
 * Resuelve los dos lados de una partida a equipos del torneo.
 * @returns {null | { sides: Array<{teamId, teamIdx, members: object[]}> }}
 *   members: [{ player, persona|null, nombre, suplente, registrado }]
 */
function resolveSides(game, cfg, tagIndex = buildTagIndex(cfg)) {
    const byTeam = new Map();
    for (const p of game.players || []) {
        const tid = p.team_id ?? 0;
        if (!byTeam.has(tid)) byTeam.set(tid, []);
        byTeam.get(tid).push(p);
    }
    if (byTeam.size !== 2) return null;

    const sides = [];
    for (const [teamIdx, players] of byTeam) {
        const counts = new Map();
        for (const p of players) {
            const hit = tagIndex.get(lower(p.gamertag));
            if (hit) counts.set(hit.teamId, (counts.get(hit.teamId) || 0) + 1);
        }
        const [best] = [...counts.entries()].sort((x, y) => y[1] - x[1]);
        if (!best || best[1] < cfg.minTitulares) return null;
        const teamId = best[0];
        sides.push({
            teamId,
            teamIdx,
            members: players.map(p => {
                const hit = tagIndex.get(lower(p.gamertag));
                return {
                    player: p,
                    persona: hit ? hit.persona : null,
                    nombre: hit ? hit.nombre : p.gamertag,
                    personaTeam: hit ? hit.teamId : null,
                    suplente: !hit || hit.teamId !== teamId,
                    registrado: !!hit,
                };
            }),
        });
    }
    if (sides[0].teamId === sides[1].teamId) return null;
    return { sides };
}

/** Puntaje por lado y ganador (teamId) o null si empate. */
function sideResult(game, resolved) {
    const scores = resolved.sides.map(s => s.members.reduce((sum, m) => sum + (Number(m.player.score) || 0), 0));
    const winner = scores[0] === scores[1] ? null : resolved.sides[scores[0] > scores[1] ? 0 : 1].teamId;
    const byTeam = {};
    resolved.sides.forEach((s, i) => { byTeam[s.teamId] = scores[i]; });
    return { winner, scores: byTeam };
}

function findSerie(cfg, t1, t2) {
    return cfg.series.find(s => (s.a === t1 && s.b === t2) || (s.a === t2 && s.b === t1)) || null;
}

/**
 * Cálculo completo del torneo.
 * @param {object} cfg - config normalizada (normalizeConfig)
 * @param {array} games - partidas desde el inicio (cualquier formato, anuladas
 *   incluidas) + las fijadas por override; cada una con players anidados.
 */
function computeTorneo(cfg, games) {
    const tagIndex = buildTagIndex(cfg);
    const inicioTs = Date.parse(cfg.inicio);
    const finTs = cfg.fin ? Date.parse(cfg.fin) : Infinity;
    const teamById = new Map(cfg.equipos.map(e => [e.id, e]));

    const ov = cfg.overrides;
    const excluded = new Set(ov.filter(o => o.tipo === 'excluir').map(o => o.gameId));
    const fixed = new Map(ov.filter(o => o.tipo === 'fijar').map(o => [o.gameId, o]));
    const manual = ov.filter(o => o.tipo === 'resultado');
    const woBySerie = new Map(ov.filter(o => o.tipo === 'wo').map(o => [Number(o.serie), o]));
    const cancelled = new Set(ov.filter(o => o.tipo === 'cancelar').map(o => Number(o.serie)));
    const drawn = new Map(ov.filter(o => o.tipo === 'empate').map(o => [Number(o.serie), o]));

    // Estado por serie: slots con sus partidas
    const seriesState = new Map(cfg.series.map(s => [s.n, {
        serie: s,
        slots: s.games.map(() => ({ games: [], manual: null })),
    }]));

    const unique = new Map();
    for (const g of games) if (g && g.game_unique_id && !unique.has(g.game_unique_id)) unique.set(g.game_unique_id, g);
    const ordered = [...unique.values()].sort((x, y) => tsOf(x) - tsOf(y));

    // 1) Clasificar cada partida
    const candidatas = [];
    const entryById = new Map();
    for (const g of ordered) {
        const resolved = resolveSides(g, cfg, tagIndex);
        const fix = fixed.get(g.game_unique_id);
        const inWindow = tsOf(g) >= inicioTs && tsOf(g) <= finTs;
        if (!resolved && !fix) continue;
        if (!fix && !inWindow) continue;

        const entry = {
            game: g,
            resolved,
            modo: modeOf(g.game_type_name),
            serie: null,
            slot: null,
            estado: null,
            motivo: null,
            result: resolved ? sideResult(g, resolved) : null,
        };
        entryById.set(g.game_unique_id, entry);
        candidatas.push(entry);

        if (!resolved) {
            entry.estado = 'revisar';
            entry.motivo = `Fijada a la serie ${fix.serie}, pero los lados no traen ${cfg.minTitulares} titulares de un equipo`;
            continue;
        }
        const serie = findSerie(cfg, resolved.sides[0].teamId, resolved.sides[1].teamId);
        if (!serie) {
            entry.estado = 'revisar';
            entry.motivo = 'No hay serie programada entre estos equipos';
            continue;
        }
        entry.serie = serie.n;

        if (excluded.has(g.game_unique_id)) { entry.estado = 'excluida'; continue; }

        if (fix) {
            if (Number(fix.serie) !== serie.n) {
                entry.estado = 'revisar';
                entry.motivo = `Fijada a la serie ${fix.serie}, pero la juegan los equipos de la serie ${serie.n}`;
                continue;
            }
            entry.slot = Number(fix.slot) - 1;
            entry.fijada = true;
            if (!serie.games[entry.slot]) {
                entry.estado = 'revisar';
                entry.motivo = `Fijada al game ${fix.slot}, pero la serie ${serie.n} solo tiene ${serie.games.length}`;
                entry.slot = null;
                continue;
            }
        } else if (g.is_voided) {
            entry.estado = 'anulada';
            entry.motivo = `Anulada por el validador (${g.void_reason || 'sin motivo'}); un admin puede fijarla`;
            continue;
        } else {
            entry.slot = null; // se decide abajo, en orden cronológico
        }
        seriesState.get(serie.n).pending = seriesState.get(serie.n).pending || [];
        seriesState.get(serie.n).pending.push(entry);
    }

    // Resultados manuales por slot (sin partida)
    for (const m of manual) {
        const st = seriesState.get(Number(m.serie));
        const idx = Number(m.slot) - 1;
        if (!st || !st.slots[idx] || !teamById.has(lower(m.ganador))) continue;
        st.slots[idx].manual = { ganador: lower(m.ganador), at: m.at || null, nota: m.nota || null, por: m.por || null };
    }

    // 2) Asignar slots y decidir resultado por serie
    const seriesOut = [];
    for (const s of cfg.series) {
        const st = seriesState.get(s.n);
        for (const entry of st.pending || []) {
            if (entry.slot === null) {
                const unknownMap = isUnknownMap(entry.game.map_name);
                const matches = s.games
                    .map((sg, i) => ({ sg, i }))
                    .filter(({ sg }) => sg.modo === entry.modo && (unknownMap || mapMatches(entry.game.map_name, sg.mapa)));
                if (matches.length === 0) {
                    entry.estado = 'revisar';
                    entry.motivo = `${entry.game.map_name || 'Mapa ?'} · ${entry.game.game_type_name || 'modo ?'} no está en la serie ${s.n}`;
                    continue;
                }
                // Modo ambiguo con mapa desconocido: primer slot sin resultado aún
                const free = matches.find(({ i }) => !st.slots[i].games.some(e => e.result.winner) && !st.slots[i].manual);
                entry.slot = (free || matches[0]).i;
            }
            st.slots[entry.slot].games.push(entry);
        }

        // Resultado de cada slot: última no-empate; las demás, reiniciadas/empates
        const counted = [];
        st.slots.forEach((slot, i) => {
            const nonDraw = slot.games.filter(e => e.result.winner);
            const winnerEntry = nonDraw[nonDraw.length - 1] || null;
            for (const e of slot.games) {
                if (e === winnerEntry) continue;
                if (!e.result.winner) e.estado = 'empate';
                else { e.estado = 'reiniciada'; e.motivo = 'Se volvió a jugar el mismo game'; }
            }
            if (slot.manual) {
                if (winnerEntry) { winnerEntry.estado = 'reiniciada'; winnerEntry.motivo = 'Reemplazada por un resultado manual'; }
                counted.push({ slot: i, winner: slot.manual.ganador, ts: Date.parse(slot.manual.at) || Infinity, manual: slot.manual });
            } else if (winnerEntry) {
                counted.push({ slot: i, winner: winnerEntry.result.winner, ts: tsOf(winnerEntry.game), entry: winnerEntry });
            }
        });

        // Orden cronológico: al llegar a la mayoría, lo que siga es "revisar"
        counted.sort((x, y) => x.ts - y.ts);
        const need = Math.floor(s.games.length / 2) + 1;
        const wins = { [s.a]: 0, [s.b]: 0 };
        let decidedBy = null;
        let decidedTs = Infinity;
        for (const c of counted) {
            if (decidedBy) {
                if (c.entry) { c.entry.estado = 'revisar'; c.entry.motivo = 'La serie ya estaba decidida'; }
                c.ignored = true;
                continue;
            }
            wins[c.winner]++;
            if (c.entry) c.entry.estado = 'cuenta';
            if (wins[c.winner] >= need) { decidedBy = c.winner; decidedTs = c.ts; }
        }
        // Empates jugados después de que la serie ya estaba decidida tampoco cuentan
        for (const slot of st.slots) for (const e of slot.games) {
            if (e.estado === 'empate' && tsOf(e.game) > decidedTs) { e.estado = 'revisar'; e.motivo = 'La serie ya estaba decidida'; }
        }

        let estado;
        let ganador = decidedBy;
        const wo = woBySerie.get(s.n);
        if (cancelled.has(s.n)) {
            estado = 'cancelada';
            ganador = null;
            for (const slot of st.slots) for (const e of slot.games) {
                if (e.estado === 'cuenta' || e.estado === 'empate') { e.estado = 'cancelada'; e.motivo = 'Serie cancelada'; }
            }
        } else if (wo && teamById.has(lower(wo.ganador)) && !decidedBy) {
            estado = 'wo';
            ganador = lower(wo.ganador);
            wins[ganador] = need;
        } else if (drawn.has(s.n) && !decidedBy) {
            estado = 'empatada';
            ganador = null;
        } else if (decidedBy) {
            estado = 'terminada';
        } else if (counted.length || st.slots.some(sl => sl.games.length)) {
            estado = 'en_curso';
        } else {
            estado = 'pendiente';
        }

        const marcador = estado === 'cancelada' ? { [s.a]: 0, [s.b]: 0 } : wins;
        seriesOut.push({
            n: s.n,
            a: s.a,
            b: s.b,
            estado,
            ganador,
            marcador,
            wo: estado === 'wo' ? { ganador, at: wo.at || null, por: wo.por || null, nota: wo.nota || null } : null,
            empate: estado === 'empatada'
                ? { at: drawn.get(s.n).at || null, por: drawn.get(s.n).por || null, nota: drawn.get(s.n).nota || null } : null,
            games: s.games.map((sg, i) => {
                const slot = st.slots[i];
                const c = counted.find(x => x.slot === i && !x.ignored);
                return {
                    slot: i + 1,
                    mapa: sg.mapa,
                    modo: sg.modo,
                    ganador: estado === 'cancelada' ? null : (c ? c.winner : null),
                    manual: c?.manual ? { ganador: c.manual.ganador, nota: c.manual.nota, por: c.manual.por } : null,
                    gameId: c?.entry ? c.entry.game.game_unique_id : null,
                    marcador: c?.entry ? c.entry.result.scores : null,
                    intentos: slot.games.map(e => ({
                        gameId: e.game.game_unique_id,
                        timestamp: e.game.timestamp,
                        estado: e.estado,
                        ganador: e.result.winner,
                        marcador: e.result.scores,
                    })),
                };
            }),
        });
    }

    // 3) Tabla por equipos
    const standings = computeStandings(cfg, seriesOut, candidatas);

    // 4) Stats individuales
    const players = computePlayers(cfg, candidatas);

    return {
        torneo: {
            id: cfg.id, nombre: cfg.nombre, activo: cfg.activo, inicio: cfg.inicio, fin: cfg.fin, bo: cfg.bo,
            equipos: cfg.equipos.map(e => ({
                id: e.id, nombre: e.nombre, color: e.color,
                jugadores: e.jugadores.map(j => ({ nombre: j.nombre, gamertags: j.gamertags, capitan: j.capitan })),
            })),
        },
        standings,
        series: seriesOut,
        players,
        candidatas: candidatas.map(e => describeCandidata(cfg, e)),
    };
}

/** Partidas jugadas que cuentan para stats (por equipo e individuales). */
function statEntries(candidatas) {
    return candidatas.filter(e => e.estado === 'cuenta' || e.estado === 'empate');
}

function computeStandings(cfg, series, candidatas) {
    const P = cfg.puntos || { victoria: 3, empate: 1, derrota: 0 };
    const rows = new Map(cfg.equipos.map(e => [e.id, {
        id: e.id, nombre: e.nombre, color: e.color,
        puntos: 0, pj: 0, pg: 0, pe: 0, pp: 0, seriesPendientes: 0, seriesCanceladas: 0,
        partidasGanadas: 0, partidasPerdidas: 0, difPartidas: 0,
        kills: 0, deaths: 0, assists: 0, kd: 0,
        desempateExtra: false,
    }]));

    const closed = s => s.estado === 'terminada' || s.estado === 'wo' || s.estado === 'empatada';
    for (const s of series) {
        const ra = rows.get(s.a), rb = rows.get(s.b);
        if (s.estado === 'cancelada') { ra.seriesCanceladas++; rb.seriesCanceladas++; continue; }
        ra.partidasGanadas += s.marcador[s.a]; ra.partidasPerdidas += s.marcador[s.b];
        rb.partidasGanadas += s.marcador[s.b]; rb.partidasPerdidas += s.marcador[s.a];
        if (!closed(s)) { ra.seriesPendientes++; rb.seriesPendientes++; continue; }
        ra.pj++; rb.pj++;
        if (s.estado === 'empatada') {
            ra.pe++; rb.pe++;
        } else {
            rows.get(s.ganador).pg++;
            rows.get(s.ganador === s.a ? s.b : s.a).pp++;
        }
    }

    for (const e of statEntries(candidatas)) {
        for (const side of e.resolved.sides) {
            const r = rows.get(side.teamId);
            for (const m of side.members) {
                r.kills += Number(m.player.kills) || 0;
                r.deaths += Number(m.player.deaths) || 0;
                r.assists += Number(m.player.assists) || 0;
            }
        }
    }

    for (const r of rows.values()) {
        r.puntos = r.pg * P.victoria + r.pe * P.empate + r.pp * P.derrota;
        r.difPartidas = r.partidasGanadas - r.partidasPerdidas;
        r.kd = r.deaths > 0 ? round2(r.kills / r.deaths) : r.kills;
    }

    // Enfrentamiento directo entre empatados: mini tabla de puntos con solo
    // las series cerradas entre ellos (con 2 equipos = quién ganó su serie).
    const directo = (ids) => {
        const set = new Set(ids);
        const pts = new Map(ids.map(id => [id, 0]));
        for (const s of series) {
            if (!set.has(s.a) || !set.has(s.b) || !closed(s)) continue;
            if (s.estado === 'empatada') {
                pts.set(s.a, pts.get(s.a) + P.empate);
                pts.set(s.b, pts.get(s.b) + P.empate);
            } else {
                const l = s.ganador === s.a ? s.b : s.a;
                pts.set(s.ganador, pts.get(s.ganador) + P.victoria);
                pts.set(l, pts.get(l) + P.derrota);
            }
        }
        return pts;
    };

    // 1) puntos, 2) dif. de games; los que siguen empatados -> 3) directo,
    // 4) más games ganados; si aun así empatan -> partida extra (se marca).
    const all = [...rows.values()].sort((x, y) =>
        (y.puntos - x.puntos) || (y.difPartidas - x.difPartidas) || x.nombre.localeCompare(y.nombre));
    const out = [];
    for (let i = 0; i < all.length;) {
        let j = i;
        while (j < all.length && all[j].puntos === all[i].puntos && all[j].difPartidas === all[i].difPartidas) j++;
        const group = all.slice(i, j);
        if (group.length > 1) {
            const pts = directo(group.map(g => g.id));
            const key = r => [pts.get(r.id), r.partidasGanadas];
            group.sort((x, y) => (pts.get(y.id) - pts.get(x.id)) || (y.partidasGanadas - x.partidasGanadas) || x.nombre.localeCompare(y.nombre));
            for (const r of group) {
                const twins = group.filter(o => o !== r && key(o).join() === key(r).join());
                if (twins.length && [r, ...twins].every(t => t.pj > 0 && t.seriesPendientes === 0)) r.desempateExtra = true;
            }
        }
        out.push(...group);
        i = j;
    }
    return out.map((r, i) => ({ pos: i + 1, ...r }));
}

/** MVP de la partida: mayor KDA ((K+A)/max(D,1)), desempate por kills. */
function mvpOf(entry) {
    let best = null;
    for (const side of entry.resolved.sides) {
        for (const m of side.members) {
            const p = m.player;
            const kda = ((Number(p.kills) || 0) + (Number(p.assists) || 0)) / Math.max(Number(p.deaths) || 0, 1);
            if (!best || kda > best.kda || (kda === best.kda && (p.kills || 0) > (best.kills || 0))) {
                best = { key: m.persona || `gt:${lower(p.gamertag)}`, kda, kills: p.kills || 0 };
            }
        }
    }
    return best && best.key;
}

function computePlayers(cfg, candidatas) {
    const teamById = new Map(cfg.equipos.map(e => [e.id, e]));
    const map = new Map();

    // Titulares primero (aparecen aunque no hayan jugado todavía)
    for (const e of cfg.equipos) {
        for (const j of e.jugadores) {
            map.set(`${e.id}:${j.nombre}`, {
                nombre: j.nombre, equipo: e.id, capitan: j.capitan, titular: true, registrado: true,
                gamertags: [], pj: 0, ganadas: 0, perdidas: 0, empates: 0,
                kills: 0, deaths: 0, assists: 0, bestSpree: 0, mvps: 0, dcs: 0, comoSuplente: 0,
            });
        }
    }

    for (const e of statEntries(candidatas)) {
        const outcomes = teamOutcomes(e.game);
        const mvp = mvpOf(e);
        for (const side of e.resolved.sides) {
            for (const m of side.members) {
                const p = m.player;
                const key = m.persona || `gt:${lower(p.gamertag)}`;
                if (!map.has(key)) {
                    map.set(key, {
                        nombre: p.gamertag, equipo: side.teamId, capitan: false, titular: false, registrado: false,
                        gamertags: [], pj: 0, ganadas: 0, perdidas: 0, empates: 0,
                        kills: 0, deaths: 0, assists: 0, bestSpree: 0, mvps: 0, dcs: 0, comoSuplente: 0,
                    });
                }
                const a = map.get(key);
                if (!a.gamertags.includes(p.gamertag)) a.gamertags.push(p.gamertag);
                a.pj++;
                const r = outcomes.get(p.gamertag);
                if (r === 'W') a.ganadas++; else if (r === 'L') a.perdidas++; else a.empates++;
                a.kills += Number(p.kills) || 0;
                a.deaths += Number(p.deaths) || 0;
                a.assists += Number(p.assists) || 0;
                a.bestSpree = Math.max(a.bestSpree, Number(p.most_kills_in_a_row) || 0);
                if (mvp === key) a.mvps++;
                if (p.completed_game === 0 || p.completed_game === false) a.dcs++;
                if (m.suplente) a.comoSuplente++;
            }
        }
    }

    return [...map.values()].map(a => ({
        ...a,
        equipoNombre: teamById.get(a.equipo)?.nombre || a.equipo,
        kd: a.deaths > 0 ? round2(a.kills / a.deaths) : a.kills,
        kda: a.deaths > 0 ? round2((a.kills + a.assists) / a.deaths) : a.kills + a.assists,
        killsPorPartida: a.pj ? round2(a.kills / a.pj) : 0,
    })).sort((x, y) => (y.pj > 0) - (x.pj > 0) || y.kda - x.kda || y.kills - x.kills || x.nombre.localeCompare(y.nombre));
}

function describeCandidata(cfg, e) {
    const g = e.game;
    const sides = e.resolved ? e.resolved.sides.map(s => ({
        equipo: s.teamId,
        puntos: e.result.scores[s.teamId],
        jugadores: s.members.map(m => ({
            gamertag: m.player.gamertag,
            nombre: m.nombre,
            suplente: m.suplente,
            registrado: m.registrado,
            dc: m.player.completed_game === 0 || m.player.completed_game === false,
            kills: m.player.kills, deaths: m.player.deaths, assists: m.player.assists, score: m.player.score,
        })),
    })) : [];
    const objetivo = e.modo ? cfg.objetivos[e.modo] : undefined;
    const winScore = e.result && e.result.winner ? e.result.scores[e.result.winner] : null;
    return {
        gameId: g.game_unique_id,
        timestamp: g.timestamp,
        mapa: g.map_name,
        modo: e.modo,
        gameType: g.game_type_name,
        duration: g.duration ?? null,
        anuladaPorValidador: !!g.is_voided,
        voidReason: g.void_reason || null,
        serie: e.serie,
        slot: e.slot === null || e.slot === undefined ? null : e.slot + 1,
        estado: e.estado,
        motivo: e.motivo,
        fijada: !!e.fijada,
        ganador: e.result ? e.result.winner : null,
        lados: sides,
        noRegistrados: sides.flatMap(s => s.jugadores.filter(j => !j.registrado).map(j => ({ gamertag: j.gamertag, equipo: s.equipo }))),
        terminoAntes: objetivo !== undefined && winScore !== null && winScore < objetivo,
    };
}

/**
 * Contexto de UNA partida dentro del torneo (caption de WhatsApp/Discord).
 * @returns {null | { serie, slot, estado, a, b, marcador, serieEstado, ganadorSerie }}
 */
function contextForGame(result, gameId) {
    const c = result.candidatas.find(x => x.gameId === gameId);
    if (!c || !c.serie) return null;
    const s = result.series.find(x => x.n === c.serie);
    if (!s) return null;
    // Marcador "a la hora de esta partida" (para que un republish del G1
    // diga 1-0 y no el resultado final de la serie).
    const at = Date.parse(c.timestamp);
    const need = Math.floor(s.games.length / 2) + 1;
    const marcador = { [s.a]: 0, [s.b]: 0 };
    for (const sg of s.games) {
        if (!sg.ganador) continue;
        const intento = sg.gameId && sg.intentos.find(i => i.gameId === sg.gameId);
        const ts = intento ? Date.parse(intento.timestamp) : -Infinity; // manual: ya contaba
        if (ts <= at) marcador[sg.ganador]++;
    }
    const ganadorSerie = [s.a, s.b].find(t => marcador[t] >= need) || null;
    return {
        serie: s.n, slot: c.slot, estado: c.estado, motivo: c.motivo, a: s.a, b: s.b,
        marcador, serieEstado: ganadorSerie ? 'terminada' : s.estado === 'terminada' ? 'en_curso' : s.estado, ganadorSerie,
    };
}

module.exports = {
    MODOS, ESTADOS_SERIE, OVERRIDE_TIPOS,
    modeOf, isUnknownMap, mapMatches, normalizeConfig, buildTagIndex, resolveSides,
    computeTorneo, contextForGame,
};
