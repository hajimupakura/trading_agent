# Security Setup

## Initial Setup

1. Copy the example config file:
   ```bash
   cp ecosystem.config.example.cjs ecosystem.config.cjs
   cp .env.example .env
   ```

2. Edit `ecosystem.config.cjs` and `.env` with your actual credentials:
   - `GEMINI_API_KEY`: Get from https://makersuite.google.com/app/apikey
   - `DATABASE_URL`: Your PostgreSQL connection string
   - `JWT_SECRET`: Generate with `openssl rand -hex 32`

3. **NEVER commit these files to git!** They are in `.gitignore` for security.

## Environment Variables

The application requires these environment variables:

- `GEMINI_API_KEY`: Google Gemini API key for AI features
- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: Secret for JWT token signing
- `LLM_MODEL`: AI model to use (default: gemini-2.5-flash)
- `PORT`: Application port (default: 5005)

## Security Best Practices

- ✅ Never commit API keys or secrets to git
- ✅ Never share API keys in chat or conversations
- ✅ Rotate secrets immediately if exposed
- ✅ Use SSH keys for git instead of Personal Access Tokens
- ✅ Keep `.env` and `ecosystem.config.cjs` in `.gitignore`
