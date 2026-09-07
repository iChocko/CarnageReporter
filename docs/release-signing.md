# Firma de releases del cliente (Fase B5)

Desde v1.7, cada release del cliente publica tres archivos además del/los
`.exe`:

- `SHA256SUMS` — hashes SHA256 de cada `.exe` del release (`CarnageReporter.exe`
  y `CarnageReporter-Setup.exe`).
- `SHA256SUMS.sig` — firma Ed25519 de `SHA256SUMS`, en base64.

El propio cliente (`client/src/updater.js`) verifica ambos antes de aplicar
cualquier auto-actualización: descarga el `.exe`, calcula su SHA256, lo
compara contra `SHA256SUMS`, y verifica que `SHA256SUMS` esté firmado con la
clave privada del proyecto (contra la clave pública embebida en
`client/src/releaseKey.js`). Si un release no publica `SHA256SUMS`/`.sig`
(por ejemplo, uno de antes de esta fase), el cliente **se niega a
actualizar** — nunca instala un `.exe` sin verificar.

Esto es independiente de la firma de código (Authenticode) de Windows — ver
la sección de SignPath más abajo — y no la reemplaza: son dos problemas
distintos. La firma Ed25519 protege el **canal de auto-actualización**
(que nadie pueda servir un `.exe` falso como si fuera el release oficial);
Authenticode/SignPath es lo que le quita el aviso de "Editor: Desconocido"
a SmartScreen cuando alguien descarga o abre el `.exe` a mano.

## Cómo funciona la firma Ed25519

1. En CI, después de compilar el `.exe` (y el instalador), se genera
   `dist/SHA256SUMS` con `sha256sum` sobre todos los `.exe` de `dist/`.
2. `client/scripts/sign-release.js` firma esos bytes exactos con
   `crypto.sign(null, data, privateKey)` (Ed25519, sin hash intermedio —
   Ed25519 ya lo incluye) usando la clave privada del secret
   `RELEASE_SIGNING_KEY`, y escribe `dist/SHA256SUMS.sig` en base64.
3. Los cuatro archivos (`.exe`, `-Setup.exe`, `SHA256SUMS`, `SHA256SUMS.sig`)
   se suben al release de GitHub.
4. El cliente, al encontrar una versión nueva, descarga los tres archivos
   relevantes, calcula el SHA256 del `.exe` descargado, lo compara contra
   `SHA256SUMS`, y verifica la firma de `SHA256SUMS` con
   `crypto.verify(null, data, publicKey, signature)` contra la clave pública
   embebida en el propio cliente (`RELEASE_PUBLIC_KEY_PEM` en
   `client/src/releaseKey.js`). Solo si TODO pasa, reemplaza el `.exe` en uso.

Se eligió Ed25519 (en vez de RSA) porque las claves y firmas son mucho más
cortas, y Node lo soporta nativo con `crypto.sign`/`crypto.verify` sin
dependencias externas.

## Generar el par de claves (una sola vez)

```bash
node client/scripts/generate-release-key.js
```

Esto escribe la clave **privada** en `release-signing.key` (en `.gitignore`,
nunca se sube al repo) e imprime la clave **pública** en la consola.

- La clave pública va pegada tal cual en `client/src/releaseKey.js`
  (`RELEASE_PUBLIC_KEY_PEM`) y sí se commitea — es pública, su trabajo es
  identificar al proyecto, no protegerlo.
- La clave privada se sube como el secret `RELEASE_SIGNING_KEY` en GitHub:
  **Settings → Secrets and variables → Actions → New repository secret**,
  pegando el contenido completo de `release-signing.key` (el PEM, con las
  líneas `-----BEGIN/END PRIVATE KEY-----` incluidas).

Si la clave privada se filtra o se pierde el control de ella, hay que:
1. Generar un par nuevo (`generate-release-key.js` de nuevo).
2. Actualizar `RELEASE_PUBLIC_KEY_PEM` en `client/src/releaseKey.js` y
   publicar un release con esa clave pública nueva.
3. Reemplazar el secret `RELEASE_SIGNING_KEY` en GitHub.
4. Ojo: clientes instalados que todavía tengan la clave pública VIEJA
   embebida no van a poder verificar (ni por lo tanto instalar) releases
   firmados con la clave nueva hasta que se actualicen manualmente una vez
   descargando el `.exe` a mano — el auto-update no puede "brincar" ese
   cambio de clave solo. Es una situación de emergencia, no algo que deba
   pasar en operación normal.

En CI, el job falla explícitamente (`::error::`) si falta el secret
`RELEASE_SIGNING_KEY`: nunca se publica un release sin firmar en silencio.

## Firma de código (Authenticode / SmartScreen)

El `.exe` y el instalador todavía no están firmados con un certificado de
firma de código de Windows — por eso SmartScreen muestra "Editor:
Desconocido" al descargar o abrir la app (ver aviso en el README). El plan
es aplicar a firma gratuita para proyectos open source:

### SignPath Foundation (plan principal)

[SignPath Foundation](https://signpath.org) ofrece certificados de firma de
código gratis a proyectos OSS que cumplan sus criterios (repositorio
público, build reproducible en CI, sin licencia restrictiva). Pasos:

1. Aplicar en <https://signpath.org/apply> con la URL del repo
   (`https://github.com/iChocko/CarnageReporter`), una descripción corta del
   proyecto y el enlace a este documento como evidencia del proceso de
   build.
2. Una vez aprobada la solicitud, SignPath da de alta el proyecto en su
   plataforma (organización, "signing policy" para releases de producción,
   "artifact configuration" describiendo qué archivo firmar).
3. Se genera un API token de SignPath y se sube como el secret
   `SIGNPATH_API_TOKEN` en GitHub Actions.
4. Se descomenta el bloque de `signpath/github-action-submit-signing-request`
   en `.github/workflows/build-and-release.yml` (ahora mismo está comentado,
   con los nombres de policy/artifact-configuration como placeholders — hay
   que reemplazarlos por los que SignPath asigne al aprobar la solicitud), y
   se coloca DESPUÉS de compilar el `.exe`/instalador pero ANTES de generar
   `SHA256SUMS` — así el hash firmado con Ed25519 cubre los binarios ya
   firmados con Authenticode, no los originales sin firmar.
5. `dist/CarnageReporter.exe` deja de subirse tal cual sale de `pkg`: se
   reemplaza por la versión que devuelve el signing request (carpeta
   `output-artifact-directory` del action) antes del paso de
   "Generar SHA256SUMS".

Mientras la solicitud esté en trámite (o si se rechaza), el README sigue
avisando sobre SmartScreen y las instrucciones de "Ejecutar de todas
formas" / "Conservar de todas formas".

### Azure Trusted Signing (respaldo)

Si SignPath no aplica (el proyecto deja de ser 100% OSS, la solicitud tarda
demasiado, o cambian los criterios de elegibilidad), el respaldo es
[Azure Trusted Signing](https://azure.microsoft.com/products/trusted-signing):
de pago (tiene un tier barato pensado justo para proyectos chicos/individuales)
pero sin proceso de aprobación — se contrata y se firma. La integración en
CI sería con la action `azure/trusted-signing-action`, en el mismo punto del
pipeline (después de compilar, antes de `SHA256SUMS`). No implementado
todavía porque SignPath es gratis y el proyecto sí califica como OSS; queda
documentado aquí como plan B si hace falta acelerar.
