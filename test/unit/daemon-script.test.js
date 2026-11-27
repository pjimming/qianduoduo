'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('runtime identity rejects recycled PIDs and verifies elevated process timestamps',
  { skip: process.platform !== 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-runtime-'));
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const helper = path.resolve(__dirname, '../../scripts/runtime-process.ps1');
    fs.mkdirSync(path.join(root, 'run'));
    const script = `
. ${quote(helper)}
$fixtureRoot = ${quote(root)}
$fixturePid = Join-Path $fixtureRoot 'run\\daemon.pid'
Set-Content -LiteralPath $fixturePid -Value '4321' -Encoding ASCII
$created = (Get-Date).AddSeconds(-1)
$script:fixtureInfo = [pscustomobject]@{ProcessId=4321; ParentProcessId=1234; Name='powershell.exe'; CreationDate=$created; CommandLine=''}
function Get-CimInstance { return $script:fixtureInfo }
function Get-Process { return [pscustomobject]@{Id=4321; StartTime=$created} }
$meta = @{pid=4321;root=$fixtureRoot;port=18769;process_started_at=$created.ToUniversalTime().ToString('o')}
$metaPath = Join-Path $fixtureRoot 'run\\supervisor.json'
function Save-Meta { $meta | ConvertTo-Json | Set-Content -LiteralPath $metaPath -Encoding UTF8 }
function Assert-Identity($expected) {
  $actual = Get-QddRuntimeProcess -PidFile $fixturePid -Role supervisor -Root $fixtureRoot -Port 18769
  if ([bool]$actual -ne $expected) { throw 'Unexpected runtime identity result' }
}
Save-Meta
Assert-Identity $true
$meta.process_started_at = $created.AddDays(-1).ToUniversalTime().ToString('o')
Save-Meta
Assert-Identity $false
$meta.process_started_at = $created.ToUniversalTime().ToString('o')
Save-Meta
$script:fixtureInfo.Name = 'msedgewebview2.exe'
Assert-Identity $false
$script:fixtureInfo.Name = 'powershell.exe'
$script:fixtureInfo.CommandLine = 'powershell.exe -File "' + (Join-Path $fixtureRoot 'scripts\\daemon.ps1') + '" -Action run -Root "' + $fixtureRoot + '" -Port 18769'
Assert-Identity $true
$script:fixtureInfo.CommandLine = $script:fixtureInfo.CommandLine.Replace('18769', '18770')
Assert-Identity $false
$script:fixtureInfo.CommandLine = 'powershell.exe -Command Start-Sleep'
Assert-Identity $false
Write-Output 'identity cases passed'
`;
    try {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /identity cases passed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test(
  'production daemon and host scripts parse under Windows PowerShell 5.1',
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
      'scripts/runtime-process.ps1',
      'scripts/production-host.ps1',
      'scripts/install-autostart.ps1',
      'scripts/deploy-production.ps1',
      'test/daemon-exit-smoke.ps1',
      'test/production-host-smoke.ps1',
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

test(
  'scheduled production bootstrap launches PowerShell without a console',
  { skip: process.platform !== 'win32' },
  () => {
    const launcher = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../scripts/production-bootstrap-template.vbs',
      ),
      'utf8',
    );
    assert.match(launcher, /-WindowStyle Hidden/);
    assert.match(launcher, /\.\\scripts\\production-host\.ps1/);
    assert.match(launcher, /-Root ""\.""/);
    assert.match(launcher, /shell\.Run\(command,\s*0,\s*True\)/);
    assert.match(launcher, /WScript\.Quit exitCode/);
  },
);
