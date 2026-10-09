[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

try {
    $bundledNodeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
    $nodeCandidates = @()
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
    $nodeCandidates += (Join-Path $bundledNodeRoot 'bin\node.exe')
    $nodePath = $null
    foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $versionText = (& $candidate --version 2>$null | Out-String).Trim()
        if ($versionText -match '^v(\d+\.\d+\.\d+)' -and [version]$Matches[1] -ge [version]'22.13.0') {
            $nodePath = $candidate
            break
        }
    }
    if (-not $nodePath) { throw 'Node.js 22.13 or newer is required. Install Node.js LTS from https://nodejs.org/ and run this launcher again.' }
    $env:PATH = (Split-Path -Parent $nodePath) + [IO.Path]::PathSeparator + $env:PATH

    Write-Host ''
    Write-Host '  LUMINA / Gallery' -ForegroundColor Cyan
    Write-Host ('  Runtime: ' + $nodePath)

    $listenPort = 3210
    if ($env:PORT) {
        $parsedPort = 0
        if (-not [int]::TryParse($env:PORT, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) { throw 'PORT must be an integer between 1 and 65535.' }
        $listenPort = $parsedPort
    }
    $browserUrl = 'http://127.0.0.1:' + $listenPort
    $existingHealth = $null
    try { $existingHealth = Invoke-RestMethod -Uri ($browserUrl + '/api/health') -TimeoutSec 2 } catch {}
    if ($existingHealth.ok -eq $true -and $existingHealth.app -ceq 'lumina-gallery') {
        Write-Host ('  Lumina is already running: ' + $browserUrl) -ForegroundColor Green
        if (-not $NoBrowser) { Start-Process $browserUrl }
        return
    }

    $packageCommand = $null
    $packagePrefix = @()
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $bundledPnpm = Join-Path $bundledNodeRoot 'node_modules\pnpm\bin\pnpm.cjs'
    if ($npmCommand) {
        $packageCommand = $npmCommand.Source
    } elseif (Test-Path -LiteralPath $bundledPnpm) {
        $packageCommand = $nodePath
        $packagePrefix = @($bundledPnpm)
    }

    $dependenciesReady = (Test-Path 'node_modules\tsx\dist\cli.mjs') -and (Test-Path 'node_modules\vite\bin\vite.js') -and (Test-Path 'node_modules\sharp\package.json') -and (Test-Path 'node_modules\typescript\bin\tsc')
    if (-not $dependenciesReady) {
        if (-not $packageCommand) { throw 'npm was not found. Reinstall Node.js with npm, then run this launcher again.' }
        Write-Host '  Installing dependencies (internet connection required)...'
        & $packageCommand @packagePrefix install
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. See the message above and try again.' }
    }

    $buildRequired = -not (Test-Path 'dist\index.html')
    if (-not $buildRequired) {
        $buildTime = (Get-Item 'dist\index.html').LastWriteTimeUtc
        $sourceFiles = @(Get-ChildItem -Path 'src', 'server', 'shared', 'public' -File -Recurse -ErrorAction SilentlyContinue)
        $sourceFiles += @(Get-Item -Path 'package.json', 'index.html', 'vite.config.ts', 'tsconfig.json' -ErrorAction SilentlyContinue)
        $buildRequired = @($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $buildTime }).Count -gt 0
    }
    if ($buildRequired) {
        if (-not $packageCommand) { throw 'npm was not found. Reinstall Node.js with npm to build the application.' }
        Write-Host '  Building the application...'
        & $packageCommand @packagePrefix run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed. See the message above for details.' }
    }

    if (-not $NoBrowser) {
        $browserHelper = @"
`$ErrorActionPreference = 'SilentlyContinue'
for (`$attempt = 0; `$attempt -lt 90; `$attempt++) {
    try {
        `$result = Invoke-RestMethod -Uri '$browserUrl/api/health' -TimeoutSec 2
        if (`$result.ok -eq `$true -and `$result.app -ceq 'lumina-gallery') { Start-Process '$browserUrl'; break }
    } catch {}
    Start-Sleep -Seconds 1
}
"@
        $encodedHelper = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($browserHelper))
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-EncodedCommand', $encodedHelper) | Out-Null
    }
    Write-Host ('  Open: ' + $browserUrl) -ForegroundColor Green
    Write-Host '  Keep this window open for daily link checks. Press Ctrl+C to stop.'
    Write-Host ''
    & $nodePath 'node_modules\tsx\dist\cli.mjs' 'server\index.ts' '--production'
    if ($LASTEXITCODE -ne 0) { throw ('The application stopped with exit code ' + $LASTEXITCODE + '. Check whether the port is already in use.') }
} catch {
    Write-Host ''
    Write-Host ('  Error: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
