# QuickLaunch

> **Codename:** QuickLaunch
> **Localhost:** http://localhost:8000

## About

QuickLaunch is a localhost dashboard for launching and controlling local development apps. It displays app icons with one-click access and on/off toggles to start/stop dev servers.

## Development Ground Rules

**We are a team. Claude must converse before implementing.**

1. **No unsolicited features** - Do not add features, UI elements, or functionality without explicit user approval. If you have an idea, propose it first and wait for confirmation.
2. **Discuss before coding** - Present options and get buy-in before writing code.
3. **Minimal changes** - Only implement what is explicitly requested.
4. **Comment generously** - Add lots of comments in code and documentation. This makes unwinding past work much faster.

## Features

- On/off toggle switches to start/stop apps
- One-click launch to any localhost app (click icon when running)
- Visual status indicators (green = running, red = offline)
- Add/manage apps through the UI
- **Port registry** prevents port conflicts between apps
- Express backend for process control

## Architecture

### Source of Truth: `apps.json`

App definitions and port reservations are stored server-side in `apps.json`:

```json
{
  "reservedPorts": {
    "8000": "QuickLaunch (system)",
    "3000": "Common Express/React default - avoid"
  },
  "apps": [
    {
      "id": "bulletproof",
      "name": "Bulletproof",
      "port": 5173,
      "path": "C:\\...\\HTM_Email",
      "command": "npm run dev",
      ...
    }
  ]
}
```

### Port Management

1. **Reserved ports** - Ports used by external services (PostgreSQL, Redis, etc.) that QuickLaunch doesn't manage but should avoid
2. **App ports** - Ports assigned to QuickLaunch-managed apps
3. **Real-time validation** - When adding/editing apps, the UI checks port availability against both the registry and system

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/apps` | GET | List all apps |
| `/api/apps` | POST | Add new app |
| `/api/apps/:id` | PUT | Update app |
| `/api/apps/:id` | DELETE | Remove app |
| `/api/ports/check/:port` | GET | Check port availability |
| `/api/ports/suggest` | GET | Get next available port |
| `/api/ports/reserve` | POST | Reserve a port |

## Registered Apps

Apps are defined in `apps.json`. Current apps:

| Codename | Real Name | Port | Icon |
|----------|-----------|------|------|
| Bulletproof | HTM_Email | 5173 | 📧 |

## Usage

```bash
cd C:\Users\BenjaminRebeske\Documents\Projects\QuickLaunch
npm start
```

Then visit http://localhost:8000

## Tech Stack

- Frontend: HTML/CSS/JS
- Backend: Express.js (Node.js)
- Process management: tree-kill

---
*Last updated: 2026-01-01*
