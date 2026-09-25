# Выпуск новой версии: собирает dist, упаковывает в zip и публикует GitHub Release.
# Перед запуском подними <Version> в AniimoChecklist.csproj и запушь изменения.
# Запуск: pwsh .\release.ps1 -Notes "Что нового"
param([Parameter(Mandatory)][string]$Notes)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

[xml]$proj = Get-Content AniimoChecklist.csproj
$version = ($proj.Project.PropertyGroup | Where-Object Version | Select-Object -First 1).Version
if (-not $version) { throw "Не нашёл <Version> в AniimoChecklist.csproj" }

if (git status --porcelain) { throw "Есть незакоммиченные изменения — сначала закоммить и запушь" }

& .\build.ps1

$zip = Join-Path $env:TEMP "AniimoChecklist-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path dist\* -DestinationPath $zip

gh release create "v$version" $zip --title "v$version" --notes $Notes
if ($LASTEXITCODE -ne 0) { throw "Не удалось создать релиз" }
Remove-Item $zip
Write-Host "Релиз v$version опубликован" -ForegroundColor Green
