'use strict';

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const MAPS = require('./maps');

// fast-xml-parser >=4.4 coerce el texto "true"/"false" a booleanos reales,
// así que las comparaciones `=== 'true'` que antes funcionaban (cuando el
// valor llegaba como string) ahora son siempre false. toBool acepta ambas
// formas para no depender de la versión/configuración del parser.
const toBool = v => v === true || v === 'true' || v === 1 || v === '1';

function getMapName(filename, gameData = {}) {
    const fn = filename.toLowerCase();
    for (const [key, val] of Object.entries(MAPS)) {
        if (fn.includes(key)) return val;
    }

    // Ignorar tokens de localización sin resolver (ej. "$MP_H3TeamDoubles_Title")
    if (gameData.hopperName && gameData.hopperName !== 'Unknown' && gameData.hopperName !== ''
        && !gameData.hopperName.startsWith('$')) {
        return gameData.hopperName;
    }

    if (fn.includes('mpcarnagereport')) return 'Halo 3 Match';
    return 'Halo 3 Map';
}

// El XML de carnage report NO trae el mapa (ni en su contenido ni en el nombre
// de archivo: llega como "mpcarnagereport*.xml"). La única fuente por partida
// es el film que MCC autoguarda durante el juego en Halo3/autosave/, cuyo
// nombre SÍ lleva el código del mapa: "asq_warehou_2B3D71C8_6A5319E9.film".
// Los sufijos son grupos de 8 hex (hash/id) que hay que quitar.
const FILM_MAX_AGE_MS = 30 * 60 * 1000; // un film más viejo no es de esta partida

function extractMapCodeFromFilmName(name) {
    const base = name.toLowerCase()
        .replace(/\.(film|temp)$/, '')
        .replace(/(_[0-9a-f]{8})+$/, '');
    return /^asq_[a-z0-9_]+$/.test(base) ? base : null;
}

function findMapCodeFromFilms(xmlDir) {
    try {
        const autosaveDir = path.join(xmlDir, 'Halo3', 'autosave');
        const candidates = fs.readdirSync(autosaveDir)
            .filter(f => /^asq_.*\.(film|temp)$/i.test(f))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(autosaveDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        if (candidates.length === 0) return null;
        if (Date.now() - candidates[0].mtime > FILM_MAX_AGE_MS) return null;
        return extractMapCodeFromFilmName(candidates[0].name);
    } catch {
        return null;
    }
}

function parseTimestampFromFilename(filename) {
    const match = filename.match(/(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
    if (match) {
        const parts = match[1].split('-');
        return new Date(
            parseInt(parts[0]),
            parseInt(parts[1]) - 1,
            parseInt(parts[2]),
            parseInt(parts[3]),
            parseInt(parts[4]),
            parseInt(parts[5])
        );
    }
    return new Date();
}

function parseXML(filePath) {
    const xmlContent = fs.readFileSync(filePath, 'utf-8');
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: ''
    });
    const result = parser.parse(xmlContent);
    const root = result.CarnageReport || result.MultiplayerCarnageReport || result;

    const hopperName = root.HopperName?.HopperName || 'Unknown';
    const mapNameFromXML = root.MapName?.MapName || root.MapName;

    const gameData = {
        gameUniqueId: root.GameUniqueId?.GameUniqueId || 'unknown',
        gameEnum: parseInt(root.GameEnum?.mGameEnum || 0),
        isMatchmaking: toBool(root.IsMatchmaking?.IsMatchmaking),
        isTeamsEnabled: toBool(root.IsTeamsEnabled?.IsTeamsEnabled),
        hopperName: hopperName,
        gameTypeName: root.GameTypeName?.GameTypeName || 'Slayer',
        timestamp: parseTimestampFromFilename(path.basename(filePath)),
        // v2: flags de completitud de la partida
        lastMatchIncomplete: toBool(root.mLastMatchIncomplete?.mLastMatchIncomplete),
        partySize: parseInt(root.mPartySize?.mPartySize || 0),
    };

    const mapFromName = getMapName(path.basename(filePath), gameData);
    if (mapFromName !== 'Halo 3 Match' && mapFromName !== 'Halo 3 Map') {
        gameData.mapName = mapFromName;
    } else if (mapNameFromXML && mapNameFromXML !== 'Unknown' && mapNameFromXML !== '') {
        gameData.mapName = mapNameFromXML;
    } else {
        gameData.mapName = mapFromName;
    }

    // v1.5.0: mandar el CÓDIGO crudo del mapa. El nombre del XML nunca lo trae
    // (siempre es "mpcarnagereport*"), así que la fuente real es el film de
    // autosave más reciente. El servidor lo traduce a nombre bonito y recopila
    // los códigos desconocidos. Sin film reciente -> null.
    const codeMatch = path.basename(filePath).toLowerCase().match(/asq_[a-z0-9_]+/);
    gameData.mapCode = (codeMatch ? codeMatch[0] : null)
        || findMapCodeFromFilms(path.dirname(filePath));
    if (gameData.mapCode && MAPS[gameData.mapCode]) {
        gameData.mapName = MAPS[gameData.mapCode];
    }

    const playersNode = root.Players?.Player;
    const players = (Array.isArray(playersNode) ? playersNode : [playersNode]).filter(Boolean).map(p => {
        // v2: medallas — solo las que tienen conteo > 0 (de 384 posibles quedan pocas)
        const medalsNode = p.MedalsCount?.Medal;
        const medals = (Array.isArray(medalsNode) ? medalsNode : [medalsNode])
            .filter(Boolean)
            .map(m => ({ id: parseInt(m.mId || 0), count: parseInt(m.mCount || 0) }))
            .filter(m => m.count > 0);

        return {
            xboxUserId: p.mXboxUserId || '',
            gamertag: p.mGamertagText || 'Unknown',
            clanTag: p.ClantagText || '',
            serviceId: p.ServiceId || '',
            teamId: parseInt(p.mTeamId || 0),
            score: parseInt(p.Score || 0),
            standing: parseInt(p.mStanding || 0),
            kills: parseInt(p.mKills || 0),
            deaths: parseInt(p.mDeaths || 0),
            assists: parseInt(p.mAssists || 0),
            betrayals: parseInt(p.mBetrayals || 0),
            suicides: parseInt(p.mSuicides || 0),
            mostKillsInARow: parseInt(p.mMostKillsInARow || 0),
            // v2: duración y completitud por jugador
            secondsPlayed: parseInt(p.mSecondsPlayed || 0),
            secondsAlive: parseInt(p.mSecondsAlive || 0),
            completedGame: p.mCompletedGame !== undefined ? parseInt(p.mCompletedGame) : null,
            // v2: desglose de kills por tipo
            killsWeapon: parseInt(p.mKillsWeapon || 0),
            killsGrenade: parseInt(p.mKillsGrenade || 0),
            killsMelee: parseInt(p.mKillsMelee || 0),
            killsOther: parseInt(p.mKillsOther || 0),
            isGuest: toBool(p.isGuest),
            medals: medals
        };
    });

    // v2: duración de la partida = el mayor tiempo jugado entre los presentes
    gameData.duration = players.reduce((max, p) => Math.max(max, p.secondsPlayed || 0), 0);

    return { gameData, players };
}

module.exports = {
    parseXML,
    getMapName,
    extractMapCodeFromFilmName,
    findMapCodeFromFilms,
    parseTimestampFromFilename,
    toBool,
    FILM_MAX_AGE_MS
};
