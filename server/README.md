# Psych Scribe Server (Mac Mini)

Storage backend for Psych Scribe notes. Runs on Mac Mini, receives completed notes from the Electron app on Lorenzo's laptop.

## Architecture

```
Laptop (Psych Scribe)          Mac Mini
┌─────────────────┐           ┌──────────────────┐
│ Dictate/paste    │           │ Express server    │
│ → Claude API     │──POST──→ │ → SQLite (notes)  │
│ → Display note   │  :7450   │ → Mae can query   │
└─────────────────┘           └──────────────────┘
```

- Notes generated locally on laptop (Claude API called directly)
- After generation, note synced to Mac Mini via HTTP POST
- Sync is non-blocking — if server is down, app works fine
- No PHI in transit headers, only in encrypted request body
- Bearer token auth

## Setup on Laptop

In Psych Scribe, the sync config is stored in `~/.psych-scribe/config.json`:

```json
{
  "syncServerUrl": "http://<mac-mini-ip>:7450",
  "syncAuthToken": "<token>",
  "syncEnabled": true
}
```

For now, manually add those fields. UI settings panel coming later.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Server status + note count |
| POST | `/api/notes` | Yes | Submit a note |
| GET | `/api/notes` | Yes | List notes (query: site, limit, offset) |
| GET | `/api/notes/:id` | Yes | Get full note |
| DELETE | `/api/notes/:id` | Yes | Delete a note |

## Token

Stored in macOS Keychain: `secret get psych-scribe-server-token`

## Service

Auto-starts via launchd: `com.mae.psych-scribe-server`

```bash
# Check status
curl http://localhost:7450/health

# Restart
launchctl unload ~/Library/LaunchAgents/com.mae.psych-scribe-server.plist
launchctl load ~/Library/LaunchAgents/com.mae.psych-scribe-server.plist
```
