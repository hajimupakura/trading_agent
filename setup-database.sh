#!/bin/bash

# Trading Agent PostgreSQL Database Setup Script
# Creates a new database called 'trading_agent' in the existing PostgreSQL instance

echo "========================================"
echo "   Trading Agent Database Setup"
echo "   Using Existing PostgreSQL"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Database credentials
DB_NAME="trading_agent"
DB_USER="trading_user"
DB_PASSWORD="trading_password"
DB_HOST="localhost"
DB_PORT="5434"  # Using buildzim's PostgreSQL port

echo -e "${BLUE}Database Configuration:${NC}"
echo "  Database: ${DB_NAME}"
echo "  User: ${DB_USER}"
echo "  Host: ${DB_HOST}"
echo "  Port: ${DB_PORT}"
echo ""

echo -e "${YELLOW}This will create a NEW database called '${DB_NAME}' in your existing PostgreSQL${NC}"
echo -e "${YELLOW}It will use the same PostgreSQL instance as buildzim (port 5434)${NC}"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Check if PostgreSQL is running
echo -e "${BLUE}Checking PostgreSQL connection...${NC}"
if ! pg_isready -h ${DB_HOST} -p ${DB_PORT} > /dev/null 2>&1; then
    echo -e "${RED}✗ PostgreSQL is not running on ${DB_HOST}:${DB_PORT}${NC}"
    echo ""
    echo "Please ensure the buildzim PostgreSQL container is running:"
    echo "  cd /home/hmpakula_gmail_com/git_repos/buildzim-platform"
    echo "  docker-compose up -d postgres"
    exit 1
fi
echo -e "${GREEN}✓ PostgreSQL is running${NC}"
echo ""

# Create database and user
echo -e "${BLUE}Creating database and user...${NC}"
echo "Please enter the PostgreSQL admin password when prompted."
echo "(Default for buildzim docker: buildzim_password)"
echo ""

# Use buildzim_user to create the new database
PGPASSWORD=buildzim_password psql -h ${DB_HOST} -p ${DB_PORT} -U buildzim_user -d buildzim_dev <<SQL
-- Create new database
CREATE DATABASE ${DB_NAME};

-- Create user if not exists (PostgreSQL 9.5+)
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_user WHERE usename = '${DB_USER}') THEN
        CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
    END IF;
END
\$\$;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};

\c ${DB_NAME}

-- Grant schema privileges
GRANT ALL ON SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO ${DB_USER};

-- Set default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO ${DB_USER};

SELECT 'Database and user created successfully!' AS status;
SQL

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}========================================"
    echo "✓ Database Setup Complete!"
    echo "========================================${NC}"
    echo ""
    echo "Database Details:"
    echo "  Database: ${DB_NAME}"
    echo "  User: ${DB_USER}"
    echo "  Password: ${DB_PASSWORD}"
    echo "  Host: ${DB_HOST}"
    echo "  Port: ${DB_PORT}"
    echo ""
    echo "Connection String:"
    echo "  postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
    echo ""
    echo -e "${BLUE}Next Steps:${NC}"
    echo "  1. The database is created but empty"
    echo "  2. Run './deploy.sh' to create tables and deploy the app"
    echo "  3. Or run 'pnpm drizzle-kit push' in the project directory to create tables"
    echo ""
else
    echo ""
    echo -e "${RED}========================================"
    echo "✗ Database Setup Failed"
    echo "========================================${NC}"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check if PostgreSQL is running:"
    echo "     docker-compose ps postgres"
    echo ""
    echo "  2. Verify the admin password (default: buildzim_password)"
    echo ""
    echo "  3. Ensure port 5434 is accessible:"
    echo "     nc -zv localhost 5434"
    echo ""
    exit 1
fi
