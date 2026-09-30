@echo off
rem LEVEL NINE bot: запуск із автоперезапуском і автооновленням. Не закривайте це вікно (воно приховане).
cd /d "%~dp0.."
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"
:loop
for %%A in (bot.log) do if %%~zA gtr 5000000 move /y bot.log bot.log.old >nul 2>&1
if exist .git (
  git pull --ff-only --quiet origin main >> bot.log 2>&1
  git diff --quiet HEAD@{1} HEAD -- package-lock.json 2>nul || call npm install --omit=dev --no-audit --no-fund >> bot.log 2>&1
)
node src\index.js >> bot.log 2>&1
echo [%date% %time%] bot exited, restarting in 5 s >> bot.log
timeout /t 5 /nobreak >nul
goto loop
