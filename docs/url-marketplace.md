# URL Marketplace

## Overview

**File**: `public/urls.html` + `worker/src/index.js`

The URL Marketplace is a community-driven link submission system. Users can submit URLs, vote on them, and report broken links. It's powered by a Cloudflare Worker that uses GitHub Issues as a database.

## Page Structure

The marketplace page (`urls.html`) is a standalone HTML page with:

- Header with title and info button
- Submission form (URL, description, category)
- Filter tabs (All, Games, AI, Media)
- Entry cards with voting buttons
- Admin login (if configured)
- Info banner (admin announcement)

## API Integration

The page fetches from the Cloudflare Worker:

```js
// Load entries
const res = await fetch('https://url-marketplace.jesherhead.workers.dev/list');
const { entries, mode, notice } = await res.json();

// Submit URL
await fetch('https://url-marketplace.jesherhead.workers.dev/submit', {
  method: 'POST',
  body: JSON.stringify({ url, description, category })
});

// Vote
await fetch('https://url-marketplace.jesherhead.workers.dev/react', {
  method: 'POST',
  body: JSON.stringify({ id, type: 'thumbsup', voter })
});
```

## Entry Card

Each entry displays:
- URL (clickable)
- Description (max 50 chars)
- Category icon (games/AI/media)
- Status indicator (working/blocked)
- Vote buttons: 👍 (+1), 👎 (-1), 🔥 (+2), ❌ (-5)
- Report button

## Voting

- One vote per browser per entry
- Voter ID stored in localStorage + cookie
- Switching vote moves the count
- Removing vote decrements count
- Vote counts stored in Cloudflare KV (not GitHub reactions)

## Submission Categories

| Category | Icon | Description |
|----------|------|-------------|
| `games` | 🎮 | Game sites |
| `ai` | 🤖 | AI tools |
| `media` | 🎬 | Media/streaming |
| (none) | — | No category |

## Safety

Submissions are screened by:
1. URL validation (no localhost, intranet, credentials)
2. Static denylists (adult content, executable downloads)
3. Google Safe Browsing (optional, when configured)
4. Description validation (no links, no profanity)

## Admin Features

- Login with username/password
- View all entries (including closed)
- Set entry status (working/blocked)
- Remove/reopen entries
- Clear review flags
- Set kill-switch mode (normal/readonly/off)
- Set public announcement

## Rate Limits

| Action | Limit |
|--------|-------|
| Submit URL | 20/hour |
| Vote | 200/hour |
| Report | 20/hour |
| List entries | 300/hour |
| Admin login | 10 failures/hour |
