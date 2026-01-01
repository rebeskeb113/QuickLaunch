const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const treeKill = require('tree-kill');

const app = express();
const PORT = 8000;

// Track running processes: { appId: { process, port, name } }
const runningProcesses = new Map();

app.use(express.json());
app.use(express.static(__dirname));

// Get status of all apps
app.get('/api/status', (req, res) => {
  const status = {};
  for (const [id, info] of runningProcesses) {
    status[id] = {
      running: true,
      port: info.port,
      name: info.name,
      pid: info.process.pid
    };
  }
  res.json(status);
});

// Start an app
app.post('/api/start', (req, res) => {
  const { id, name, port, path: appPath, command } = req.body;

  if (!id || !appPath || !command) {
    return res.status(400).json({ error: 'Missing required fields: id, path, command' });
  }

  if (runningProcesses.has(id)) {
    return res.status(400).json({ error: 'App is already running' });
  }

  try {
    // Parse command - support "npm run dev" style commands
    const parts = command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    // Use shell on Windows for npm commands
    const isWindows = process.platform === 'win32';
    const proc = spawn(cmd, args, {
      cwd: appPath,
      shell: isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    proc.stdout.on('data', (data) => {
      console.log(`[${name}] ${data.toString().trim()}`);
    });

    proc.stderr.on('data', (data) => {
      console.error(`[${name}] ${data.toString().trim()}`);
    });

    proc.on('error', (err) => {
      console.error(`[${name}] Failed to start:`, err.message);
      runningProcesses.delete(id);
    });

    proc.on('exit', (code) => {
      console.log(`[${name}] Exited with code ${code}`);
      runningProcesses.delete(id);
    });

    runningProcesses.set(id, {
      process: proc,
      port,
      name
    });

    console.log(`[${name}] Started on port ${port} (PID: ${proc.pid})`);
    res.json({ success: true, pid: proc.pid });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop an app
app.post('/api/stop', (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Missing required field: id' });
  }

  const info = runningProcesses.get(id);
  if (!info) {
    return res.status(400).json({ error: 'App is not running' });
  }

  const pid = info.process.pid;
  const appName = info.name;

  // Remove from tracking immediately
  runningProcesses.delete(id);

  // Use tree-kill to kill the process and all children
  // On Windows, don't specify a signal - let tree-kill use taskkill
  treeKill(pid, (err) => {
    if (err) {
      console.error(`[${appName}] Error stopping (PID ${pid}):`, err.message);
    } else {
      console.log(`[${appName}] Stopped (PID: ${pid})`);
    }
  });

  res.json({ success: true });
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\nShutting down QuickLaunch...');
  for (const [id, info] of runningProcesses) {
    console.log(`Stopping ${info.name}...`);
    treeKill(info.process.pid);
  }
  setTimeout(() => process.exit(), 1000);
});

app.listen(PORT, () => {
  console.log(`QuickLaunch running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');
});
