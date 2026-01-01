# QuickLaunch

> **Codename:** QuickLaunch
> **Localhost:** Simply open index.html in browser (static file)

## About

QuickLaunch is a simple localhost dashboard for quick-launching all your local development apps. It displays app icons with one-click access to their localhost URLs.

## Features

- One-click launch to any localhost app
- Visual status indicators (green = running, red = offline)
- Add/manage apps through the UI
- Apps persist in localStorage
- Auto-refresh status every 30 seconds

## Registered Apps

Apps are stored in localStorage. Default apps:

| Codename | Real Name | Port | Icon |
|----------|-----------|------|------|
| Bulletproof | HTM_Email | 5173 | 📧 |

## Usage

1. Open `index.html` in your browser
2. Click any app card to launch it
3. Click "+ Add App" to register a new localhost app

## Tech Stack

- Pure HTML/CSS/JS (no build step required)
- localStorage for persistence

---
*Last updated: 2026-01-01*
