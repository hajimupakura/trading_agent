## ✅ RSS News Sync Cron Job Setup

### 📋 What Was Configured

A cron job has been set up to automatically sync RSS news feeds **every 15 minutes**.

### 🔧 Configuration Details

**Cron Schedule:** `*/15 * * * *` (every 15 minutes)

**Script:** `/home/hmpakula_gmail_com/git_repos/trading_agent/sync-rss-news.ts`

**Log File:** `/home/hmpakula_gmail_com/git_repos/trading_agent/logs/rss-sync.log`

**Command:**
```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent && /usr/bin/npx tsx sync-rss-news.ts >> /home/hmpakula_gmail_com/git_repos/trading_agent/logs/rss-sync.log 2>&1
```

### 📝 Current Cron Jobs

To view all cron jobs:
```bash
crontab -l
```

To edit cron jobs:
```bash
crontab -e
```

### 🧪 Testing

**Test the script manually:**
```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent
npx tsx sync-rss-news.ts
```

**Check cron logs:**
```bash
tail -f /home/hmpakula_gmail_com/git_repos/trading_agent/logs/rss-sync.log
```

**Verify cron is running:**
```bash
# Check if cron service is running
systemctl status cron

# Check recent cron execution
grep CRON /var/log/syslog | tail -10
```

### 📊 What the Script Does

1. **Loads Environment Variables**
   - Uses `.env.production` in production mode
   - Uses `.env` in development mode

2. **Syncs RSS Feeds**
   - Fetches news from configured RSS feeds:
     - Yahoo Finance
     - MarketWatch
     - CNBC Markets
     - Seeking Alpha
   - Stores new articles in database
   - Skips duplicate articles (by URL)

3. **Logs Results**
   - Logs to console and log file
   - Reports: articles added, articles skipped
   - Timestamps all operations

### 🔍 Monitoring

**Check if cron job is working:**
```bash
# View recent log entries
tail -20 /home/hmpakula_gmail_com/git_repos/trading_agent/logs/rss-sync.log

# Check last execution time
ls -lh /home/hmpakula_gmail_com/git_repos/trading_agent/logs/rss-sync.log
```

**Expected log format:**
```
[Cron] Starting RSS news sync at 2026-01-26T20:00:00.000Z
[RSS Sync] Fetched 45 articles from RSS feeds
[RSS Sync] Added 12 new articles, skipped 33 existing
[Cron] RSS sync completed: 12 added, 33 skipped
```

### ⚙️ Troubleshooting

**If cron job isn't running:**

1. **Check cron service:**
   ```bash
   systemctl status cron
   sudo systemctl start cron  # if not running
   ```

2. **Check script permissions:**
   ```bash
   ls -l /home/hmpakula_gmail_com/git_repos/trading_agent/sync-rss-news.ts
   chmod +x /home/hmpakula_gmail_com/git_repos/trading_agent/sync-rss-news.ts
   ```

3. **Check environment variables:**
   ```bash
   # Make sure DATABASE_URL is set in .env.production
   grep DATABASE_URL /home/hmpakula_gmail_com/git_repos/trading_agent/.env.production
   ```

4. **Test script manually:**
   ```bash
   cd /home/hmpakula_gmail_com/git_repos/trading_agent
   DATABASE_URL="postgresql://trading_user:trading_password@localhost:5434/trading_agent" npx tsx sync-rss-news.ts
   ```

5. **Check cron logs:**
   ```bash
   # System cron logs
   grep CRON /var/log/syslog | grep sync-rss-news | tail -10
   ```

### 🔄 Modifying the Schedule

To change the frequency, edit the cron job:
```bash
crontab -e
```

**Common schedules:**
- Every 15 minutes: `*/15 * * * *`
- Every 30 minutes: `*/30 * * * *`
- Every hour: `0 * * * *`
- Every 5 minutes: `*/5 * * * *`

### 📝 Notes

- The script runs independently of the main application
- It uses the same database connection as the main app
- Logs are appended to the log file (not overwritten)
- The script exits with code 0 on success, 1 on failure
- Cron will retry on the next scheduled run if a run fails

### ✅ Status

**Cron job is now active and will run every 15 minutes!**

The RSS news feed will automatically update with the latest articles from configured sources.
