# EXBRAM — generator Reels

Automatyczny generator pionowych rolek (1080×1920) z materiałów z realizacji
ogrodzeń. AI analizuje zdjęcia i filmy, wybiera ujęcia i układa montaż,
Remotion składa gotowy plik, a na koniec powstaje opis pod Facebooka
i Instagram.

## Panel w przeglądarce (najprościej)

Dwuklik na **`panel.bat`** — otwiera się panel pod `http://localhost:4321`
(działa tylko na tym komputerze). W panelu:

- **Nowy zestaw** + przeciągnięcie zdjęć i filmów jednej realizacji,
- **Generuj rolkę** z podglądem kroków i logu na żywo,
- **Wyniki**: odtwarzacz, okładka, opis z przyciskiem „Kopiuj”, lista danych
  do uzupełnienia, poprzednie wersje,
- **Napisy i opis**: poprawki hooka, plansz, okładki i opisu, potem
  **Zapisz i renderuj** — nowa wersja bez kosztów AI,
- **Brief copywritera** — edycja instrukcji dla AI.

Zamknięcie okna `panel.bat` wyłącza panel.

## Szybki start (bez panelu)

1. Utwórz folder zestawu w `public/media/` i wrzuć do niego materiały
   **jednej realizacji** — zdjęcia i filmy razem, bez rozdzielania:

```
public/media/
├── kowalski-brama/
│   ├── IMG_5394.mov
│   ├── IMG_5395.jpg
│   └── IMG_5396.jpg
└── nowak-2026-09/
```

2. Ustaw `OPENAI_API_KEY` (zmienna środowiskowa albo plik `.env`)
3. Dwuklik na `make-reel.bat`

Jeden folder = jedna realizacja = jedna rolka. Wynik trafia do folderu
o tej samej nazwie:

```
output/kowalski-brama/reel-2026-09-06_23-32-45.mp4
output/kowalski-brama/opis-2026-09-06_23-32-45.txt
output/kowalski-brama/okladka-2026-09-06_23-32-45.jpg
```

| Uruchomienie | Co robi |
|---|---|
| `make-reel.bat` | zestawy, które nie mają jeszcze folderu w `output/` |
| `make-reel.bat --wszystko` | wszystkie zestawy od nowa |
| `node make-reel.mjs "kowalski-brama"` | ten jeden zestaw |
| `node make-reel.mjs "kowalski-brama" --tylko-render` | ponowny render z zapisanego planu (np. po poprawce napisów), bez AI |

## Na innym komputerze

1. Programy (PowerShell): `winget install OpenJS.NodeJS`,
   `winget install Git.Git`, `winget install Gyan.FFmpeg` — potem nowy terminal.
2. Kod: `git clone https://github.com/marvin822/rolki-exbram.git`
3. Ręcznie skopiuj (nie ma ich w gicie): `.env` z kluczem OpenAI (bezpiecznie,
   nie mailem), `public/music/*.mp3`, opcjonalnie `work/text-history.json`.
4. Dwuklik `panel.bat` — pierwsze uruchomienie samo zrobi `npm install`,
   pierwszy render pobierze przeglądarkę Remotion (~100 MB).

Bez karty NVIDIA filmy przerabia procesor (wolniej, ale działa). Potrzebny
jest internet (OpenAI, czcionka napisów). Aktualizacje: `git pull`.

## Dokumentacja

Pełny opis pipeline'u, logiki kadrowania, reguł montażu i wykrytych pułapek:
**[EXBRAM_generator_reels_podsumowanie.md](EXBRAM_generator_reels_podsumowanie.md)**

## Wymagania

- Node.js 24
- FFmpeg z `libvidstab` (stabilizacja) i `h264_nvenc` (enkoder GPU, NVIDIA)
- Klucz OpenAI

## Stack

Node.js · Remotion 4 + React/TypeScript · FFmpeg · OpenAI `gpt-5-mini`
