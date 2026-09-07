/**
 * Tubería de POST /api/report (Fase A2 — movida tal cual desde index.js).
 *
 * `processReport(input, ctx)` hace los pasos 1-9 en el MISMO orden y con los
 * MISMOS textos de log que antes; la ruta (server/http/routes/report.js)
 * solo hace auth/rate-limit/candado en memoria y llama aquí.
 */

'use strict';

const path = require('path');
const { logger } = require('../logger');
const { evaluateMatch } = require('../services/validator');
const { buildCaptionParts } = require('../utils/matchSummary');
const { classifyFormat } = require('../utils/format');
const { resolveMap } = require('../utils/maps');
const { currentOrLastSession, formatLiveRoundUpdate } = require('../utils/sessions');
const { getRondasGames } = require('../domain/rondas');

const reportLog = logger.child({ mod: 'report' });

// Desfase máximo de reloj (Fase B3) que se tolera sin corregir: por debajo
// de esto no vale la pena tocar el timestamp (jitter normal de red/NTP).
const CLOCK_SKEW_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * @param {{ gameData: object, players: object[], filename?: string, schemaVersion: number, clientVersion: string|null, installId?: string|null, clientSentAt?: string|null }} input
 * @param {object} ctx - contexto compartido (ver server/index.js)
 * @returns {Promise<{status: string, gameId: string, [key: string]: any}>}
 */
async function processReport({ gameData, players, filename, schemaVersion, clientVersion, installId, clientSentAt }, ctx) {
    const { supabase, renderer, discord, discord4v4, whatsapp, alerts, outputDir, gamesCache } = ctx;
    const gameId = gameData.gameUniqueId;

    // Fase B3: los clientes v3 mandan clientSentAt (hora UTC real de su
    // reloj al momento de enviar) además del timestamp de la partida (que
    // sale del reloj LOCAL leído del nombre del archivo). Si el reloj del
    // cliente está desfasado, clientSentAt también lo está — y por cuánto,
    // así que se puede corregir el timestamp de la partida en vez de solo
    // tirarlo a la hora del servidor (que pierde la hora real de la partida).
    if (schemaVersion >= 3 && typeof clientSentAt === 'string') {
        const sentMs = new Date(clientSentAt).getTime();
        const originalTsMs = new Date(gameData.timestamp).getTime();
        if (Number.isFinite(sentMs) && Number.isFinite(originalTsMs)) {
            const skewMs = sentMs - Date.now();
            if (Math.abs(skewMs) > CLOCK_SKEW_THRESHOLD_MS) {
                const adjusted = new Date(originalTsMs - skewMs).toISOString();
                reportLog.warn(`⚠️  Desfase de reloj de ${skewMs}ms en ${gameId} (clientSentAt=${clientSentAt}) — ajustando timestamp de ${gameData.timestamp} a ${adjusted}`);
                gameData.timestamp = adjusted;
            }
        }
    }

    // El timestamp viene del reloj de la máquina de cada cliente y no es
    // confiable (una llegó 6h adelantada y rompió el agrupado de sesiones).
    // El reporte llega segundos después de terminar la partida: cualquier
    // timestamp en el futuro (ya sea el original de v1/v2, o lo que quedó
    // tras el ajuste de arriba) se reemplaza por la hora del servidor como
    // salvaguarda final.
    const tsMs = new Date(gameData.timestamp).getTime();
    if (!Number.isFinite(tsMs) || tsMs > Date.now() + 10 * 60 * 1000) {
        reportLog.warn(`⚠️  Timestamp inválido o futuro en ${gameId} (${gameData.timestamp}) — se usa la hora del servidor`);
        gameData.timestamp = new Date().toISOString();
    }

    // Si el guardado en Supabase (paso 8) ya se completó y algo truena
    // DESPUÉS, la partida queda persistida pero el cliente nunca recibió
    // confirmación: estado inconsistente que amerita una alerta a Discord
    // (server/alerts.js), no solo un log.
    let gameSaved = false;

    try {
        // 1. Verificar duplicados en Supabase
        const exists = await supabase.gameExists(gameId);
        if (exists) {
            reportLog.info(`⏭️  Juego ${gameId} ya procesado, saltando`);
            return {
                status: 'duplicate',
                gameId,
                message: 'Este juego ya fue procesado anteriormente'
            };
        }

        // 2. Resolver el mapa del lado servidor (el cliente v1.5.0 manda mapCode
        //    sacado del film de autosave; el XML solo no trae el mapa).
        //    Códigos desconocidos -> placeholder + se guarda el código para mapearlo.
        const mapResolved = resolveMap({
            mapCode: gameData.mapCode,
            filename,
            mapName: gameData.mapName
        });
        gameData.mapName = mapResolved.mapName;
        const mapCode = mapResolved.mapCode;

        // 3. Clasificar formato (2v2 / 4v4 / null)
        const format = classifyFormat(players);
        const saveMeta = { schemaVersion, clientVersion, mapCode, format, installId, clientSentAt };

        // 4. Evaluar validez (formato no soportado, reinicios, abandonos, cortas)
        const verdict = evaluateMatch(gameData, players, schemaVersion);
        if (verdict.voided) {
            reportLog.info(`🚫 Partida ${gameId} anulada (${verdict.reason}) — se guarda sin publicar`);
            await supabase.saveGame(gameData, players, { ...saveMeta, isVoided: true, voidReason: verdict.reason });
            gamesCache.invalidateAll();
            return {
                status: 'voided', gameId, reason: verdict.reason,
                message: 'Partida anulada; no cuenta para stats'
            };
        }

        // 5. 2v2 en matchmaking se ignora (solo customs 2v2). 4v4 sí acepta matchmaking.
        if (format === '2v2' && gameData.isMatchmaking === true) {
            reportLog.info(`🎮 Partida ${gameId} es 2v2 matchmaking — ignorada (2v2 solo customs)`);
            return {
                status: 'skipped', gameId,
                message: 'Partida 2v2 de matchmaking ignorada'
            };
        }

        // 6. Generar PNG
        reportLog.info(`🎨 Generando imagen ${format} para partida ${gameId} (${gameData.mapName})...`);
        const pngPath = path.join(outputDir, `match_${gameId}.png`);
        await renderer.generatePNG(gameData, players, pngPath);

        // 7. Publicar según formato:
        //    2v2 -> Discord(Retas H3) + WhatsApp(Retas H3)
        //    4v4 -> Discord(validación) + WhatsApp(Torneos Halo 3)
        if (format === '2v2') {
            const dsResult = await discord.sendImage(pngPath, gameData, players);
            reportLog.info(`   ${dsResult ? '✅' : '❌'} Discord: ${dsResult ? 'Enviado' : 'Fallido'}`);
        }

        if (format === '4v4') {
            const ds4Result = await discord4v4.sendImage(pngPath, gameData, players);
            reportLog.info(`   ${ds4Result ? '✅' : '❌'} Discord (4v4): ${ds4Result ? 'Enviado' : 'Fallido'}`);
        }

        if (whatsapp.isReady()) {
            const chatId = whatsapp.groupIdFor(format);
            if (chatId) {
                const { winnerLine, mapLine, dateStr, timeStr, shortId } = buildCaptionParts(gameData, players);
                const waCaption = `🏆 *${winnerLine}*\n${mapLine}\n${dateStr} ${timeStr} hrs (CDMX)\nID: ${shortId}`;
                const waResult = await whatsapp.sendImage(pngPath, waCaption, chatId);
                reportLog.info(`   ${waResult ? '✅' : '❌'} WhatsApp (${format}): ${waResult ? 'Enviado' : 'Fallido'}`);
            } else {
                reportLog.warn(`   ⚠️  Sin grupo de WhatsApp configurado para ${format}`);
            }
        } else if (process.env.WHATSAPP_ENABLED === 'true') {
            // Que la omisión quede en el log: una sesión caída (waiting_qr)
            // pasaba días sin ninguna traza en los reportes.
            reportLog.warn(`   ⚠️  WhatsApp (${format}): omitido, servicio en estado '${whatsapp.getStatus().status}'`);
        }

        // 8. Guardar en Supabase
        await supabase.saveGame(gameData, players, saveMeta);
        gameSaved = true;
        gamesCache.invalidateAll();
        reportLog.info(`✅ Juego ${gameId} (${format}) procesado completamente`);

        // 9. Anuncio automático del marcador de la ronda (Bo3) en el grupo 2v2:
        //    cómo va la ronda en curso, o su cierre si alguien llegó a 2.
        if (format === '2v2' && whatsapp.isReady()) {
            const chatId = whatsapp.groupIdFor('2v2');
            if (chatId) {
                try {
                    const rondasGames = await getRondasGames(ctx);
                    const update = formatLiveRoundUpdate(currentOrLastSession(rondasGames));
                    if (update) {
                        const okRonda = await whatsapp.sendMessage(update, chatId);
                        reportLog.info(`   ${okRonda ? '✅' : '❌'} WhatsApp (marcador ronda): ${okRonda ? 'Enviado' : 'Fallido'}`);
                    }
                } catch (e) {
                    // El marcador es un extra: si falla, la partida ya quedó publicada y guardada
                    reportLog.warn({ err: e }, '   ⚠️  Marcador de ronda falló');
                }
            }
        }

        return { status: 'processed', gameId, format, message: 'Reporte procesado' };

    } catch (error) {
        reportLog.error({ err: error, gameId }, `❌ Error procesando ${gameId}`);
        if (gameSaved) {
            alerts.alert('error',
                `Reporte de la partida ${gameId} falló DESPUÉS de guardarse en Supabase: ${error.message}. ` +
                'La partida ya quedó persistida; revisar si publicó bien en Discord/WhatsApp.',
                { key: `report:${gameId}` });
        }
        throw error;
    }
}

module.exports = { processReport, reportLog };
