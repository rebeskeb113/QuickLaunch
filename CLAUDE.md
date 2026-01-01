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
- Apps persist in localStorage
- Express backend for process control

## Registered Apps

Apps are stored in localStorage. Default apps:

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
