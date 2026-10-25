# sync-deps.ps1 —— SfW 运行环境依赖同步（真源 = 主仓 Sublimation）
#
# 处理器脚本与标准库由编译器按 CWD 相对路径装载（BuiltinProcessors.DEFAULT_DIR =
# File("annotation processer")、脚本 stdlibDir = File("core")），因此「从 SfW 仓根
# 运行 compile」要求仓根同时可见这两者。本脚本从主仓把 core 同步到本地：
#
#   <主仓>/core                  -> ./core/      处理器脚本的标准库（CWD 可见；本地副本，不入库）
#                                 -> ./app/core/ 编译输入目录的 core 副本（入库；随主仓更新）
#
# QuickJS 运行时（quickjs-emscripten-core / @jitl/* 变体）已 vender 在
# wasm-app/vendor/quickjs/node_modules 下（随仓入库），不在本脚本范围。
#
# 用法：
#   pwsh scripts/sync-deps.ps1                                   # 自动探测主仓
#   pwsh scripts/sync-deps.ps1 -MainRepo D:path	oSublimation   # 显式指定
#   $env:SUBLIMATION_REPO = "D:path	oSublimation"; pwsh scripts/sync-deps.ps1

param(
    [string] $MainRepo = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Find-MainRepo {
    param([string] $Hint)
    $candidates = @()
    if ($Hint) { $candidates += $Hint }
    if ($env:SUBLIMATION_REPO) { $candidates += $env:SUBLIMATION_REPO }
    $candidates += @(
        "F:KotlinProject\Sublimation",
        "F:\KotlinProject\sublimation",
        (Join-Path (Split-Path -Parent (Split-Path -Parent $repoRoot)) "KotlinProject\Sublimation")
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c "annotation processer\android.subs")) -and
            (Test-Path (Join-Path $c "core\logic\logic.subl"))) {
            return $c
        }
    }
    return $null
}

$main = Find-MainRepo -Hint $MainRepo
if (-not $main) {
    Write-Error "找不到主仓 Sublimation（需同时含 annotation processer\android.subs 与 core\logic\logic.subl）。用法：pwsh scripts/sync-deps.ps1 -MainRepo <主仓路径>；或设环境变量 SUBLIMATION_REPO=<主仓路径>"
    exit 1
}
Write-Host "[sync-deps] 主仓（真源）：$main"

function Sync-Tree($src, $dst) {
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item (Join-Path $src "*") $dst -Recurse -Force
    Write-Host "[sync-deps] $src -> $dst"
}

Sync-Tree (Join-Path $main "core") (Join-Path $repoRoot "core")
Sync-Tree (Join-Path $main "core") (Join-Path $repoRoot "app\core")

Write-Host "[sync-deps] 完成"
