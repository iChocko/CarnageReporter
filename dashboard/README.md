# Carnage Reporter — Dashboard

Frontend del tracker de stats de Halo 3 MCC (customs 2v2/4v4 de Retas H3).
React 19 + Vite, sin router externo ni CSS framework: todo el tema visual
vive en `src/index.css` y el ruteo es un hook propio sobre la History API.

## Desarrollo

```bash
npm install
npm run dev
```

Levanta Vite en `http://localhost:5173`. Las peticiones a `/api/*` se
redirigen (proxy de Vite, ver `vite.config.js`) hacia el backend Express en
`http://localhost:3000` — hay que tenerlo corriendo aparte:
`npm --prefix server run dev` (o `npm --prefix server start`).

Otros scripts: `npm run build` (build de producción a `dist/`), `npm run
lint`, `npm run preview` (sirve el build ya generado).

## Variables de entorno

- `VITE_STRIPE_PUBLISHABLE_KEY` — clave pública de Stripe. El botón
  "Apoyar el proyecto" y el modal de donación solo aparecen si esta
  variable está seteada al momento del build (Vite la inyecta en
  build-time, no en runtime). Sin ella el dashboard funciona igual, nomás
  sin esa opción de donar con tarjeta.

En Docker, esta variable se pasa como build-arg (`docker build --build-arg
VITE_STRIPE_PUBLISHABLE_KEY=...`, ver `Dockerfile` y `deploy.sh`). Para
deploys locales con `deploy.sh`, se define junto a `DEPLOY_HOST` en el
`.env.deploy` de la raíz del repo (gitignoreado):

```
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_xxxxx
```

## Estructura

```
src/
  api/client.js        getJSON con timeout de 10s y ApiError tipado
  hooks/
    useApi.js           fetch + loading/error/reload para una vista
    useFormat.js         formato 2v2/4v4 en ?f= y localStorage
    useRoute.js           router minimo (History API, sin react-router)
    useMediaQuery.js        matchMedia reactivo (breakpoints en JS)
  lib/
    format.js           helpers puros: fechas CDMX, KD/KDA, análisis de partida
    links.js             URLs externas (Discord, GitHub, PayPal)
  components/           piezas de UI reusables (Header, Tabs, MatchCard,
                         Skeleton, ErrorState, ServerBanner, etc.)
  views/                 una vista por pestaña: Rankings, Partidas, H2H, Perfil
  App.jsx                 solo composición: arma header + tabs + vista activa
```

Rutas: `/rankings` (default), `/partidas`, `/h2h`, `/perfil/:gamertag`.
Cualquier otra ruta cae a `/rankings`.

`ServerBanner` avisa "Servidor no disponible" si `GET /api/health` falla o
responde `status: "down"` (poll cada 60s).
