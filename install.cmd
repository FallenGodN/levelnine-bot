@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem ============================================================
rem  LEVEL NINE GYM bot — встановлення на комп'ютер зала (Windows)
rem  Запустіть подвійним кліком. Ставить Node.js і Git (якщо їх нема),
rem  завантажує бота з GitHub, питає токен, вмикає автозапуск.
rem ============================================================
set "REPO=https://github.com/FallenGodN/levelnine-bot.git"
set "DIR=C:\levelnine-bot"
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"

echo.
echo  === LEVEL NINE bot: встановлення ===
echo.

where node >nul 2>&1 || (
  echo  [1/5] Встановлюю Node.js...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent || goto :fail
  set "PATH=%ProgramFiles%\nodejs;!PATH!"
)
where git >nul 2>&1 || (
  echo  [2/5] Встановлюю Git...
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements --silent || goto :fail
  set "PATH=%ProgramFiles%\Git\cmd;!PATH!"
)
where node >nul 2>&1 || (echo  Node.js не знайдено. Перезапустіть цей файл ще раз. & pause & exit /b 1)
where git >nul 2>&1 || (echo  Git не знайдено. Перезапустіть цей файл ще раз. & pause & exit /b 1)

if exist "%~dp0src\index.js" (
  set "DIR=%~dp0"
  set "DIR=!DIR:~0,-1!"
  echo  [3/5] Використовую цю папку: !DIR!
) else if exist "%DIR%\.git" (
  echo  [3/5] Оновлюю бота в %DIR%...
  git -C "%DIR%" pull --ff-only origin main || goto :fail
) else (
  echo  [3/5] Завантажую бота в %DIR%...
  git clone "%REPO%" "%DIR%" || goto :fail
)
cd /d "!DIR!"

echo  [4/5] Встановлюю залежності...
call npm install --omit=dev --no-audit --no-fund || goto :fail

if not exist .env (
  echo.
  echo  Потрібно два значення. Токен беруть у @BotFather, ID власника показує бот на /start.
  set /p BOT_TOKEN="  Токен бота (BOT_TOKEN): "
  set /p OWNER_ID="  Telegram ID власника (OWNER_TELEGRAM_ID): "
  set /p OPENAI_KEY="  Ключ OpenAI (Enter — пропустити): "
  (
    echo BOT_TOKEN=!BOT_TOKEN!
    echo OWNER_TELEGRAM_ID=!OWNER_ID!
    echo OPENAI_API_KEY=!OPENAI_KEY!
    echo OPENAI_MODEL=gpt-4.1-mini
    echo OPENAI_MONTHLY_LIMIT_USD=10
    echo DAILY_REPORT_TIME=22:30
    echo BACKUP_TIME=03:30
    echo DATA_DIR=./data
    echo TZ_NAME=Europe/Kyiv
  ) > .env
  echo  .env збережено.
)

echo  [5/5] Вмикаю автозапуск і запускаю бота...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
(
  echo Set sh = CreateObject^("WScript.Shell"^)
  echo sh.Run "cmd /c ""!DIR!\tools\run-bot.cmd""", 0, False
) > "%STARTUP%\LevelNineBot.vbs"
call "!DIR!\tools\stop-bot.cmd" >nul 2>&1
wscript.exe //B "%STARTUP%\LevelNineBot.vbs"
timeout /t 8 /nobreak >nul
echo.
findstr /c:"працює" bot.log >nul 2>&1 && (
  echo  ГОТОВО. Бот працює і стартуватиме сам після кожного ввімкнення комп'ютера.
) || (
  echo  Бот запущений, але ще не відповів. Подивіться bot.log у !DIR! через хвилину.
)
echo  Оновлення підтягуються з GitHub автоматично кожні 10 хвилин.
echo.
pause
exit /b 0

:fail
echo.
echo  ПОМИЛКА. Зробіть скріншот цього вікна і надішліть Максиму.
pause
exit /b 1
