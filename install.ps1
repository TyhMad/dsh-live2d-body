# 安装：把插件放进 DSH、起服务、可选开桌面窗口
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshRoot "C:\path\to\dsh"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshRoot ... -ModelDir "D:\models\xxx"
param(
  [Parameter(Mandatory = $true)][string]$DshRoot,
  [string]$ModelDir = '',
  [switch]$NoDesktop
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $DshRoot)) { throw "DSH 目录不存在：$DshRoot" }

$pluginDir = Join-Path $DshRoot 'plugins\body'
$liveDir = Join-Path $DshRoot 'live2d'

New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
New-Item -ItemType Directory -Force -Path $liveDir | Out-Null

Copy-Item (Join-Path $here 'plugins\body\*') $pluginDir -Force
Copy-Item (Join-Path $here 'live2d\body.js') $liveDir -Force
Copy-Item (Join-Path $here 'live2d\body-server.mjs') $liveDir -Force
Copy-Item (Join-Path $here 'live2d\index.html') $liveDir -Force
Copy-Item (Join-Path $here 'live2d\vocab.json') $liveDir -Force
Copy-Item (Join-Path $here 'live2d\lexicon.json') $liveDir -Force
Copy-Item (Join-Path $here 'live2d\launch-desktop.ps1') $liveDir -Force
New-Item -ItemType Directory -Force -Path (Join-Path $liveDir 'desktop') | Out-Null
Copy-Item (Join-Path $here 'live2d\desktop\*') (Join-Path $liveDir 'desktop') -Force

Write-Host "[ok] 插件 -> $pluginDir"
Write-Host "[ok] 渲染 -> $liveDir"

if ($ModelDir) {
  if (-not (Test-Path $ModelDir)) { throw "模型目录不存在：$ModelDir" }
  $env:LIVE2D_MODEL_DIR = $ModelDir
  Write-Host "[ok] 本次进程内已设 LIVE2D_MODEL_DIR=$ModelDir"
  Write-Host "     要长期生效：setx LIVE2D_MODEL_DIR \"$ModelDir\""
}

Write-Host ''
Write-Host '下一步：'
Write-Host "  1) 起服务：node `"$(Join-Path $liveDir 'body-server.mjs')`""
Write-Host '  2) 打开  http://127.0.0.1:17901/'
if (-not $NoDesktop) {
  Write-Host "  3) 桌面窗口：powershell -ExecutionPolicy Bypass -File `"$(Join-Path $liveDir 'launch-desktop.ps1')`""
}
Write-Host '  4) 重启 DSH，让插件加载；工具的 baseUrl 在 plugins\body\plugin.json 里改'
