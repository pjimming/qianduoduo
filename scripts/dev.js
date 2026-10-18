'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const BACKEND_PORT = Number(process.env.PORT || 8765);
const DEV_PORT = Number(process.env.VITE_DEV_PORT || 5173);
const BACKEND_HEALTH_URL = `http://${HOST}:${BACKEND_PORT}/api/health`;
const DEV_URL = `http://${HOST}:${DEV_PORT}`;
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const OPEN_BROWSER = process.env.R2_NO_OPEN !== '1';

let backendProcess = null;
let viteProcess = null;
let shuttingDown = false;

function ping(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitFor(url, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${url}`);
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGTERM');
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(viteProcess);
  killTree(backendProcess);
  process.exitCode = exitCode;
}

async function main() {
  if (!fs.existsSync(VITE_BIN)) {
    throw new Error('Vite is not installed. Run npm install first.');
  }

  const backendAlreadyRunning = await ping(BACKEND_HEALTH_URL);
  if (backendAlreadyRunning) {
    console.log(`Backend already running at http://${HOST}:${BACKEND_PORT}`);
    console.log('Reusing the existing backend. Close start.bat to enable server.js watch mode.');
  } else {
    backendProcess = spawn(
      process.execPath,
      ['--watch', '--no-warnings', 'server.js'],
      {
        cwd: ROOT,
        env: { ...process.env, PORT: String(BACKEND_PORT) },
        stdio: 'inherit',
      },
    );
    backendProcess.on('exit', (code) => {
      if (!shuttingDown) shutdown(code ?? 0);
    });
    await waitFor(BACKEND_HEALTH_URL, 'Backend');
    console.log(`Backend watching on http://${HOST}:${BACKEND_PORT}`);
  }

  const viteArgs = [
    VITE_BIN,
    '--host',
    HOST,
    '--port',
    String(DEV_PORT),
    '--strictPort',
  ];
  if (OPEN_BROWSER) viteArgs.push('--open');

  viteProcess = spawn(process.execPath, viteArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_API_PROXY_TARGET: `http://${HOST}:${BACKEND_PORT}`,
    },
    stdio: 'inherit',
  });
  viteProcess.on('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 0);
  });

  console.log(`Dev page: ${DEV_URL}`);
  console.log('Vue, TypeScript and CSS changes update through Vite HMR.');
  console.log('Press Ctrl+C to stop the development servers.');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  killTree(viteProcess);
  killTree(backendProcess);
});

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
});
