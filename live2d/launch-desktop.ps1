# Launch the desktop fish (transparent always-on-top Electron window).
# Kept as a real .ps1 so the .bat wrapper needs no nested quoting.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = if ($env:ELECTRON_EXE) { $env:ELECTRON_EXE } else { Join-Path $env:USERPROFILE '.dsh\dsh-orb\electron-runtime\electron.exe' }
$appDir = Join-Path $here 'desktop'

if (-not (Test-Path $electron)) { Write-Host "[error] Electron runtime not found: $electron"; exit 1 }
if (-not (Test-Path $appDir)) { Write-Host "[error] app dir not found: $appDir"; exit 1 }

# DSH sets ELECTRON_RUN_AS_NODE=1 globally; electron must start as a GUI app.
$env:ELECTRON_RUN_AS_NODE = ''

# 电脑窗口默认连云上那台身体服务（电脑和手机看同一个她）；
# live2d\cloud.json 里没有配置、或者用 FISH_LOCAL=1 启动，就退回本机 17901。
$cloudCfg = Join-Path $here 'cloud.json'
if ($env:FISH_LOCAL -eq '1') {
  $env:FISH_URL = ''
  Write-Host '[info] FISH_LOCAL=1 -> 用本机的身体服务（17901）'
} elseif (Test-Path $cloudCfg) {
  try {
    $cfg = Get-Content $cloudCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.url -and $cfg.token) {
      $env:FISH_URL = ('{0}/?k={1}&desktop=1' -f $cfg.url.TrimEnd('/'), [uri]::EscapeDataString($cfg.token))
      Write-Host ('[info] 连云上的身体：{0}' -f $cfg.url)
    }
  } catch {
    Write-Host ('[warn] cloud.json 读不出来，改用本机：{0}' -f $_.Exception.Message)
    $env:FISH_URL = ''
  }
}

$running = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*live2d\desktop*' }
if ($running) {
  Write-Host '[skip] desktop fish already running'
  exit 0
}

Start-Process -FilePath $electron -ArgumentList ('"' + $appDir + '"')
Write-Host '[ok] desktop fish launched'
