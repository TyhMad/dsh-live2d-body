# 发布前自检：扫敏感信息、看有没有不该进仓库的东西
# 用法：powershell -ExecutionPolicy Bypass -File scripts/prepublish-check.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $root

$patterns = @(
  # '<你的旧令牌片段>',        # 需要时自己加
  '\b106\.\d+\.\d+\.\d+\b',    # 公网 IP
  # '<你的 QQ 号>',            # 需要时自己加：把你的 QQ 号写进这一行
  '[A-Za-z]:\\\\GAME',         # 本机路径
  'C:\\\\Users\\\\',
  'root@',
  'ghp_',                      # GitHub token 前缀
  'sk-'                        # 常见 API key 前缀
)

$text = Get-ChildItem -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\\.git\\' -and $_.Name -ne 'prepublish-check.ps1' -and $_.Name -notmatch '\.(png|jpg|jpeg|gif|moc3|webp)$' }

Write-Host '== 1) 敏感字符串 ==' -ForegroundColor Cyan
$hit = 0
foreach ($p in $patterns) {
  $m = $text | Select-String -Pattern $p -AllMatches -ErrorAction SilentlyContinue
  if ($m) {
    $hit++
    Write-Host ("  [!] /{0}/ -> {1} 处" -f $p, ($m | Measure-Object).Count) -ForegroundColor Yellow
    $m | Select-Object -First 3 | ForEach-Object { Write-Host ("      {0}:{1}" -f $_.Path.Replace($root, '.'), $_.LineNumber) }
  }
}
if (-not $hit) { Write-Host '  [ok] 没有命中' -ForegroundColor Green }

Write-Host ''
Write-Host '== 2) 不该进仓库的二进制 ==' -ForegroundColor Cyan
$bad = Get-ChildItem -Recurse -File -Include *.moc3,*.png,*.jpg,*.jpeg,*.m4a,*.wav,*.mp3,*.min.js |
  Where-Object { $_.FullName -notmatch '\\\.git\\' }
if ($bad) {
  $bad | ForEach-Object { Write-Host ("  [!] {0}  ({1:N0} 字节)" -f $_.FullName.Replace($root, '.'), $_.Length) -ForegroundColor Yellow }
  Write-Host '      模型/贴图/音频/vendor 二进制都不该提交（vendor 见 live2d/vendor/README.md）'
} else {
  Write-Host '  [ok] 没有任何模型/贴图/音频二进制' -ForegroundColor Green
}

Write-Host ''
Write-Host '== 3) 体量与文件数 ==' -ForegroundColor Cyan
$all = Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' }
$sum = ($all | Measure-Object -Property Length -Sum).Sum
Write-Host ("  {0} 个文件，共 {1:N0} 字节" -f $all.Count, $sum)

Write-Host ''
Write-Host '== 4) 语法检查 ==' -ForegroundColor Cyan
foreach ($f in @('live2d\body.js', 'live2d\body-server.mjs', 'plugins\body\index.js', 'live2d\desktop\main.js')) {
  if (Test-Path $f) {
    node --check $f 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "  [ok] $f" -ForegroundColor Green } else { Write-Host "  [x] $f" -ForegroundColor Red }
  }
}

Pop-Location
