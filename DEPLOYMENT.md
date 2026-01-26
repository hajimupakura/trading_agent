# AI Trading Agent - Production Deployment Guide

This guide covers deploying the AI Trading Agent on your GAP server with PostgreSQL database, PM2 process management, and nginx reverse proxy.

## Prerequisites

- Node.js 22.x or higher
- PostgreSQL 14+ database
- PM2 process manager
- nginx web server
- Git

## Server Setup

### 1. Install Dependencies

```bash
# Install Node.js 22.x (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
sudo npm install -g pm2 pnpm

# Install PostgreSQL (if not already installed)
sudo apt-get install -y postgresql postgresql-contrib

# Install nginx
sudo apt-get install -y nginx
```

### 2. Database Setup

```bash
# Connect to PostgreSQL
sudo -u postgres psql

# Create database and user
CREATE DATABASE trading_agent;
CREATE USER trading_user WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE trading_agent TO trading_user;

# Enable SSL (recommended for production)
ALTER DATABASE trading_agent SET ssl TO on;

# Exit PostgreSQL
\q
```

### 3. Clone Repository

```bash
# Clone from GitHub
cd /var/www
sudo git clone https://github.com/yourusername/ai-trading-agent.git
cd ai-trading-agent

# Set proper permissions
sudo chown -R $USER:$USER /var/www/ai-trading-agent
```

### 4. Configure Environment

```bash
# Copy environment template
cp .env.production.template .env.production

# Edit environment variables
nano .env.production
```

**Required Configuration:**

```env
# Database
DATABASE_URL=postgresql://trading_user:your_secure_password@localhost:5432/trading_agent?sslmode=require

# Server
PORT=5005
NODE_ENV=production

# LLM (Gemini via OpenRouter)
OPENROUTER_API_KEY=your_openrouter_api_key
LLM_MODEL=google/gemini-2.0-flash-exp:free

# Optional APIs (or use web scraping)
ALPHA_VANTAGE_API_KEY=your_key_here
NEWS_API_KEY=your_key_here
YOUTUBE_API_KEY=your_key_here
```

### 5. Install Application Dependencies

```bash
# Install Node.js dependencies
pnpm install

# Run database migrations
pnpm db:push

# Build frontend
pnpm build
```

### 6. Configure PM2

Create PM2 ecosystem file:

```bash
nano ecosystem.config.js
```

```javascript
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
    }
  }]
};
```

Start the application:

```bash
# Create logs directory
mkdir -p logs

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup systemd
# Follow the command output instructions
```

### 7. Configure nginx

Create nginx configuration:

```bash
sudo nano /etc/nginx/sites-available/trading-agent
```

```nginx
server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain or IP

    # Frontend static files
    location / {
        root /var/www/ai-trading-agent/dist/client;
        try_files $uri $uri/ /index.html;
        
        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    # Backend API proxy
    location /api {
        proxy_pass http://localhost:5005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Increase timeout for long-running AI operations
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:5005/health;
        access_log off;
    }
}
```

Enable the site:

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/trading-agent /etc/nginx/sites-enabled/

# Test nginx configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

### 8. Setup Automated Tasks (Cron Jobs)

The application includes built-in schedulers, but you can also use system cron for redundancy:

```bash
# Edit crontab
crontab -e

# Add these lines:
# News analysis: 3 times daily (8am, 2pm, 8pm)
0 8,14,20 * * * curl -X POST http://localhost:5005/api/cron/analyze-news

# ARK trades sync: Once daily (9am)
0 9 * * * curl -X POST http://localhost:5005/api/cron/sync-ark-trades

# YouTube sync: Once daily (10am)
0 10 * * * curl -X POST http://localhost:5005/api/cron/sync-youtube

# Prediction generation: Once daily (11am)
0 11 * * * curl -X POST http://localhost:5005/api/cron/generate-predictions

# PM2 log rotation: Daily at midnight
0 0 * * * pm2 flush
```

### 9. SSL/HTTPS Setup (Optional but Recommended)

```bash
# Install Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
```

## Monitoring & Maintenance

### View Application Logs

```bash
# PM2 logs
pm2 logs trading-agent

# nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Application logs
tail -f logs/trading-agent.log
```

### PM2 Management Commands

```bash
# View status
pm2 status

# Restart application
pm2 restart trading-agent

# Stop application
pm2 stop trading-agent

# View detailed info
pm2 info trading-agent

# Monitor resources
pm2 monit
```

### Database Maintenance

```bash
# Backup database
pg_dump -U trading_user trading_agent > backup_$(date +%Y%m%d).sql

# Restore database
psql -U trading_user trading_agent < backup_20260126.sql

# Vacuum database (optimize)
psql -U trading_user -d trading_agent -c "VACUUM ANALYZE;"
```

### Update Application

```bash
# Pull latest changes
cd /var/www/ai-trading-agent
git pull origin main

# Install new dependencies
pnpm install

# Run database migrations
pnpm db:push

# Rebuild frontend
pnpm build

# Restart application
pm2 restart trading-agent
```

## Troubleshooting

### Application won't start

```bash
# Check PM2 logs
pm2 logs trading-agent --lines 100

# Check if port is in use
sudo lsof -i :5005

# Verify environment variables
pm2 env trading-agent
```

### Database connection errors

```bash
# Test PostgreSQL connection
psql -U trading_user -d trading_agent -h localhost

# Check PostgreSQL service
sudo systemctl status postgresql

# View PostgreSQL logs
sudo tail -f /var/log/postgresql/postgresql-14-main.log
```

### nginx errors

```bash
# Test nginx configuration
sudo nginx -t

# Check nginx status
sudo systemctl status nginx

# Restart nginx
sudo systemctl restart nginx
```

### High memory usage

```bash
# Check memory usage
pm2 monit

# Restart if needed
pm2 restart trading-agent

# Adjust max_memory_restart in ecosystem.config.js if needed
```

## Security Recommendations

1. **Firewall Configuration**
   ```bash
   sudo ufw allow 22/tcp    # SSH
   sudo ufw allow 80/tcp    # HTTP
   sudo ufw allow 443/tcp   # HTTPS
   sudo ufw enable
   ```

2. **Regular Updates**
   ```bash
   sudo apt-get update && sudo apt-get upgrade -y
   ```

3. **Secure Environment Variables**
   - Never commit `.env.production` to Git
   - Use strong database passwords
   - Rotate API keys regularly

4. **Database Security**
   - Use SSL for database connections
   - Limit database user permissions
   - Regular backups

5. **Rate Limiting**
   - Configure nginx rate limiting for API endpoints
   - Monitor API usage

## Performance Optimization

1. **Database Indexing**
   - Indexes are automatically created by Drizzle ORM
   - Monitor slow queries with `pg_stat_statements`

2. **Caching**
   - Static assets are cached by nginx
   - Consider Redis for API response caching

3. **PM2 Cluster Mode**
   - Increase `instances` in ecosystem.config.js for better performance
   - Recommended: `instances: 'max'` for CPU cores

## Support

For issues or questions:
- Check application logs: `pm2 logs trading-agent`
- Review this deployment guide
- Check GitHub issues: https://github.com/yourusername/ai-trading-agent/issues
