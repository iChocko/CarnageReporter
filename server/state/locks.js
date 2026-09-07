/**
 * Candados en proceso (Fase A2 — movido tal cual desde index.js).
 *
 * Las mutaciones de archivos compartidos (roster, W.O.) son lee-modifica-
 * escribe con awaits en medio; estos candados en proceso las serializan para
 * que dos comandos casi simultáneos no se pisen los datos.
 */

'use strict';

function makeLock() {
    let queue = Promise.resolve();
    return function withLock(fn) {
        const run = queue.then(fn, fn);
        queue = run.then(() => undefined, () => undefined);
        return run;
    };
}

module.exports = { makeLock };
