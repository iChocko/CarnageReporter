/**
 * Comando !rondas (Fase A2 — movido tal cual desde index.js).
 *
 * Marcador de la sesión en rondas ($25/ronda), con la ronda en curso en
 * vivo. EXCLUSIVO del grupo 2v2 (así se apuesta).
 */

'use strict';

const { currentOrLastSession, formatRondasMessage } = require('../utils/sessions');
const { setResetTs } = require('../utils/rondasReset');
const { getRondasGames } = require('../domain/rondas');

function createRondasHandler(ctx) {
    return async function handleRondasCommand({ format, args }) {
        if (format !== '2v2') {
            // OJO: la respuesta no puede EMPEZAR con "!rondas" — el bot procesa
            // sus propios mensajes (message_create) y se dispararía en bucle.
            return 'El comando !rondas solo funciona en el grupo de retas 2v2.';
        }
        const arg = (args || '').trim().toLowerCase();
        if (arg === 'reset') {
            setResetTs(ctx.outputDir);
            ctx.gamesCache.invalidateAll();
            return '*Marcador en ceros.* Rondas y cuenta arrancan desde ahora.\nLas partidas anteriores siguen en las stats, y las deudas de la semana siguen vivas: el corte del lunes las cobra igual.';
        }
        if (arg) {
            return 'Usos:\n• *!rondas* — marcador de la sesión (rondas Bo3 y cuenta)\n• *!rondas reset* — reinicia marcador y cuenta desde este momento';
        }
        const games = await getRondasGames(ctx);
        return formatRondasMessage(currentOrLastSession(games));
    };
}

module.exports = { createRondasHandler };
