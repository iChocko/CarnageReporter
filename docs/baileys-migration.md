# Migración de WhatsApp: whatsapp-web.js -> Baileys (Fase A5)

Desde la Fase A3, todo el server programa contra `MessagingPort`
(`server/messaging/port.js`), no contra un cliente de WhatsApp en concreto.
Eso es lo que hace posible esta migración sin tocar comandos ni pipeline: el
adaptador de Baileys (`server/messaging/adapters/baileys.js`) implementa el
mismo contrato que el de whatsapp-web.js (`adapters/wwebjs.js`).

**Por qué migrar**: whatsapp-web.js corre un Chromium real por dentro
(Puppeteer) para simular WhatsApp Web en un navegador — pesado, frágil ante
cambios de la interfaz web de WhatsApp, y consume memoria que en un VPS
compartido importa. Baileys habla el protocolo nativo de WhatsApp
directamente (sin navegador), es mucho más ligero, y su desarrollo está más
activo.

**Cómo NO se hace**: nunca se apaga wwebjs y se prende baileys de un salto.
El camino es: **sombra -> piloto -> cutover -> (rollback si algo sale mal)**,
cada paso reversible con un cambio de env var.

## Piezas nuevas (qué es cada cosa)

- `WHATSAPP_TRANSPORT=baileys` — usa Baileys como transporte PRIMARIO (el
  que de verdad manda mensajes al grupo real). Es el "cutover".
- `WHATSAPP_SHADOW_TRANSPORT=baileys` — corre un SEGUNDO puerto de Baileys en
  paralelo al primario, en modo SOLO LECTURA: recibe y loggea todo (incluida
  la comparación contra lo que vio el primario, ver "Cómo leer shadow.compare"
  abajo) pero jamás manda nada de verdad. Es el "sombra".
- `WHATSAPP_BAILEYS_AUTH_DIR` — subcarpeta de sesión de Baileys dentro de
  `WHATSAPP_AUTH_DIR` (default `baileys`). La instancia sombra SIEMPRE usa
  `baileys-shadow`, sin importar esta variable — nunca comparten sesión (dos
  procesos de WhatsApp con la MISMA sesión se pisan y se desloguean solos).
- `WHATSAPP_PILOT` + `WHATSAPP_GROUP_ID_TEST` — para un contenedor PILOTO
  aparte (ver más abajo), no para producción: mapea un grupo de WhatsApp de
  prueba (uno donde solo estés tú, o tú y un par de personas de confianza) a
  formato `2v2`, para poder correr comandos reales de punta a punta sin
  arriesgar el grupo real (Retas H3).

## Paso 1 — Modo sombra (en el MISMO contenedor de producción)

El modo sombra corre DENTRO del contenedor de producción existente
(`carnage-dashboard`), en paralelo al wwebjs real, sin arriesgar nada: el
puerto sombra nunca puede mandar un mensaje (`SendError('read_only')` si algo
intentara usarlo para enviar).

1. En el VPS, backup del `.env` de producción:
   ```bash
   ssh <host>
   cd /root/carnage-reporter-docker
   cp .env .env.bak.$(date +%s)
   ```
2. Agrega al `.env` de producción (append, no reescribas el archivo):
   ```
   WHATSAPP_SHADOW_TRANSPORT=baileys
   ```
   (`WHATSAPP_TRANSPORT` se queda como está — default `wwebjs` — el sombra
   NO reemplaza nada todavía.)
3. Reinicia el contenedor para que tome el env nuevo:
   ```bash
   docker compose up -d
   ```
4. La primera vez, Baileys (sombra) no tiene sesión: pide un QR nuevo,
   DISTINTO al de wwebjs (son sesiones separadas — tendrás que escanearlo con
   un número de WhatsApp, puede ser el mismo bot en otro dispositivo vinculado
   o un número aparte). Dos formas de conseguir el QR:
   - `docker logs -f carnage-dashboard` — el QR sale en ASCII en los logs
     (buscar el bloque "ESCANEA ESTE CÓDIGO QR (Baileys)").
   - `GET /api/admin/whatsapp/qr?transport=shadow` (con el header
     `X-Admin-Key`) — devuelve el QR como PNG, igual que el endpoint normal
     pero apuntando al transporte sombra.
   También se puede pedir un pairing code en vez de QR:
   `POST /api/admin/whatsapp/pairing-code` con body
   `{ "phone": "<número con lada>", "transport": "shadow" }`.
5. Una vez pareado, el sombra queda escuchando el MISMO grupo real (usa la
   misma config `WHATSAPP_GROUP_ID`/`WHATSAPP_GROUP_ID_4V4` que el primario) y
   por cada mensaje que vea, loggea dos líneas (JSON, vía `docker logs`):
   - `"msg":"shadow.message"` — lo que Baileys interpretó del mensaje
     (`id`, `chatId`, `format`, `senderKeys`, `text`, `mentionKeys`).
   - `"msg":"shadow.compare"` (solo si el primario YA vio el mismo `id`) —
     `{ id, match: boolean, sender, text, mentions }`. `match:false` es la
     señal de que investigar: Baileys interpretó ese mensaje distinto a como
     lo interpretó wwebjs (mención resuelta diferente, texto distinto por un
     wrapper que no se desenvolvió bien, etc.).
6. `GET /api/health` reporta `checks.whatsappShadow` (`{state, transport}`)
   mientras el sombra esté configurado — para confirmar de un vistazo que
   sigue `ready` sin tener que buscarlo en logs.

Déjalo corriendo así unos días de tráfico real (retas normales del grupo) y
revisa `shadow.compare` de vez en cuando (`docker logs carnage-dashboard |
grep shadow.compare`). El objetivo es ver `match:true` consistentemente antes
de pasar al piloto.

## Paso 2 — Piloto (contenedor APARTE, nunca el de producción)

El piloto es donde Baileys manda mensajes DE VERDAD por primera vez — pero a
un grupo de prueba, no al real. Corre en su propio contenedor Docker, con su
propio `.env`, su propio volumen de auth y de `output/`, y **sin puerto
publicado** (nadie de fuera debe poder pegarle).

Plantilla: `scripts/docker-compose.pilot.yml` (léela primero, trae los
comentarios de cada decisión). Pasos:

```bash
# En el VPS, junto al directorio de producción:
mkdir -p /root/carnage-reporter-pilot
cp scripts/docker-compose.pilot.yml /root/carnage-reporter-pilot/docker-compose.yml
cp /root/carnage-reporter-docker/.env /root/carnage-reporter-pilot/.env
```

Edita `/root/carnage-reporter-pilot/.env`:
```
WHATSAPP_TRANSPORT=baileys
WHATSAPP_SHADOW_TRANSPORT=          # vacío: el piloto no necesita su propio sombra
WHATSAPP_PILOT=true
WHATSAPP_GROUP_ID_TEST=<id del grupo de prueba, ej. 1203xxxxxxxx@g.us>
OUTBOX_ENABLED=false                # el piloto no comparte la tabla outbox con producción
```

`WHATSAPP_GROUP_ID_TEST` se mapea a formato `2v2` (en vez de
`WHATSAPP_GROUP_ID`) SOLO cuando `WHATSAPP_PILOT=true` — así el mismo `.env`
de producción sirve de base sin tener que reescribir `WHATSAPP_GROUP_ID`.

```bash
cd /root/carnage-reporter-pilot
docker compose up -d
docker logs -f carnage-pilot   # QR/pairing igual que en el paso 1
```

Con el piloto pareado y listo, prueba TODOS los comandos reales en el grupo
de prueba: `!comandos`, `!soy`, `!vincula`, `!rondas`, `!caracola`,
`!perdida`, `!anular`, `!marcador`. Confirma que las menciones etiquetan bien
(el puente lid↔teléfono de Baileys es la parte más nueva/frágil) y que los
reportes de partidas (si le apuntas manualmente, ver nota de seguridad abajo)
publican imagen + caption correctamente.

**Nunca** mandes reportes de partidas reales (`POST /api/report`) al piloto
apuntando a la base de producción — el piloto solo debe usarse para probar el
transporte de WhatsApp, no para escribir en Supabase.

## Paso 3 — Cutover (producción)

Cuando el piloto lleva un tiempo sin sorpresas:

1. Backup del `.env` de producción (otra vez, siempre antes de tocarlo).
2. Cambia:
   ```
   WHATSAPP_TRANSPORT=baileys
   WHATSAPP_SHADOW_TRANSPORT=          # opcional: puedes dejar wwebjs de sombra
   ```
   Si quieres quedarte con una red de seguridad, deja **wwebjs como sombra**
   mientras Baileys es primario — pero OJO: `WHATSAPP_SHADOW_TRANSPORT` hoy
   solo acepta `fake` o `baileys` en el factory (`server/messaging/index.js`);
   correr wwebjs como sombra no es una fábrica soportada todavía (sería un
   segundo Chromium corriendo — costoso). Si quieres esa red de seguridad de
   verdad, la forma simple es NO borrar el `wwebjs_auth` viejo y estar listo
   para el rollback del paso siguiente en vez de un shadow real.
3. `docker compose up -d`. Baileys usa la sesión que ya pareaste en el paso 1
   (mismo `WHATSAPP_BAILEYS_AUTH_DIR`, mismo volumen `wwebjs_auth` — el
   subdirectorio `baileys/` ya vive ahí desde el modo sombra, no hace falta
   re-parear).
4. Verifica:
   - `curl https://h3mccstats.cloud/api/health` -> `checks.whatsapp.transport`
     debe decir `"baileys"` y `state` debe llegar a `"ready"` en un rato.
   - `docker logs --tail 80 carnage-dashboard` — sin errores de conexión
     repetidos.
   - Manda un comando de prueba de verdad en el grupo real (`!comandos`) y
     confirma que responde.
5. Deja `WHATSAPP_SHADOW_TRANSPORT` apagado un tiempo (o en `baileys` con
   `WHATSAPP_TRANSPORT=wwebjs` invertido, si quisieras validar un rollback
   antes de necesitarlo — no es obligatorio).

## Rollback

Si algo sale mal después del cutover (sesión que no pega, mensajes raros,
lo que sea): es un cambio de una sola línea, no hay nada irreversible.

```bash
ssh <host>
cd /root/carnage-reporter-docker
sed -i 's/^WHATSAPP_TRANSPORT=baileys/WHATSAPP_TRANSPORT=wwebjs/' .env
docker compose up -d
```

wwebjs vuelve a usar su propia sesión (`WHATSAPP_AUTH_DIR` raíz, nunca se
tocó durante todo este proceso — Baileys vive en su propio subdirectorio
`baileys/`), así que no hace falta volver a escanear nada.

## Pitfalls conocidos

- **Nunca compartas el auth dir entre dos procesos.** Si por error apuntas
  dos instancias de Baileys (o Baileys y algo más) al MISMO directorio de
  sesión al mismo tiempo, WhatsApp detecta la sesión duplicada y cierra una
  de las dos (o las dos). Por eso el sombra usa `baileys-shadow` siempre, sin
  importar `WHATSAPP_BAILEYS_AUTH_DIR`, y por eso el piloto tiene su PROPIO
  volumen de auth completo (ni siquiera comparte la raíz).
- **`markOnlineOnConnect: false` es a propósito.** Sin esto, Baileys marca al
  bot como "en línea" en WhatsApp apenas conecta — visible para cualquiera
  del grupo. Se deja apagado para que el bot se comporte como wwebjs (que no
  expone presencia).
- **Rate limits / bans.** WhatsApp puede limitar o banear números que
  parecen bots (mensajes muy seguidos, patrones raros). El adaptador ya
  serializa los envíos a máximo 1 mensaje/segundo por chat
  (`server/messaging/adapters/baileys.js`), pero eso no es una garantía —
  evita pruebas agresivas (spamear comandos) contra un número real, sobre
  todo durante el piloto.
- **Exactitud del reloj del VPS.** Baileys (como cualquier cliente de
  WhatsApp) es sensible a que el reloj del sistema esté sincronizado (NTP);
  un reloj desfasado puede romper el cifrado de sesión o hacer que los
  timestamps de mensajes salgan mal. Confirma `timedatectl` en el VPS antes
  de un cutover si nunca lo has revisado.
- **Replay tras reconexión: `COMMAND_MAX_AGE_S`.** Un mensaje "viejo" que
  Baileys reproduce al reconectar (o que llega tarde por la razón que sea) se
  ignora sin correr el handler si es más viejo que `COMMAND_MAX_AGE_S`
  segundos (default 120) — ver `server/messaging/commandRouter.js`. Si
  bajaste ese valor a algo muy chico para otra cosa, un reconexión larga de
  Baileys podría hacer que un comando legítimo llegue "tarde" y se descarte;
  120s es un buen default, no lo bajes de ~60s sin pensarlo.
- **El QR/pairing code del sombra es UNA sesión de WhatsApp separada.** No
  puedes parear la sombra con el MISMO número que ya usa wwebjs en
  producción (un número solo puede tener una sesión "principal" de
  WhatsApp Web/multi-dispositivo activa a la vez de forma estable) — usa un
  número secundario o un dispositivo vinculado aparte para las pruebas de
  sombra/piloto.

## Referencia rápida de variables

| Variable | Dónde | Qué hace |
|---|---|---|
| `WHATSAPP_TRANSPORT` | producción | `wwebjs` (hoy) / `fake` (tests) / `baileys` (cutover) |
| `WHATSAPP_SHADOW_TRANSPORT` | producción, temporal | `''` (default) / `fake` / `baileys` (modo sombra, paso 1) |
| `WHATSAPP_BAILEYS_AUTH_DIR` | producción/piloto | subcarpeta de sesión de Baileys (default `baileys`; sombra siempre `baileys-shadow`) |
| `WHATSAPP_PILOT` | SOLO piloto | `true` activa el mapeo de `WHATSAPP_GROUP_ID_TEST` |
| `WHATSAPP_GROUP_ID_TEST` | SOLO piloto | id del grupo de prueba, mapeado a formato `2v2` |
