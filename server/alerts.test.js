/**
 * Tests de server/alerts.js con un DiscordService falso (sin red): prefijo
 * por nivel, dedupe por key dentro del cooldown, y el fallback de
 * DISCORD_ALERT_WEBHOOK_URL -> DISCORD_WEBHOOK_URL.
 */

const { test } = require('node:test');
const assert = require('assert');

const { createAlerts, resolveWebhookUrl } = require('./alerts');

function fakeDiscord(impl) {
    const sent = [];
    return {
        sent,
        sendMessage: async (text) => {
            sent.push(text);
            return impl ? impl(text) : true;
        },
    };
}

test('prefija 🔴 para error, 🟠 para warn y 🟢 para info', async () => {
    const discord = fakeDiscord();
    const { alert } = createAlerts(discord);

    await alert('error', 'algo truena');
    await alert('warn', 'algo raro');
    await alert('info', 'todo bien');

    assert.strictEqual(discord.sent[0], '🔴 algo truena');
    assert.strictEqual(discord.sent[1], '🟠 algo raro');
    assert.strictEqual(discord.sent[2], '🟢 todo bien');
});

test('nivel desconocido cae al prefijo de info', async () => {
    const discord = fakeDiscord();
    const { alert } = createAlerts(discord);
    await alert('nivel-que-no-existe', 'texto');
    assert.strictEqual(discord.sent[0], '🟢 texto');
});

test('dedupe: dos alertas con la misma key dentro del cooldown solo mandan una', async () => {
    const discord = fakeDiscord();
    const { alert } = createAlerts(discord);

    const first = await alert('error', 'primera', { key: 'cron:x', cooldownMs: 60_000 });
    const second = await alert('error', 'segunda', { key: 'cron:x', cooldownMs: 60_000 });

    assert.strictEqual(first, true);
    assert.strictEqual(second, false, 'la segunda debió dedupearse');
    assert.strictEqual(discord.sent.length, 1);
    assert.strictEqual(discord.sent[0], '🔴 primera');
});

test('sin key: nunca dedupea (cada llamada manda su propio mensaje)', async () => {
    const discord = fakeDiscord();
    const { alert } = createAlerts(discord);

    await alert('warn', 'uno');
    await alert('warn', 'dos');

    assert.strictEqual(discord.sent.length, 2);
});

test('distintas keys no interfieren entre sí', async () => {
    const discord = fakeDiscord();
    const { alert } = createAlerts(discord);

    await alert('error', 'a', { key: 'cron:a' });
    await alert('error', 'b', { key: 'cron:b' });

    assert.strictEqual(discord.sent.length, 2);
});

test('pasado el cooldown, una key vuelve a poder alertar', async () => {
    const discord = fakeDiscord();
    const { alert } = createAlerts(discord);

    await alert('error', 'primera', { key: 'cron:y', cooldownMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await alert('error', 'segunda', { key: 'cron:y', cooldownMs: 10 });

    assert.strictEqual(second, true);
    assert.strictEqual(discord.sent.length, 2);
});

test('nunca lanza: si el discord falso truena, alert() resuelve false', async () => {
    const discord = { sendMessage: async () => { throw new Error('red caída'); } };
    const { alert } = createAlerts(discord);

    const ok = await alert('error', 'texto', { key: 'algo' });
    assert.strictEqual(ok, false);
});

test('si sendMessage devuelve false (webhook no configurado), alert() propaga false', async () => {
    const discord = fakeDiscord(() => false);
    const { alert } = createAlerts(discord);
    const ok = await alert('warn', 'texto');
    assert.strictEqual(ok, false);
});

test('resolveWebhookUrl: usa DISCORD_ALERT_WEBHOOK_URL si está configurado', () => {
    const url = resolveWebhookUrl({
        DISCORD_ALERT_WEBHOOK_URL: 'https://discord.com/api/webhooks/alertas',
        DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/resultados',
    });
    assert.strictEqual(url, 'https://discord.com/api/webhooks/alertas');
});

test('resolveWebhookUrl: cae a DISCORD_WEBHOOK_URL si no hay uno de alertas dedicado', () => {
    const url = resolveWebhookUrl({
        DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/resultados',
    });
    assert.strictEqual(url, 'https://discord.com/api/webhooks/resultados');
});

test('resolveWebhookUrl: undefined si no hay ninguno configurado', () => {
    assert.strictEqual(resolveWebhookUrl({}), undefined);
});
