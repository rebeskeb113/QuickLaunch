# QuickLaunch - Continuous Improvement TODO

> This file tracks enhancement ideas discovered during troubleshooting sessions.
> Review and address these items to improve app reliability.

## High Priority

### Auto-Install Dependencies
- [x] When `node_modules` is missing, offer to run `npm install` automatically
- [x] Show progress indicator during install
- [x] Support both npm and yarn detection

### Port Conflict Resolution
- [x] Add option to auto-select next available port when conflict detected
- [ ] Remember user's preference for port conflict handling
- [x] Show which process is using the conflicting port

### Startup Health Check
- [x] Implement proper health check endpoint polling instead of timer-based detection
- [x] Configurable health check URL per app (e.g., `/api/health`)
- [x] Timeout configuration for slow-starting apps

## Medium Priority

### Log Viewer
- [ ] Add expandable log panel on app cards
- [ ] Show last N lines of stdout/stderr
- [ ] Color-code errors vs info
- [ ] Add "Copy logs" button for support

### App Groups/Categories
- [ ] Allow grouping apps (e.g., "Frontend", "Backend", "Services")
- [ ] Batch start/stop for groups
- [ ] Collapsible group sections

### Configuration Persistence
- [ ] Export/import app configurations
- [ ] Sync config across machines (optional cloud backup)
- [ ] Config validation on import

## Low Priority

### UI Enhancements
- [ ] Dark/light theme toggle
- [ ] Customizable card colors per app
- [ ] Drag-and-drop card reordering
- [ ] Keyboard shortcuts (e.g., Ctrl+1 to toggle first app)

### Process Management
- [ ] Memory/CPU usage display per app
- [ ] Auto-restart on crash (configurable)
- [ ] Scheduled start/stop times

### Developer Experience
- [ ] VSCode extension integration
- [ ] CLI companion tool (`ql start bulletproof`)
- [ ] Webhook notifications on app status change

---

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
