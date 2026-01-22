/**
 * PM2 Configuration
 * Ejecutar: pm2 start ecosystem.config.js
 */

module.exports = {
    apps: [{
        name: 'carnage-server',
        script: 'index.js',
        cwd: '/root/carnage-reporter/server',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        },
        error_file: '/root/carnage-reporter/logs/error.log',
        out_file: '/root/carnage-reporter/logs/out.log',
        log_file: '/root/carnage-reporter/logs/combined.log',
        time: true,

        // Reinicio automático si falla
        exp_backoff_restart_delay: 100,
        max_restarts: 10,
        min_uptime: '10s',

        // Kill timeout
        kill_timeout: 5000,
        listen_timeout: 10000,
    }]
};
