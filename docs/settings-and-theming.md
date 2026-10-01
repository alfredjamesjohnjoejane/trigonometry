# Settings & Theming

## Settings System

**Module**: `src/settings/index.ts`

### Settings Page

The settings page is a full-screen overlay (`#settings-wrap`) with multiple sections:

| Section | Contents |
|---------|----------|
| Appearance | Landing animations toggle |
| Panic Key | Key input, URL input, presets |
| Maintenance | Check game status, CDN status display |
| Web App | PWA install button |
| Cache | Cache size display, clear cache button |

### Settings Persistence

All settings are stored in localStorage via the `ST` wrapper. See [Storage & Caching](storage-and-caching.md) for the full key list.

### Settings Migration

On load, stale keys from removed features are purged:

```ts
ST.remove('cloakMarketplace');  // Removed feature
ST.remove('onlineGames');       // Removed feature
```

This ensures old clients self-heal without clearing all data.

### Reset

```ts
export function resetHubSettings(): void
```

- Shows a confirmation dialog
- Removes all settings keys
- Reloads the page after 450ms

---

## Import/Export

### Export

```ts
export function exportData(): void
```

Collects all settings into a JSON object, encodes as base64:

```json
{
  "version": 2,
  "favs": ["url1", "url2"],
  "playCount": 42,
  "totalPlayTime": 3600,
  "settings": {
    "pk": "`",
    "panicUrl": "https://www.google.com",
    "sfx": "false",
    "landingAnims": "true",
    "theme": "midnight",
    "customPrimary": "#ffffff",
    "customAccent": "#cccccc",
    "cloakPreset": "classroom",
    "cloakTitle": "Google Classroom",
    "cloakUrl": "https://classroom.google.com/",
    "cloakIcon": "https://ssl.gstatic.com/classroom/favicon.png"
  }
}
```

Copied to clipboard (with `prompt()` fallback).

### Import

```ts
export function importData(): void
```

1. Decodes base64 input
2. Validates version (must be 2)
3. Sanitizes each setting value
4. Only allows specific keys (see `IMPORTABLE_SETTINGS_KEYS`)
5. Applies settings and re-renders

### Importable Keys

```
pk, panicUrl, sfx, landingAnims, theme,
customPrimary, customAccent,
cloakPreset, cloakTitle, cloakUrl, cloakIcon
```

### Value Sanitization

| Key | Validation |
|-----|-----------|
| `panicUrl`, `cloakUrl` | Must pass `isSafeHttpUrl()` |
| `customPrimary`, `customAccent` | Must match `/^#[0-9a-f]{6}$/i` |
| `theme` | Must match `/^[a-z0-9_-]{1,32}$/i` |
| `landingAnims` | Must be `'true'` or `'false'` |
| `pk` | Max 16 characters |
| `favs` | Max 5000 entries |
| `playCount`, `totalPlayTime` | Must be non-negative finite numbers |

---

## Theme System

**Module**: `src/theme/index.ts`

### Built-in Themes

Defined in `src/types/index.ts`:

| Theme | Primary | Accent | Accent Dark | Background |
|-------|---------|--------|-------------|------------|
| `mono` | `#ffffff` | `#cccccc` | `#888888` | Dark gradient |
| `shadow` | `#a0aec0` | `#718096` | `#4a5568` | Blue-gray gradient |
| `midnight` | `#cbd5e1` | `#64748b` | `#1e293b` | Navy gradient |

### Theme Application

```ts
export function applyTheme(theme: string): void
```

Sets CSS custom properties on `document.documentElement`:

```ts
document.documentElement.style.setProperty('--primary', t.p);
document.documentElement.style.setProperty('--accent', t.a);
document.documentElement.style.setProperty('--accent-dark', t.a2);
```

Also sets text colors, card backgrounds, and border colors based on the theme.

### Theme Preview

```ts
export function previewTheme(t: string): void
```

- Applies theme temporarily (1.8 seconds)
- Snapshots current theme for restoration
- Auto-reverts after timeout

### Custom Themes

```ts
export function saveCustomTheme(): void
```

Users can set custom primary and accent colors via hex color inputs:

- Validated: `/^#[0-9a-f]{6}$/i`
- Stored in `customPrimary` and `customAccent` localStorage keys
- Applied as a gradient background: `linear-gradient(-45deg, #111, primary, accent, #111)`

### Custom Theme Safety

Custom colors are re-validated on read (not just on save):

```ts
function readHex(key: string, fallback: string): string {
  const v = (ST.get(key) || '').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}
```

This prevents CSS injection from imported settings that bypass the save-time check.

---

## Landing Page Animations

### Toggle

```ts
export function toggleLandingAnims(): void
```

- Stored in `landingAnims` (`'true'`/`'false'`)
- Default: enabled
- When disabled: adds `anim-off` class to landing page

### Effects

| Effect | CSS Class | Description |
|--------|-----------|-------------|
| Liquid title | `.lt.fx-liquid` | White liquid rises/drains inside text outline |
| Chrome subtext | `.fx-chrome` | Brushed-metal letters with passing sheens |
| Button borders | `.br button::before/::after` | Border draws in from both sides on hover |

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  .lt.fx-liquid { animation: none; }
}
```

Respects the user's `prefers-reduced-motion` setting.

---

## Play Timer

**Module**: `src/ui/index.ts` → `startPlayTimer()`

Tracks total play time in seconds:

- Increments every second (only when tab is visible)
- Persists every 15 seconds and on `pagehide`/`visibilitychange`
- Displayed as `H:MM` format
- Stored in `playTime` localStorage key

```ts
function startPlayTimer(): void {
  setInterval(() => {
    if (document.hidden) return;
    totalPlayTime++;
    if (totalPlayTime % 15 === 0) persist();
    // Update display
  }, 1000);
}
```

---

## Settings Reminder

```ts
export function showSettingsReminder(): void
```

A one-time popup reminding users about new settings:

- Shows once (tracked by `settingsReminderSeen` in localStorage)
- "Open Settings" button navigates to settings
- "Later" button dismisses
