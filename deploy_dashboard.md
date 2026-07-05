# Despliegue Automático a VPS

Este flujo despliega los cambios del dashboard a h3mccstats.cloud.

## Requisitos

- Acceso SSH por llave al VPS (`ssh root@<TU_VPS>` debe entrar sin password).
- `/root/carnage-reporter-docker/.env` creado en el VPS con las variables de producción (ver `.env.example`).

## Pasos:

1. Copiar el nuevo build al servidor
2. Reiniciar servidor para reflejar los cambios

```bash
# Hacer commit de los cambios
git add .
git commit -m "feat: descripción de los cambios"
git push origin main

# Desplegar (usa deploy.sh, que lee DEPLOY_HOST de .env.deploy)
./deploy.sh
```

## Verificación
- Dashboard: https://h3mccstats.cloud/
- API Health: https://h3mccstats.cloud/api/health
