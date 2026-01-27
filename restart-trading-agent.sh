#!/bin/bash

# Trading Agent Restart Script
# Quick restart for trading-agent PM2 service

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_ROOT="/home/hmpakula_gmail_com/git_repos/trading_agent"
cd "$PROJECT_ROOT"

echo "========================================"
echo "   Trading Agent Restart"
echo "========================================"
echo ""

# Step 1: Stop PM2 process
echo -e "${YELLOW}Step 1: Stopping trading-agent...${NC}"
pm2 stop trading-agent 2>/dev/null || echo -e "${RED}Process not running${NC}"
echo -e "${GREEN}✓ Stopped${NC}"
echo ""

# Step 2: Start PM2 process
echo -e "${YELLOW}Step 2: Starting trading-agent...${NC}"
pm2 start ecosystem.config.cjs 2>/dev/null || pm2 restart trading-agent
echo -e "${GREEN}✓ Started${NC}"
echo ""

# Step 3: Show status
echo -e "${YELLOW}Step 3: Checking status...${NC}"
pm2 list
echo ""

# Summary
echo "========================================"
echo -e "${GREEN}   Restart Complete!${NC}"
echo "========================================"
echo ""
echo "Application URL:"
echo "  http://35.238.160.230:5005"
echo ""
echo "Useful commands:"
echo "  pm2 logs trading-agent   - View logs"
echo "  pm2 monit                - Monitor in real-time"
echo "  pm2 restart trading-agent - Quick restart"
echo ""
