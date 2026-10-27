/**
 * Torneo activo: carga de la config (output/torneo.json), lectura de sus
 * partidas vía gamesCache, overrides del admin y textos derivados (caption
 * de la partida). La lógica de cálculo vive en utils/torneo.js (pura).
 *
 * La config es un JSON en OUTPUT_DIR (volumen montado, sobrevive redeploys
 * y entra al backup diario de output/*.json), igual que forfeits/ajustes.
 * Sin archivo -> no hay torneo activo y nada de esto se nota.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const { readJson, writeJsonAtomic } = require('../state/jsonStore');
const { normalizeConfig, computeTorneo, contextForGame, OVERRIDE_TIPOS } = require('../utils/torneo');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { logger } = require('../logger');

const log = logger.child({ mod: 'torneo' });

const TORNEO_FILE = 'torneo.json';

function torneoFilePath(dir) {
    return path.join(dir, TORNEO_FILE);
}

/** Config cruda tal cual está en disco (o null). */
function loadRawConfig(dir) {
    return readJson(torneoFilePath(dir), null);
}

/**
 * Config normalizada, o null si no hay archivo o si está rota (se loguea:
 * una config mala nunca debe tumbar el reporte de partidas).
 */
function loadConfig(dir) {
    const raw = loadRawConfig(dir);
    if (!raw) return null;
    try {
        return normalizeConfig(raw);
    } catch (err) {
        log.error({ err }, `torneo.json inválido: ${err.message}`);
        return null;
    }
}

/** Valida y guarda la config completa (PUT del admin). Conserva overrides si no vienen. */
function saveConfig(dir, raw) {
    const prev = loadRawConfig(dir);
    const next = { ...raw };
    if (!Array.isArray(next.overrides)) next.overrides = prev?.overrides || [];
    normalizeConfig(next); // lanza si está mal
    writeJsonAtomic(torneoFilePath(dir), next);
    return next;
}

function withLock(ctx, fn) {
    const lock = ctx.locks?.withTorneoLock;
    return lock ? lock(fn) : fn();
}

/**
 * Calcula el estado del torneo activo.
 * @returns {Promise<null | ReturnType<typeof computeTorneo>>}
 */
async function getTorneoResult(ctx, { includeInactive = false } = {}) {
    const cfg = loadConfig(ctx.outputDir);
    if (!cfg || (!cfg.activo && !includeInactive)) return null;

    const games = await ctx.gamesCache.getGamesWithPlayersSince(cfg.inicio);
    // Partidas fijadas por un admin que quedaron fuera de la ventana (antes
    // del inicio): se leen una por una, son excepcionales.
    const have = new Set(games.map(g => g.game_unique_id));
    const extra = [];
    for (const o of cfg.overrides.filter(x => x.tipo === 'fijar' && !have.has(x.gameId))) {
        try {
            const rec = await ctx.supabase.getGameWithPlayers(o.gameId);
            if (rec) extra.push({ ...rec.game, players: rec.players });
        } catch (err) {
            log.warn({ err, gameId: o.gameId }, 'No se pudo leer una partida fijada');
        }
    }
    return computeTorneo(cfg, [...games, ...extra]);
}

/**
 * Agrega un override. `o` = { tipo, gameId?, serie?, slot?, ganador?, nota? }.
 * Valida contra la config (serie/slot/equipo existentes) y devuelve el
 * override guardado (con id, autor y fecha).
 */
async function addOverride(ctx, o, por) {
    return withLock(ctx, async () => {
        const raw = loadRawConfig(ctx.outputDir);
        if (!raw) throw Object.assign(new Error('No hay torneo configurado'), { status: 404 });
        const cfg = normalizeConfig(raw);

        const tipo = String(o?.tipo || '');
        if (!OVERRIDE_TIPOS.includes(tipo)) {
            throw Object.assign(new Error(`tipo debe ser uno de: ${OVERRIDE_TIPOS.join(', ')}`), { status: 400 });
        }
        const bad = msg => Object.assign(new Error(msg), { status: 400 });
        const serie = o.serie !== undefined ? cfg.series.find(s => s.n === Number(o.serie)) : null;
        const entry = { id: crypto.randomUUID().slice(0, 8), tipo, por: por || 'admin', at: new Date().toISOString() };
        if (o.nota) entry.nota = String(o.nota).slice(0, 200);

        if (tipo === 'excluir' || tipo === 'fijar') {
            if (!o.gameId) throw bad('Falta gameId');
            entry.gameId = String(o.gameId);
        }
        if (['fijar', 'resultado', 'wo', 'cancelar'].includes(tipo)) {
            if (!serie) throw bad(`No existe la serie ${o.serie}`);
            entry.serie = serie.n;
        }
        if (tipo === 'fijar' || tipo === 'resultado') {
            const slot = Number(o.slot);
            if (!serie.games[slot - 1]) throw bad(`La serie ${serie.n} no tiene game ${o.slot}`);
            entry.slot = slot;
        }
        if (tipo === 'resultado' || tipo === 'wo') {
            const g = String(o.ganador || '').toLowerCase();
            if (g !== serie.a && g !== serie.b) throw bad(`El ganador debe ser ${serie.a} o ${serie.b}`);
            entry.ganador = g;
        }

        // Un override nuevo sobre lo mismo reemplaza al anterior
        const sameTarget = x => x.tipo === tipo && (
            (entry.gameId && x.gameId === entry.gameId) ||
            (!entry.gameId && x.serie === entry.serie && (entry.slot === undefined || x.slot === entry.slot)));
        raw.overrides = (Array.isArray(raw.overrides) ? raw.overrides : []).filter(x => !sameTarget(x));
        if (tipo === 'fijar') raw.overrides = raw.overrides.filter(x => !(x.tipo === 'excluir' && x.gameId === entry.gameId));
        if (tipo === 'excluir') raw.overrides = raw.overrides.filter(x => !(x.tipo === 'fijar' && x.gameId === entry.gameId));
        raw.overrides.push(entry);
        writeJsonAtomic(torneoFilePath(ctx.outputDir), raw);
        ctx.gamesCache.invalidateAll();
        log.info({ override: entry }, `Override del torneo: ${tipo}`);
        return entry;
    });
}

/** Quita un override por id (o el último si id es null). Devuelve el quitado o null. */
async function removeOverride(ctx, id) {
    return withLock(ctx, async () => {
        const raw = loadRawConfig(ctx.outputDir);
        if (!raw || !Array.isArray(raw.overrides) || raw.overrides.length === 0) return null;
        const idx = id ? raw.overrides.findIndex(x => x.id === id) : raw.overrides.length - 1;
        if (idx < 0) return null;
        const [removed] = raw.overrides.splice(idx, 1);
        writeJsonAtomic(torneoFilePath(ctx.outputDir), raw);
        ctx.gamesCache.invalidateAll();
        log.info({ override: removed }, 'Override del torneo eliminado');
        return removed;
    });
}

/** Asigna un gamertag (cuenta alterna) a un jugador del torneo. */
async function addGamertag(ctx, { equipo, jugador, gamertag }) {
    return withLock(ctx, async () => {
        const raw = loadRawConfig(ctx.outputDir);
        if (!raw) throw Object.assign(new Error('No hay torneo configurado'), { status: 404 });
        const tag = String(gamertag || '').trim();
        const team = (raw.equipos || []).find(e => String(e.id).toLowerCase() === String(equipo || '').toLowerCase());
        const player = team && team.jugadores.find(j => j.nombre.toLowerCase() === String(jugador || '').toLowerCase());
        if (!tag || !player) throw Object.assign(new Error('Equipo, jugador o gamertag inválido'), { status: 400 });
        player.gamertags = [...new Set([...(player.gamertags || []), tag])];
        try {
            normalizeConfig(raw);
        } catch (err) {
            throw Object.assign(err, { status: 400 });
        }
        writeJsonAtomic(torneoFilePath(ctx.outputDir), raw);
        ctx.gamesCache.invalidateAll();
        return { equipo: team.id, jugador: player.nombre, gamertags: player.gamertags };
    });
}

/**
 * Línea extra para el caption de una partida del torneo, o null.
 * Nunca lanza: si algo falla, el caption sale normal.
 * @param {'whatsapp'|'discord'} platform
 */
async function captionLineFor(ctx, gameId, platform = 'whatsapp') {
    try {
        const result = await getTorneoResult(ctx);
        if (!result) return null;
        const c = contextForGame(result, gameId);
        if (!c) return null;
        const name = id => sanitizeCaptionText(result.torneo.equipos.find(e => e.id === id)?.nombre || id);
        const head = `🏆 ${sanitizeCaptionText(result.torneo.nombre)} · Serie ${c.serie}`;
        const bold = t => (platform === 'discord' ? `**${t}**` : `*${t}*`);

        if (c.estado === 'cuenta') {
            const score = `${name(c.a)} ${c.marcador[c.a]}-${c.marcador[c.b]} ${name(c.b)}`;
            if (c.serieEstado === 'terminada') {
                const w = c.ganadorSerie;
                const l = w === c.a ? c.b : c.a;
                return `${head} · Game ${c.slot} · ${bold(`Gana ${name(w)} ${c.marcador[w]}-${c.marcador[l]}`)}`;
            }
            return `${head} · Game ${c.slot} · ${score}`;
        }
        if (c.estado === 'empate') return `${head} · Game ${c.slot} · Empate, se repite`;
        if (c.estado === 'revisar') return `${head} · ⚠️ Partida por revisar: ${sanitizeCaptionText(c.motivo || '')}`;
        return null;
    } catch (err) {
        log.warn({ err, gameId }, 'No se pudo calcular la línea del torneo para el caption');
        return null;
    }
}

/**
 * ¿Puede administrar el torneo? Admin global del bot, o un gamertag de
 * `admins` en la config vinculado (roster) al número que manda el comando.
 */
async function isTorneoAdmin(ctx, senderId, msg, format) {
    // require perezoso: commands/* depende de servicios de WhatsApp que el
    // resto del dominio no necesita cargar.
    const { isAdminSender } = require('../commands/admin');
    if (await isAdminSender(ctx, senderId, msg, format)) return { ok: true, por: 'admin' };
    const cfg = loadConfig(ctx.outputDir);
    if (!cfg || !cfg.admins.length) return { ok: false };
    const { resolveSenderTag } = require('../commands/mentions');
    const tag = await resolveSenderTag(ctx, senderId);
    if (tag && cfg.admins.some(a => a.toLowerCase() === tag.toLowerCase())) return { ok: true, por: tag };
    return { ok: false };
}

module.exports = {
    TORNEO_FILE, loadConfig, loadRawConfig, saveConfig, getTorneoResult,
    addOverride, removeOverride, addGamertag, captionLineFor, isTorneoAdmin,
};
