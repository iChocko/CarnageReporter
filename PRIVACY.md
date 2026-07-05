# Privacy Policy / Política de Privacidad

_Last updated: July 2026_

## English

**What the software collects.** The Carnage Reporter desktop client reads the post-game
carnage report XML files that Halo 3 (MCC) writes to its own temporary folder
(`%USERPROFILE%\AppData\LocalLow\MCC\Temporary`). From those files it extracts:

- Xbox gamertags of the players in the match (public identifiers)
- Per-match gameplay statistics (kills, deaths, assists, score, medals, match duration)
- Match metadata (map, game type, date and time)

**Where the data goes.** This data is sent to the project's server
(`h3mccstats.cloud`) and stored in a database to power the community leaderboard and
match history. Match summaries (image + text) are posted automatically to the
community's Discord channel and WhatsApp group.

**What the software does NOT collect.** No personal information beyond public Xbox
gamertags. No chat logs, no files outside the MCC temporary folder, no telemetry,
no analytics, no advertising identifiers. The client contacts only two endpoints:
the project server (to submit match reports) and the GitHub Releases API (to check
for updates).

**Data removal.** To request deletion of your gamertag's data, open an issue at
[github.com/iChocko/CarnageReporter](https://github.com/iChocko/CarnageReporter/issues)
or ask in the community Discord. Individual matches can be removed by the maintainer.

## Español

**Qué recolecta.** El cliente de escritorio lee los archivos XML de reporte de partida
que Halo 3 (MCC) genera en su carpeta temporal, y extrae: gamertags de Xbox de los
jugadores (identificadores públicos), estadísticas de la partida (bajas, muertes,
asistencias, puntuación, medallas, duración) y metadatos (mapa, modo de juego, fecha y hora).

**A dónde van los datos.** Se envían al servidor del proyecto (`h3mccstats.cloud`) y se
almacenan en una base de datos para el leaderboard y el historial de la comunidad. Los
resúmenes de partida se publican automáticamente en el Discord y el grupo de WhatsApp
de la comunidad.

**Qué NO recolecta.** Ninguna información personal más allá del gamertag público de Xbox.
Sin chats, sin archivos fuera de la carpeta temporal de MCC, sin telemetría, sin
analytics, sin publicidad.

**Eliminación de datos.** Para solicitar la eliminación de los datos de tu gamertag, abre
un issue en GitHub o pídelo en el Discord de la comunidad.
