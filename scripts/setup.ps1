# Ferrata - installation complete (Windows / PowerShell).
# A relancer apres chaque `git pull` : installe les dependances, construit l'extension,
# compile le backend. Usage : scripts\setup.cmd   (ou)   powershell -File scripts\setup.ps1 [-SkipBackend]
# Messages volontairement sans accents : PowerShell 5.1 lit les scripts en ANSI.

param(
  [switch]$SkipBackend,
  # Builds the extension on simulated data (FakeBridge): no backend needed.
  [switch]$Fake
)

$ErrorActionPreference = 'Stop'
$MinNodeMajor = 22
$DevServerPort = 5173
$Root = Split-Path -Parent $PSScriptRoot
$Frontend = Join-Path $Root 'frontend'
$Backend = Join-Path $Root 'backend'
$Dist = Join-Path $Frontend 'packages\extension\dist'

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "`nERREUR : $Message" -ForegroundColor Red; exit 1 }

function Invoke-Checked([string]$Label, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { Fail "$Label a echoue (code $LASTEXITCODE). Lis les messages ci-dessus." }
}

Step 'Verification des outils'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js n'est pas installe. Installe la version LTS ($MinNodeMajor ou plus) depuis https://nodejs.org puis relance."
}
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt $MinNodeMajor) {
  Fail "Node.js $(node --version) est trop ancien. Il faut la version $MinNodeMajor ou plus (https://nodejs.org)."
}
Write-Host "Node.js $(node --version) OK"

# Windows locks files in use: npm ci cannot replace node_modules while the dev server runs,
# and cargo cannot overwrite a running sq-services.exe ("Acces refuse (os error 5)").
if (Get-NetTCPConnection -LocalPort $DevServerPort -State Listen -ErrorAction SilentlyContinue) {
  Fail "Le serveur de dev de l'extension tourne (fenetre 'Ferrata extension', port $DevServerPort). Ferme-le puis relance le setup."
}
if (-not $SkipBackend -and (Get-Process sq-services -ErrorAction SilentlyContinue)) {
  Fail "Le backend tourne deja (fenetre 'Ferrata backend' ou un autre terminal). Ferme-le puis relance le setup, ou utilise -SkipBackend."
}

$hasCargo = [bool](Get-Command cargo -ErrorAction SilentlyContinue)
if (-not $SkipBackend -and -not $hasCargo) {
  Write-Host "Rust (cargo) absent : le backend ne sera pas compile. Installe-le depuis https://rustup.rs si tu en as besoin." -ForegroundColor Yellow
}

Step 'Installation des dependances du frontend (npm ci)'
Push-Location $Frontend
try {
  # npm ci suit exactement package-lock.json : tout le monde a les memes versions.
  Invoke-Checked 'npm ci' { npm ci --no-audit --no-fund }

  # Without the backend the real bridge has nothing to talk to: fall back to simulated data.
  $useFake = $Fake -or -not $hasCargo
  $env:VITE_BRIDGE = if ($useFake) { 'fake' } else { 'real' }
  Step "Construction de l'extension (donnees : $(if ($useFake) { 'simulees' } else { 'backend reel' }))"
  Invoke-Checked 'Le build de l extension' { npm run build -w packages/extension }
} finally {
  Pop-Location
}

if (-not $SkipBackend -and $hasCargo) {
  Step 'Compilation du backend (la premiere fois peut prendre quelques minutes)'
  Push-Location $Backend
  try {
    Invoke-Checked 'cargo build' { cargo build -p sq-services }
  } finally {
    Pop-Location
  }
}

Step 'Termine'
Write-Host @"
Extension prete dans :
  $Dist

Pour l'ajouter a Chrome (une seule fois) :
  1. Ouvre chrome://extensions
  2. Active le Mode developpeur (en haut a droite)
  3. Charger l'extension non empaquetee -> choisis le dossier ci-dessus
Apres un nouveau setup : clique sur le bouton de rechargement de l'extension.

Pour developper (backend + rechargement automatique) : scripts\dev.cmd
Connexion de demo : alice / demo
Donnees : $(if ($env:VITE_BRIDGE -eq 'fake') { "SIMULEES (pas de backend)" } else { "backend reel : lance scripts\dev.cmd ou 'cargo run -p sq-services' dans backend\" })
"@ -ForegroundColor Green
