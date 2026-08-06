# SPX / SPY Options Research Command Center

The active product is now the clean Next.js application in [`apps/trading`](apps/trading). The former Vite/Express application remains in the repository only as a rollback reference and is not part of the intended Vercel deployment.

```bash
pnpm install
pnpm dev:trading
pnpm check:trading
pnpm test:trading
pnpm build:trading
```

For Vercel, set the project Root Directory to `apps/trading`. The application uses Supabase Auth and does not require the legacy `DATABASE_URL`, `JWT_SECRET`, Express server, or MySQL schema.

The primary interface is a paper-only 0–2 DTE SPX/SPY research system. It monitors each underlying's own one-minute chart, filters the option chain for executable contracts, and ranks eligible contracts with volume as the largest component. It does not place live orders.

## Current decision flow

1. Load SPY stock bars or the `I:SPX` index bars from Massive.
2. Require a confirmed 15-minute opening-range break aligned with trend.
3. Reject contracts outside 0–2 DTE, one-sided quotes, spreads above 12%, volume below 25, premiums below $0.10, or asks above $8.00 (about $800 per standard contract).
4. Rank the remainder by volume (40%), spread quality (20%), volume/open-interest flow (18%), open interest (12%), and delta proximity (10%).
5. Display the top call or put for the confirmed direction, plus its exact invalidation.

AI is not required and is off by default. With `AI_OPTIONS_REVIEW_ENABLED=true`, it only adds a structured confirm/reject/caution critique after the deterministic engine selects a candidate. It cannot select a different ticker or override the controls.

## Supabase and Vercel

Apply [the Supabase migration](supabase/migrations/20260806040123_create_options_research_tables.sql), then configure these server-side Vercel variables:

```env
MASSIVE_API_KEY=...
NEXT_PUBLIC_SUPABASE_URL=https://wgjyeddedsnbrqcbatwz.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
CRON_SECRET=...
AI_OPTIONS_REVIEW_ENABLED=false
```

Never expose `SUPABASE_SECRET_KEY` through a `VITE_` variable. The options tables have RLS enabled and are intentionally server-only. `vercel.json` schedules a once-per-minute SPY/SPX persistence refresh; the signed-in dashboard also refreshes on demand every 15 seconds. Vercel Cron's once-per-minute schedule requires a paid plan. This cadence is suitable for research and alerting, not latency-sensitive automatic execution.

The pre-existing broader market-intelligence application remains available at `/legacy`.

---

# Legacy AI Trading Agent

An intelligent financial market intelligence dashboard that helps retail traders identify investment opportunities 2-3 weeks before they go mainstream. Powered by Gemini 2.0 Flash and autonomous browser agents.

![AI Trading Agent Dashboard](https://via.placeholder.com/800x400?text=AI+Trading+Agent+Dashboard)

## 🎯 Features

### Predictive Intelligence
- **Rally Prediction Engine**: AI-powered analysis of historical patterns to predict upcoming sector rallies
- **Dynamic Sector Discovery**: Automatically detects emerging sectors (UAVs, rare earth metals, computational drug design, etc.)
- **Confidence Scoring**: Color-coded predictions (Green 75%+, Blue 60-74%, Amber <60%)
- **Early Warning Signals**: Identifies opportunities 2-3 weeks ahead of mainstream adoption

### Data Aggregation
- **Multi-Source News**: Aggregates financial news from Reuters, Bloomberg, Yahoo Finance, MarketWatch
- **ARK Invest Tracking**: Monitors Cathie Wood's daily trades across all ARK ETFs
- **YouTube Influencer Insights**: Tracks and summarizes content from trading YouTubers
- **Sentiment Analysis**: AI-powered analysis of news and social media sentiment

### Trading Intelligence
- **Priority Watchlist**: Special tracking for Google, NVDA, TSLA, SpaceX IPO, OpenAI IPO
- **Downside Risk Alerts**: Identifies recession signals, wars, market corrections for put trading
- **Sector Momentum**: Real-time tracking of AI, metals, quantum, energy, chip sectors
- **Historical Pattern Learning**: Learns from past rallies to improve future predictions

### AI Browser Agent
- **Prompt-Driven Automation**: Natural language instructions for web scraping
- **Autonomous Navigation**: AI decides which sites to visit and how to extract data
- **Multimodal Analysis**: Can analyze trading charts and images
- **Zero Hardcoding**: No brittle selectors or fixed URLs

## 🚀 Quick Start

### Prerequisites

- Node.js 22.x or higher
- PostgreSQL 14+
- PM2 (for production)
- OpenRouter API key (for Gemini 2.0 Flash)

### Installation

```bash
# Clone repository
git clone https://github.com/yourusername/ai-trading-agent.git
cd ai-trading-agent

# Install dependencies
pnpm install

# Configure environment
cp .env.production.template .env.production
nano .env.production  # Add your API keys

# Setup database
pnpm db:push

# Build application
pnpm build

# Start with PM2
pm2 start ecosystem.config.js
```

### Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Run tests
pnpm test

# Type checking
pnpm check
```

## 🔧 Configuration

### Required Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/trading_agent

# LLM (Gemini 2.0 Flash via OpenRouter)
OPENROUTER_API_KEY=your_key_here
LLM_MODEL=google/gemini-2.0-flash-001

# Server
PORT=5005
NODE_ENV=production
```

### Optional API Keys

```env
# Stock Prices (or use Yahoo Finance scraping)
ALPHA_VANTAGE_API_KEY=your_key_here

# News (or use web scraping)
NEWS_API_KEY=your_key_here

# YouTube (or use web scraping)
YOUTUBE_API_KEY=your_key_here
```

## 📊 Architecture

### Tech Stack

**Frontend:**
- React 19 + TypeScript
- Tailwind CSS 4
- tRPC for type-safe APIs
- Shadcn/ui components

**Backend:**
- Node.js + Express
- tRPC 11
- Drizzle ORM
- PostgreSQL

**AI & Automation:**
- Gemini 2.0 Flash (via OpenRouter)
- Puppeteer for browser automation
- Custom AI browser agent

### Project Structure

```
├── client/                 # Frontend React application
│   ├── src/
│   │   ├── pages/         # Page components
│   │   ├── components/    # Reusable UI components
│   │   └── lib/           # tRPC client
├── server/                # Backend Node.js application
│   ├── _core/             # Core server infrastructure
│   ├── services/          # Business logic services
│   │   ├── aiBrowserAgent.ts    # AI browser automation
│   │   ├── sentimentAnalysis.ts # News sentiment analysis
│   │   ├── rallyPrediction.ts   # Prediction engine
│   │   └── ...
│   ├── db.ts              # Database queries
│   └── routers.ts         # tRPC API routes
├── drizzle/               # Database schema
└── shared/                # Shared types and constants
```

## 🤖 AI Browser Agent Usage

The AI browser agent uses Gemini 2.0 Flash to autonomously navigate websites and extract data based on natural language prompts.

```typescript
import { executeAIBrowserTask } from './server/services/aiBrowserAgent';

// Example: Scrape financial news
const result = await executeAIBrowserTask(
  "Find the latest AI stock news from Reuters and Bloomberg. " +
  "Extract title, summary, URL, and published date for each article."
);

// Example: Get stock price
const price = await executeAIBrowserTask(
  "Go to Yahoo Finance and get the current price for NVDA stock"
);

// Example: ARK trades
const trades = await executeAIBrowserTask(
  "Visit ark-funds.com and extract all trades from today's daily email"
);
```

## 📈 Usage

### Dashboard Tabs

1. **Overview**: Sector momentum indicators, quick stats, recent alerts
2. **News Feed**: AI-analyzed financial news with sentiment and timeframe
3. **Watchlist**: Priority stocks and custom watchlist management
4. **ARK Trades**: Cathie Wood's portfolio changes
5. **Predicted Rallies**: AI predictions with confidence scores
6. **YouTube**: Influencer insights and video summaries

### Automated Tasks

The application runs automated tasks on a schedule:

- **News Analysis**: 3x daily (8am, 2pm, 8pm)
- **ARK Trades Sync**: Daily (9am)
- **YouTube Sync**: Daily (10am)
- **Prediction Generation**: Daily (11am)

Configure schedules in `.env.production`:

```env
CRON_NEWS_ANALYSIS=0 8,14,20 * * *
CRON_ARK_SYNC=0 9 * * *
CRON_YOUTUBE_SYNC=0 10 * * *
CRON_PREDICTIONS=0 11 * * *
```

## 🚢 Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed production deployment instructions including:

- PostgreSQL setup
- PM2 configuration
- nginx reverse proxy
- SSL/HTTPS setup
- Monitoring and maintenance

### Quick Deploy

```bash
# Build application
pnpm build

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup auto-start on boot
pm2 startup systemd
```

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test server/predictions.test.ts

# Watch mode
pnpm test --watch
```

Test coverage includes:
- News aggregation and sentiment analysis
- Watchlist management
- ARK trade tracking
- Rally prediction generation
- Sector discovery
- YouTube video syncing

## 💰 Cost Estimation

### Gemini 2.0 Flash Pricing (via OpenRouter)

- Input: $0.10 per 1M tokens
- Output: $0.40 per 1M tokens

### Daily Usage Estimate

- 100 news articles analyzed: ~$0.05
- 10 YouTube videos summarized: ~$0.03
- 5 predictions generated: ~$0.02
- 20 browser automation tasks: ~$0.10

**Total: ~$0.20/day or $6/month**

## 🔒 Security

- Environment variables for sensitive data
- PostgreSQL with SSL enabled
- Rate limiting on API endpoints
- Input validation and sanitization
- CORS configuration
- Helmet.js security headers

## 📝 License

MIT License - see [LICENSE](./LICENSE) file for details

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📧 Support

For issues or questions:
- Open an issue on GitHub
- Check [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment help

## 🙏 Acknowledgments

- Built with [tRPC](https://trpc.io/)
- UI components from [shadcn/ui](https://ui.shadcn.com/)
- Powered by [Gemini 2.0 Flash](https://deepmind.google/technologies/gemini/)
- Browser automation with [Puppeteer](https://pptr.dev/)

---

**Disclaimer**: This tool is for informational purposes only and does not constitute financial advice. Always do your own research before making investment decisions.
