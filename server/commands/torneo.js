/**
 * Comando !torneo: tabla del torneo activo, detalle de una serie y
 * correcciones de los organizadores desde el celular.
 *
 * Públicos:   !torneo · !torneo serie <n> · !torneo stats
 * Admins:     !torneo revisar · excluir <id> · fijar <id> <serie> <game>
 *             · resultado <serie> <game> <equipo> · wo <serie> <equipo>
 *             · cancelar <serie> · deshacer
 * Admins = admins globales del bot o los gamertags de `admins` en la config
 * del torneo vinculados a su número (domain/torneo.isTorneoAdmin).
 *
 * OJO: ninguna respuesta puede EMPEZAR con "!torneo" (el bot procesa sus
 * propios mensajes y se dispararía en bucle).
 */

'use strict';

const torneo = require('../domain/torneo');
const teams = require('../utils/teams');
const { sanitizeCaptionText } = require('../utils/matchSummary');

const clean = sanitizeCaptionText;

const ESTADO_LABEL = {
    pendiente: 'pendiente', en_curso: 'en curso', terminada: 'terminada', wo: 'W.O.', cancelada: 'cancelada',
};
const MODO_LABEL = { ctf: 'CTF', slayer: 'Slayer', oddball: 'Oddball', koth: 'KOTH' };

const USAGE = [
    'Usos del torneo:',
    '• *!torneo* — tabla de posiciones y líderes',
    '• *!torneo serie 2* — detalle de una serie',
    '• *!torneo stats* — stats individuales (top 10 por KDA)',
    '',
    'Organizadores:',
    '• *!torneo revisar* — partidas que el bot no supo acomodar',
    '• *!torneo excluir <id>* — la partida no cuenta',
    '• *!torneo fijar <id> <serie> <game>* — cuenta como ese game',
    '• *!torneo resultado <serie> <game> <equipo>* — resultado sin partida (foto)',
    '• *!torneo wo <serie> <equipo>* — W.O. de la serie',
    '• *!torneo cancelar <serie>* — la serie no se jugará',
    '• *!torneo deshacer* — quita la última corrección',
].join('\n');

function teamName(result, id) {
    return clean(result.torneo.equipos.find(e => e.id === id)?.nombre || id);
}

/** Equipo por id, nombre o nombre del capitán (case-insensitive). */
function findTeam(result, text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    return result.torneo.equipos.find(e =>
        e.id === t || e.nombre.toLowerCase() === t ||
        e.jugadores.some(j => j.capitan && j.nombre.toLowerCase() === t)) || null;
}

function formatTabla(result) {
    const lines = [`🏆 *${clean(result.torneo.nombre)}* — tabla`];
    for (const r of result.standings) {
        lines.push(`${r.pos}. *${clean(r.nombre)}* · series ${r.seriesGanadas}-${r.seriesPerdidas} · games ${r.partidasGanadas}-${r.partidasPerdidas} (${r.difPartidas >= 0 ? '+' : ''}${r.difPartidas}) · K/D ${r.kd}`);
    }
    const top = result.players.filter(p => p.pj > 0).slice(0, 5);
    if (top.length) {
        lines.push('', '*Líderes (KDA)*');
        top.forEach((p, i) => lines.push(`${i + 1}. ${clean(p.nombre)} (${teamName(result, p.equipo)}) · KDA ${p.kda} · ${p.kills}/${p.deaths}/${p.assists} · ${p.pj} PJ`));
    }
    const pend = result.series.filter(s => s.estado === 'pendiente' || s.estado === 'en_curso');
    if (pend.length) {
        lines.push('', '*Por jugar*');
        for (const s of pend) {
            const sc = s.estado === 'en_curso' ? ` (va ${s.marcador[s.a]}-${s.marcador[s.b]})` : '';
            lines.push(`Serie ${s.n}: ${teamName(result, s.a)} vs ${teamName(result, s.b)}${sc}`);
        }
    }
    const revisar = result.candidatas.filter(c => c.estado === 'revisar' || c.estado === 'anulada').length;
    if (revisar) lines.push('', `⚠️ ${revisar} partida(s) por revisar — los organizadores pueden usar *!torneo revisar*.`);
    return lines.join('\n');
}

function formatSerie(result, n) {
    const s = result.series.find(x => x.n === n);
    if (!s) return `No existe la serie ${n}. Son de la 1 a la ${result.series.length}.`;
    const lines = [`🏆 *Serie ${s.n}: ${teamName(result, s.a)} vs ${teamName(result, s.b)}* — ${ESTADO_LABEL[s.estado]}`,
        `Marcador: ${teamName(result, s.a)} ${s.marcador[s.a]}-${s.marcador[s.b]} ${teamName(result, s.b)}`];
    if (s.wo) lines.push(`W.O. a favor de ${teamName(result, s.wo.ganador)}${s.wo.por ? ` (por ${clean(s.wo.por)})` : ''}`);
    for (const g of s.games) {
        let res = 'pendiente';
        if (g.manual) res = `gana ${teamName(result, g.ganador)} (resultado manual${g.manual.por ? `, ${clean(g.manual.por)}` : ''})`;
        else if (g.ganador) res = `gana ${teamName(result, g.ganador)} ${g.marcador[g.ganador]}-${g.marcador[g.ganador === s.a ? s.b : s.a]}`;
        lines.push(`G${g.slot} ${clean(g.mapa)} ${MODO_LABEL[g.modo]}: ${res}`);
        for (const i of g.intentos.filter(x => x.gameId !== g.gameId)) {
            lines.push(`   ↳ ${i.gameId.slice(0, 8)}: ${i.estado}`);
        }
    }
    return lines.join('\n');
}

function formatStats(result) {
    const rows = result.players.filter(p => p.pj > 0).slice(0, 10);
    if (!rows.length) return 'Todavía no hay partidas del torneo.';
    return [`🏆 *${clean(result.torneo.nombre)}* — stats individuales`,
        ...rows.map((p, i) => `${i + 1}. ${clean(p.nombre)} (${teamName(result, p.equipo)}${p.titular ? '' : ', suplente'}) · KDA ${p.kda} · K/D ${p.kd} · ${p.kills}/${p.deaths}/${p.assists} · MVP ${p.mvps} · ${p.pj} PJ`),
    ].join('\n');
}

function formatRevisar(result) {
    const list = result.candidatas.filter(c => ['revisar', 'anulada'].includes(c.estado));
    const unknown = result.candidatas.flatMap(c => c.noRegistrados);
    if (!list.length && !unknown.length) return 'Nada por revisar. ✅';
    const lines = ['*Por revisar*'];
    for (const c of list) {
        const who = c.lados.map(l => teamName(result, l.equipo)).join(' vs ');
        lines.push(`• ${c.gameId.slice(0, 8)} · ${clean(c.mapa)} ${clean(c.gameType)} · ${who} · ${c.estado}: ${clean(c.motivo || '')}`);
    }
    const uniq = [...new Map(unknown.map(u => [u.gamertag.toLowerCase(), u])).values()];
    if (uniq.length) {
        lines.push('', '*Gamertags no registrados* (se agregan desde la web del torneo):');
        uniq.forEach(u => lines.push(`• ${clean(u.gamertag)} jugando con ${teamName(result, u.equipo)}`));
    }
    return lines.join('\n');
}

/** ID corto -> gameId completo entre las partidas del torneo. */
function resolveCandidata(result, shortId) {
    const id = String(shortId || '').toLowerCase();
    if (id.length < 6) return { error: 'Usa al menos 6 caracteres del ID de la partida.' };
    const hits = result.candidatas.filter(c => c.gameId.toLowerCase().startsWith(id));
    if (hits.length === 0) return { error: `No encontré la partida ${shortId} entre las del torneo.` };
    if (hits.length > 1) return { error: `El ID ${shortId} es ambiguo, usa más caracteres.` };
    return { gameId: hits[0].gameId };
}

function createTorneoHandler(ctx) {
    return async function handleTorneoCommand({ format, args, msg, senderId }) {
        const words = teams.stripMentionTokens(args || '').trim().split(/\s+/).filter(Boolean);
        const sub = (words[0] || '').toLowerCase();

        let result = await torneo.getTorneoResult(ctx, { includeInactive: true });
        if (!result) return 'No hay torneo configurado.';

        if (!sub) return formatTabla(result);
        if (sub === 'serie') return formatSerie(result, Number(words[1]));
        if (sub === 'stats') return formatStats(result);
        if (sub === 'ayuda' || sub === 'help') return USAGE;

        const ADMIN_SUBS = ['revisar', 'excluir', 'fijar', 'resultado', 'wo', 'cancelar', 'deshacer'];
        if (!ADMIN_SUBS.includes(sub)) return USAGE;

        const auth = await torneo.isTorneoAdmin(ctx, senderId, msg, format);
        if (!auth.ok) return 'Solo los organizadores del torneo pueden hacer correcciones.';
        if (sub === 'revisar') return formatRevisar(result);

        try {
            let serieN = null;
            if (sub === 'deshacer') {
                const removed = await torneo.removeOverride(ctx, null);
                if (!removed) return 'No hay correcciones que deshacer.';
                serieN = removed.serie || result.candidatas.find(c => c.gameId === removed.gameId)?.serie || null;
                result = await torneo.getTorneoResult(ctx, { includeInactive: true });
                return [`Deshecho: ${removed.tipo}${removed.gameId ? ` ${removed.gameId.slice(0, 8)}` : ''}${removed.serie ? ` serie ${removed.serie}` : ''}.`,
                    serieN ? formatSerie(result, serieN) : ''].filter(Boolean).join('\n\n');
            }

            const o = { tipo: sub };
            if (sub === 'excluir' || sub === 'fijar') {
                const r = resolveCandidata(result, words[1]);
                if (r.error) return r.error;
                o.gameId = r.gameId;
                if (sub === 'fijar') { o.serie = Number(words[2]); o.slot = Number(words[3]); }
                serieN = o.serie || result.candidatas.find(c => c.gameId === r.gameId)?.serie;
            } else if (sub === 'resultado') {
                o.serie = Number(words[1]); o.slot = Number(words[2]);
                const t = findTeam(result, words.slice(3).join(' '));
                if (!t) return 'Equipo no reconocido. Usa el nombre del equipo (ej. Tomm).';
                o.ganador = t.id;
                o.nota = 'Resultado desde WhatsApp';
            } else if (sub === 'wo') {
                o.serie = Number(words[1]);
                const t = findTeam(result, words.slice(2).join(' '));
                if (!t) return 'Equipo no reconocido. Usa el nombre del equipo (ej. Tomm).';
                o.ganador = t.id;
            } else if (sub === 'cancelar') {
                o.serie = Number(words[1]);
            }
            serieN = serieN || o.serie;

            await torneo.addOverride(ctx, o, auth.por);
            result = await torneo.getTorneoResult(ctx, { includeInactive: true });
            return [`Listo (${sub}).`, serieN ? formatSerie(result, serieN) : ''].filter(Boolean).join('\n\n');
        } catch (err) {
            if (err.status === 400 || err.status === 404) return `No se pudo: ${err.message}`;
            throw err;
        }
    };
}

module.exports = { createTorneoHandler, formatTabla, formatSerie, formatStats, formatRevisar, TORNEO_USAGE: USAGE };
