/**
 * Registro de comandos de WhatsApp (Fase A2 — antes al final de start() en
 * index.js). `registerAll(whatsapp, ctx)` hace exactamente las mismas
 * llamadas a `whatsapp.registerCommand(...)` que antes, una por comando.
 */

'use strict';

const { createPartidasHandler } = require('./partidas');
const { createEquiposHandler } = require('./equipos');
const { createSoyHandler } = require('./soy');
const { createVinculaHandler } = require('./vincula');
const { createRosterHandler } = require('./roster');
const { createPerdidaHandler } = require('./perdida');
const { createAnularHandler } = require('./anular');
const { createRondasHandler } = require('./rondas');
const { createMarcadorHandler } = require('./marcador');
const { createComandosHandler } = require('./comandos');

/**
 * @param {import('../messaging/port').MessagingPort} whatsapp
 * @param {object} ctx - contexto compartido (ver server/index.js)
 */
function registerAll(whatsapp, ctx) {
    // Comando del grupo: !partidas -> últimas 10 partidas del formato del grupo
    // (Retas H3 -> 2v2, Torneos Halo 3 -> 4v4).
    whatsapp.registerCommand('!partidas', createPartidasHandler(ctx));

    // Comando del grupo: !caracola -> equipos parejos por skill. Acepta
    // menciones (@persona, resueltas vía roster), gamertags escritos, o mezcla,
    // y responde mencionando a los jugadores. !equipos queda como alias.
    whatsapp.registerCommand('!caracola', createEquiposHandler(ctx));
    whatsapp.registerCommand('!equipos', createEquiposHandler(ctx));

    // Roster número ↔ gamertag: autoregistro, vínculo por admin y listado
    whatsapp.registerCommand('!soy', createSoyHandler(ctx));
    whatsapp.registerCommand('!vincula', createVinculaHandler(ctx));
    whatsapp.registerCommand('!roster', createRosterHandler(ctx));

    // Comando del grupo: !perdida -> walkover de la partida en curso.
    // Cuenta para rondas y cuenta ($), nunca para stats. Solo 2v2.
    whatsapp.registerCommand('!perdida', createPerdidaHandler(ctx));

    // Comando del grupo: !anular -> anula la última partida (se jugó por
    // error): is_voided en la base, deja de contar para marcador y stats.
    whatsapp.registerCommand('!anular', createAnularHandler(ctx));

    // Comando del grupo: !rondas -> marcador de la sesión en rondas ($25/ronda),
    // con la ronda en curso en vivo. EXCLUSIVO del grupo 2v2 (así se apuesta).
    whatsapp.registerCommand('!rondas', createRondasHandler(ctx));

    // Comando del grupo: !marcador -> corrige serie/ronda cuando el bot se
    // perdió partidas (exe cerrado). Inyecta partidas de ajuste virtuales
    // que cuentan para marcador y cuenta ($), nunca para stats. Solo admin.
    whatsapp.registerCommand('!marcador', createMarcadorHandler(ctx));

    // Comando del grupo: !comandos (alias !ayuda) -> lista de comandos
    whatsapp.registerCommand('!comandos', createComandosHandler(ctx));
    whatsapp.registerCommand('!ayuda', createComandosHandler(ctx));
}

module.exports = { registerAll };
