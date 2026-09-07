@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title EXBRAM - generator rolki (make-reel)

rem Przejscie do folderu tego pliku (katalog projektu)
cd /d "%~dp0"

echo ========================================
echo  EXBRAM - generator rolki
echo ========================================
echo  Katalog projektu: %cd%
echo.
echo  Wrzuc materialy przed uruchomieniem:
echo    public\media\^<nazwa zestawu^>\  - zdjecia i filmy razem
echo.
echo  Jeden folder = jedna realizacja = jedna rolka.
echo  Wynik trafia do output\^<nazwa zestawu^>\
echo.
echo  Bez argumentow: tylko zestawy bez gotowej rolki.
echo  --wszystko: przerabia rowniez te, ktore juz maja rolke.
echo.

rem Wczytanie zmiennych z pliku .env (jesli istnieje), np. OPENAI_API_KEY
if exist ".env" (
  echo Wczytuje .env ...
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    set "%%a=%%b"
  )
  echo.
)

rem Sprawdzenie Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [BLAD] Nie znaleziono Node.js w PATH.
  echo Zainstaluj Node.js lub dodaj go do PATH i sprobuj ponownie.
  echo.
  pause
  exit /b 1
)

rem Sprawdzenie klucza OpenAI
if "%OPENAI_API_KEY%"=="" (
  echo [BLAD] Brak zmiennej OPENAI_API_KEY.
  echo Ustaw ja w zmiennych srodowiskowych Windows
  echo albo utworz plik .env obok tego pliku z linia:
  echo     OPENAI_API_KEY=sk-...
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

echo Start: %date% %time%
echo ----------------------------------------
echo.

node make-reel.mjs %*
set "EXITCODE=%errorlevel%"

echo.
echo ========================================
if "%EXITCODE%"=="0" (
  echo  GOTOWE - pliki w folderach output\^<nazwa zestawu^>\
) else (
  echo  BLAD - co najmniej jeden zestaw sie nie udal ^(kod %EXITCODE%^)
  echo  Szczegoly w PODSUMOWANIU wyzej.
)
echo ========================================
echo.
pause
exit /b %EXITCODE%
