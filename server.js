const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const schedule = require('node-schedule');

// Custom tree-kill that hides the command window on Windows
function killProcessTree(pid, callback) {
  if (process.platform === 'win32') {
    try {
      // Use taskkill with /T (tree) and /F (force) flags
      // windowsHide: true prevents the command window from appearing
      execSync(`taskkill /PID ${pid} /T /F`, {
        windowsHide: true,
        stdio: 'ignore'
      });
      if (callback) callback(null);
    } catch (err) {
      // Process may already be gone, which is fine
      if (callback) callback(err);
    }
  } else {
    // On Unix, use process.kill with negative PID to kill process group
    try {
      process.kill(-pid, 'SIGKILL');
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }
}

const app = express();
const PORT = 8000;

// Track running processes: { appId: { process, port, name, logs, startTime, status, appConfig } }
const runningProcesses = new Map();

// Track startup attempts and errors for troubleshooting
const startupHistory = new Map(); // { appId: { attempts: [], lastError: null } }

// Track restart attempts for auto-restart feature
// { appId: { attempts: number, lastAttempt: timestamp, cooldownUntil: timestamp } }
const restartTracker = new Map();

// Log file path for troubleshooting
const LOG_FILE = path.join(__dirname, 'quicklaunch-troubleshoot.log');
const TODO_FILE = path.join(__dirname, 'TODO.md');
const RESOLUTIONS_FILE = path.join(__dirname, 'quicklaunch-resolutions.log');
const APPS_FILE = path.join(__dirname, 'apps.json');
const SCHEDULE_STATE_FILE = path.join(__dirname, 'schedule-state.json');

// Track active scheduled jobs: { appId: job }
const scheduledJobs = new Map();

// ========== APPS.JSON MANAGEMENT ==========
// apps.json is the source of truth for app definitions and port reservations

// Load apps configuration from apps.json
function loadAppsConfig() {
  try {
    if (!fs.existsSync(APPS_FILE)) {
      // Create default config if doesn't exist
      const defaultConfig = {
        reservedPorts: {
          "8000": "QuickLaunch (system)"
        },
        apps: []
      };
      fs.writeFileSync(APPS_FILE, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    const content = fs.readFileSync(APPS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error('Failed to load apps.json:', err.message);
    return { reservedPorts: {}, apps: [] };
  }
}

// Save apps configuration to apps.json
function saveAppsConfig(config) {
  try {
    fs.writeFileSync(APPS_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save apps.json:', err.message);
    return false;
  }
}

// Check if a port is available (not reserved and not used by another app)
function checkPortAvailability(port, excludeAppId = null) {
  const config = loadAppsConfig();
  const portStr = String(port);

  // Check reserved ports
  if (config.reservedPorts[portStr]) {
    return {
      available: false,
      reason: 'reserved',
      usedBy: config.reservedPorts[portStr]
    };
  }

  // Check if another app uses this port
  const conflictingApp = config.apps.find(app =>
    app.port === port && app.id !== excludeAppId
  );

  if (conflictingApp) {
    return {
      available: false,
      reason: 'app',
      usedBy: conflictingApp.name,
      appId: conflictingApp.id
    };
  }

  return { available: true };
}

// Find next available port starting from a base port (registry-aware)
function suggestAvailablePort(basePort = 5174) {
  const config = loadAppsConfig();
  const usedPorts = new Set();

  // Collect all reserved ports
  Object.keys(config.reservedPorts).forEach(p => usedPorts.add(parseInt(p)));

  // Collect all app ports
  config.apps.forEach(app => usedPorts.add(app.port));

  // Find next available
  let port = basePort;
  while (usedPorts.has(port) && port < 65535) {
    port++;
  }

  return port < 65535 ? port : null;
}

// Generate unique ID for new apps
function generateAppId() {
  return 'app_' + Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ========== SCHEDULER MANAGEMENT ==========
// Handles scheduled task execution (e.g., daily syncs)

// Load schedule state (last run times, enabled status)
function loadScheduleState() {
  try {
    if (!fs.existsSync(SCHEDULE_STATE_FILE)) {
      return {};
    }
    const content = fs.readFileSync(SCHEDULE_STATE_FILE, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error('Failed to load schedule state:', err.message);
    return {};
  }
}

// Save schedule state
function saveScheduleState(state) {
  try {
    fs.writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save schedule state:', err.message);
    return false;
  }
}

// Check if a scheduled task was missed (should run on startup)
function checkMissedSchedule(appId, appConfig) {
  if (!appConfig.schedule || !appConfig.scheduleEnabled) return false;
  if (!appConfig.runIfMissed) return false;

  const state = loadScheduleState();
  const appState = state[appId];

  if (!appState || !appState.lastRun) {
    // Never run before - consider it missed if schedule time has passed today
    return hasScheduleTimePassedToday(appConfig.schedule);
  }

  const lastRun = new Date(appState.lastRun);
  const now = new Date();

  // Check if we missed today's scheduled run
  if (lastRun.toDateString() !== now.toDateString()) {
    // Last run was not today
    return hasScheduleTimePassedToday(appConfig.schedule);
  }

  return false;
}

// Check if the scheduled time has passed today (for cron-like schedule)
function hasScheduleTimePassedToday(cronSchedule) {
  // Parse simple "HH:MM" format or cron format
  const now = new Date();

  // Handle "12:00" format
  const timeMatch = cronSchedule.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const scheduleHour = parseInt(timeMatch[1]);
    const scheduleMinute = parseInt(timeMatch[2]);
    return now.getHours() > scheduleHour ||
           (now.getHours() === scheduleHour && now.getMinutes() >= scheduleMinute);
  }

  // Handle cron format "0 12 * * *" (minute hour day month weekday)
  const cronMatch = cronSchedule.match(/^(\d+)\s+(\d+)\s+/);
  if (cronMatch) {
    const scheduleMinute = parseInt(cronMatch[1]);
    const scheduleHour = parseInt(cronMatch[2]);
    return now.getHours() > scheduleHour ||
           (now.getHours() === scheduleHour && now.getMinutes() >= scheduleMinute);
  }

  return false;
}

// Convert simple time format to cron
function timeToCron(timeStr) {
  // Handle "12:00" format -> "0 12 * * *"
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    return `${parseInt(timeMatch[2])} ${parseInt(timeMatch[1])} * * *`;
  }
  // Already cron format
  return timeStr;
}

// Get human-readable schedule description
function getScheduleDescription(cronSchedule) {
  const timeMatch = cronSchedule.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const minute = timeMatch[2];
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return `Daily at ${hour12}:${minute} ${ampm}`;
  }

  const cronMatch = cronSchedule.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (cronMatch) {
    const minute = cronMatch[1].padStart(2, '0');
    const hour = parseInt(cronMatch[2]);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return `Daily at ${hour12}:${minute} ${ampm}`;
  }

  return cronSchedule;
}

// Execute a scheduled app (similar to manual start but fire-and-forget for one-shot tasks)
async function executeScheduledApp(appId, appConfig, isManual = false) {
  const runType = isManual ? 'manual (off-schedule)' : 'scheduled';
  console.log(`[Scheduler] Running ${runType} task: ${appConfig.name}`);
  logTroubleshoot(appConfig.name, 'info', `${isManual ? 'Manual' : 'Scheduled'} execution started`, { appId, isManual });

  const isWindows = process.platform === 'win32';
  // Use scheduleCommand if available (for hybrid apps), otherwise fall back to command
  let commandToRun = appConfig.scheduleCommand || appConfig.command;

  // For scheduled (non-manual) runs, add --headless flag to run browser in background
  // This prevents a visible Chrome window from popping up during automated syncs
  if (!isManual && commandToRun.includes('npm run sync')) {
    commandToRun = commandToRun + ' -- --headless';
    console.log(`[Scheduler] Running in headless mode for scheduled sync`);
  }

  const parts = commandToRun.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  const proc = spawn(cmd, args, {
    cwd: appConfig.path,
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true  // Hide the CMD window for scheduled tasks
  });

  const logs = [];

  // Use a separate key for sync processes so they don't conflict with the main app
  // For hybrid apps (with both command and scheduleCommand), use appId:sync
  const processKey = appConfig.scheduleCommand ? `${appId}:sync` : appId;

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    console.log(`[${appConfig.name}] ${line}`);
    logs.push({ type: 'stdout', text: line, time: Date.now() });
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    console.error(`[${appConfig.name}] ${line}`);
    logs.push({ type: 'stderr', text: line, time: Date.now() });
  });

  proc.on('error', (err) => {
    console.error(`[${appConfig.name}] ${runType} execution failed:`, err.message);
    logTroubleshoot(appConfig.name, 'error', `${isManual ? 'Manual' : 'Scheduled'} execution spawn failed`, { error: err.message, isManual });
  });

  proc.on('exit', (code) => {
    console.log(`[Scheduler] ${appConfig.name} ${runType} run completed with exit code ${code}`);
    logTroubleshoot(appConfig.name, code === 0 ? 'info' : 'error',
      `${isManual ? 'Manual' : 'Scheduled'} execution completed`, { exitCode: code, isManual });

    // Update last run time
    const state = loadScheduleState();
    if (!state[appId]) state[appId] = {};
    state[appId].lastRun = new Date().toISOString();
    state[appId].lastExitCode = code;
    state[appId].wasManual = isManual;
    saveScheduleState(state);

    // Update running processes status (use processKey, not appId)
    const info = runningProcesses.get(processKey);
    if (info) {
      info.status = code === 0 ? 'completed' : 'failed';
      info.exitCode = code;
      info.completedAt = Date.now();
    }
  });

  // Track as running process (use processKey to avoid conflict with main app)
  runningProcesses.set(processKey, {
    process: proc,
    port: 0, // Sync processes don't use ports
    name: `${appConfig.name} (sync)`,
    logs,
    startTime: Date.now(),
    status: 'running',
    appConfig,
    isScheduled: !isManual,
    isManual: isManual,
    isSyncProcess: true
  });

  return { success: true, pid: proc.pid, processKey };
}

// Set up a scheduled job for an app
function setupScheduledJob(appId, appConfig) {
  // Cancel existing job if any
  if (scheduledJobs.has(appId)) {
    scheduledJobs.get(appId).cancel();
    scheduledJobs.delete(appId);
  }

  if (!appConfig.schedule || !appConfig.scheduleEnabled) {
    return null;
  }

  const cronSchedule = timeToCron(appConfig.schedule);

  console.log(`[Scheduler] Setting up job for ${appConfig.name}: ${getScheduleDescription(appConfig.schedule)}`);

  const job = schedule.scheduleJob(cronSchedule, () => {
    console.log(`[Scheduler] Triggered: ${appConfig.name}`);
    executeScheduledApp(appId, appConfig);
  });

  if (job) {
    scheduledJobs.set(appId, job);
    return job;
  }

  return null;
}

// Initialize all scheduled jobs on startup
function initializeScheduledJobs() {
  const config = loadAppsConfig();

  console.log('[Scheduler] Initializing scheduled jobs...');

  for (const appConfig of config.apps) {
    if (appConfig.schedule && appConfig.scheduleEnabled) {
      setupScheduledJob(appConfig.id, appConfig);

      // Check for missed runs
      if (checkMissedSchedule(appConfig.id, appConfig)) {
        console.log(`[Scheduler] Missed run detected for ${appConfig.name}, executing now...`);
        executeScheduledApp(appConfig.id, appConfig);
      }
    }
  }

  console.log(`[Scheduler] ${scheduledJobs.size} scheduled job(s) active`);
}

// ========== AUTO-RESTART MANAGEMENT ==========

// Check if an app should be auto-restarted
function shouldAutoRestart(appId, appConfig) {
  if (!appConfig?.autoRestart) return false;

  const maxAttempts = appConfig.maxRestartAttempts || 3;
  const tracker = restartTracker.get(appId) || { attempts: 0, lastAttempt: 0, cooldownUntil: 0 };

  // Check if in cooldown
  if (Date.now() < tracker.cooldownUntil) {
    console.log(`[AutoRestart] ${appConfig.name} is in cooldown until ${new Date(tracker.cooldownUntil).toISOString()}`);
    return false;
  }

  // Check if max attempts reached
  if (tracker.attempts >= maxAttempts) {
    console.log(`[AutoRestart] ${appConfig.name} reached max restart attempts (${maxAttempts})`);
    return false;
  }

  return true;
}

// Record a restart attempt
function recordRestartAttempt(appId, appConfig) {
  const tracker = restartTracker.get(appId) || { attempts: 0, lastAttempt: 0, cooldownUntil: 0 };

  tracker.attempts++;
  tracker.lastAttempt = Date.now();

  // If max attempts reached, set a 5-minute cooldown before resetting
  const maxAttempts = appConfig?.maxRestartAttempts || 3;
  if (tracker.attempts >= maxAttempts) {
    tracker.cooldownUntil = Date.now() + (5 * 60 * 1000); // 5 minute cooldown
  }

  restartTracker.set(appId, tracker);
  return tracker;
}

// Reset restart counter (called when app runs stably for a period)
function resetRestartCounter(appId) {
  restartTracker.delete(appId);
}

// Perform auto-restart of an app
async function autoRestartApp(appId, appConfig) {
  const name = appConfig.name;
  console.log(`[AutoRestart] Attempting to restart ${name}...`);
  logTroubleshoot(name, 'info', 'Auto-restart triggered', { appId });

  const tracker = recordRestartAttempt(appId, appConfig);

  // Small delay before restart
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check if port is available
  const portInUse = await isPortInUse(appConfig.port);
  if (portInUse) {
    console.log(`[AutoRestart] Port ${appConfig.port} still in use, attempting to free...`);
    await killProcessOnPort(appConfig.port);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Spawn new process
  const isWindows = process.platform === 'win32';
  const parts = appConfig.command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  const proc = spawn(cmd, args, {
    cwd: appConfig.path,
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  const logs = [];

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    console.log(`[${name}] ${line}`);
    logs.push({ type: 'stdout', text: line, time: Date.now() });
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    console.error(`[${name}] ${line}`);
    logs.push({ type: 'stderr', text: line, time: Date.now() });
  });

  proc.on('error', (err) => {
    console.error(`[${name}] Auto-restart failed:`, err.message);
    logTroubleshoot(name, 'error', 'Auto-restart spawn failed', { error: err.message });
  });

  // Set up exit handler for the new process (recursive auto-restart)
  proc.on('exit', (code) => {
    handleProcessExit(appId, code, appConfig);
  });

  // Store the new process info
  runningProcesses.set(appId, {
    process: proc,
    port: appConfig.port,
    name: appConfig.name,
    logs,
    startTime: Date.now(),
    status: 'starting',
    appConfig // Store config for future restarts
  });

  logTroubleshoot(name, 'info', `Auto-restarted (attempt ${tracker.attempts})`, { pid: proc.pid });

  // Set a timer to reset the restart counter if app runs stably for 60 seconds
  setTimeout(() => {
    const info = runningProcesses.get(appId);
    if (info && (info.status === 'running' || info.status === 'starting')) {
      resetRestartCounter(appId);
      console.log(`[AutoRestart] ${name} running stably, reset restart counter`);
    }
  }, 60000);

  return { success: true, pid: proc.pid, attempt: tracker.attempts };
}

// Exit codes that represent normal terminations, not crashes
// 3221225786 (0xC000013A) = STATUS_CONTROL_C_EXIT (Ctrl+C or window close)
// 1073807364 (0x40010004) = STATUS_SYSTEM_PROCESS_TERMINATED (system shutdown/logoff)
const NORMAL_EXIT_CODES = new Set([0, 3221225786, 1073807364]);

function isNormalExit(exitCode) {
  return NORMAL_EXIT_CODES.has(exitCode);
}

// Handle process exit (used by both initial start and auto-restart)
function handleProcessExit(appId, exitCode, appConfig) {
  const name = appConfig?.name || appId;
  const isNormal = isNormalExit(exitCode);
  console.log(`[${name}] Exited with code ${exitCode}${isNormal && exitCode !== 0 ? ' (normal termination)' : ''}`);
  logTroubleshoot(name, isNormal ? 'info' : 'error', `Process exited with code ${exitCode}`, { exitCode, normalTermination: isNormal });

  const info = runningProcesses.get(appId);
  if (info) {
    const runTime = Date.now() - info.startTime;
    info.status = 'stopped';
    info.exitCode = exitCode;

    // If crashed (non-zero exit that's not a normal termination) after running for a while, consider auto-restart
    if (!isNormal && runTime > 5000 && appConfig?.autoRestart) {
      info.status = 'restarting';

      if (shouldAutoRestart(appId, appConfig)) {
        autoRestartApp(appId, appConfig).catch(err => {
          console.error(`[AutoRestart] Failed to restart ${name}:`, err.message);
          info.status = 'failed';
          info.error = 'Auto-restart failed: ' + err.message;
        });
      } else {
        info.status = 'failed';
        info.error = `Crashed (max restart attempts reached)`;
        logTroubleshoot(name, 'error', 'Auto-restart disabled or max attempts reached', {
          autoRestart: appConfig?.autoRestart,
          maxAttempts: appConfig?.maxRestartAttempts
        });
      }
    } else if (!isNormal && runTime < 5000) {
      // Quick crash = startup failure, don't auto-restart
      info.status = 'failed';
      info.error = `Startup crash (exit code ${exitCode})`;
    }
  }
}

// Parse resolutions log to find past solutions
function getResolutions(appName = null) {
  const resolutions = [];

  try {
    if (!fs.existsSync(RESOLUTIONS_FILE)) {
      return resolutions;
    }

    const content = fs.readFileSync(RESOLUTIONS_FILE, 'utf8');
    const entries = content.split('\n---\n').filter(e => e.trim());

    for (const entry of entries) {
      const lines = entry.trim().split('\n');
      const resolution = {};

      for (const line of lines) {
        if (line.startsWith('Date: ')) resolution.date = line.slice(6);
        else if (line.startsWith('App: ')) resolution.app = line.slice(5);
        else if (line.startsWith('Issue: ')) resolution.issue = line.slice(7);
        else if (line.startsWith('ErrorType: ')) resolution.errorType = line.slice(11);
        else if (line.startsWith('Fix: ')) resolution.fix = line.slice(5);
        else if (line.startsWith('Worked: ')) resolution.worked = line.slice(8) === 'true';
        else if (line.startsWith('Notes: ')) resolution.notes = line.slice(7);
      }

      if (resolution.date && resolution.issue) {
        if (!appName || resolution.app === appName) {
          resolutions.push(resolution);
        }
      }
    }
  } catch (err) {
    console.error('Failed to read resolutions:', err.message);
  }

  return resolutions;
}

// Save a resolution to the log
function saveResolution(resolution) {
  const entry = `Date: ${resolution.date}
App: ${resolution.app || 'General'}
Issue: ${resolution.issue}
ErrorType: ${resolution.errorType || 'UNKNOWN'}
Disposition: ${resolution.disposition || 'resolved'}
Explanation: ${resolution.explanation}
Notes: ${resolution.notes || ''}
---
`;

  try {
    fs.appendFileSync(RESOLUTIONS_FILE, entry);
    return true;
  } catch (err) {
    console.error('Failed to save resolution:', err.message);
    return false;
  }
}

// Delete a TODO item from TODO.md
function deleteTodoFromFile(todoText) {
  try {
    if (!fs.existsSync(TODO_FILE)) {
      return false;
    }

    const content = fs.readFileSync(TODO_FILE, 'utf8');
    const lines = content.split('\n');
    let found = false;

    // Find and remove the line containing this TODO
    const newLines = lines.filter(line => {
      // Match unchecked checkbox with this text
      if (line.match(/^[\s]*-\s*\[\s*\]/) && line.includes(todoText)) {
        found = true;
        return false; // Remove this line
      }
      return true;
    });

    if (found) {
      fs.writeFileSync(TODO_FILE, newLines.join('\n'));
      return true;
    }

    return false;
  } catch (err) {
    console.error('Failed to delete TODO:', err.message);
    return false;
  }
}

// Count pending TODOs from TODO.md with priority information
function countPendingTodos() {
  try {
    if (!fs.existsSync(TODO_FILE)) {
      return { count: 0, items: [], itemsWithPriority: [] };
    }

    const content = fs.readFileSync(TODO_FILE, 'utf8');
    const lines = content.split('\n');
    const pendingItems = [];
    const itemsWithPriority = [];

    let currentPriority = 'Medium'; // Default priority
    let currentSection = null; // Track current ### subsection for context
    let inNextSession = false; // Track if we're in "Next Session" section
    let inParkingLot = false; // Track if we're in "Parking Lot" section
    let inSupportCodes = false; // Track if we're past the main TODO sections

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Track ### subsections (like "### Log Viewer") for tooltip context
      const subsectionMatch = line.match(/^###\s+(.+)/);
      if (subsectionMatch) {
        currentSection = subsectionMatch[1].trim();
      }

      // Track priority sections (## headings)
      if (line.match(/^##\s+High\s+Priority/i)) {
        currentPriority = 'High';
        currentSection = null;
        inNextSession = false;
        inParkingLot = false;
        inSupportCodes = false;
      } else if (line.match(/^##\s+Medium\s+Priority/i)) {
        currentPriority = 'Medium';
        currentSection = null;
        inNextSession = false;
        inParkingLot = false;
        inSupportCodes = false;
      } else if (line.match(/^##\s+Low\s+Priority/i)) {
        currentPriority = 'Low';
        currentSection = null;
        inNextSession = false;
        inParkingLot = false;
        inSupportCodes = false;
      } else if (line.match(/^##\s+Next\s+Session/i)) {
        // Items marked for implementation go here
        currentSection = null;
        inNextSession = true;
        inParkingLot = false;
        inSupportCodes = false;
      } else if (line.match(/^##\s+Parking\s+Lot/i)) {
        // Items explicitly parked by user
        currentSection = null;
        inParkingLot = true;
        inNextSession = false;
        inSupportCodes = false;
      } else if (line.match(/^##\s+Support\s+Codes/i) || line.match(/^##\s+Auto-Detected/i)) {
        // Non-TODO sections - stop counting
        inSupportCodes = true;
      } else if (line.match(/^##\s+/) && !line.match(/^###/)) {
        // Other ## sections we haven't explicitly handled - be conservative
        // Don't reset priority, just mark as support codes section
        inSupportCodes = true;
      }

      // Skip items in support codes or reference sections
      if (inSupportCodes) continue;

      // Match unchecked checkboxes: - [ ] (note the space in brackets)
      if (line.match(/^[\s]*-\s*\[\s\]/)) {
        const item = line.replace(/^[\s]*-\s*\[\s\]\s*/, '').trim();
        if (item) {
          // Look ahead for description on next line (format: "  > description")
          let description = null;
          if (i < lines.length - 1) {
            const nextLine = lines[i + 1];
            const descMatch = nextLine.match(/^\s*>\s*(.+)/);
            if (descMatch) {
              description = descMatch[1].trim();
            }
          }

          pendingItems.push(item);
          itemsWithPriority.push({
            text: item,
            priority: currentPriority,
            section: currentSection, // Parent section for tooltip context
            description: description, // 6th-grader friendly explanation
            markedForImplement: inNextSession, // Flag items already in Next Session
            markedParking: inParkingLot // Flag items explicitly parked by user
          });
        }
      }
    }

    // Also count auto-detected issues (### headers in auto-detected section)
    const autoSection = content.indexOf('## Auto-Detected Issues');
    if (autoSection > -1) {
      const autoContent = content.slice(autoSection);
      // Match full ### header line, not just the date bracket
      const autoMatches = autoContent.match(/^### \[.+$/gm) || [];
      for (const match of autoMatches) {
        const item = match.replace(/^### /, '').trim();
        if (!pendingItems.includes(item)) {
          pendingItems.push(`[Auto] ${item}`);
          itemsWithPriority.push({
            text: `[Auto] ${item}`,
            priority: 'High', // Auto-detected issues are high priority
            section: 'Auto-Detected Issues',
            description: 'Automatically detected issue that needs attention',
            markedForImplement: false,
            markedParking: false,
            isAutoDetected: true, // Flag to help triage identify these
            originalText: item    // Store the original text without [Auto] prefix
          });
        }
      }
    }

    console.log(`[QuickLaunch] Found ${pendingItems.length} pending TODOs`);
    return { count: pendingItems.length, items: pendingItems, itemsWithPriority };
  } catch (err) {
    console.error('Failed to count TODOs:', err.message);
    return { count: 0, items: [], itemsWithPriority: [] };
  }
}

// Apply triage decisions to TODO.md
function applyTriage(items) {
  const results = { parking: 0, implement: 0, dontdo: 0 };

  try {
    if (!fs.existsSync(TODO_FILE)) {
      return results;
    }

    let content = fs.readFileSync(TODO_FILE, 'utf8');
    const lines = content.split('\n');

    // Process each triaged item
    for (const item of items) {
      const { text, priority, action } = item;

      if (action === 'parking') {
        // Move to "Parking Lot" section to mark as explicitly triaged
        // Check if this is an auto-detected item (starts with [Auto])
        const isAutoDetected = text.startsWith('[Auto] ');
        const searchText = isAutoDetected ? text.replace('[Auto] ', '') : text;
        const displayText = isAutoDetected ? searchText : text;

        let lineIndex = -1;
        let endIndex = -1;

        if (isAutoDetected) {
          // Auto-detected items are ### headers, find the header and its content block
          lineIndex = lines.findIndex(line =>
            line.startsWith('### ') && line.includes(searchText)
          );

          if (lineIndex !== -1) {
            // Find where this block ends (next ### or ## or end of content)
            endIndex = lineIndex + 1;
            while (endIndex < lines.length) {
              const nextLine = lines[endIndex];
              if (nextLine.startsWith('## ') || nextLine.startsWith('### ')) {
                break;
              }
              endIndex++;
            }
            // Remove trailing empty lines from the block
            while (endIndex > lineIndex + 1 && lines[endIndex - 1].trim() === '') {
              endIndex--;
            }
          }
        } else {
          // Regular checkbox item
          lineIndex = lines.findIndex(line =>
            line.match(/^[\s]*-\s*\[\s*\]/) && line.includes(searchText)
          );
        }

        if (lineIndex !== -1) {
          // Remove the item (or block for auto-detected)
          const removeCount = isAutoDetected && endIndex > lineIndex ? endIndex - lineIndex : 1;
          lines.splice(lineIndex, removeCount);

          // Find or create "Parking Lot" section
          let parkingLotIndex = lines.findIndex(line => line.match(/^##\s+Parking\s+Lot/i));

          if (parkingLotIndex === -1) {
            // Create "Parking Lot" section at the end (before Support Codes if exists)
            const supportCodesIndex = lines.findIndex(line => line.match(/^##\s+Support\s+Codes/i));
            if (supportCodesIndex !== -1) {
              lines.splice(supportCodesIndex, 0, '', '## Parking Lot', '', `- [ ] ${displayText}`, '');
            } else {
              // No support codes section, add at end
              lines.push('', '## Parking Lot', '', `- [ ] ${displayText}`);
            }
          } else {
            // Insert after "Parking Lot" heading
            lines.splice(parkingLotIndex + 1, 0, `- [ ] ${displayText}`);
          }

          results.parking++;
        }
      } else if (action === 'implement') {
        // Move to "Next Session" section (create if doesn't exist)
        // Check if this is an auto-detected item (starts with [Auto])
        const isAutoDetected = text.startsWith('[Auto] ');
        const searchText = isAutoDetected ? text.replace('[Auto] ', '') : text;
        const displayText = isAutoDetected ? searchText : text;

        let lineIndex = -1;
        let endIndex = -1;

        if (isAutoDetected) {
          // Auto-detected items are ### headers, find the header and its content block
          lineIndex = lines.findIndex(line =>
            line.startsWith('### ') && line.includes(searchText)
          );

          if (lineIndex !== -1) {
            // Find where this block ends (next ### or ## or end of content)
            endIndex = lineIndex + 1;
            while (endIndex < lines.length) {
              const nextLine = lines[endIndex];
              if (nextLine.startsWith('## ') || nextLine.startsWith('### ')) {
                break;
              }
              endIndex++;
            }
            // Remove trailing empty lines from the block
            while (endIndex > lineIndex + 1 && lines[endIndex - 1].trim() === '') {
              endIndex--;
            }
          }
        } else {
          // Regular checkbox item
          lineIndex = lines.findIndex(line =>
            line.match(/^[\s]*-\s*\[\s*\]/) && line.includes(searchText)
          );
        }

        if (lineIndex !== -1) {
          // Remove the item (or block for auto-detected)
          const removeCount = isAutoDetected && endIndex > lineIndex ? endIndex - lineIndex : 1;
          lines.splice(lineIndex, removeCount);

          // Find or create "Next Session" section
          let nextSessionIndex = lines.findIndex(line => line.match(/^##\s+Next\s+Session/i));

          if (nextSessionIndex === -1) {
            // Create "Next Session" section at the top (after title/description)
            // Find first ## heading
            const firstHeadingIndex = lines.findIndex(line => line.match(/^##\s+/));
            if (firstHeadingIndex !== -1) {
              lines.splice(firstHeadingIndex, 0, '## Next Session\n', `- [ ] ${displayText}`, '');
              nextSessionIndex = firstHeadingIndex;
            } else {
              // No headings found, add at end
              lines.push('', '## Next Session', '', `- [ ] ${displayText}`);
            }
          } else {
            // Insert after "Next Session" heading
            lines.splice(nextSessionIndex + 1, 0, `- [ ] ${displayText}`);
          }

          results.implement++;
        }
      } else if (action === 'dontdo') {
        // Check if this is an auto-detected item (starts with [Auto])
        const isAutoDetected = text.startsWith('[Auto] ');
        const searchText = isAutoDetected ? text.replace('[Auto] ', '') : text;

        let lineIndex = -1;
        let endIndex = -1; // For auto-detected items, we need to remove the whole block

        if (isAutoDetected) {
          // Auto-detected items are ### headers, find the header and its content block
          lineIndex = lines.findIndex(line =>
            line.startsWith('### ') && line.includes(searchText)
          );

          if (lineIndex !== -1) {
            // Find where this block ends (next ### or ## or end of content)
            endIndex = lineIndex + 1;
            while (endIndex < lines.length) {
              const nextLine = lines[endIndex];
              if (nextLine.startsWith('## ') || nextLine.startsWith('### ')) {
                break;
              }
              endIndex++;
            }
            // Remove trailing empty lines from the block
            while (endIndex > lineIndex + 1 && lines[endIndex - 1].trim() === '') {
              endIndex--;
            }
          }
        } else {
          // Regular checkbox item
          lineIndex = lines.findIndex(line =>
            line.match(/^[\s]*-\s*\[\s*\]/) && line.includes(searchText)
          );
        }

        if (lineIndex !== -1) {
          // Remove the item (or block for auto-detected)
          const removeCount = isAutoDetected && endIndex > lineIndex ? endIndex - lineIndex : 1;
          lines.splice(lineIndex, removeCount);

          // Log to resolutions file
          const resolution = {
            date: new Date().toISOString(),
            app: 'QuickLaunch',
            issue: searchText,
            errorType: isAutoDetected ? 'AUTO_DETECTED_RESOLVED' : 'TODO_TRIAGED',
            disposition: 'cancelled',
            explanation: 'Marked as "Don\'t Do" during triage',
            notes: `Original priority: ${priority}${isAutoDetected ? ' (auto-detected issue)' : ''}`
          };
          saveResolution(resolution);

          results.dontdo++;
        }
      }
    }

    // Write updated content back
    fs.writeFileSync(TODO_FILE, lines.join('\n'));

    return results;
  } catch (err) {
    console.error('Failed to apply triage:', err.message);
    return results;
  }
}

// Parse log file and analyze patterns
function analyzeLogHistory(appId, appName) {
  const analysis = {
    totalAttempts: 0,
    failures: 0,
    recentFailures: 0, // last 7 days
    errorTypes: {},
    patterns: [],
    recommendation: null,
    pastResolutions: [] // NEW: include past resolutions for this app
  };

  // Get past resolutions for this app
  analysis.pastResolutions = getResolutions(appName);

  // Build a set of resolved error types (disposition = 'resolved', not 'cancelled')
  // We only count errors that occurred BEFORE the resolution date as resolved
  const resolvedErrors = new Map(); // errorType -> resolution date
  for (const res of analysis.pastResolutions) {
    if (res.disposition === 'resolved' && res.errorType) {
      const resDate = new Date(res.date).getTime();
      // Keep the most recent resolution date for each error type
      if (!resolvedErrors.has(res.errorType) || resDate > resolvedErrors.get(res.errorType)) {
        resolvedErrors.set(res.errorType, resDate);
      }
    }
  }

  try {
    if (!fs.existsSync(LOG_FILE)) {
      return analysis;
    }

    const logContent = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = logContent.split('\n').filter(line => line.trim());
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    for (const line of lines) {
      // Parse log line: [timestamp] [LEVEL] [AppName] message {details}
      const match = line.match(/^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] (.+)$/);
      if (!match) continue;

      const [, timestamp, level, logAppName, rest] = match;
      if (logAppName !== appName) continue;

      const logTime = new Date(timestamp).getTime();

      // Count attempts (starting app messages)
      if (rest.includes('Starting app')) {
        analysis.totalAttempts++;
        if (logTime > sevenDaysAgo) {
          // We'll count failures separately
        }
      }

      // Count failures - but skip if this error type was resolved AFTER this log entry
      // Also skip if the log indicates a normal termination (new logs have normalTermination field)
      if ((level === 'ERROR' || level === 'WARN') && !rest.includes('"normalTermination":true')) {
        // Determine the error type for this log entry
        let errorType = null;
        if (rest.includes('Port') && rest.includes('in use')) {
          errorType = 'PORT_IN_USE';
        } else if (rest.includes('not found') || rest.includes('not exist')) {
          errorType = 'PATH_NOT_FOUND';
        } else if (rest.includes('module') || rest.includes('MODULE')) {
          errorType = 'MISSING_MODULE';
        } else if (rest.includes('exited with code')) {
          // Extract exit code and check if it's a normal termination
          const exitCodeMatch = rest.match(/exited with code (\d+)/);
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;
          // Only count as CRASH if it's not a normal termination (Ctrl+C, shutdown, etc.)
          if (exitCode !== null && !isNormalExit(exitCode)) {
            errorType = 'CRASH';
          }
        }

        // Check if this error type was resolved after this failure occurred
        const resolutionDate = errorType ? resolvedErrors.get(errorType) : null;
        const wasResolved = resolutionDate && logTime < resolutionDate;

        // Only count failures that haven't been resolved
        if (!wasResolved) {
          analysis.failures++;
          if (logTime > sevenDaysAgo) {
            analysis.recentFailures++;
          }

          // Categorize error types (only unresolved ones)
          if (errorType) {
            analysis.errorTypes[errorType] = (analysis.errorTypes[errorType] || 0) + 1;
          }
        }
      }
    }

    // Detect patterns and generate recommendations
    const dominantError = Object.entries(analysis.errorTypes)
      .sort((a, b) => b[1] - a[1])[0];

    if (dominantError) {
      const [errorType, count] = dominantError;

      if (count >= 3) {
        analysis.patterns.push({
          type: errorType,
          count,
          message: getPatternMessage(errorType, count, appName)
        });
      }

      // Escalating recommendations based on failure count
      if (analysis.recentFailures >= 6) {
        analysis.recommendation = {
          level: 'critical',
          message: `${appName} has failed ${analysis.recentFailures} times in the last 7 days. This needs a permanent fix.`,
          action: getRecommendedAction(errorType, 'critical'),
          shouldAutoTodo: true
        };
      } else if (analysis.recentFailures >= 3) {
        analysis.recommendation = {
          level: 'warning',
          message: `${appName} has failed ${analysis.recentFailures} times recently. Consider addressing the root cause.`,
          action: getRecommendedAction(errorType, 'warning'),
          shouldAutoTodo: false
        };
      }
    }

    return analysis;

  } catch (err) {
    console.error('Failed to analyze log history:', err.message);
    return analysis;
  }
}

function getPatternMessage(errorType, count, appName) {
  switch (errorType) {
    case 'PORT_IN_USE':
      return `Port conflicts detected ${count} times. Another app may be using this port, or ${appName} isn't shutting down cleanly.`;
    case 'PATH_NOT_FOUND':
      return `Path errors detected ${count} times. The project may have moved or the path is misconfigured.`;
    case 'MISSING_MODULE':
      return `Module errors detected ${count} times. Dependencies may need reinstalling.`;
    case 'CRASH':
      return `App crashed ${count} times. Check for code errors or resource issues.`;
    default:
      return `${errorType} occurred ${count} times.`;
  }
}

function getRecommendedAction(errorType, level) {
  const actions = {
    PORT_IN_USE: {
      warning: 'Try changing the port in app settings, or check what process is using this port.',
      critical: 'Change the port permanently to avoid conflicts. Current port may be used by another service.'
    },
    PATH_NOT_FOUND: {
      warning: 'Verify the project path exists and is accessible.',
      critical: 'Update the project path in app configuration - it appears to be permanently incorrect.'
    },
    MISSING_MODULE: {
      warning: 'Run "npm install" to restore dependencies.',
      critical: 'Dependencies are persistently missing. Check package.json and node_modules integrity.'
    },
    CRASH: {
      warning: 'Check recent code changes or resource availability.',
      critical: 'Investigate crash cause - may be a code bug, memory issue, or configuration problem.'
    }
  };

  return actions[errorType]?.[level] || 'Investigate the recurring issue.';
}

// Auto-append to TODO.md when patterns are detected
function appendAutoTodo(appName, analysis) {
  if (!analysis.recommendation?.shouldAutoTodo) return;

  const today = new Date().toISOString().split('T')[0];
  const dominantError = Object.entries(analysis.errorTypes)
    .sort((a, b) => b[1] - a[1])[0];

  const todoEntry = `
### [${today}] ${appName} - Recurring ${dominantError?.[0] || 'failures'} (Auto-detected)
- Failed ${analysis.recentFailures} times in the last 7 days
- Primary issue: ${dominantError?.[0]} (${dominantError?.[1]} occurrences)
- **Suggested fix:** ${analysis.recommendation.action}
- Pattern: ${analysis.patterns[0]?.message || 'Multiple failures detected'}

`;

  try {
    let todoContent = '';
    if (fs.existsSync(TODO_FILE)) {
      todoContent = fs.readFileSync(TODO_FILE, 'utf8');
    }

    // Check if this issue was already logged today
    if (todoContent.includes(`[${today}] ${appName}`)) {
      return; // Already logged today
    }

    // Find or create the auto-detected section
    const autoSection = '## Auto-Detected Issues (from troubleshooting log)';
    if (!todoContent.includes(autoSection)) {
      // Add section before the Support Codes Reference if it exists, otherwise at end
      const supportCodesIndex = todoContent.indexOf('## Support Codes Reference');
      if (supportCodesIndex > -1) {
        todoContent = todoContent.slice(0, supportCodesIndex) +
          autoSection + '\n' +
          todoEntry +
          todoContent.slice(supportCodesIndex);
      } else {
        todoContent += '\n' + autoSection + '\n' + todoEntry;
      }
    } else {
      // Insert after the auto-detected section header
      const sectionIndex = todoContent.indexOf(autoSection);
      const insertPoint = sectionIndex + autoSection.length;
      todoContent = todoContent.slice(0, insertPoint) + '\n' + todoEntry + todoContent.slice(insertPoint);
    }

    fs.writeFileSync(TODO_FILE, todoContent);
    console.log(`[QuickLaunch] Auto-added TODO for ${appName} recurring issue`);

  } catch (err) {
    console.error('Failed to append auto-todo:', err.message);
  }
}

// Write to troubleshooting log
function logTroubleshoot(appName, level, message, details = {}) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    app: appName,
    level,
    message,
    ...details
  };
  const logLine = `[${timestamp}] [${level.toUpperCase()}] [${appName}] ${message} ${Object.keys(details).length ? JSON.stringify(details) : ''}\n`;

  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (err) {
    console.error('Failed to write to log file:', err.message);
  }

  return entry;
}

// Check if port is in use
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

// Detect package manager (npm vs yarn)
function detectPackageManager(appPath) {
  const yarnLock = path.join(appPath, 'yarn.lock');
  const npmLock = path.join(appPath, 'package-lock.json');

  if (fs.existsSync(yarnLock)) {
    return 'yarn';
  }
  return 'npm'; // Default to npm
}

// Track ongoing installs
const ongoingInstalls = new Map(); // { appId: { process, logs, status } }

// Run npm/yarn install for an app
function runInstall(appId, appPath, appName) {
  return new Promise((resolve, reject) => {
    const packageManager = detectPackageManager(appPath);
    const isWindows = process.platform === 'win32';

    logTroubleshoot(appName, 'info', `Running ${packageManager} install`, { path: appPath });

    const proc = spawn(packageManager, ['install'], {
      cwd: appPath,
      shell: isWindows,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const installInfo = {
      process: proc,
      logs: [],
      status: 'running',
      packageManager,
      startTime: Date.now()
    };
    ongoingInstalls.set(appId, installInfo);

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        installInfo.logs.push({ type: 'stdout', text: line, time: Date.now() });
        console.log(`[${appName} install] ${line}`);
      }
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        installInfo.logs.push({ type: 'stderr', text: line, time: Date.now() });
        // npm outputs progress to stderr, so don't treat all stderr as errors
        console.log(`[${appName} install] ${line}`);
      }
    });

    proc.on('error', (err) => {
      installInfo.status = 'failed';
      installInfo.error = err.message;
      logTroubleshoot(appName, 'error', `${packageManager} install failed`, { error: err.message });
      reject(err);
    });

    proc.on('exit', (code) => {
      const duration = Date.now() - installInfo.startTime;
      if (code === 0) {
        installInfo.status = 'success';
        logTroubleshoot(appName, 'info', `${packageManager} install completed`, { duration });
        resolve({ success: true, packageManager, duration, logs: installInfo.logs });
      } else {
        installInfo.status = 'failed';
        installInfo.exitCode = code;
        logTroubleshoot(appName, 'error', `${packageManager} install failed with code ${code}`);
        reject(new Error(`${packageManager} install failed with exit code ${code}`));
      }

      // Keep install info for a bit so UI can fetch final status
      setTimeout(() => ongoingInstalls.delete(appId), 30000);
    });
  });
}

// Kill process on port (Windows)
async function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = result.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(pid)) {
          try {
            execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf8' });
            return { success: true, pid };
          } catch (e) {
            // Process may already be gone
          }
        }
      }
    }
    return { success: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Get info about process using a port (Windows)
function getProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = result.trim().split('\n');

      for (const line of lines) {
        // Match lines with LISTENING state or exact port match
        if (line.includes('LISTENING') || line.includes(`:${port} `)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];

          if (pid && !isNaN(pid)) {
            // Try to get process name
            try {
              const tasklistResult = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
              const match = tasklistResult.match(/"([^"]+)"/);
              const processName = match ? match[1] : 'Unknown';

              return {
                pid: parseInt(pid),
                name: processName,
                found: true
              };
            } catch (e) {
              return { pid: parseInt(pid), name: 'Unknown', found: true };
            }
          }
        }
      }
    }
    return { found: false };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// Find next available port starting from a given port
async function findNextAvailablePort(startPort, maxAttempts = 100) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const inUse = await isPortInUse(port);
    if (!inUse) {
      return { found: true, port };
    }
  }
  return { found: false, error: `No available port found between ${startPort} and ${startPort + maxAttempts}` };
}

// Health check polling - check if an app is responding
async function checkHealth(port, healthUrl = null, timeoutMs = 2000) {
  const http = require('http');
  const url = healthUrl || `http://localhost:${port}/`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ healthy: false, error: 'timeout' });
    }, timeoutMs);

    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      clearTimeout(timeout);
      // Any response (even 404) means the server is up
      resolve({ healthy: true, statusCode: res.statusCode });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ healthy: false, error: err.code || err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      resolve({ healthy: false, error: 'timeout' });
    });
  });
}

// Poll health endpoint until healthy or timeout
async function waitForHealthy(port, options = {}) {
  const {
    healthUrl = null,
    startupTimeout = 30000,  // Default 30 seconds max wait
    pollInterval = 500,      // Check every 500ms
    singleCheckTimeout = 2000
  } = options;

  const startTime = Date.now();
  let lastError = null;
  let attempts = 0;

  while (Date.now() - startTime < startupTimeout) {
    attempts++;
    const result = await checkHealth(port, healthUrl, singleCheckTimeout);

    if (result.healthy) {
      return {
        healthy: true,
        statusCode: result.statusCode,
        elapsed: Date.now() - startTime,
        attempts
      };
    }

    lastError = result.error;

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return {
    healthy: false,
    error: lastError || 'timeout',
    elapsed: Date.now() - startTime,
    attempts,
    timedOut: true
  };
}

// CORS - Allow MealTrack and other local apps to call QuickLaunch API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static(__dirname));

// Serve icon images from local file paths
app.get('/api/icon', (req, res) => {
  const { path: iconPath } = req.query;
  if (!iconPath) {
    return res.status(400).send('Missing path parameter');
  }

  // Only allow image file extensions
  const ext = iconPath.toLowerCase().split('.').pop();
  if (!['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp'].includes(ext)) {
    return res.status(400).send('Invalid file type');
  }

  // Check if file exists and send it
  const fs = require('fs');
  if (fs.existsSync(iconPath)) {
    res.sendFile(iconPath);
  } else {
    res.status(404).send('Icon not found');
  }
});

// Get status of all apps (with recent logs)
// Enhanced to detect externally-started apps via health check
app.get('/api/status', async (req, res) => {
  const status = {};
  const config = loadAppsConfig();

  // First, populate from runningProcesses (apps started by QuickLaunch)
  for (const [id, info] of runningProcesses) {
    status[id] = {
      running: info.status === 'running',
      port: info.port,
      name: info.name,
      pid: info.process?.pid,
      status: info.status,
      recentLogs: info.logs?.slice(-10) || [],
      startTime: info.startTime
    };
  }

  // Then, check for externally-started apps (those with ports that aren't 'running')
  // Only check apps that have a port and are either failed/stopped or not tracked
  const appsToCheck = config.apps.filter(app => {
    if (!app.port || app.port <= 0) return false; // Skip portless/scheduled apps
    const tracked = status[app.id];
    // Check if not tracked OR tracked but not running (failed/stopped)
    return !tracked || (tracked.status !== 'running' && tracked.status !== 'starting');
  });

  // Parallel health checks for efficiency (quick 500ms timeout)
  const healthChecks = await Promise.all(
    appsToCheck.map(async (app) => {
      const healthUrl = app.healthCheckUrl ? `http://localhost:${app.port}${app.healthCheckUrl}` : null;
      const result = await checkHealth(app.port, healthUrl, 500); // Quick check
      return { app, healthy: result.healthy };
    })
  );

  // Update status for externally-running apps
  for (const { app, healthy } of healthChecks) {
    if (healthy) {
      status[app.id] = {
        running: true,
        port: app.port,
        name: app.name,
        pid: null, // Unknown - started externally
        status: 'external', // New status: running but not managed by QuickLaunch
        recentLogs: [],
        startTime: null,
        external: true // Flag to indicate this was detected, not started
      };
    }
    // If not healthy and was 'failed', keep the failed status (already in status object)
  }

  res.json(status);
});

// Get startup history for troubleshooting
app.get('/api/history/:id', (req, res) => {
  const history = startupHistory.get(req.params.id) || { attempts: [] };
  res.json(history);
});

// Get TODO count for banner display
app.get('/api/todos', (req, res) => {
  const todos = countPendingTodos();
  res.json(todos);
});

// ========== APPS API ENDPOINTS ==========
// These endpoints manage the apps.json configuration

// GET /api/apps - Get all apps from apps.json
app.get('/api/apps', (req, res) => {
  const config = loadAppsConfig();
  res.json({
    apps: config.apps,
    reservedPorts: config.reservedPorts
  });
});

// POST /api/apps - Add a new app
app.post('/api/apps', (req, res) => {
  const { name, description, port, path: appPath, command, icon, iconPath, colors, healthCheckUrl, startupTimeout, autoRestart, maxRestartAttempts } = req.body;

  // Validate required fields
  if (!name || !port || !appPath || !command) {
    return res.status(400).json({ error: 'Missing required fields: name, port, path, command' });
  }

  // Check port availability
  const portCheck = checkPortAvailability(port);
  if (!portCheck.available) {
    return res.status(400).json({
      error: `Port ${port} is not available`,
      reason: portCheck.reason,
      usedBy: portCheck.usedBy,
      suggestedPort: suggestAvailablePort(port + 1)
    });
  }

  const config = loadAppsConfig();

  // Generate new app
  const newApp = {
    id: generateAppId(),
    name,
    description: description || '',
    port: parseInt(port),
    path: appPath,
    command,
    icon: icon || '🚀',
    iconPath: iconPath || null,
    colors: colors || ['#00d9ff', '#00ff88'],
    healthCheckUrl: healthCheckUrl || null,
    startupTimeout: startupTimeout || 30000,
    autoRestart: autoRestart || false,
    maxRestartAttempts: maxRestartAttempts || 3
  };

  config.apps.push(newApp);

  if (saveAppsConfig(config)) {
    console.log(`[QuickLaunch] Added new app: ${name} on port ${port}`);
    res.json({ success: true, app: newApp });
  } else {
    res.status(500).json({ error: 'Failed to save app configuration' });
  }
});

// PUT /api/apps/:id - Update an existing app
app.put('/api/apps/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const config = loadAppsConfig();
  const appIndex = config.apps.findIndex(app => app.id === id);

  if (appIndex === -1) {
    return res.status(404).json({ error: 'App not found' });
  }

  // If port is being changed, check availability
  if (updates.port && updates.port !== config.apps[appIndex].port) {
    const portCheck = checkPortAvailability(updates.port, id);
    if (!portCheck.available) {
      return res.status(400).json({
        error: `Port ${updates.port} is not available`,
        reason: portCheck.reason,
        usedBy: portCheck.usedBy,
        suggestedPort: suggestAvailablePort(updates.port + 1)
      });
    }
  }

  // Merge updates (preserve fields not being updated)
  config.apps[appIndex] = {
    ...config.apps[appIndex],
    ...updates,
    id // Ensure ID can't be changed
  };

  if (saveAppsConfig(config)) {
    console.log(`[QuickLaunch] Updated app: ${config.apps[appIndex].name}`);
    res.json({ success: true, app: config.apps[appIndex] });
  } else {
    res.status(500).json({ error: 'Failed to save app configuration' });
  }
});

// DELETE /api/apps/:id - Delete an app
app.delete('/api/apps/:id', (req, res) => {
  const { id } = req.params;

  const config = loadAppsConfig();
  const appIndex = config.apps.findIndex(app => app.id === id);

  if (appIndex === -1) {
    return res.status(404).json({ error: 'App not found' });
  }

  const deletedApp = config.apps[appIndex];
  config.apps.splice(appIndex, 1);

  if (saveAppsConfig(config)) {
    console.log(`[QuickLaunch] Deleted app: ${deletedApp.name}`);
    res.json({ success: true, deleted: deletedApp });
  } else {
    res.status(500).json({ error: 'Failed to save app configuration' });
  }
});

// GET /api/ports/check/:port - Check if a port is available
app.get('/api/ports/check/:port', async (req, res) => {
  const port = parseInt(req.params.port);
  const excludeAppId = req.query.exclude || null;

  if (isNaN(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Invalid port number' });
  }

  // Check registry (apps.json)
  const registryCheck = checkPortAvailability(port, excludeAppId);

  // Also check if port is actually in use on the system
  const systemInUse = await isPortInUse(port);

  res.json({
    port,
    registryAvailable: registryCheck.available,
    registryReason: registryCheck.reason || null,
    registryUsedBy: registryCheck.usedBy || null,
    systemInUse,
    available: registryCheck.available && !systemInUse,
    suggestedPort: (!registryCheck.available || systemInUse) ? suggestAvailablePort(port + 1) : null
  });
});

// GET /api/ports/suggest - Get next available port
app.get('/api/ports/suggest', (req, res) => {
  const basePort = parseInt(req.query.base) || 5174;
  const suggested = suggestAvailablePort(basePort);

  res.json({
    suggestedPort: suggested,
    basePort
  });
});

// POST /api/ports/reserve - Add a reserved port
app.post('/api/ports/reserve', (req, res) => {
  const { port, description } = req.body;

  if (!port || !description) {
    return res.status(400).json({ error: 'Missing required fields: port, description' });
  }

  const config = loadAppsConfig();
  const portStr = String(port);

  // Check if already reserved or used by an app
  if (config.reservedPorts[portStr]) {
    return res.status(400).json({
      error: `Port ${port} is already reserved`,
      usedBy: config.reservedPorts[portStr]
    });
  }

  const conflictingApp = config.apps.find(app => app.port === parseInt(port));
  if (conflictingApp) {
    return res.status(400).json({
      error: `Port ${port} is used by app "${conflictingApp.name}"`,
      appId: conflictingApp.id
    });
  }

  config.reservedPorts[portStr] = description;

  if (saveAppsConfig(config)) {
    console.log(`[QuickLaunch] Reserved port ${port}: ${description}`);
    res.json({ success: true, port, description });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// DELETE /api/ports/reserve/:port - Remove a reserved port
app.delete('/api/ports/reserve/:port', (req, res) => {
  const portStr = req.params.port;

  const config = loadAppsConfig();

  if (!config.reservedPorts[portStr]) {
    return res.status(404).json({ error: 'Port reservation not found' });
  }

  // Prevent removing QuickLaunch's own port
  if (portStr === '8000') {
    return res.status(400).json({ error: 'Cannot remove QuickLaunch system port reservation' });
  }

  const description = config.reservedPorts[portStr];
  delete config.reservedPorts[portStr];

  if (saveAppsConfig(config)) {
    console.log(`[QuickLaunch] Removed port reservation: ${portStr}`);
    res.json({ success: true, port: portStr, wasReservedFor: description });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// POST /api/apps/migrate - Migrate apps from localStorage (one-time import)
app.post('/api/apps/migrate', (req, res) => {
  const { apps: clientApps } = req.body;

  if (!clientApps || !Array.isArray(clientApps)) {
    return res.status(400).json({ error: 'Missing required field: apps (array)' });
  }

  const config = loadAppsConfig();
  let imported = 0;
  let skipped = 0;
  const results = [];

  for (const clientApp of clientApps) {
    // Check if app with same ID already exists
    const exists = config.apps.find(app => app.id === clientApp.id);
    if (exists) {
      skipped++;
      results.push({ id: clientApp.id, name: clientApp.name, status: 'skipped', reason: 'already exists' });
      continue;
    }

    // Check if port conflicts
    const portCheck = checkPortAvailability(clientApp.port);
    if (!portCheck.available) {
      skipped++;
      results.push({ id: clientApp.id, name: clientApp.name, status: 'skipped', reason: `port ${clientApp.port} conflicts with ${portCheck.usedBy}` });
      continue;
    }

    // Import the app
    config.apps.push({
      id: clientApp.id || generateAppId(),
      name: clientApp.name,
      description: clientApp.description || '',
      port: clientApp.port,
      path: clientApp.path,
      command: clientApp.command,
      icon: clientApp.icon || '🚀',
      iconPath: clientApp.iconPath || null,
      colors: clientApp.colors || ['#00d9ff', '#00ff88'],
      healthCheckUrl: clientApp.healthCheckUrl || null,
      startupTimeout: clientApp.startupTimeout || 30000,
      autoRestart: clientApp.autoRestart || false,
      maxRestartAttempts: clientApp.maxRestartAttempts || 3
    });

    imported++;
    results.push({ id: clientApp.id, name: clientApp.name, status: 'imported' });
  }

  if (saveAppsConfig(config)) {
    console.log(`[QuickLaunch] Migration complete: ${imported} imported, ${skipped} skipped`);
    res.json({ success: true, imported, skipped, results });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Apply triage decisions to TODO.md
app.post('/api/triage', (req, res) => {
  const { items } = req.body;

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Missing required field: items (array)' });
  }

  const results = applyTriage(items);
  res.json(results);
});

// Get all resolutions (optionally filtered by app)
app.get('/api/resolutions', (req, res) => {
  const { app: appName } = req.query;
  const resolutions = getResolutions(appName || null);
  res.json(resolutions);
});

// Check if dependencies need to be installed for an app
app.post('/api/check-deps', (req, res) => {
  const { id, path: appPath, name } = req.body;

  if (!appPath) {
    return res.status(400).json({ error: 'Missing required field: path' });
  }

  // Check if path exists
  if (!fs.existsSync(appPath)) {
    return res.json({ needsInstall: false, error: 'Path does not exist' });
  }

  // Check for package.json
  const packageJsonPath = path.join(appPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return res.json({ needsInstall: false, hasPackageJson: false });
  }

  // Check for node_modules
  const nodeModulesPath = path.join(appPath, 'node_modules');
  const needsInstall = !fs.existsSync(nodeModulesPath);

  // Detect package manager
  const packageManager = detectPackageManager(appPath);

  res.json({
    needsInstall,
    hasPackageJson: true,
    packageManager,
    path: appPath
  });
});

// Run npm/yarn install for an app
app.post('/api/install', async (req, res) => {
  const { id, path: appPath, name } = req.body;

  if (!id || !appPath) {
    return res.status(400).json({ error: 'Missing required fields: id, path' });
  }

  // Check if already installing
  if (ongoingInstalls.has(id) && ongoingInstalls.get(id).status === 'running') {
    return res.status(400).json({ error: 'Install already in progress' });
  }

  // Check path exists
  if (!fs.existsSync(appPath)) {
    return res.status(400).json({ error: 'Project path does not exist' });
  }

  // Check for package.json
  const packageJsonPath = path.join(appPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return res.status(400).json({ error: 'No package.json found in project' });
  }

  const packageManager = detectPackageManager(appPath);

  // Start install (don't await - return immediately so UI can poll)
  runInstall(id, appPath, name || id).catch(err => {
    console.error(`Install failed for ${name || id}:`, err.message);
  });

  res.json({
    success: true,
    status: 'started',
    packageManager,
    message: `Running ${packageManager} install...`
  });
});

// Get install status/progress
app.get('/api/install/:id', (req, res) => {
  const installInfo = ongoingInstalls.get(req.params.id);

  if (!installInfo) {
    return res.json({ status: 'none' });
  }

  res.json({
    status: installInfo.status,
    packageManager: installInfo.packageManager,
    logs: installInfo.logs.slice(-20), // Last 20 log entries
    error: installInfo.error,
    exitCode: installInfo.exitCode,
    duration: installInfo.status !== 'running' ? undefined : Date.now() - installInfo.startTime
  });
});

// Save a new resolution (marking a TODO as resolved or cancelled)
app.post('/api/resolutions', (req, res) => {
  const { app, issue, errorType, disposition, explanation, notes } = req.body;

  if (!issue || !explanation) {
    return res.status(400).json({ error: 'Missing required fields: issue, explanation' });
  }

  if (!['resolved', 'cancelled'].includes(disposition)) {
    return res.status(400).json({ error: 'Disposition must be "resolved" or "cancelled"' });
  }

  // Auto-detect error type from issue text if not provided
  let detectedErrorType = errorType;
  if (!detectedErrorType || detectedErrorType === 'UNKNOWN') {
    const issueLower = issue.toLowerCase();
    if (issueLower.includes('port') || issueLower.includes('address in use') || issueLower.includes('eaddrinuse')) {
      detectedErrorType = 'PORT_IN_USE';
    } else if (issueLower.includes('not found') || issueLower.includes('path') || issueLower.includes('enoent')) {
      detectedErrorType = 'PATH_NOT_FOUND';
    } else if (issueLower.includes('module') || issueLower.includes('cannot find') || issueLower.includes('node_modules')) {
      detectedErrorType = 'MISSING_MODULE';
    } else if (issueLower.includes('crash') || issueLower.includes('exited') || issueLower.includes('failed')) {
      detectedErrorType = 'CRASH';
    } else {
      detectedErrorType = 'UNKNOWN';
    }
  }

  const resolution = {
    date: new Date().toISOString(),
    app: app || 'General',
    issue,
    errorType: detectedErrorType,
    disposition,
    explanation,
    notes: notes || ''
  };

  const saveSuccess = saveResolution(resolution);
  const deleteSuccess = deleteTodoFromFile(issue);

  if (saveSuccess) {
    res.json({
      success: true,
      resolution,
      todoDeleted: deleteSuccess
    });
  } else {
    res.status(500).json({ error: 'Failed to save resolution' });
  }
});

// Start an app with full troubleshooting
app.post('/api/start', async (req, res) => {
  const {
    id, name, port: requestedPort, path: appPath, command,
    retry = false, overridePort = null,
    // Health check configuration
    healthCheckUrl = null,      // Custom health endpoint (e.g., '/api/health')
    startupTimeout = 30000,     // Max wait time in ms (default 30s, configurable per app speed)
    // Auto-restart configuration
    autoRestart = false,        // Whether to auto-restart on crash
    maxRestartAttempts = 3      // Max restart attempts before giving up
  } = req.body;

  // Build app config object for auto-restart feature
  const appConfig = {
    id, name, port: overridePort || requestedPort, path: appPath, command,
    healthCheckUrl, startupTimeout, autoRestart, maxRestartAttempts
  };

  // Use override port if provided (for "use alternative port" feature)
  const port = overridePort || requestedPort;

  if (!id || !appPath || !command) {
    return res.status(400).json({ error: 'Missing required fields: id, path, command' });
  }

  // Initialize history tracking
  if (!startupHistory.has(id)) {
    startupHistory.set(id, { attempts: [], lastError: null });
  }
  const history = startupHistory.get(id);

  const attempt = {
    timestamp: new Date().toISOString(),
    troubleshooting: [],
    result: null
  };

  // Check if already running
  if (runningProcesses.has(id)) {
    const info = runningProcesses.get(id);
    if (info.status === 'running') {
      return res.status(400).json({ error: 'App is already running' });
    }
    // Clean up stale entry
    runningProcesses.delete(id);
  }

  // LEARNING: Analyze past failures before starting
  const logAnalysis = analyzeLogHistory(id, name);
  if (logAnalysis.recommendation) {
    attempt.troubleshooting.push({
      step: 'history_analysis',
      status: logAnalysis.recommendation.level,
      message: logAnalysis.recommendation.message,
      failureCount: logAnalysis.recentFailures
    });

    // Auto-add to TODO.md if critical
    if (logAnalysis.recommendation.shouldAutoTodo) {
      appendAutoTodo(name, logAnalysis);
    }
  }

  // TROUBLESHOOTING STEP 1: Check if port is in use
  logTroubleshoot(name, 'info', 'Starting app', { port, path: appPath, command });
  attempt.troubleshooting.push({ step: 'port_check', status: 'checking' });

  const portInUse = await isPortInUse(port);
  if (portInUse) {
    logTroubleshoot(name, 'warn', `Port ${port} is already in use`, { port });
    attempt.troubleshooting.push({ step: 'port_check', status: 'port_in_use', port });

    // TROUBLESHOOTING STEP 2: Try to kill process on port
    if (retry) {
      logTroubleshoot(name, 'info', `Attempting to kill process on port ${port}`);
      attempt.troubleshooting.push({ step: 'kill_port_process', status: 'attempting' });

      const killResult = await killProcessOnPort(port);
      if (killResult.success) {
        logTroubleshoot(name, 'info', `Killed process on port ${port}`, { pid: killResult.pid });
        attempt.troubleshooting.push({ step: 'kill_port_process', status: 'success', pid: killResult.pid });
        // Wait a moment for port to free up
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        logTroubleshoot(name, 'error', `Failed to kill process on port ${port}`, killResult);
        attempt.troubleshooting.push({ step: 'kill_port_process', status: 'failed', error: killResult.error });

        attempt.result = 'failed';
        history.attempts.push(attempt);
        history.lastError = {
          type: 'PORT_IN_USE',
          message: `Port ${port} is in use and could not be freed`,
          suggestion: 'Close the application using this port or choose a different port',
          supportCode: 'QL-PORT-001'
        };

        return res.status(400).json({
          error: `Port ${port} is already in use`,
          troubleshooting: attempt.troubleshooting,
          suggestion: 'Close the application using this port, or click retry to attempt auto-recovery',
          canRetry: true,
          supportCode: 'QL-PORT-001'
        });
      }
    } else {
      // Get info about what's using the port
      const processInfo = getProcessOnPort(port);
      const alternativePort = await findNextAvailablePort(port + 1);

      attempt.troubleshooting.push({
        step: 'port_info',
        status: 'identified',
        blockingProcess: processInfo.found ? { pid: processInfo.pid, name: processInfo.name } : null,
        alternativePort: alternativePort.found ? alternativePort.port : null
      });

      attempt.result = 'failed';
      history.attempts.push(attempt);
      history.lastError = {
        type: 'PORT_IN_USE',
        message: `Port ${port} is in use`,
        suggestion: 'Click retry to attempt auto-recovery, or manually close the conflicting app'
      };

      return res.status(400).json({
        error: `Port ${port} is already in use`,
        troubleshooting: attempt.troubleshooting,
        suggestion: processInfo.found
          ? `Port ${port} is being used by "${processInfo.name}" (PID: ${processInfo.pid})`
          : 'Click retry to attempt auto-recovery, or manually close the conflicting app',
        blockingProcess: processInfo.found ? { pid: processInfo.pid, name: processInfo.name } : null,
        alternativePort: alternativePort.found ? alternativePort.port : null,
        canRetry: true,
        canUseAlternative: alternativePort.found,
        supportCode: 'QL-PORT-001'
      });
    }
  }

  attempt.troubleshooting.push({ step: 'port_check', status: 'available' });

  // TROUBLESHOOTING STEP 3: Verify path exists
  if (!fs.existsSync(appPath)) {
    logTroubleshoot(name, 'error', 'Project path does not exist', { path: appPath });
    attempt.troubleshooting.push({ step: 'path_check', status: 'not_found', path: appPath });
    attempt.result = 'failed';
    history.attempts.push(attempt);
    history.lastError = {
      type: 'PATH_NOT_FOUND',
      message: `Project path does not exist: ${appPath}`,
      suggestion: 'Verify the project path in app settings'
    };

    return res.status(400).json({
      error: `Project path does not exist: ${appPath}`,
      troubleshooting: attempt.troubleshooting,
      suggestion: 'Edit the app and verify the project path is correct',
      canRetry: false,
      supportCode: 'QL-PATH-001'
    });
  }
  attempt.troubleshooting.push({ step: 'path_check', status: 'exists' });

  // TROUBLESHOOTING STEP 4: Check for package.json (if npm command)
  if (command.startsWith('npm ')) {
    const packageJsonPath = path.join(appPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      logTroubleshoot(name, 'error', 'package.json not found', { path: packageJsonPath });
      attempt.troubleshooting.push({ step: 'package_json_check', status: 'not_found' });
      attempt.result = 'failed';
      history.attempts.push(attempt);

      return res.status(400).json({
        error: 'package.json not found in project directory',
        troubleshooting: attempt.troubleshooting,
        suggestion: 'Run "npm init" in the project directory or verify the path',
        canRetry: false,
        supportCode: 'QL-NPM-001'
      });
    }
    attempt.troubleshooting.push({ step: 'package_json_check', status: 'found' });

    // Check for node_modules
    const nodeModulesPath = path.join(appPath, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      logTroubleshoot(name, 'warn', 'node_modules not found - dependencies need to be installed');
      attempt.troubleshooting.push({ step: 'node_modules_check', status: 'not_found', warning: 'Dependencies need to be installed' });

      const packageManager = detectPackageManager(appPath);
      attempt.result = 'needs_install';
      history.attempts.push(attempt);

      return res.status(400).json({
        error: 'Dependencies not installed',
        needsInstall: true,
        packageManager,
        troubleshooting: attempt.troubleshooting,
        suggestion: `Run "${packageManager} install" to install dependencies`,
        canInstall: true,
        supportCode: 'QL-MOD-001'
      });
    } else {
      attempt.troubleshooting.push({ step: 'node_modules_check', status: 'found' });
    }
  }

  try {
    // Parse command - support "npm run dev" style commands
    const isWindows = process.platform === 'win32';
    const parts = command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    const proc = spawn(cmd, args, {
      cwd: appPath,
      shell: isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true
    });

    // Track logs for this process
    const logs = [];
    let startupError = null;
    let hasStarted = false;

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      console.log(`[${name}] ${line}`);
      logs.push({ type: 'stdout', text: line, time: Date.now() });

      // Detect successful startup
      if (line.includes('Local:') || line.includes('ready in') || line.includes('listening')) {
        hasStarted = true;
        const info = runningProcesses.get(id);
        if (info) {
          info.status = 'running';
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      console.error(`[${name}] ${line}`);
      logs.push({ type: 'stderr', text: line, time: Date.now() });

      // Capture error patterns
      if (line.includes('EADDRINUSE') || line.includes('address already in use')) {
        startupError = { type: 'PORT_IN_USE', message: line };
      } else if (line.includes('Cannot find module') || line.includes('MODULE_NOT_FOUND')) {
        startupError = { type: 'MISSING_MODULE', message: line };
      } else if (line.includes('ENOENT')) {
        startupError = { type: 'FILE_NOT_FOUND', message: line };
      }
    });

    proc.on('error', (err) => {
      console.error(`[${name}] Failed to start:`, err.message);
      logTroubleshoot(name, 'error', 'Process spawn failed', { error: err.message });
      logs.push({ type: 'error', text: err.message, time: Date.now() });

      const info = runningProcesses.get(id);
      if (info) {
        info.status = 'failed';
        info.error = err.message;
      }
    });

    proc.on('exit', (code) => {
      // Use shared handleProcessExit for auto-restart support
      // But also handle startup-specific failure tracking here
      const info = runningProcesses.get(id);
      const runTime = info ? Date.now() - info.startTime : 0;

      // For quick crashes during startup, record in attempt history
      if (code !== 0 && runTime < 5000) {
        attempt.result = 'failed';
        attempt.troubleshooting.push({
          step: 'process_start',
          status: 'crashed',
          exitCode: code,
          runTime,
          error: startupError
        });
        history.attempts.push(attempt);
        history.lastError = {
          type: startupError?.type || 'STARTUP_CRASH',
          message: startupError?.message || `Process exited with code ${code}`,
          exitCode: code,
          logs: logs.slice(-5)
        };
      }

      // Delegate to shared exit handler (handles auto-restart)
      handleProcessExit(id, code, appConfig);
    });

    runningProcesses.set(id, {
      process: proc,
      port,
      name,
      logs,
      startTime: Date.now(),
      status: 'starting',
      appConfig // Store config for auto-restart
    });

    attempt.troubleshooting.push({ step: 'process_start', status: 'spawned', pid: proc.pid });
    logTroubleshoot(name, 'info', `Started on port ${port}`, { pid: proc.pid });

    // Wait briefly (500ms) to catch immediate crashes before health polling
    await new Promise(resolve => setTimeout(resolve, 500));

    const info = runningProcesses.get(id);
    if (info?.status === 'failed') {
      attempt.result = 'failed';
      attempt.troubleshooting.push({ step: 'immediate_crash', status: 'failed', error: info.error });
      history.attempts.push(attempt);

      return res.status(500).json({
        error: info.error || 'App failed to start',
        troubleshooting: attempt.troubleshooting,
        logs: logs.slice(-10),
        suggestion: getSuggestion(startupError),
        canRetry: startupError?.type === 'PORT_IN_USE',
        supportCode: getSupportCode(startupError)
      });
    }

    // Health check polling - wait for app to respond (with timeout safety net)
    attempt.troubleshooting.push({ step: 'health_check', status: 'polling', timeout: startupTimeout });
    logTroubleshoot(name, 'info', `Waiting for health check on port ${port}`, { timeout: startupTimeout, healthUrl: healthCheckUrl });

    const fullHealthUrl = healthCheckUrl ? `http://localhost:${port}${healthCheckUrl}` : null;
    const healthResult = await waitForHealthy(port, {
      healthUrl: fullHealthUrl,
      startupTimeout,
      pollInterval: 500,
      singleCheckTimeout: 2000
    });

    // Check if process crashed during health polling
    const infoAfterPoll = runningProcesses.get(id);
    if (infoAfterPoll?.status === 'failed' || infoAfterPoll?.status === 'stopped') {
      attempt.result = 'failed';
      attempt.troubleshooting.push({
        step: 'health_check',
        status: 'process_died',
        error: infoAfterPoll.error || 'Process exited during startup'
      });
      history.attempts.push(attempt);

      return res.status(500).json({
        error: infoAfterPoll.error || 'App crashed during startup',
        troubleshooting: attempt.troubleshooting,
        logs: logs.slice(-10),
        suggestion: getSuggestion(startupError),
        canRetry: startupError?.type === 'PORT_IN_USE',
        supportCode: getSupportCode(startupError)
      });
    }

    if (healthResult.healthy) {
      // App is responding - mark as running
      if (infoAfterPoll) {
        infoAfterPoll.status = 'running';
      }

      attempt.troubleshooting.push({
        step: 'health_check',
        status: 'healthy',
        elapsed: healthResult.elapsed,
        attempts: healthResult.attempts,
        statusCode: healthResult.statusCode
      });
      attempt.result = 'success';
      history.attempts.push(attempt);

      logTroubleshoot(name, 'info', `Health check passed`, {
        elapsed: healthResult.elapsed,
        attempts: healthResult.attempts
      });

      res.json({
        success: true,
        pid: proc.pid,
        status: 'running',
        healthCheck: {
          elapsed: healthResult.elapsed,
          attempts: healthResult.attempts
        },
        troubleshooting: attempt.troubleshooting,
        // Include pattern analysis for UI awareness
        analysis: logAnalysis.recommendation ? {
          level: logAnalysis.recommendation.level,
          message: logAnalysis.recommendation.message,
          recentFailures: logAnalysis.recentFailures,
          patterns: logAnalysis.patterns,
          pastResolutions: logAnalysis.pastResolutions
        } : null
      });
    } else {
      // Health check timed out - app might still be starting (slow apps)
      // Keep it as 'starting' but warn the user
      attempt.troubleshooting.push({
        step: 'health_check',
        status: 'timeout',
        elapsed: healthResult.elapsed,
        attempts: healthResult.attempts,
        error: healthResult.error
      });

      logTroubleshoot(name, 'warn', `Health check timed out after ${healthResult.elapsed}ms`, {
        attempts: healthResult.attempts,
        error: healthResult.error
      });

      // Still return success but with warning - process is running, just not responding yet
      attempt.result = 'partial';
      history.attempts.push(attempt);

      res.json({
        success: true,
        pid: proc.pid,
        status: 'starting', // Still starting, not confirmed running
        healthCheck: {
          timedOut: true,
          elapsed: healthResult.elapsed,
          attempts: healthResult.attempts,
          error: healthResult.error
        },
        warning: `App started but health check timed out after ${Math.round(healthResult.elapsed / 1000)}s. It may still be loading.`,
        troubleshooting: attempt.troubleshooting,
        analysis: logAnalysis.recommendation ? {
          level: logAnalysis.recommendation.level,
          message: logAnalysis.recommendation.message,
          recentFailures: logAnalysis.recentFailures,
          patterns: logAnalysis.patterns,
          pastResolutions: logAnalysis.pastResolutions
        } : null
      });
    }

  } catch (err) {
    logTroubleshoot(name, 'error', 'Exception during startup', { error: err.message });
    attempt.result = 'failed';
    attempt.troubleshooting.push({ step: 'process_start', status: 'exception', error: err.message });
    history.attempts.push(attempt);

    res.status(500).json({
      error: err.message,
      troubleshooting: attempt.troubleshooting,
      suggestion: 'Contact development support if this persists',
      supportCode: 'QL-ERR-500'
    });
  }
});

// Helper: Get suggestion based on error type
function getSuggestion(error) {
  if (!error) return 'Check the logs for more details';

  switch (error.type) {
    case 'PORT_IN_USE':
      return 'Another process is using this port. Click retry to attempt auto-recovery, or close the conflicting application.';
    case 'MISSING_MODULE':
      return 'Run "npm install" in the project directory to install dependencies.';
    case 'FILE_NOT_FOUND':
      return 'A required file is missing. Verify the project path and that all files are present.';
    default:
      return 'Check the logs for more details. If this persists, contact development support.';
  }
}

// Helper: Get support code based on error type
function getSupportCode(error) {
  if (!error) return 'QL-ERR-000';

  switch (error.type) {
    case 'PORT_IN_USE': return 'QL-PORT-002';
    case 'MISSING_MODULE': return 'QL-MOD-001';
    case 'FILE_NOT_FOUND': return 'QL-FILE-001';
    default: return 'QL-ERR-000';
  }
}

// ========== SCHEDULE API ENDPOINTS ==========

// GET /api/schedule/:id - Get schedule info for an app
app.get('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const config = loadAppsConfig();
  const appConfig = config.apps.find(app => app.id === id);

  if (!appConfig) {
    return res.status(404).json({ error: 'App not found' });
  }

  const state = loadScheduleState();
  const appState = state[id] || {};
  const isJobActive = scheduledJobs.has(id);

  res.json({
    schedule: appConfig.schedule || null,
    scheduleEnabled: appConfig.scheduleEnabled || false,
    runIfMissed: appConfig.runIfMissed || false,
    scheduleDescription: appConfig.schedule ? getScheduleDescription(appConfig.schedule) : null,
    lastRun: appState.lastRun || null,
    lastExitCode: appState.lastExitCode,
    isJobActive,
    nextRun: isJobActive && scheduledJobs.get(id).nextInvocation()
      ? scheduledJobs.get(id).nextInvocation().toISOString()
      : null
  });
});

// Check if schedule ran today
function hasRunToday(appId) {
  const state = loadScheduleState();
  const appState = state[appId];
  if (!appState || !appState.lastRun) return false;

  const lastRun = new Date(appState.lastRun);
  const now = new Date();
  return lastRun.toDateString() === now.toDateString();
}

// POST /api/schedule/:id/enable - Enable/disable schedule for an app
app.post('/api/schedule/:id/enable', (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body;

  const config = loadAppsConfig();
  const appIndex = config.apps.findIndex(app => app.id === id);

  if (appIndex === -1) {
    return res.status(404).json({ error: 'App not found' });
  }

  const appConfig = config.apps[appIndex];

  // Must have a schedule defined to enable
  if (enabled && !appConfig.schedule) {
    return res.status(400).json({ error: 'No schedule defined for this app' });
  }

  // Update enabled status
  config.apps[appIndex].scheduleEnabled = enabled;

  if (saveAppsConfig(config)) {
    // Set up or cancel the job
    if (enabled) {
      setupScheduledJob(id, config.apps[appIndex]);
      console.log(`[Scheduler] Enabled schedule for ${appConfig.name}`);
    } else {
      if (scheduledJobs.has(id)) {
        scheduledJobs.get(id).cancel();
        scheduledJobs.delete(id);
      }
      console.log(`[Scheduler] Disabled schedule for ${appConfig.name}`);
    }

    const state = loadScheduleState();
    const appState = state[id] || {};
    const ranToday = hasRunToday(id);

    res.json({
      success: true,
      scheduleEnabled: enabled,
      schedule: appConfig.schedule,
      scheduleDescription: getScheduleDescription(appConfig.schedule),
      lastRun: appState.lastRun || null,
      lastExitCode: appState.lastExitCode,
      ranToday: ranToday,
      isJobActive: scheduledJobs.has(id),
      message: enabled
        ? (ranToday
          ? `Scheduler enabled. Already ran today at ${new Date(appState.lastRun).toLocaleTimeString()}. Next run tomorrow.`
          : `Scheduler enabled. Will run at ${getScheduleDescription(appConfig.schedule)}.`)
        : 'Scheduler disabled.'
    });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// POST /api/schedule/:id/run - Manually run a scheduled app (must be enabled)
app.post('/api/schedule/:id/run', async (req, res) => {
  const { id } = req.params;

  const config = loadAppsConfig();
  const appConfig = config.apps.find(app => app.id === id);

  if (!appConfig) {
    return res.status(404).json({ error: 'App not found' });
  }

  // Must have schedule enabled to run manually
  if (!appConfig.scheduleEnabled) {
    return res.status(400).json({
      error: 'Schedule must be enabled to run this app',
      hint: 'Turn the scheduler ON first, then you can run manually'
    });
  }

  // Check if sync is already running (use sync-specific key for hybrid apps)
  const syncProcessKey = appConfig.scheduleCommand ? `${id}:sync` : id;
  const existingProcess = runningProcesses.get(syncProcessKey);
  if (existingProcess && existingProcess.status === 'running') {
    return res.status(400).json({ error: 'Sync is already running' });
  }

  try {
    const result = await executeScheduledApp(id, appConfig, true); // isManual = true
    res.json({
      success: true,
      message: `Manual (off-schedule) run started for ${appConfig.name}`,
      isManual: true,
      pid: result.pid,
      processKey: result.processKey
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/schedule/:id/status - Get status of a running scheduled app
app.get('/api/schedule/:id/status', (req, res) => {
  const { id } = req.params;

  // For hybrid apps, check the sync-specific process key first
  const config = loadAppsConfig();
  const appConfig = config.apps.find(app => app.id === id);
  const syncProcessKey = appConfig?.scheduleCommand ? `${id}:sync` : id;

  // Check sync process first (for hybrid apps), then fall back to main app id
  let processInfo = runningProcesses.get(syncProcessKey);
  if (!processInfo && syncProcessKey !== id) {
    processInfo = runningProcesses.get(id);
  }

  if (!processInfo) {
    // No running process, return state info only
    const state = loadScheduleState();
    const appState = state[id] || {};
    return res.json({
      status: 'not_running',
      lastRun: appState.lastRun || null,
      lastExitCode: appState.lastExitCode
    });
  }

  const state = loadScheduleState();
  const appState = state[id] || {};

  res.json({
    status: processInfo.status,
    exitCode: processInfo.exitCode,
    startTime: processInfo.startTime,
    isManual: processInfo.isManual || false,
    isSyncProcess: processInfo.isSyncProcess || false,
    lastRun: appState.lastRun || null,
    lastExitCode: appState.lastExitCode,
    logs: processInfo.logs?.slice(-20) || [] // Last 20 log lines
  });
});

// PUT /api/schedule/:id - Update schedule settings for an app
app.put('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const { schedule: newSchedule, runIfMissed } = req.body;

  const config = loadAppsConfig();
  const appIndex = config.apps.findIndex(app => app.id === id);

  if (appIndex === -1) {
    return res.status(404).json({ error: 'App not found' });
  }

  // Update schedule settings
  if (newSchedule !== undefined) {
    config.apps[appIndex].schedule = newSchedule;
  }
  if (runIfMissed !== undefined) {
    config.apps[appIndex].runIfMissed = runIfMissed;
  }

  if (saveAppsConfig(config)) {
    // Re-setup job if enabled
    if (config.apps[appIndex].scheduleEnabled) {
      setupScheduledJob(id, config.apps[appIndex]);
    }

    res.json({
      success: true,
      schedule: config.apps[appIndex].schedule,
      scheduleDescription: config.apps[appIndex].schedule
        ? getScheduleDescription(config.apps[appIndex].schedule)
        : null,
      runIfMissed: config.apps[appIndex].runIfMissed
    });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// GET /api/schedules - Get all scheduled apps status
app.get('/api/schedules', (req, res) => {
  const config = loadAppsConfig();
  const state = loadScheduleState();

  const schedules = config.apps
    .filter(app => app.schedule)
    .map(app => {
      const appState = state[app.id] || {};
      const isJobActive = scheduledJobs.has(app.id);
      const job = scheduledJobs.get(app.id);

      return {
        id: app.id,
        name: app.name,
        schedule: app.schedule,
        scheduleDescription: getScheduleDescription(app.schedule),
        scheduleEnabled: app.scheduleEnabled || false,
        runIfMissed: app.runIfMissed || false,
        lastRun: appState.lastRun || null,
        lastExitCode: appState.lastExitCode,
        isJobActive,
        nextRun: isJobActive && job?.nextInvocation()
          ? job.nextInvocation().toISOString()
          : null
      };
    });

  res.json(schedules);
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

  // Kill the process and all children (windowsHide prevents cmd popup)
  killProcessTree(pid, (err) => {
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
    killProcessTree(info.process.pid);
  }
  setTimeout(() => process.exit(), 1000);
});

app.listen(PORT, () => {
  console.log(`QuickLaunch running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');

  // Initialize scheduled jobs
  initializeScheduledJobs();
});
