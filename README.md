# EXBRAM — generator Reels

Automatyczny generator pionowych rolek (1080×1920) z materiałów z realizacji
ogrodzeń. AI analizuje zdjęcia i filmy, wybiera ujęcia i układa montaż,
Remotion składa gotowy plik, a na koniec powstaje opis pod Facebooka
i Instagram.

## Szybki start

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
```

| Uruchomienie | Co robi |
|---|---|
| `make-reel.bat` | zestawy, które nie mają jeszcze folderu w `output/` |
| `make-reel.bat --wszystko` | wszystkie zestawy od nowa |
| `node make-reel.mjs "kowalski-brama"` | ten jeden zestaw |

## Dokumentacja

Pełny opis pipeline'u, logiki kadrowania, reguł montażu i wykrytych pułapek:
**[EXBRAM_generator_reels_podsumowanie.md](EXBRAM_generator_reels_podsumowanie.md)**

## Wymagania

- Node.js 24
- FFmpeg z `libvidstab` (stabilizacja) i `h264_nvenc` (enkoder GPU, NVIDIA)
- Klucz OpenAI

## Stack

Node.js · Remotion 4 + React/TypeScript · FFmpeg · OpenAI `gpt-5-mini`
