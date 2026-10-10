# Ferrata - lance l'environnement de dev (Windows / PowerShell).
# Ouvre deux fenetres : le backend (http://localhost:8787) et l'extension en mode dev
# (rechargement automatique a chaque sauvegarde). Fermer une fenetre arrete le service.
# Usage : scripts\dev.cmd   (ou)   powershell -File scripts\dev.ps1 [-SkipBackend]
# Lance scripts\setup.cmd d'abord si ce n'est pas deja fait.

param(
  [switch]$SkipBackend,
  # Simulated data (FakeBridge) instead of the backend.
  [switch]$Fake
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Frontend = Join-Path $Root 'frontend'
$Backend = Join-Path $Root 'backend'

if (-not (Test-Path (Join-Path $Frontend 'node_modules'))) {
  Write-Host "Dependances absentes : lance d'abord scripts\setup.cmd" -ForegroundColor Red
  exit 1
}

if (-not $SkipBackend) {
  if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Start-Process powershell -WorkingDirectory $Backend -ArgumentList @(
      '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Ferrata backend'; cargo run -p sq-services"
    )
    Write-Host 'Backend : nouvelle fenetre, http://localhost:8787' -ForegroundColor Cyan
  } else {
    Write-Host "Rust (cargo) absent : backend non lance, l'extension utilise des donnees simulees." -ForegroundColor Yellow
    $Fake = $true
  }
}

$bridge = if ($Fake) { 'fake' } else { 'real' }
Start-Process powershell -WorkingDirectory $Frontend -ArgumentList @(
  '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Ferrata extension'; `$env:VITE_BRIDGE = '$bridge'; npm run dev -w packages/extension"
)
Write-Host "Donnees : $(if ($bridge -eq 'fake') { 'simulees' } else { 'backend reel' })" -ForegroundColor Cyan
Write-Host 'Extension : nouvelle fenetre (serveur de dev Vite).' -ForegroundColor Cyan
Write-Host @"

Quand la fenetre de l'extension affiche "CRXJS: Load dist as unpacked extension" :
  chrome://extensions -> bouton de rechargement sur Swissquote Wallet.
(Premiere fois : "Charger l'extension non empaquetee" -> frontend\packages\extension\dist)
"@ -ForegroundColor Green
