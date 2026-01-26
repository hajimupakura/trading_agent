# 🚀 Trading Agent - Configuration Complete

## ✅ Configuration Summary

The **Trading Agent** project has been configured for production deployment on ports **3005/5005**.

### Port Configuration
- **Backend**: Port **5005** (serves both API and frontend)
- **Frontend**: Bundled with backend (accessed via port 5005)
- **Development Frontend**: Port **3005** (when running `pnpm dev`)

### Database
- **New PostgreSQL Database**: `trading_agent`
- **User**: `trading_user`
- **Password**: `trading_password`
- **Port**: `5434` (same PostgreSQL instance as buildzim-platform)
- **Connection**: `postgresql://trading_user:trading_password@localhost:5434/trading_agent`

## 📁 Files Created/Modified

```
trading_agent/
├── .env.production          ✅ Created (production config)
├── setup-database.sh        ✅ Created (database setup)
├── deploy.sh                ✅ Created (deployment script)
├── vite.config.ts           ✅ Updated (port 3005 for dev)
├── ecosystem.config.js      ✅ Already configured (port 5005)
└── SETUP_GUIDE.md           ✅ This file
```

## 🗄️ Database Setup

### Step 1: Create PostgreSQL Database

Run the database setup script:

```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent
./setup-database.sh
```

This will:
1. Create the `trading_agent` database in the existing PostgreSQL (port 5434)
2. Create the `trading_user` with password
3. Grant all necessary privileges

**Note**: This uses the **same PostgreSQL instance** as buildzim-platform (port 5434) but creates a **separate database** called `trading_agent`.

### Step 2: Push Database Schema

After the database is created, push the schema:

```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent
pnpm drizzle-kit push
```

This will create all the tables:
- `users`
- `news_articles`
- `watchlist_stocks`
- `ark_trades`
- `alerts`
- `rally_events`
- `sector_momentum`
- `user_preferences`
- `youtube_videos`

## 🚀 Deployment

### Full Deployment

```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent
./deploy.sh
```

This script will:
1. ✅ Check database exists
2. ✅ Install dependencies (`pnpm install`)
3. ✅ Push database schema
4. ✅ Build the application
5. ✅ Stop old PM2 processes
6. ✅ Start new PM2 process
7. ✅ Save PM2 configuration

### Quick Restart

If you just need to restart without rebuilding:

```bash
pm2 restart trading-agent
```

## 🌐 Accessing the Application

### Production URL
```
http://35.238.160.230:5005
```

The backend serves both:
- **Frontend**: http://35.238.160.230:5005
- **API**: http://35.238.160.230:5005/api/trpc

### Development Mode

```bash
# Terminal 1: Start backend
cd /home/hmpakula_gmail_com/git_repos/trading_agent
pnpm dev:server

# Terminal 2: Start frontend (optional, for hot reload)
pnpm dev:client
```

Development URLs:
- Frontend: http://localhost:3005
- Backend: http://localhost:5005

## 🔐 Environment Variables

The `.env.production` file contains:

```env
# Server
PORT=5005
NODE_ENV=production

# Database (NEW MySQL database)
DATABASE_URL=mysql://trading_user:trading_password@localhost:3306/trading_agent

# LLM (Gemini via OpenRouter)
OPENROUTER_API_KEY=sk-or-v1-...
LLM_MODEL=google/gemini-2.0-flash-exp:free

# JWT Secret
JWT_SECRET=5a933dece51265a89c94fd179171ed2805387f94b6e8100672b4cda0a9ec5ec6

# Automation Schedule
CRON_NEWS_ANALYSIS=0 8,14,20 * * *
CRON_ARK_SYNC=0 9 * * *
CRON_YOUTUBE_SYNC=0 10 * * *
CRON_PREDICTIONS=0 11 * * *
```

## 📊 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Trading Agent System                      │
└─────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  CLIENT (React + Vite)                                     │
│  Dev: Port 3005                                            │
│  Prod: Bundled and served by backend                      │
└────────────────────────────────────────────────────────────┘
                         │
                         │ HTTP/tRPC
                         ▼
┌────────────────────────────────────────────────────────────┐
│  SERVER (Node.js + Express + tRPC)                         │
│  Port: 5005                                                │
│  ├─ /api/trpc        → tRPC API endpoints                 │
│  ├─ /                → Serves frontend (production)        │
│  └─ Services:                                              │
│     ├─ AI Browser Agent (Puppeteer + Gemini)              │
│     ├─ News Scraper (Reuters, Bloomberg, Yahoo)           │
│     ├─ ARK Tracker (Cathie Wood's trades)                 │
│     ├─ YouTube Tracker (Influencer videos)                │
│     ├─ Sentiment Analysis (AI-powered)                    │
│     └─ Rally Prediction Engine (ML predictions)           │
└────────────────────────────────────────────────────────────┘
                         │
                         │ SQL Queries
                         ▼
┌────────────────────────────────────────────────────────────┐
│  DATABASE (MySQL)                                          │
│  Name: trading_agent                                       │
│  Port: 3306                                                │
│  User: trading_user                                        │
│  Tables: users, news_articles, watchlist_stocks,           │
│          ark_trades, alerts, rally_events, etc.           │
└────────────────────────────────────────────────────────────┘
```

## 🔧 Troubleshooting

### Database Connection Failed

```bash
# Check if MySQL is running
sudo systemctl status mysql

# Test connection
mysql -u trading_user -p trading_agent
# Password: trading_password
```

### Port Already in Use

```bash
# Check what's using port 5005
sudo lsof -i :5005

# Kill the process if needed
sudo kill -9 <PID>
```

### PM2 Process Not Starting

```bash
# View logs
pm2 logs trading-agent

# Check error logs
cat /home/hmpakula_gmail_com/git_repos/trading_agent/logs/pm2-error.log
```

### Build Failures

```bash
# Clean install
rm -rf node_modules pnpm-lock.yaml
pnpm install

# Rebuild
pnpm build
```

## 📝 Useful Commands

### PM2 Management

```bash
# List all processes
pm2 list

# View logs
pm2 logs trading-agent
pm2 logs trading-agent --lines 100

# Restart
pm2 restart trading-agent

# Stop
pm2 stop trading-agent

# Delete
pm2 delete trading-agent

# Monitor
pm2 monit

# Save configuration
pm2 save

# Setup auto-start on boot
pm2 startup systemd
```

### Database Management

```bash
# Connect to database
psql -h localhost -p 5434 -U trading_user -d trading_agent

# List tables
psql -h localhost -p 5434 -U trading_user -d trading_agent -c "\dt"

# Push schema changes
pnpm drizzle-kit push

# Generate migrations
pnpm drizzle-kit generate

# View schema
pnpm drizzle-kit studio
```

### Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build for production
pnpm build

# Type checking
pnpm check

# Run tests
pnpm test
```

## 🎯 Post-Deployment Checklist

- [ ] MySQL database created (`./setup-database.sh`)
- [ ] Database schema pushed (`pnpm drizzle-kit push`)
- [ ] Application built (`pnpm build`)
- [ ] PM2 process running (`pm2 list`)
- [ ] Application accessible at http://35.238.160.230:5005
- [ ] Logs look healthy (`pm2 logs trading-agent`)
- [ ] PM2 saved (`pm2 save`)
- [ ] Auto-start configured (`pm2 startup`)

## 🌟 Features

The Trading Agent includes:

- 📰 **News Aggregation**: Reuters, Bloomberg, Yahoo Finance
- 📈 **ARK Invest Tracking**: Daily trades from Cathie Wood
- 🎥 **YouTube Insights**: Influencer video summaries
- 🤖 **AI Browser Agent**: Autonomous web scraping with Gemini
- 📊 **Rally Predictions**: AI-powered sector rally predictions
- 💹 **Sentiment Analysis**: News sentiment scoring
- ⏰ **Automated Tasks**: Scheduled data updates
- 📱 **Real-time Dashboard**: Beautiful React UI with charts

## 🔗 Additional Resources

- **Project README**: `/home/hmpakula_gmail_com/git_repos/trading_agent/README.md`
- **Deployment Guide**: `/home/hmpakula_gmail_com/git_repos/trading_agent/DEPLOYMENT.md`
- **Database Schema**: `/home/hmpakula_gmail_com/git_repos/trading_agent/drizzle/schema.ts`

---

**Status**: ✅ Ready for deployment
**Date**: January 26, 2026
**Next Step**: Run `./setup-database.sh` then `./deploy.sh`
