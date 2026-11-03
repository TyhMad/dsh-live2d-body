# 拉 vendor 依赖（PIXI + pixi-live2d-display 的 cubism4 运行时而）
# Cubism Core 需要你自己从 Live2D 官网下载（许可原因，本仓库不分发）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path (Split-Path -Parent $here) 'live2d\vendor'
New-Item -ItemType Directory -Force -Path $dst | Out-Null

$mirror = 'https://registry.npmmirror.com'

function Get-Pkg($name, $version, $file, $out) {
  $tgz = Join-Path $env:TEMP ("$($name -replace '[\/]', '_')-$version.tgz")
  $url = "$mirror/$name/-/$version.tgz"
  Write-Host "[get] $name@$version"
  Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing
  $dir = Join-Path $env:TEMP ("x-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  tar -xzf $tgz -C $dir
  $src = Join-Path $dir "package\$file"
  if (-not (Test-Path $src)) { throw "包里没有 $file（$name@$version）" }
  Copy-Item $src (Join-Path $dst $out) -Force
  Remove-Item -Recurse -Force $dir
  Write-Host "  -> $out"
}

Get-Pkg 'pixi.js' '6.5.10' 'dist\pixi.min.js' 'pixi.min.js'
Get-Pkg 'pixi-live2d-display' '0.4.0' 'dist\cubism4.min.js' 'cubism4.min.js'

$core = Join-Path $dst 'live2dcubismcore.min.js'
if (Test-Path $core) {
  Write-Host "[ok] Cubism Core 已存在：$core"
} else {
  Write-Host ''
  Write-Host '[需要你手动一步] Cubism Core（Live2D 专有，本仓库不分发）' -ForegroundColor Yellow
  Write-Host '  1) 打开 https://www.live2d.com/sdk/cubism/ 下载 Cubism SDK for Web'
  Write-Host "  2) 把 Core\live2dcubismcore.min.js 复制到：$core"
  Write-Host '  3) 同意并按 Live2D 的许可使用（个人/小规模通常免费，商用看条款）'
}

Get-ChildItem $dst -File | Select-Object Name, Length | Format-Table -AutoSize
