# 🔐 Security Cleanup - ACTION PLAN

## ✅ What I've Done

1. **Created Safe Templates**
   - ✅ `ecosystem.config.example.cjs` - Safe config template (can be committed)
   - ✅ `SECURITY.md` - Security setup instructions
   - ✅ Updated `.gitignore` to ignore sensitive files

2. **Cleaned Git History**
   - ✅ Removed `ecosystem.config.cjs` from ALL git history
   - ✅ Cleaned up git references and garbage collected old commits
   - ✅ Updated remote URL to use SSH (no more exposed tokens in URL)

## 🚨 CRITICAL: What You MUST Do Now

### 1. Revoke ALL Exposed Secrets

#### A. Revoke GitHub Personal Access Token
The token `ghp_40UsGD...` was exposed in git remote URL.

**Steps:**
1. Go to: https://github.com/settings/tokens
2. Find and **DELETE** the token starting with `ghp_40UsGDW...`
3. Generate a new token if needed (or use SSH keys - recommended)

#### B. Delete Old Gemini API Keys
Both keys were reported as leaked by Google:
- `AIzaSyCyVRT2eFLR9CqvGDRdjNR8b8bCa-0L3Nc` ❌
- `AIzaSyAOaCjQBNPv8sRarY_Bn17LJlx3H9DZ2gE` ❌

**Steps:**
1. Go to: https://makersuite.google.com/app/apikey
2. **Delete** both old keys
3. **Create** a brand new API key
4. **Keep it secret!** Never share in chat or commit to git

### 2. Set Up SSH Keys for GitHub (Recommended)

#### Generate SSH Key:
```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
# Press Enter to accept default location
# Enter a passphrase (recommended)
```

#### Add to SSH Agent:
```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
```

#### Add to GitHub:
1. Copy your public key:
   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```
2. Go to: https://github.com/settings/keys
3. Click "New SSH key"
4. Paste your public key
5. Save

#### Test Connection:
```bash
ssh -T git@github.com
# Should see: "Hi hajimupakura! You've successfully authenticated..."
```

### 3. Update Your Credentials

#### A. Update Gemini API Key:
```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent

# Edit ecosystem.config.cjs with NEW key
nano ecosystem.config.cjs
# Update line 19: GEMINI_API_KEY: 'YOUR_NEW_KEY_HERE'

# Edit .env with NEW key
nano .env
# Update: GEMINI_API_KEY=YOUR_NEW_KEY_HERE
```

#### B. Restart the Application:
```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent
npx pm2 delete trading-agent
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

### 4. Force Push Cleaned History

⚠️ **WARNING**: This will rewrite GitHub history. Coordinate with team if collaborating.

```bash
cd /home/hmpakula_gmail_com/git_repos/trading_agent
git push --force-with-lease origin main
```

If using HTTPS temporarily (not recommended):
```bash
git remote set-url origin https://github.com/hajimupakura/trading_agent.git
git push --force-with-lease origin main
# Then switch back to SSH after setting up keys
git remote set-url origin git@github.com:hajimupakura/trading_agent.git
```

## 📋 Future Best Practices

### ✅ DO:
- ✅ Use `.env` files for secrets (already in `.gitignore`)
- ✅ Use `ecosystem.config.example.cjs` as template
- ✅ Use SSH keys for git authentication
- ✅ Rotate secrets immediately if exposed
- ✅ Review commits before pushing

### ❌ DON'T:
- ❌ Commit `.env` or `ecosystem.config.cjs` files
- ❌ Share API keys in chat/conversations/email
- ❌ Use Personal Access Tokens in git URLs
- ❌ Hardcode secrets in source code
- ❌ Push without reviewing changes first

## 🔍 Verify Security

After completing above steps, verify:

```bash
# 1. Check no secrets in git history
cd /home/hmpakula_gmail_com/git_repos/trading_agent
git log -p | grep -E "AIzaSy|ghp_" | wc -l
# Should output: 0

# 2. Verify .gitignore works
git status
# Should NOT show ecosystem.config.cjs or .env

# 3. Test new API key
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=YOUR_NEW_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"test"}]}]}' | grep -v "leaked"
# Should work without 403 error
```

## 📞 Summary

**Secrets exposed:**
- GitHub PAT: `ghp_40Us...` (revoke immediately)
- Gemini Key 1: `AIzaSyCy...` (already disabled by Google)
- Gemini Key 2: `AIzaSyAO...` (already disabled by Google)

**Your cleaned repo is ready to push, but you MUST:**
1. Revoke GitHub token
2. Generate NEW Gemini API key
3. Set up SSH keys (recommended)
4. Force push cleaned history
5. Update credentials and restart app
