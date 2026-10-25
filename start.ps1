# Запуск проекта на Windows после перезагрузки.
# Docker Desktop иногда не стартует из-за «зависших» сокет-файлов прошлой сессии
# (%LOCALAPPDATA%\Docker\run и %LOCALAPPDATA%\docker-secrets-engine). Их нельзя удалить,
# но можно отодвинуть папку в сторону — Docker создаст новую.
# Запуск: правый клик → «Выполнить с помощью PowerShell» или  powershell -ExecutionPolicy Bypass -File start.ps1

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

function Test-Docker {
    docker version --format '{{.Server.Version}}' 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

if (-not (Test-Docker)) {
    Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    foreach ($dir in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
        if ((Test-Path $dir) -and -not (Get-Process 'com.docker.backend' -ErrorAction SilentlyContinue)) {
            Rename-Item -LiteralPath $dir -NewName ((Split-Path $dir -Leaf) + ".stale-$stamp") -ErrorAction SilentlyContinue
            Write-Host "Старые сокеты Docker отодвинуты: $dir"
        }
    }
    Write-Host 'Запускаю Docker Desktop...'
    Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    for ($i = 0; $i -lt 60 -and -not (Test-Docker); $i++) { Start-Sleep -Seconds 3 }
    if (-not (Test-Docker)) {
        Write-Host 'Docker не запустился. Посмотрите %LOCALAPPDATA%\Docker\backend.error.json'
        exit 1
    }
}

docker compose up -d
Write-Host ''
Write-Host 'Готово: http://localhost:8080'
