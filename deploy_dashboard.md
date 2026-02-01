# Despliegue Automático a VPS

Este script desplegará los cambios del dashboard a h3mccstats.cloud

## Pasos:

1. Copiar el nuevo build al servidor
2. Reiniciar servidor para reflejar los cambios

```bash
# Hacer commit de los cambios
cd /home/jluis/Documentos/repos/CarnageReporter
git add .
git commit -m "feat: Prueba realista de 2 partidas y mejoras en dashboard"
git push origin main

# Conectarse al VPS y actualizar
ssh root@31.97.209.182 "cd /root/CarnageReporter && git pull && cd server && docker-compose restart"
```

## Verificación
- Dashboard: https://h3mccstats.cloud/
- API Health: https://h3mccstats.cloud/api/health

