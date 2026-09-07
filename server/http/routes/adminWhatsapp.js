/**
 * Endpoints admin de WhatsApp: QR, status, grupos, roster, W.O., previews de
 * comandos y el corte semanal de saldos (Fase A2 — movidos tal cual desde
 * index.js).
 */

'use strict';

const express = require('express');
const { asyncHandler } = require('../errors');
const { adminAuthMiddleware } = require('../auth');
const { FORMATS } = require('../../utils/format');
const rosterStore = require('../../utils/roster');
const forfeits = require('../../utils/forfeits');
const { formatRecentGamesWhatsApp, sanitizeCaptionText } = require('../../utils/matchSummary');
const { currentOrLastSession, formatRondasMessage } = require('../../utils/sessions');
const { getRondasGames } = require('../../domain/rondas');
const { buildSaldosPayload, sendWeeklySaldos } = require('../../domain/saldos');
const { buildEquiposReply } = require('../../domain/equipos');
const { MAX_TAG_LEN } = require('../../commands/mentions');
const { WEEKLY_MESSAGE } = require('../../jobs/scheduler');
const { identityFromJid, identityKeys } = require('../../messaging/jid');

const JID_SHAPE = /^\d{5,20}@(c\.us|lid)$/;
const ID_KEY_SHAPE = /^(pn|lid):\d{4,20}$/;

function createAdminWhatsappRouter(ctx) {
    const router = express.Router();
    const adminAuth = adminAuthMiddleware(ctx.config);

    /**
     * QR de pairing como imagen PNG (abrir en el navegador y escanear).
     * 204 si no hay QR pendiente (ya emparejado o servicio apagado).
     * GET /api/admin/whatsapp/qr
     */
    router.get('/api/admin/whatsapp/qr', adminAuth, asyncHandler(async (req, res) => {
        const qr = ctx.whatsapp.getQR();
        if (!qr) {
            return res.status(204).end();
        }
        const QRCode = require('qrcode');
        const png = await QRCode.toBuffer(qr, { width: 400, margin: 2 });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(png);
    }));

    /**
     * Estado del servicio de WhatsApp.
     * GET /api/admin/whatsapp/status
     */
    router.get('/api/admin/whatsapp/status', adminAuth, (req, res) => {
        res.json(ctx.whatsapp.getStatus());
    });

    /**
     * Lista de grupos disponibles (para obtener el WHATSAPP_GROUP_ID).
     * GET /api/admin/whatsapp/groups
     */
    router.get('/api/admin/whatsapp/groups', adminAuth, asyncHandler(async (req, res) => {
        const groups = await ctx.whatsapp.listGroups();
        res.json(groups);
    }));

    /**
     * Dispara AHORA el mensaje semanal (para probar sin esperar al lunes).
     * POST /api/admin/whatsapp/test-weekly
     */
    router.post('/api/admin/whatsapp/test-weekly', adminAuth, asyncHandler(async (req, res) => {
        if (!ctx.whatsapp.isReady()) {
            return res.status(503).json({ error: 'WhatsApp no está listo' });
        }
        const chatId = ctx.whatsapp.groupIdFor('2v2');
        if (!chatId) return res.status(503).json({ error: 'Sin grupo 2v2 configurado' });
        const ok = await ctx.whatsapp.sendMessage(WEEKLY_MESSAGE, chatId);
        res.json({ status: ok ? 'sent' : 'failed', message: WEEKLY_MESSAGE });
    }));

    /**
     * Vista previa del comando !equipos SIN enviarlo al grupo.
     * GET /api/admin/whatsapp/preview-equipos?format=2v2|4v4&players=A,B,C,D
     * Con &mentions=A,B,C,D simula jugadores ya resueltos desde menciones
     * (ejercita la regla de exactamente 4 y la respuesta de emparejamientos).
     */
    router.get('/api/admin/whatsapp/preview-equipos', adminAuth, asyncHandler(async (req, res) => {
        const format = FORMATS.includes(req.query.format) ? req.query.format : '2v2';
        const mentionTags = String(req.query.mentions || '').split(',').map(s => s.trim()).filter(Boolean);
        const reply = await buildEquiposReply(ctx, format, String(req.query.players || ''), mentionTags, {
            fromMentions: mentionTags.length > 0
        });
        res.type('text/plain').send(reply);
    }));

    /**
     * Participantes del grupo de WhatsApp de un formato, con nombre visible y
     * ambas formas de JID (número y LID). Para el bootstrap del roster.
     * GET /api/admin/whatsapp/participants?format=2v2|4v4
     */
    router.get('/api/admin/whatsapp/participants', adminAuth, asyncHandler(async (req, res) => {
        if (!ctx.whatsapp.isReady()) return res.status(503).json({ error: 'WhatsApp no está listo' });
        const format = FORMATS.includes(req.query.format) ? req.query.format : '2v2';
        res.json(await ctx.whatsapp.getGroupParticipants(format));
    }));

    /**
     * Roster número ↔ gamertag persistido.
     * GET  /api/admin/whatsapp/roster            -> estado actual
     * POST /api/admin/whatsapp/roster            -> siembra/actualiza vínculos
     *      Body: { links: [{ jids: ["521...@c.us", ...], gamertag, known? }], replace? }
     *      o, formato nuevo (Fase A3): { links: [{ ids: ["pn:521...", "lid:1234"], gamertag, known? }] }
     *      Con replace=true sustituye el roster completo; si no, hace merge.
     */
    router.get('/api/admin/whatsapp/roster', adminAuth, (req, res) => {
        res.json(rosterStore.loadRoster(ctx.outputDir));
    });

    /**
     * W.O. declarados con !perdida (partidas virtuales del marcador de rondas).
     * GET /api/admin/whatsapp/forfeits
     */
    router.get('/api/admin/whatsapp/forfeits', adminAuth, (req, res) => {
        res.json(forfeits.loadForfeits(ctx.outputDir));
    });

    /**
     * Vista previa del corte semanal SIN enviarlo ni reiniciar nada.
     * GET /api/admin/whatsapp/preview-saldos
     */
    router.get('/api/admin/whatsapp/preview-saldos', adminAuth, asyncHandler(async (req, res) => {
        const { payload, gamesCount } = await buildSaldosPayload(ctx);
        res.type('text/plain').send(payload ? payload.text : `(sin retas pendientes: ${gamesCount} partidas)`);
    }));

    /**
     * Dispara AHORA el corte semanal: envío real al grupo + reset del marcador.
     * Para correrlo a mano si el cron del lunes se perdió por un reinicio, o
     * para probar el envío real sin adelantar el corte (Body: { skipReset: true }
     * — manda el mensaje real pero deja el marcador de rondas intacto).
     * POST /api/admin/whatsapp/send-saldos
     */
    router.post('/api/admin/whatsapp/send-saldos', adminAuth, asyncHandler(async (req, res) => {
        res.json(await sendWeeklySaldos(ctx, {
            force: req.body?.force === true,
            skipReset: req.body?.skipReset === true
        }));
    }));

    /**
     * Anuncio operativo al grupo (avisos de nuevas versiones del cliente, etc.).
     * POST /api/admin/whatsapp/announce  Body: { text, format? ('2v2'|'4v4') }
     */
    router.post('/api/admin/whatsapp/announce', adminAuth, asyncHandler(async (req, res) => {
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) return res.status(400).json({ error: 'Falta text' });
        if (text.length > 4000) return res.status(400).json({ error: 'Texto demasiado largo' });
        // El bot procesa sus propios mensajes (message_create): un anuncio que
        // empiece con "!" dispararía un comando en bucle.
        if (text.startsWith('!')) return res.status(400).json({ error: 'El anuncio no puede empezar con "!"' });
        if (!ctx.whatsapp.isReady()) return res.status(503).json({ error: 'WhatsApp no está listo' });
        const format = req.body?.format === '4v4' ? '4v4' : '2v2';
        const chatId = ctx.whatsapp.groupIdFor(format);
        if (!chatId) return res.status(503).json({ error: `Sin grupo ${format} configurado` });
        const ok = await ctx.whatsapp.sendMessage(text, chatId, { waitUntilMsgSent: true });
        res.json({ sent: ok, format });
    }));

    router.post('/api/admin/whatsapp/roster', adminAuth, asyncHandler(async (req, res) => {
        const links = Array.isArray(req.body?.links) ? req.body.links : null;
        if (!links) return res.status(400).json({ error: 'Body esperado: { links: [{ jids, gamertag }] }' });
        if (links.length > 100) return res.status(400).json({ error: 'Máximo 100 vínculos por llamada' });

        const payload = await ctx.locks.withRosterLock(async () => {
            const data = req.body.replace === true
                ? { version: 2, links: [] }
                : rosterStore.loadRoster(ctx.outputDir);

            const results = [];
            for (const raw of links) {
                // Formato nuevo (ids: claves de Identity) o viejo (jids: JIDs crudos).
                const idKeys = Array.isArray(raw?.ids)
                    ? raw.ids.filter(Boolean).map(String).filter(k => ID_KEY_SHAPE.test(k))
                    : (Array.isArray(raw?.jids) ? raw.jids : [raw?.jid])
                        .filter(Boolean).map(String).filter(j => JID_SHAPE.test(j))
                        .flatMap(j => identityKeys(identityFromJid(j)));
                const gamertag = sanitizeCaptionText(String(raw?.gamertag || '')).trim();
                if (!idKeys.length || !gamertag || gamertag.length > MAX_TAG_LEN || gamertag.startsWith('!')) {
                    results.push({ gamertag: gamertag || null, ok: false, error: 'ids/jids con forma inválida y/o gamertag inválido' });
                    continue;
                }
                const result = rosterStore.linkJid(data, idKeys[0], gamertag, {
                    known: raw?.known !== false,
                    by: 'admin-api'
                });
                if (result.ok) {
                    for (const alias of idKeys.slice(1)) rosterStore.addAlias(result.link, alias);
                }
                results.push({ gamertag, ok: result.ok, conflict: result.conflict?.gamertag });
            }

            rosterStore.saveRoster(ctx.outputDir, data);
            return { status: 'ok', total: data.links.length, results };
        });
        res.json(payload);
    }));

    /**
     * Vista previa del comando !rondas SIN enviarlo al grupo.
     * GET /api/admin/whatsapp/preview-rondas
     */
    router.get('/api/admin/whatsapp/preview-rondas', adminAuth, asyncHandler(async (req, res) => {
        const games = await getRondasGames(ctx);
        res.type('text/plain').send(formatRondasMessage(currentOrLastSession(games)));
    }));

    /**
     * Vista previa del texto del comando !partidas SIN enviarlo al grupo.
     * GET /api/admin/whatsapp/preview-partidas?format=2v2|4v4
     */
    router.get('/api/admin/whatsapp/preview-partidas', adminAuth, asyncHandler(async (req, res) => {
        const format = FORMATS.includes(req.query.format) ? req.query.format : '2v2';
        const games = await ctx.gamesCache.getRecentGamesWithPlayers(10, format);
        res.type('text/plain').send(formatRecentGamesWhatsApp(games));
    }));

    return router;
}

module.exports = { createAdminWhatsappRouter };
