# QuickLaunch - Continuous Improvement TODO

> This file tracks enhancement ideas discovered during troubleshooting sessions.
> Review and address these items to improve app reliability.
>
> **Format:** Each TODO has a description on the next line explaining what it does.

## Next Session
- [ ] Dark/light theme toggle
  > Let you switch between a dark screen (easier on eyes at night) and a light screen (easier to see in bright rooms)
- [ ] Drag-and-drop card reordering
  > Move your app cards around by dragging them, so you can put your favorite apps first
- [x] ~~Remember user's preference for port conflict handling~~ → Replaced with port registry (apps.json) that prevents conflicts
- [x] Auto-restart on crash (configurable) → Implemented with max 3 attempts, 60s stability reset, 5min cooldown


## High Priority

### Auto-Install Dependencies
- [x] When `node_modules` is missing, offer to run `npm install` automatically
- [x] Show progress indicator during install
- [x] Support both npm and yarn detection

### Port Conflict Resolution
- [x] Add option to auto-select next available port when conflict detected
- [x] Show which process is using the conflicting port

### Startup Health Check
- [x] Implement proper health check endpoint polling instead of timer-based detection
- [x] Configurable health check URL per app (e.g., `/api/health`)
- [x] Timeout configuration for slow-starting apps

## Medium Priority

### Log Viewer
- [ ] Add expandable log panel on app cards
  > Click a button on any app card to see what that app is printing out (like a mini console window)
- [ ] Show last N lines of stdout/stderr
  > Only show the most recent messages (like the last 50 lines) so it doesn't get too long
- [ ] Color-code errors vs info
  > Make error messages show up in red and normal messages in white, so problems are easy to spot
- [ ] Add "Copy logs" button for support
  > One-click button to copy all the log text so you can paste it when asking for help

### App Groups/Categories
- [ ] Allow grouping apps (e.g., "Frontend", "Backend", "Services")
  > Organize your apps into folders like "Work Apps" or "Personal Projects" to keep things tidy
- [ ] Batch start/stop for groups
  > Start or stop all apps in a group with one click instead of clicking each one
- [ ] Collapsible group sections
  > Hide or show entire groups by clicking on them, like folders on your computer

### Configuration Persistence
- [ ] Export/import app configurations
  > Save all your app settings to a file, so you can load them on another computer
- [ ] Sync config across machines (optional cloud backup)
  > Automatically keep your settings the same on all your computers using the cloud
- [ ] Config validation on import
  > Check that imported settings are correct and won't break anything before loading them

## Low Priority

### UI Enhancements
- [ ] Keyboard shortcuts (e.g., Ctrl+1 to toggle first app)
  > Press keyboard combinations to quickly start/stop apps without using the mouse

### Process Management
- [ ] Memory/CPU usage display per app
  > Show how much computer power each app is using, like a mini task manager
- [ ] Scheduled start/stop times
  > Set apps to automatically start at 9am and stop at 5pm, like an alarm clock for your apps

### Developer Experience
- [ ] VSCode extension integration
  > Control QuickLaunch directly from inside VSCode without switching windows
- [ ] CLI companion tool (`ql start bulletproof`)
  > Type commands in the terminal to control apps, like "ql start myapp" instead of clicking
- [ ] Webhook notifications on app status change
  > Send a message to Slack or email when an app crashes or starts, so you always know what's happening

---


## Parking Lot

- [ ] Customizable card colors per app
  > Pick your own colors for each app card, like giving each app its own personality

## Support Codes Reference

| Code | Issue | Resolution |
|------|-------|------------|
| QL-PORT-001 | Port in use (first attempt) | Click retry for auto-kill |
| QL-PORT-002 | Port in use after retry | Manually close blocking app |
| QL-PATH-001 | Project path not found | Verify path in app settings |
| QL-NPM-001 | package.json missing | Run `npm init` or check path |
| QL-MOD-001 | Module not found | Run `npm install` |
| QL-FILE-001 | Required file missing | Check project integrity |
| QL-NET-001 | Network/server error | Ensure QuickLaunch server running |
| QL-ERR-000 | Unknown error | Check logs, contact support |
| QL-ERR-500 | Server exception | Check server logs |

---

*Last updated: 2026-01-01*
*Generated during troubleshooting session*
