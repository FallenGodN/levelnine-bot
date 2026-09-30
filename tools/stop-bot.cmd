@echo off
rem Зупинити бота на цьому комп'ютері
for /f "tokens=2 delims=," %%P in ('wmic process where "name='cmd.exe' and commandline like '%%run-bot.cmd%%'" get processid /format:csv ^| findstr /r "[0-9]"') do taskkill /pid %%P /f >nul 2>&1
for /f "tokens=2 delims=," %%P in ('wmic process where "name='node.exe' and commandline like '%%index.js%%'" get processid /format:csv ^| findstr /r "[0-9]"') do taskkill /pid %%P /f >nul 2>&1
echo Бота зупинено.
