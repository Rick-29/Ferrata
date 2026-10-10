@echo off
rem Double-cliquable. Contourne la politique d'execution PowerShell pour ce script uniquement.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
