# Сборка готового приложения в папку dist\
# Нужен .NET 8 SDK. Запуск: pwsh .\build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$running = Get-Process AniimoChecklist -ErrorAction SilentlyContinue
if ($running) { $running | Stop-Process -Force; $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
if (Test-Path dist) { Remove-Item dist -Recurse -Force }

dotnet publish AniimoChecklist.csproj -c Release -r win-x64 --self-contained false -o dist -p:DebugType=none
if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась" }

Write-Host ""
Write-Host "Готово: $PSScriptRoot\dist\AniimoChecklist.exe" -ForegroundColor Green
