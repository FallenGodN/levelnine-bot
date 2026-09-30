# LEVEL NINE GYM bot — встановлення на Windows без winget (Node.js і Git напряму з офіційних сайтів).
# Запускається з install.cmd; можна й вручну: powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Continue'  # npm/git пишуть попередження в stderr — це не помилки; перевіряємо коди виходу вручну
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Repo = 'https://github.com/FallenGodN/levelnine-bot.git'
$Dir = 'C:\levelnine-bot'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $here 'src\index.js')) { $Dir = $here }

function Say($t) { Write-Host "  $t" }
function Fail($t) { Write-Host ""; Write-Host "  ПОМИЛКА: $t" -ForegroundColor Red; Write-Host "  Зробіть скріншот цього вікна і надішліть Максиму."; Read-Host "  Enter, щоб закрити" | Out-Null; exit 1 }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd" }
function Have($exe) { Refresh-Path; return [bool](Get-Command $exe -ErrorAction SilentlyContinue) }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host ""; Write-Host "  === LEVEL NINE bot: встановлення ==="; Write-Host ""

# --- Node.js ---
if (-not (Have 'node')) {
  Say '[1/5] Завантажую Node.js (LTS) з nodejs.org...'
  try { $sums = Invoke-RestMethod 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' } catch { Fail "немає доступу до nodejs.org: $($_.Exception.Message)" }
  $msi = ($sums -split "`n" | Where-Object { $_ -match 'node-v[\d\.]+-x64\.msi' } | Select-Object -First 1) -replace '.*\s', ''
  if (-not $msi) { Fail 'не знайшов інсталятор Node.js' }
  $msiPath = Join-Path $env:TEMP $msi
  Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$msi" -OutFile $msiPath
  Say "      Встановлюю $msi (підтвердьте запит Windows, якщо з'явиться)..."
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /passive /norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "msiexec завершився з кодом $($p.ExitCode)" }
  if (-not (Have 'node')) { Fail 'Node.js встановлено, але не знайдено в PATH. Перезапустіть інсталятор.' }
}
Say "[1/5] Node.js: $(node -v)"

# --- Git ---
if (-not (Have 'git')) {
  Say '[2/5] Завантажую Git з git-scm.com...'
  try { $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'levelnine-installer' } } catch { Fail "немає доступу до github.com: $($_.Exception.Message)" }
  $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d\.]+-64-bit\.exe$' } | Select-Object -First 1
  if (-not $asset) { Fail 'не знайшов інсталятор Git' }
  $gitExe = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest $asset.browser_download_url -OutFile $gitExe
  Say "      Встановлюю $($asset.name)..."
  $p = Start-Process $gitExe -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /COMPONENTS="gitlfs" /o:PathOption=Cmd' -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail "інсталятор Git завершився з кодом $($p.ExitCode)" }
  if (-not (Have 'git')) { Fail 'Git встановлено, але не знайдено в PATH. Перезапустіть інсталятор.' }
}
Say "[2/5] Git: $((git --version) -replace 'git version ','')"

# --- код бота ---
if ($Dir -eq $here) {
  Say "[3/5] Використовую цю папку: $Dir"
} elseif (Test-Path (Join-Path $Dir '.git')) {
  Say "[3/5] Оновлюю бота в $Dir (відновлюю всі файли з GitHub)..."
  $p = Start-Process cmd.exe -ArgumentList "/c git -C `"$Dir`" fetch --quiet origin main && git -C `"$Dir`" reset --hard --quiet origin/main" -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ne 0) { Fail 'git fetch/reset не вдався' }
} else {
  Say "[3/5] Завантажую бота в $Dir..."
  $p = Start-Process cmd.exe -ArgumentList "/c git clone --quiet $Repo `"$Dir`"" -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ne 0) { Fail 'git clone не вдався' }
}
Set-Location $Dir
if (-not (Test-Path (Join-Path $Dir 'package.json'))) { Fail "у $Dir немає package.json навіть після відновлення — перевірте антивірус" }

Say '[4/5] Встановлюю залежності (1–2 хв)...'
$ok = $false
$registries = @('https://registry.npmjs.org/', 'https://registry.npmjs.org/', 'https://registry.npmmirror.com/', 'https://registry.npmmirror.com/')
for ($try = 1; $try -le $registries.Count; $try++) {
  if (Test-Path (Join-Path $Dir 'node_modules')) { cmd /c "rmdir /s /q `"$Dir
ode_modules`"" 2>$null | Out-Null }
  $reg = $registries[$try - 1]
  $p = Start-Process cmd.exe -ArgumentList "/c npm install --omit=dev --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=60000 --registry=$reg > npm-install.log 2>&1" -Wait -PassThru -NoNewWindow -WorkingDirectory $Dir
  if ($p.ExitCode -eq 0) { $ok = $true; break }
  $err = (Get-Content (Join-Path $Dir 'npm-install.log') | Where-Object { $_ -match '^npm error' } | Select-Object -First 2) -join ' | '
  Say "      спроба $try ($reg) не вдалася: $err"
  Say '      повторюю через 10 с...'
  Start-Sleep -Seconds 10
}
if (-not $ok) { Fail "npm install не вдався після 4 спроб (див. $Dir
pm-install.log)" }

if (-not (Test-Path '.env')) {
  Write-Host ""
  Say 'Потрібно два значення. Токен беруть у @BotFather, ID власника показує бот на /start.'
  $token = Read-Host '  Токен бота (BOT_TOKEN)'
  $owner = Read-Host '  Telegram ID власника (OWNER_TELEGRAM_ID)'
  $openai = Read-Host '  Ключ OpenAI (Enter — пропустити)'
  @(
    "BOT_TOKEN=$($token.Trim())", "OWNER_TELEGRAM_ID=$($owner.Trim())", "OPENAI_API_KEY=$($openai.Trim())",
    'OPENAI_MODEL=gpt-4.1-mini', 'OPENAI_MONTHLY_LIMIT_USD=10', 'DAILY_REPORT_TIME=22:30', 'BACKUP_TIME=03:30', 'DATA_DIR=./data', 'TZ_NAME=Europe/Kyiv'
  ) | Set-Content -Path '.env' -Encoding ASCII
  Say '.env збережено.'
}

Say '[5/5] Вмикаю автозапуск і запускаю бота...'
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'LevelNineBot.vbs'
@("Set sh = CreateObject(""WScript.Shell"")", "sh.Run ""cmd /c """"$Dir\tools\run-bot.cmd"""""", 0, False") | Set-Content -Path $vbs -Encoding ASCII
& (Join-Path $Dir 'tools\stop-bot.cmd') | Out-Null
Start-Process wscript.exe -ArgumentList '//B', "`"$vbs`""
Start-Sleep -Seconds 10
Write-Host ""
$log = Join-Path $Dir 'bot.log'
if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'працює' -Quiet)) {
  Say "ГОТОВО. Бот працює і стартуватиме сам після кожного ввімкнення комп'ютера."
} else {
  Say "Бот запущений, але ще не відповів. Подивіться bot.log у $Dir через хвилину."
}
Say 'Оновлення підтягуються з GitHub автоматично кожні 10 хвилин.'
Write-Host ""
Read-Host '  Enter, щоб закрити' | Out-Null
