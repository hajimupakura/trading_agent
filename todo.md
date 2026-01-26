# AI Trading Agent - Feature TODO

## Core Features

### Dashboard & News Aggregation
- [x] Multi-source news aggregation (Reuters, Bloomberg, Yahoo Finance, MarketWatch)
- [x] Automated daily scanning system
- [x] News display with source attribution
- [x] Date/time filtering for news articles

### AI-Powered Analysis
- [x] Sentiment analysis for financial news
- [x] Stock potential classification (short-term, medium-term, long-term)
- [x] News summarization with key highlights
- [x] Rally detection algorithm

### Watchlist & Priority Tracking
- [x] Custom watchlist functionality
- [x] Priority stocks tracking (Google, NVDA, TSLA)
- [x] SpaceX IPO tracker (purported)
- [x] OpenAI IPO tracker (purported)
- [ ] Real-time price updates for watchlist stocks (future enhancement)

### ARK Invest Tracking
- [x] Daily ARK trade data collection
- [x] Portfolio changes visualization
- [x] Buy/sell activity tracking across all ARK ETFs
- [x] Historical ARK trade data storage

### Market Rally Detection
- [x] Historical pattern analysis (metals, AI, quantum, energy, chips)
- [x] Sector-specific rally indicators
- [x] Momentum tracking for key sectors
- [x] Rally timeline visualization

### Alert System
- [x] Significant market event alerts
- [x] Potential rally notifications
- [x] Downside risk alerts (recession, wars, market corrections)
- [x] Put trading opportunity identification
- [x] Configurable alert thresholds
- [x] Email/in-app notification system

### Historical Analysis
- [x] Retrospective rally analysis tool
- [x] Major trend start date identification
- [x] Historical data on metals rally
- [x] Historical data on AI rally
- [x] Historical data on quantum rally

### User Preferences & Settings
- [x] Customizable refresh schedule
- [x] Alert threshold configuration
- [x] Watchlist management
- [x] Notification preferences

### UI/UX
- [x] Clean, minimal dashboard layout
- [x] Quick information scanning optimization
- [x] Clear visual hierarchy
- [x] Sector momentum indicators
- [x] News feed with filtering
- [x] Responsive design for mobile/tablet

## Technical Infrastructure
- [x] Database schema design
- [x] News scraping service
- [x] ARK trade data collection service
- [x] Sentiment analysis integration with LLM
- [x] Scheduled job system for automated scanning
- [x] API endpoints for all features
- [x] Frontend state management
- [x] Error handling and logging

## Enhancement Phase - Predictive Intelligence

### Dynamic Sector Discovery
- [x] Auto-detect emerging sectors from news patterns (UAVs, rare earth metals, computational drug design, etc.)
- [x] Remove hardcoded sector limitations
- [x] Track sector emergence timeline
- [x] Sector classification using AI

### Predictive Rally Detection
- [x] Pattern learning engine from historical rallies
- [x] Early warning signals (2-3 weeks before mainstream)
- [x] Prediction confidence scoring
- [x] Rally probability indicators
- [x] Short-term rally detection (2-3 week opportunities)

### YouTube Influencer Tracking
- [x] YouTube content aggregation for specified channels
- [x] Video summarization using AI
- [x] Key takeaways extraction
- [x] Sentiment analysis of influencer opinions
- [x] Integration with news feed

### UI Improvements
- [x] Enhanced color scheme for better visual hierarchy
- [x] Prediction confidence indicators with color coding
- [x] Rally probability visualization
- [x] Remove or minimize historical rally display
- [x] Focus on forward-looking predictions
- [x] Emerging sector highlights

### Backend Intelligence
- [x] Historical rally pattern database
- [x] Pattern matching algorithm
- [x] Predictive model training from past rallies
- [x] Early signal detection system
- [x] Confidence scoring algorithm


## UI Restoration
- [x] Restore original Dashboard with all tabs (Overview, News Feed, Watchlist, ARK Trades)
- [x] Replace "Rally Tracker" tab with "Predicted Rallies" tab
- [x] Keep sector momentum indicators
- [x] Keep all predictive intelligence features from v2.0


## Production Deployment Preparation

### Database Configuration
- [x] Configure PostgreSQL connection for production server
- [x] Update database schema for PostgreSQL compatibility
- [x] Create database migration scripts
- [x] Add connection pooling configuration

### Real API Integrations
- [x] Custom AI browser agent with Gemini 2.0 Flash
- [x] Puppeteer for autonomous web scraping
- [x] Financial news scraping (Reuters, Bloomberg, Yahoo Finance)
- [x] ARK Invest trade scraping
- [x] YouTube video scraping
- [x] Stock price scraping (Yahoo Finance)
- [x] API rate limiting and error handling

### Deployment Configuration
- [x] Create production environment variables template
- [x] Write deployment documentation for GAP server
- [x] Set up PM2 configuration (ecosystem.config.js)
- [x] Configure nginx reverse proxy
- [x] Add health check endpoints

### Automation & Scheduling
- [ ] Create cron jobs for automated news analysis (2-3x daily)
- [ ] Create cron jobs for ARK trade syncing (daily)
- [ ] Create cron jobs for YouTube video syncing (daily)
- [ ] Create cron jobs for prediction generation (daily)
- [ ] Add email/SMS alert notifications

### GitHub Repository
- [x] Organize code structure for GitHub
- [x] Create comprehensive README.md
- [x] Add .gitignore for sensitive files
- [x] Create deployment guide (DEPLOYMENT.md)
- [x] Add API setup instructions


## System Refinement - Universal Opportunity Scanner

### Core Philosophy Change
- [x] Remove sector limitations - scan ALL markets and sectors
- [x] Focus on "what's moving" not "what sector is it"
- [x] Detect both RALLIES (call opportunities) and DROPS (put opportunities)
- [x] Money-first approach: "Can I make money on this in 2-3 weeks?"

### AI Prompt Refinements
- [x] Update news analysis prompt to be sector-agnostic
- [x] Add momentum detection (volume, price action, social buzz)
- [x] Include downside opportunity detection for puts
- [x] Remove predefined sector filters

### Prediction Engine Updates
- [x] Detect upward momentum (rally predictions for calls)
- [x] Detect downward momentum (drop predictions for puts)
- [x] Identify emerging sectors automatically (no predefined list)
- [x] Add "opportunity type" field: CALL or PUT
- [x] Add "momentum direction" field: UP or DOWN

### Sector Discovery Enhancement
- [ ] Remove hardcoded sector list (AI, Metals, Quantum, etc.)
- [ ] Discover sectors dynamically from market data
- [ ] Track ANY emerging trend regardless of category
- [ ] Flag "new" sectors that are just starting to move

### UI Updates
- [x] Show both call and put opportunities
- [x] Color code: Green for calls (upside), Red for puts (downside)
- [x] Add momentum indicators (volume, price change, social buzz)
- [ ] Remove static sector momentum cards, make dynamic


## RSS Feed Integration - Near Real-Time News

### RSS Feed Setup
- [ ] Install RSS parser library (rss-parser)
- [ ] Create RSS feed service for fetching news
- [ ] Configure RSS feeds for major financial news sources
  - [ ] Reuters Business RSS
  - [ ] Bloomberg Markets RSS
  - [ ] Yahoo Finance RSS
  - [ ] MarketWatch RSS
  - [ ] CNBC Markets RSS

### News Fetching
- [ ] Update news scraper to use RSS feeds instead of browser agent
- [ ] Fetch news every 15-30 minutes (configurable)
- [ ] Store headlines with source links immediately
- [ ] Deduplicate articles by URL/title
- [ ] Track publication timestamps for freshness

### AI Analysis Optimization
- [ ] Separate news fetching from AI analysis
- [ ] Run AI sentiment analysis every 30 minutes during market hours (8 AM - 4 PM EST)
- [ ] Batch analyze new articles since last run
- [ ] Mark articles as "analyzed" vs "pending analysis"
- [ ] Show unanalyzed articles with basic info, analyzed ones with AI insights
- [ ] Estimated cost: ~$1.50/month for AI analysis

### UI Updates
- [ ] Display news with clickable links to source articles
- [ ] Show publication timestamp (e.g., "5 minutes ago")
- [ ] Add visual indicator for analyzed vs unanalyzed articles
- [ ] Add "Analyze Now" button for manual AI analysis
- [ ] Sort by newest first

### Cost Optimization
- [ ] RSS fetching: FREE (no API costs)
- [ ] AI analysis: Every 30 min during market hours (~$1.50/month)
- [ ] Total estimated cost: ~$1.50/month


## Finnhub API Integration

### Finnhub Setup
- [x] Install Finnhub SDK (finnhub)
- [x] Create Finnhub service for stock data and news
- [x] Add FINNHUB_API_KEY to environment variables
- [x] Configure Finnhub client with API key

### Stock Data Enhancement
- [x] Use Finnhub as primary source for real-time quotes (60 calls/min)
- [x] Use Yahoo Finance as backup/fallback
- [x] Add Finnhub company profile data
- [x] Add Finnhub earnings and financials

### Company News Integration
- [x] Fetch company-specific news from Finnhub
- [x] Integrate with existing RSS news feed
- [ ] Deduplicate news from multiple sources (future enhancement)
- [ ] Prioritize company news for watchlist stocks (future enhancement)

### Benefits
- [x] 60 API calls/minute (vs Yahoo's unofficial API)
- [x] Official API with better reliability
- [x] Company-specific news and data
- [x] Redundancy if Yahoo Finance blocks requests
