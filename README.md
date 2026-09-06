# EXBRAM — generator Reels

Automatyczny generator pionowych rolek (1080×1920) z materiałów z realizacji
ogrodzeń. AI analizuje zdjęcia i filmy, wybiera ujęcia i układa montaż,
Remotion składa gotowy plik, a na koniec powstaje opis pod Facebooka
i Instagram.

## Szybki start

1. Wrzuć materiały:
   - zdjęcia → `public/media/photos`
   - filmy → `public/media/videos`
2. Ustaw `OPENAI_API_KEY` (zmienna środowiskowa albo plik `.env`)
3. Dwuklik na `make-reel.bat` (albo `node make-reel.mjs`)

Wynik ląduje w `output/` jako para plików ze wspólnym znacznikiem czasu:

```
output/reel-2026-09-06_23-32-45.mp4
output/opis-2026-09-06_23-32-45.txt
```

## Dokumentacja

Pełny opis pipeline'u, logiki kadrowania, reguł montażu i wykrytych pułapek:
**[EXBRAM_generator_reels_podsumowanie.md](EXBRAM_generator_reels_podsumowanie.md)**

## Wymagania

- Node.js 24
- FFmpeg z `libvidstab` (stabilizacja) i `h264_nvenc` (enkoder GPU, NVIDIA)
- Klucz OpenAI

## Stack

Node.js · Remotion 4 + React/TypeScript · FFmpeg · OpenAI `gpt-5-mini`
