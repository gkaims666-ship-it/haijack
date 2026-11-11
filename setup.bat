@echo off
rem haijack - установка на Windows (cmd / PowerShell / Windows Terminal)
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo === haijack: установка ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js не найден.
  echo     Установите LTS-версию: https://nodejs.org  или  winget install OpenJS.NodeJS.LTS
  echo     Затем откройте НОВОЕ окно терминала и запустите setup.bat снова.
  goto :fail
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo [x] Нужен Node.js 18.17 или новее. Сейчас:
  node --version
  goto :fail
)
echo [ok] Node.js
node --version

rem Зависимостей нет - npm install не требует интернета. Ставим глобальную команду lcc.
call npm install -g . --no-audit --no-fund
if errorlevel 1 (
  echo [!] Глобальная установка не удалась. Можно запускать без неё:
  echo     node "%~dp0bin\lcc.js"
) else (
  echo [ok] Команда lcc установлена
)

rem Папка конфигурации и шаблон .env
if not exist "%USERPROFILE%\.lcc" mkdir "%USERPROFILE%\.lcc"
if not exist "%USERPROFILE%\.lcc\.env" (
  copy /y ".env.example" "%USERPROFILE%\.lcc\.env" >nul
  echo [ok] Создан %USERPROFILE%\.lcc\.env - впишите туда ANTHROPIC_API_KEY
  echo      ^(или просто запустите lcc - ключ будет запрошен при первом запуске^)
)

call node "%~dp0bin\lcc.js" --version >nul 2>nul
if errorlevel 1 goto :fail

echo.
echo Готово. Откройте папку проекта и запустите:
echo     cd C:\путь\к\проекту
echo     lcc
echo.
endlocal
exit /b 0

:fail
echo.
echo Установка не завершена.
endlocal
pause
exit /b 1
