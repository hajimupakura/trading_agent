module.exports = {
  apps: [{
    name: 'trading-agent',
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'cluster',
    cwd: '/home/hmpakula_gmail_com/git_repos/trading_agent',
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 5005,
      DATABASE_URL: 'postgresql://user:password@localhost:5434/database_name',
      GEMINI_API_KEY: 'your_gemini_api_key_here',
      LLM_MODEL: 'gemini-2.5-flash',
      JWT_SECRET: 'your_jwt_secret_here',
      PUPPETEER_HEADLESS: 'true',
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
