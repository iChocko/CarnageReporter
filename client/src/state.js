'use strict';

// ============== ESTADO COMPARTIDO EN MEMORIA (Fase B4) ==============
// No confundir con settings.js (preferencias persistentes en disco): esto
// es el estado vivo del proceso que leen statusServer (GET /), statusFile
// (status.json) y --status, y que escriben watcher/reporter al procesar
// cada partida. Un solo objeto mutable compartido por referencia evita
// pasar el mismo puñado de campos por media docena de funciones.

const STATE = {
    startedAt: Date.now(),
    version: null,
    mode: null, // 'manual' | 'background'
    reportsSent: 0,
    lastReportAt: null,
    lastError: null,
    serverReachable: null,
    lastUpdateCheck: null,
};

module.exports = { STATE };
