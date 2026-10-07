@echo off
chcp 65001 >nul
title EXBRAM - panel generatora rolek

rem Przejscie do folderu tego pliku (katalog projektu)
cd /d "%~dp0"

rem Sprawdzenie Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [BLAD] Nie znaleziono Node.js w PATH.
  echo Zainstaluj Node.js lub dodaj go do PATH i sprobuj ponownie.
  echo.
  pause
  exit /b 1
)

rem Instalacja zaleznosci przy pierwszym uruchomieniu
if not exist "node_modules" (
  echo Brak node_modules - instaluje zaleznosci ^(npm install^) ...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [BLAD] npm install zakonczylo sie bledem.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem Panel sam wczytuje .env (OPENAI_API_KEY) i otwiera przegladarke.
rem Zamkniecie tego okna wylacza panel.
node panel\server.mjs

echo.
pause
