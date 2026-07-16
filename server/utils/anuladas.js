/**
 * Anulación de partidas por comando (!anular).
 *
 * Cuando una partida se inicia por error y aun así se termina (el cliente la
 * reporta como cualquier otra), no basta un W.O. ni un !rondas reset: la
 * partida ya cuenta para el marcador, la cuenta ($), el corte semanal y las
 * stats. La cura es anularla en la base (is_voided) — todas las tuberías
 * filtran anuladas — y aquí se lleva la bitácora local de esas anulaciones
 * para poder deshacerlas y para el guard anti doble-comando (mismo patrón de
 * archivo que forfeits.js: volumen montado en OUTPUT_DIR, sobrevive redeploys).
 */

const fs = require('fs');
const path = require('path');

const ANULADAS_FILE = 'anuladas.json';
const ANULAR_COOLDOWN_MS = 5 * 60 * 1000; // dos !anular en <5 min = doble reacción al mismo error

function anuladasFilePath(dir) {
    return path.join(dir, ANULADAS_FILE);
}

function emptyAnuladas() {
    return { version: 1, anuladas: [] };
}

/** Carga la bitácora; tolerante a archivo faltante o corrupto (lista vacía). */
function loadAnuladas(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(anuladasFilePath(dir), 'utf-8'));
        if (!data || !Array.isArray(data.anuladas)) return emptyAnuladas();
        const valid = data.anuladas.filter(a =>
            a && typeof a.gameId === 'string' && a.gameId.length > 0 &&
            Number.isFinite(Date.parse(a.annulledAt))
        );
        return { version: data.version || 1, anuladas: valid };
    } catch (e) {
        return emptyAnuladas();
    }
}

/** Guarda la bitácora con escritura atómica (tmp + rename). */
function saveAnuladas(dir, data) {
    const file = anuladasFilePath(dir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

/**
 * ¿Procede anular esta partida? Reglas:
 *  - debe existir una última partida válida;
 *  - guard anti doble-comando: si ya se anuló algo hace <5 min, frenar
 *    (un segundo !anular apuntaría a la partida ANTERIOR, que sí es real);
 *  - solo los que jugaron la partida pueden anularla (o un admin);
 *  - si la partida ya no es reciente (fuera de la ventana de sesión), solo admin.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateAnulacion({ game, senderTag, isAdmin, lastAnnulledAt, now = Date.now(), gapMinutes = 150 }) {
    if (!game) return { ok: false, error: 'No hay partidas que anular.' };

    if (lastAnnulledAt && now - Date.parse(lastAnnulledAt) < ANULAR_COOLDOWN_MS) {
        return { ok: false, error: 'Ya se anuló una partida hace un momento; esa ya no cuenta. Si hay que anular OTRA, esperen unos minutos y repitan el comando.' };
    }

    const players = (game.players || []).map(p => String(p.gamertag).toLowerCase());
    const inGame = senderTag && players.includes(String(senderTag).toLowerCase());
    if (!inGame && !isAdmin) {
        return { ok: false, error: 'Solo los que jugaron esa partida (o un admin) pueden anularla.' };
    }

    // Ojo: un timestamp que no parsea da NaN y la comparación < falla a
    // propósito — partida de fecha dudosa solo la anula un admin.
    const ageMs = now - new Date(game.timestamp).getTime();
    if (!isAdmin && !(ageMs < gapMinutes * 60 * 1000)) {
        return { ok: false, error: 'Esa partida ya no es de la sesión en curso; solo un admin puede anular partidas viejas.' };
    }

    return { ok: true };
}

module.exports = { loadAnuladas, saveAnuladas, validateAnulacion, ANULADAS_FILE, ANULAR_COOLDOWN_MS };
