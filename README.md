# QuickLaunch

A local development dashboard for managing and launching your dev apps with one click.

![QuickLaunch Dashboard](https://img.shields.io/badge/version-2.0.0-blue) ![Node.js](https://img.shields.io/badge/node-%3E%3D16-green) ![License](https://img.shields.io/badge/license-MIT-brightgreen)

## Features

- **One-Click Start/Stop** - Toggle your dev servers on and off with a single click
- **Visual Status Dashboard** - See which apps are running at a glance with live status indicators
- **Port Management** - Built-in port registry prevents conflicts between apps
- **Auto-Restart on Crash** - Optionally restart apps automatically if they crash (configurable per app)
- **Health Check Monitoring** - Configurable health check endpoints with custom timeouts
- **Smart Error Handling** - Detailed troubleshooting info when things go wrong, with actionable suggestions
- **Dependency Auto-Install** - Detects missing `node_modules` and offers to run `npm install`
- **TODO Triage Panel** - Built-in task management integrated with your project's TODO.md

## Quick Start

```bash
# Clone the repository
git clone https://github.com/rebeskeb113/QuickLaunch.git
cd QuickLaunch

# Install dependencies
npm install

# Start QuickLaunch
npm start
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

## Adding Your Apps

1. Click the **"+ Add App"** card in the dashboard
2. Fill in the details:
   - **App Name** - Display name for your app
   - **Description** - Brief description (optional)
   - **Port** - The port your app runs on
   - **Project Path** - Full path to the project folder
   - **Start Command** - Command to start the dev server (e.g., `npm run dev`)
   - **Icon** - Emoji to identify your app (optional)
3. Click **Save App**

### Example Configuration

```json
{
  "id": "my-app",
  "name": "My App",
  "description": "React frontend for my project",
  "port": 3000,
  "path": "C:\\Projects\\my-app",
  "command": "npm run dev",
  "icon": "⚛️",
  "autoRestart": true,
  "startupTimeout": 30000,
  "healthCheckUrl": "/api/health"
}
```

## Configuration

Apps are stored in `apps.json` in the project root. You can edit this file directly or use the web interface.

### App Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | required | Display name |
| `port` | number | required | Port the app runs on |
| `path` | string | required | Absolute path to project folder |
| `command` | string | required | Command to start the app |
| `description` | string | `""` | Brief description |
| `icon` | string | `"🚀"` | Emoji icon |
| `autoRestart` | boolean | `false` | Auto-restart on crash (max 3 attempts) |
| `startupTimeout` | number | `30000` | Health check timeout in ms |
| `healthCheckUrl` | string | `null` | Custom health check endpoint |

### Reserved Ports

You can reserve ports to prevent conflicts:

```json
{
  "reservedPorts": {
    "8000": "QuickLaunch (system)",
    "3000": "Reserved for frontend",
    "5432": "PostgreSQL"
  }
}
```

## TODO Integration

QuickLaunch includes a built-in TODO triage system. Create a `TODO.md` file in the QuickLaunch directory with this format:

```markdown
## Next Session
- [ ] Task to do first
  > Description of what this task involves

## High Priority
- [ ] Critical bug fix
  > Explain the bug here

## Medium Priority
- [ ] Feature enhancement
  > What the feature does

## Low Priority
- [ ] Nice to have
  > Optional improvement
```

The triage panel lets you:
- **Implement** - Mark items for immediate work
- **Parking Lot** - Defer items for later
- **Don't Do** - Remove items with documentation

## Troubleshooting

### Common Issues

**Port already in use**
- QuickLaunch will detect the conflict and offer to use an alternative port
- Or show you which process is blocking and offer to retry

**Dependencies missing**
- If `node_modules` is missing, QuickLaunch offers to run `npm install` automatically

**App won't start**
- Check the troubleshooting steps in the error toast
- Verify the project path exists
- Ensure `package.json` is present
- Try running the start command manually in the project directory

### Support Codes

| Code | Issue | Resolution |
|------|-------|------------|
| QL-PORT-001 | Port in use | Click retry for auto-resolution |
| QL-PORT-002 | Port still in use | Manually close blocking app |
| QL-PATH-001 | Path not found | Verify path in app settings |
| QL-NPM-001 | package.json missing | Check project path |
| QL-MOD-001 | Module not found | Run `npm install` |
| QL-NET-001 | Network error | Ensure QuickLaunch server is running |

## API Endpoints

QuickLaunch exposes a REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/apps` | List all configured apps |
| POST | `/api/apps` | Add a new app |
| PUT | `/api/apps/:id` | Update an app |
| DELETE | `/api/apps/:id` | Remove an app |
| GET | `/api/status` | Get running status of all apps |
| POST | `/api/start` | Start an app |
| POST | `/api/stop` | Stop an app |
| GET | `/api/ports/check/:port` | Check if a port is available |
| GET | `/api/todos` | Get TODO items from TODO.md |
| POST | `/api/triage` | Apply triage decisions |

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JavaScript (no build step!)
- **Process Management**: Custom process tree termination (Windows-optimized)
- **Storage**: JSON file-based (no database required)

## Development

```bash
# Run in development mode (same as start)
npm run dev

# The server auto-serves index.html from the project root
```

## Running as a Background Service (PM2)

QuickLaunch can run as a background service that auto-starts on boot using [PM2](https://pm2.keymetrics.io/).

### Initial Setup

```bash
# Install PM2 globally
npm install -g pm2

# Start QuickLaunch with PM2
pm2 start server.js --name quicklaunch

# Save the process list (for auto-restart on reboot)
pm2 save

# Set up PM2 to start on system boot (run as Administrator)
pm2-startup
```

### Managing the Service

```bash
pm2 list                  # Show all managed apps
pm2 restart quicklaunch   # Restart QuickLaunch
pm2 stop quicklaunch      # Stop QuickLaunch
pm2 start quicklaunch     # Start QuickLaunch
pm2 logs quicklaunch      # View logs
pm2 monit                 # Real-time monitoring dashboard
```

### Updating After Code Changes

After pulling updates or making changes to `server.js`:

```bash
pm2 restart quicklaunch
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

Ben Rebeske

---

*Built with help from [Claude Code](https://claude.com/claude-code)*
