# Cloudflare Worker (URL Marketplace)

## Overview

**File**: `worker/src/index.js`

The Cloudflare Worker powers the URL Marketplace — a community-driven link submission system. It uses GitHub Issues as a database and KV for rate limiting, vote tallies, and configuration.

## Architecture

```
Browser (urls.html)
    │
    │ fetch /list, /submit, /react, /report
    ▼
Cloudflare Worker (url-marketplace)
    │
    ├── GitHub Issues API (via GITHUB_TOKEN)
    ├── Cloudflare KV (rate limits, tallies, config)
    └── PostHog upstream (analytics proxy)
```

## Endpoints

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/list` | List marketplace entries (newest first, max 100) |
| GET | `/notice` | Get public admin announcement |
| POST | `/submit` | Submit a new URL |
| POST | `/feedback` | Report an entry as blocked |
| POST | `/react` | Vote on an entry (emoji reaction) |
| POST | `/report` | Flag an entry for review |
| GET | `/ph/*` | PostHog analytics proxy |

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/login` | Authenticate (returns 12h token) |
| GET | `/admin/list` | List all entries including closed |
| GET | `/admin/reports` | List flagged entries |
| POST | `/admin/status` | Set entry status |
| POST | `/admin/remove` | Close/reopen an entry |
| POST | `/admin/clear-report` | Remove review flag |
| GET | `/admin/notice` | Get announcement (including hidden) |
| POST | `/admin/notice` | Set announcement |
| POST | `/admin/mode` | Set kill-switch mode |

## GitHub Issues as Database

Each marketplace entry is a GitHub Issue:

```
Title: Site: example.com
Body:
  URL: https://example.com
  Description: A great site
  Category: games
  Status: working
  Submitted: 2026-01-15T10:30:00.000Z

Labels: marketplace-url, status:working
```

### Labels

| Label | Purpose |
|-------|---------|
| `marketplace-url` | Identifies marketplace entries |
| `status:working` | Entry is active |
| `status:blocked` | Entry is blocked |
| `needs-review` | Flagged for admin review |

## Submission Flow

```
POST /submit {url, description?, category?}
    │
    ├── Rate limit check (20/hour per IP)
    ├── Mode check (normal/readonly/off)
    ├── URL validation (parseUrl)
    ├── Description validation (checkDescription)
    ├── Static safety check (checkUrlSafety)
    ├── Safe Browsing check (optional, fail-open)
    ├── Duplicate check (canonical URL comparison)
    ├── Create GitHub Issue
    └── Return entry
```

### URL Validation (`parseUrl`)

- Must be `http://` or `https://`
- Max 500 characters
- No credentials in URL
- Rejects: localhost, 0.0.0.0, .local, .localhost, .internal, .lan, 127.x, 10.x, 192.168.x, 172.16-31.x, 169.254.x

### Description Validation (`checkDescription`)

- Max 50 characters
- No links (URLs, www., TLDs)
- No banned words (profanity, sexual content)
- Whole-word matching only

### Safety Check (`checkUrlSafety`)

Static denylists enforced on every submission:

- **Adult TLDs**: xxx, adult, porn, sex, sexy
- **Blocked domains**: 50+ known adult sites
- **Adult labels**: porn, hentai, sex, escort, etc.
- **Blocked extensions**: exe, msi, apk, dmg, pkg, scr, bat, cmd, ps1, vbs, msc

### Safe Browsing (Optional)

When `SAFE_BROWSING_KEY` is configured:
- Screens URLs against Google Safe Browsing API v4
- Checks for: MALWARE, SOCIAL_ENGINEERING, UNWANTED_SOFTWARE, POTENTIALLY_HARMFUL_APPLICATION
- Results cached in KV for 1 hour
- **Fail-open**: If the API errors, the submission proceeds (static denylists still apply)

## Voting System

### Reaction Types

| Type | Weight | Emoji |
|------|--------|-------|
| `thumbsup` | +1 | 👍 |
| `thumbsdown` | -1 | 👎 |
| `fire` | +2 | 🔥 |
| `redx` | -5 | ❌ |

### Vote Storage

- **KV key**: `vote:{scope}:{issueId}` where scope is voter ID or IP
- **Tally**: `tally:{issueId}` — JSON object with counts per type
- **Reactions**: `react:{scope}:{issueId}:{type}` — tracks which types a voter has used

### Voter Identity

- **Preferred**: Per-browser voter ID (localStorage + cookie, 8-64 chars)
- **Fallback**: IP address (for old clients)
- **Legacy migration**: Old per-type keys are folded into the single current-vote key

### Vote Rules

- One vote per browser per entry
- Switching vote: decrements old type, increments new type
- Removing vote: decrements count
- Same type twice: 409 error
- Vote limit: 200/hour per IP

## Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/submit` | 20/hour | Per IP+UA |
| `/feedback` | 20/hour | Per IP+UA |
| `/react` | 200/hour | Per IP+UA |
| `/report` | 20/hour | Per IP+UA |
| `/list` | 300/hour | Per IP+UA |
| `/admin/login` | 10 failures/hour | Per IP |

Rate limit keys are composite: `IP + User-Agent hash` to prevent header-less requests from sharing one bucket.

## Admin Authentication

### Login

```
POST /admin/login {user, pass}
```

- Password hashed with SHA-256, compared in constant-time
- Rate-limited: 10 failures per hour per IP
- Returns HMAC-signed token (12-hour expiry)

### Token Format

```
base64url(payload).base64url(HMAC-SHA256(payload))
```

Payload: `{"u": "username", "exp": 1234567890}`

### Token Verification

- HMAC signature verified in constant-time
- Username match verified
- Expiry checked

## Kill Switch

Admin can set marketplace mode:

| Mode | Effect |
|------|--------|
| `normal` | Full functionality |
| `readonly` | No submissions, votes, or reports |
| `off` | All endpoints return 503 |

Mode is stored in KV at `marketplace:mode`.

## Announcements

Admin can set a public announcement:

```
POST /admin/notice {text, visible}
```

- Max 500 characters
- Plain text only (rendered escaped)
- Stored in KV at `marketplace:notice`
- Publicly visible only when `visible: true` and text is non-empty

## CORS

All responses include CORS headers for `https://jesherhead.github.io`:

```
Access-Control-Allow-Origin: https://jesherhead.github.io
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

## Configuration

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `GITHUB_TOKEN` | Fine-grained PAT for GitHub Issues API |

### Optional Secrets

| Secret | Purpose |
|--------|---------|
| `SAFE_BROWSING_KEY` | Google Safe Browsing API key |
| `ADMIN_USER` | Admin username |
| `ADMIN_PASS_HASH` | SHA-256 hash of admin password |
| `ADMIN_SECRET` | HMAC signing secret for session tokens |

### KV Namespaces

| Binding | ID | Purpose |
|---------|----|---------|
| `RL` | `33c6cc4902044f1789ab5e1248564b22` | Rate limits, tallies, votes, config |

## Deployment

```bash
cd worker/
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put SAFE_BROWSING_KEY  # optional
npx wrangler secret put ADMIN_USER          # optional
npx wrangler secret put ADMIN_PASS_HASH     # optional
npx wrangler secret put ADMIN_SECRET        # optional
npx wrangler deploy
```
