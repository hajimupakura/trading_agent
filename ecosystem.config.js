module.exports = {
  apps: [{
    name: 'trading-agent',
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'cluster',
    env_file: '.env.production',
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 5005
    },
    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 3000,
    // Restart delay
    restart_delay: 4000,
    // Max restarts within 1 minute
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
