#!/bin/bash

# Trading Agent Production Deployment Script
# Ports: Frontend 3005 (via backend), Backend 5005

set -e

echo "========================================"
echo "   Trading Agent Deployment"
echo "   Backend: Port 5005"
echo "   (Frontend bundled with backend)"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_ROOT="/home/hmpakula_gmail_com/git_repos/trading_agent"
cd "$PROJECT_ROOT"

# Step 1: Check if database exists
echo -e "${YELLOW}Step 1: Checking database...${NC}"
DB_EXISTS=$(mysql -u root -e "SHOW DATABASES LIKE 'trading_agent';" 2>/dev/null | grep trading_agent || echo "")

if [ -z "$DB_EXISTS" ]; then
    echo -e "${RED}✗ Database 'trading_agent' not found${NC}"
    echo "Please run ./setup-database.sh first to create the database"
    exit 1
fi
echo -e "${GREEN}✓ Database exists${NC}"
echo ""

# Step 2: Install dependencies
echo -e "${YELLOW}Step 2: Installing dependencies...${NC}"
pnpm install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Step 3: Push database schema
echo -e "${YELLOW}Step 3: Pushing database schema...${NC}"
pnpm drizzle-kit push
echo -e "${GREEN}✓ Database schema updated${NC}"
echo ""

# Step 4: Build application
echo -e "${YELLOW}Step 4: Building application...${NC}"
pnpm build
echo -e "${GREEN}✓ Application built${NC}"
echo ""

# Step 5: Stop existing PM2 process
echo -e "${YELLOW}Step 5: Stopping existing processes...${NC}"
pm2 stop trading-agent 2>/dev/null || echo "No existing process"
pm2 delete trading-agent 2>/dev/null || echo "No existing process to delete"
echo -e "${GREEN}✓ Stopped existing processes${NC}"
echo ""

# Step 6: Start PM2 process
echo -e "${YELLOW}Step 6: Starting PM2 process...${NC}"
pm2 start ecosystem.config.js
echo -e "${GREEN}✓ PM2 process started${NC}"
echo ""

# Step 7: Save PM2 configuration
echo -e "${YELLOW}Step 7: Saving PM2 configuration...${NC}"
pm2 save
echo -e "${GREEN}✓ PM2 configuration saved${NC}"
echo ""

# Step 8: Show status
echo -e "${YELLOW}Step 8: Checking status...${NC}"
pm2 list
echo ""

# Summary
echo "========================================"
echo -e "${GREEN}   Deployment Complete!${NC}"
echo "========================================"
echo ""
echo "Application URL:"
echo "  http://35.238.160.230:5005"
echo ""
echo "The frontend is served by the backend on port 5005"
echo ""
echo "Useful commands:"
echo "  pm2 list                 - Show all processes"
echo "  pm2 logs trading-agent   - View logs"
echo "  pm2 restart trading-agent - Restart"
echo "  pm2 monit                - Monitor in real-time"
echo ""
echo "Database:"
echo "  Name: trading_agent"
echo "  User: trading_user"
echo ""
