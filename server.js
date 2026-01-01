const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const treeKill = require('tree-kill');

const app = express();
const PORT = 8000;

// Track running processes: { appId: { process, port, name, logs, startTime, status } }
const runningProcesses = new Map();

// Track startup attempts and errors for troubleshooting
const startupHistory = new Map(); // { appId: { attempts: [], lastError: null } }

// Log file path for troubleshooting
const LOG_FILE = path.join(__dirname, 'quicklaunch-troubleshoot.log');
const TODO_FILE = path.join(__dirname, 'TODO.md');
const RESOLUTIONS_FILE = path.join(__dirname, 'quicklaunch-resolutions.log');

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

// Count pending TODOs from TODO.md
function countPendingTodos() {
  try {
    if (!fs.existsSync(TODO_FILE)) {
      return { count: 0, items: [] };
    }

    const content = fs.readFileSync(TODO_FILE, 'utf8');
    const lines = content.split('\n');
    const pendingItems = [];

    for (const line of lines) {
      // Match unchecked checkboxes: - [ ]
      if (line.match(/^[\s]*-\s*\[\s*\]/)) {
        const item = line.replace(/^[\s]*-\s*\[\s*\]\s*/, '').trim();
        if (item) pendingItems.push(item);
      }
    }

    // Also count auto-detected issues (### headers in auto-detected section)
    const autoSection = content.indexOf('## Auto-Detected Issues');
    if (autoSection > -1) {
      const autoContent = content.slice(autoSection);
      const autoMatches = autoContent.match(/^### \[.*?\]/gm) || [];
      for (const match of autoMatches) {
        const item = match.replace(/^### /, '').trim();
        if (!pendingItems.includes(item)) {
          pendingItems.push(`[Auto] ${item}`);
        }
      }
    }

    return { count: pendingItems.length, items: pendingItems };
  } catch (err) {
    console.error('Failed to count TODOs:', err.message);
    return { count: 0, items: [] };
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
      if (level === 'ERROR' || level === 'WARN') {
        // Determine the error type for this log entry
        let errorType = null;
        if (rest.includes('Port') && rest.includes('in use')) {
          errorType = 'PORT_IN_USE';
        } else if (rest.includes('not found') || rest.includes('not exist')) {
          errorType = 'PATH_NOT_FOUND';
        } else if (rest.includes('module') || rest.includes('MODULE')) {
          errorType = 'MISSING_MODULE';
        } else if (rest.includes('exited with code')) {
          errorType = 'CRASH';
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

app.use(express.json());
app.use(express.static(__dirname));

// Get status of all apps (with recent logs)
app.get('/api/status', (req, res) => {
  const status = {};
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
    startupTimeout = 30000      // Max wait time in ms (default 30s, configurable per app speed)
  } = req.body;

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
      console.log(`[${name}] Exited with code ${code}`);
      logTroubleshoot(name, code === 0 ? 'info' : 'error', `Process exited with code ${code}`, { exitCode: code });

      const info = runningProcesses.get(id);
      if (info) {
        info.status = 'stopped';
        info.exitCode = code;

        // If exited quickly with non-zero, it's a startup failure
        const runTime = Date.now() - info.startTime;
        if (code !== 0 && runTime < 5000) {
          info.status = 'failed';
          info.error = startupError?.message || `Exited with code ${code}`;

          // Record failure in history
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
      }
    });

    runningProcesses.set(id, {
      process: proc,
      port,
      name,
      logs,
      startTime: Date.now(),
      status: 'starting'
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
