'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test(
  'daemon and auto-start scripts parse under Windows PowerShell 5.1',
  { skip: process.platform !== 'win32' },
  () => {
    const powershell = path.join(
      process.env.SystemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    for (const relativePath of [
      'scripts/daemon.ps1',
      'scripts/install-autostart.ps1',
      'test/daemon-exit-smoke.ps1',
    ]) {
      const scriptPath = path.resolve(__dirname, '../../', relativePath);
      const parser = [
        '$tokens=$null;',
        '$errors=$null;',
        `[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null;`,
        'if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}',
      ].join(' ');
      const result = spawnSync(
        powershell,
        ['-NoProfile', '-Command', parser],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(
        result.status,
        0,
        result.stderr || result.stdout || `${relativePath} parse failed`,
      );
    }
  },
);
