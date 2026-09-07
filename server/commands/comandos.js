/**
 * Comando !comandos (alias !ayuda) (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

/** Comando !comandos (alias !ayuda): lista de comandos del grupo. */
function buildComandosReply(format) {
    const comunes = [
        '• *!partidas* — últimas 10 partidas',
        '• *!caracola @P1 @P2 @P3 @P4* — equipos parejos (alias *!equipos*)',
        '• *!soy <gamertag>* — regístrate con tu gamertag',
        '• *!roster* — quién está registrado',
        '• *!comandos* — esta lista (alias *!ayuda*)',
    ];
    if (format !== '2v2') {
        return [
            '*Comandos del bot*',
            ...comunes,
            '',
            'Solo admin:',
            '• *!vincula @persona <gamertag>* — registra a otra persona',
        ].join('\n');
    }
    return [
        '*Comandos del bot*',
        ...comunes,
        '• *!rondas* — marcador de la noche (rondas Bo3 y cuenta)',
        '• *!rondas reset* — marcador en ceros',
        '• *!perdida* — tu equipo da por perdida la partida en curso (W.O.)',
        '• *!anular* — anula la última partida (se jugó por error)',
        '',
        'Solo admin:',
        '• *!vincula @persona <gamertag>* — registra a otra persona',
        '• *!marcador @persona 2-1 [ronda 1-0]* — corrige el marcador si el bot se perdió partidas',
        '• *!perdida deshacer* · *!anular deshacer* · *!marcador deshacer* · *!roster unlink <gamertag>*',
    ].join('\n');
}

function createComandosHandler() {
    return async function handleComandosCommand({ format }) {
        return buildComandosReply(format);
    };
}

module.exports = { createComandosHandler, buildComandosReply };
