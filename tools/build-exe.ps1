<#
  只出 exe，不打 NSIS 安装包（AGENTS.md：用户明确要求）。

  为什么要跑 mygo build 而不是裸 `go build`：Windows 任务的图标、DPI 感知清单、
  版本信息都是 MyGo 在编译期生成 .syso 链接进 exe 的（见 mygo 的 winres.go）。
  裸 go build 会让 exe 退回 Go 默认图标 —— 任务栏、资源管理器、Alt+Tab 全变丑。

  MyGo 0.3.7 在 Windows 上没有跳过安装包的开关（nsisCompiler 无条件下载并调用
  makensis），所以只能事后剔除，然后只把 exe 汇总到 build\portable\。

  用法
    bun run build:exe
    powershell -File tools\build-exe.ps1 -KeepInstaller   # 顺便保留安装包
#>
[CmdletBinding()]
param(
    [switch]$KeepInstaller
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # tools\ 的上级 = 仓库根
Set-Location $root

$env:GOPROXY = if ($env:GOPROXY) { $env:GOPROXY } else { 'https://goproxy.cn,direct' }
$env:CGO_ENABLED = '0'                             # 零 CGO 是硬约束（AGENTS.md）

Write-Host "`n--- 前端构建 ---" -ForegroundColor Cyan
& bun run build:web
if ($LASTEXITCODE -ne 0) { throw "前端构建失败（exit $LASTEXITCODE）" }

Write-Host "`n--- mygo build ---" -ForegroundColor Cyan
& mygo build
if ($LASTEXITCODE -ne 0) { throw "mygo build 失败（exit $LASTEXITCODE）" }

$platform = 'windows-amd64'
$src = Join-Path $root "build\$platform"
if (-not (Test-Path $src)) { throw "找不到构建产物 $src" }

# 安装包：默认剔除
$setups = Get-ChildItem $src -Filter '*Setup*.exe' -File -ErrorAction SilentlyContinue
foreach ($setup in $setups) {
    if ($KeepInstaller) {
        Write-Host "保留安装包：$($setup.Name)" -ForegroundColor DarkGray
    }
    else {
        Remove-Item -LiteralPath $setup.FullName -Force
        Write-Host "已剔除安装包：$($setup.Name)" -ForegroundColor DarkGray
    }
}

# 汇总交付目录
$out = Join-Path $root 'build\portable'
if (Test-Path $out) {
    Remove-Item -LiteralPath $out -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $out | Out-Null

Get-ChildItem $src -File | ForEach-Object {
    Copy-Item $_.FullName $out -Force
}

Write-Host "`n--- 产物 ---" -ForegroundColor Green
Get-ChildItem $out -File | ForEach-Object {
    Write-Host ("  {0,-32} {1,8} MB" -f $_.Name, [math]::Round($_.Length / 1MB, 2))
}
Write-Host "`n目录：$out" -ForegroundColor Green