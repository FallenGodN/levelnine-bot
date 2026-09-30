@echo off
rem LEVEL NINE GYM bot: встановлення. Уся логіка в install.ps1 (без winget, з офіційних сайтів).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  rem запущено з %TEMP% без install.ps1 поруч — тягнемо його з GitHub
  curl -sL -o "%TEMP%\install.ps1" https://raw.githubusercontent.com/FallenGodN/levelnine-bot/main/install.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\install.ps1"
)
