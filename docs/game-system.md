# Game System

## Overview

The game system is the core of jesherhead. It loads a catalog of 1000+ games from a JSON file, renders them as a filterable/sortable grid, and launches them in sandboxed iframes.

## Game Catalog

### Data Source

Games are loaded from `public/data/games_merged.json` — a static JSON array. Each entry:

```json
{
  "n": "Smash Karts",           // name
  "c": "action",                // category
  "u": "https://games.crazygames.com/...",  // URL
  "i": "https://imgs.crazygames.com/...",   // thumbnail (optional)
  "d": "Multiplayer kart battle arena",      // description (optional)
  "p": 1,                       // player count
  "isNew": true,                // new badge (optional)
  "broken": false,              // broken flag (optional)
  "src": "og"                   // source identifier
}
```

### Loading

```ts
// src/games/index.ts
async function loadGames(): Promise<void>
```

- Fetches `data/games_merged.json` with up to 3 retries (exponential backoff + jitter)
- Merges with local play counts and "played" history from localStorage
- Sets `GAMES_READY = true` on success
- Exported as `loadGames` for use by `main.ts` and `ui/index.ts`

## Game Categories

Games are filtered by the `c` (category) field. Built-in special categories:

| Category | Filter |
|----------|--------|
| `all` | No filter |
| `favs` | Games in favorites list (localStorage) |
| `2player` | Games with `p >= 2` |
| Any other | Exact match on `c` field |

## Game Rendering

```ts
function renderGames(): void
```

1. Reads favorites from localStorage
2. Filters by current category
3. Filters by search term (matches name and description)
4. Sorts by name (localeCompare) or play count
5. Clears the grid (`grid.replaceChildren()`)
6. Builds cards in a `DocumentFragment` (off-DOM for performance)
7. Appends fragment to grid

### Card Structure

```html
<div class="card">
  <img class="cbg" src="thumbnail" loading="lazy" />
  <div class="cov">
    <button class="pb">Play</button>
  </div>
  <!-- Optional: <div class="bbdg">BLOCKED</div> -->
</div>
```

### Card Interactions

- **Click card or Play button**: Launches the game
- **Mouse move**: 3D tilt effect (throttled via `requestAnimationFrame`)
- **Mouse enter**: Shows tooltip with description
- **Mouse leave**: Hides tooltip, resets tilt

### Blocked Games

Games with `broken: true` in the catalog:
- Show a "BLOCKED" ribbon badge
- Play button is disabled and shows "Blocked"
- No click handler, no tilt, no tooltip
- `aria-disabled="true"` for accessibility

## Game Launching

```ts
async function launchGame(url: string, name: string): void
```

### Launch Flow

1. **Staleness token**: `launchSeq` prevents race conditions (launching B while A is fetching)
2. **Analytics**: Tracks game play via PostHog
3. **Play count**: Increments in-memory and localStorage
4. **Iframe setup**:
   - Sets `sandbox="allow-scripts allow-forms allow-popups allow-modals"`
   - Sets `allow="storage-access *; autoplay; fullscreen"`
   - Clears `src` and `srcdoc`
5. **Content loading** (three paths):

#### Path 1: HTML Source URLs
```ts
function isHtmlSourceUrl(url: string): boolean
```
Matches URLs from `cdn.jsdelivr.net/gh/gn-math/html@main`, `cdn.jsdelivr.net/gh/3kh0/3kh0-lite@main`, or any `.html` URL.

For these, `buildRenderableHtml(url)` in `src/games/html.ts`:
1. Checks IndexedDB cache first
2. On miss, fetches the HTML with `credentials: 'omit'`
3. Injects `<base href="...">` and `<meta name="referrer" content="no-referrer">` into `<head>`
4. Caches the result in IndexedDB
5. Falls back to `buildGameIframeHtml(url)` on error

#### Path 2: Lumin SDK Test
Special URL `__TEST_LUMIN__` loads the Lumin SDK test page:
1. Checks cache (discards stale entries with `script@1/`)
2. Falls back to `getTestPageHtml()` which creates a page with the Lumin SDK script
3. Calls `Lumin.init({container, theme: 'dark'})`

#### Path 3: Standard iframe wrapper
```ts
function buildGameIframeHtml(url: string): string
```
Creates a minimal HTML page with a fullscreen iframe pointing to the game URL. Used for most games.

### New Tab Launch

```ts
async function openGameTab(): Promise<void>
```

Opens the current game in a new tab using the "shell" pattern:
1. Opens `about:blank` popup
2. Builds a toolbar (Back to Hub, title, Reload) via DOM APIs
3. Appends a sandboxed iframe with the game
4. Falls back to direct `window.open` if popup blocked

## Search

```ts
function searchGames(t: string): void
```

- Case-insensitive matching on name and description
- Re-renders the grid on each call
- No debouncing (grid re-render is fast enough for 1000+ games)

## Random Game

```ts
function randomGame(): void
```

- Filters out broken games
- Respects current category filter
- Picks random entry and launches it

## Sorting

```ts
function sortGames(type: string, btn: HTMLElement): void
```

Two sort modes:
- `name`: Alphabetical (localeCompare)
- `plays`: By play count (descending)

## Favorites

Favorites are stored in localStorage as a JSON array of game URLs under the key `favs`. The `favs` category filter shows only favorited games.

## Play Tracking

Three localStorage keys track play statistics:

| Key | Format | Description |
|-----|--------|-------------|
| `playCount` | Number (string) | Total games played |
| `gamePlays` | JSON object `{url: count}` | Per-game play counts (max 1000 entries) |
| `gamePlayed` | JSON array `[url, ...]` | URLs of played games (max 1000 entries) |
