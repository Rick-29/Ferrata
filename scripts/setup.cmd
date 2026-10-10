@echo off
rem Double-cliquable. Contourne la politique d'execution PowerShell pour ce script uniquement.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if errorlevel 1 (
  echo.
  echo Le setup a echoue, voir les messages ci-dessus.
)
pause
