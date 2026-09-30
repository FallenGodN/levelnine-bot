@echo off
rem Зупинити бота на цьому комп'ютері (цикл run-bot.cmd і сам node)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-bot.cmd*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*index.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Бота зупинено.
