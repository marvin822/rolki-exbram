# EXBRAM — generator Reels

Automatyczny generator pionowych rolek (1080×1920) z materiałów z realizacji.
Fotograf wrzuca zdjęcia i filmy, AI analizuje materiał, wybiera ujęcia, ustala
montaż, a Remotion składa gotowy plik razem z opisem pod Facebooka i Instagram.

---

## 1. Uruchomienie

**Windows, dwuklik:** `make-reel.bat`

Sprawdza Node i `OPENAI_API_KEY`, przy pierwszym uruchomieniu robi `npm install`,
odpala pipeline i zostawia otwarty terminal, żeby było widać przebieg.

**Z konsoli:**

```bash
node make-reel.mjs
```

| Flaga / zmienna | Działanie |
|---|---|
| `"nazwa zestawu"` | przerabia ten jeden zestaw, nawet jeśli ma już rolkę |
| `--wszystko` (`--all`) | przerabia wszystkie zestawy, także te z gotową rolką |
| `--skip-opis` (`--bez-opisu`) | pomija generowanie opisu |
| `REEL_STABILIZE=0` | wyłącza stabilizację obrazu (oszczędza jeden przebieg dekodowania) |
| `REEL_SET` | nazwa zestawu; ustawia ją `make-reel.mjs`, ręcznie tylko przy uruchamianiu pojedynczego kroku |
| `OPENAI_API_KEY` | wymagany; zmienna środowiskowa albo plik `.env` obok `make-reel.bat` |

Bez argumentów przerabiane są **tylko zestawy bez folderu w `output/`**. Powtórka
nie jest darmowa — cache ma wyłącznie analiza zdjęć, a analiza filmów, opis,
stabilizacja i render lecą od nowa.

## 2. Materiały wejściowe

**Zestaw = podfolder `public/media/` = jedna realizacja = jedna rolka.**
Zdjęcia i filmy leżą w nim razem; rozdziela je wyłącznie rozszerzenie pliku.

```
public/
├── media/
│   ├── kowalski-brama/   ← zdjęcia + filmy jednej realizacji
│   │   ├── IMG_5394.mov
│   │   └── IMG_5395.jpg
│   └── nowak-2026-09/
├── music/                ← podkłady .mp3 (losowane)
├── others/               ← logo planszy końcowej i znak wodny
└── processed/            ← znormalizowane filmy (generowane)
```

Nazwy zestawów mogą zawierać spacje i polskie znaki — nazwa jedzie do kroków
zmienną `REEL_SET`, nie argumentem, więc powłoka jej nie rozbije.

Luźne pliki wrzucone prosto do `public/media/` nie należą do żadnego zestawu.
Pipeline wypisuje je jako pominięte, zamiast po cichu ignorować.

AI analizuje **wyłącznie** zawartość folderu zestawu. Logo i muzyka leżą osobno,
żeby nie trafiły do montażu jako zwykła scena.

`public/media/` jest w `.gitignore` — materiał per realizacja trzymamy lokalnie.

## 3. Wynik

```
output/
└── kowalski-brama/
    ├── reel-RRRR-MM-DD_GG-MM-SS.mp4
    └── opis-RRRR-MM-DD_GG-MM-SS.txt
```

Folder wyjściowy nazywa się tak samo jak źródłowy. Każdy przebieg dokłada nową
parę plików ze wspólnym znacznikiem czasu — nic nie jest nadpisywane.

## 3a. Stan między zestawami

Kroki pipeline'u gadają przez `analysis.json`, `video-analysis.json` i
`edit.json` w korzeniu projektu, bo Remotion importuje je statycznie i musi je
tam zastać w chwili renderu.

Przy wielu zestawach te pliki są jednocześnie cache'em, więc `make-reel.mjs`
przed każdym zestawem wczytuje jego stan z `work/<zestaw>/`, a po analizie
zapisuje go z powrotem. Bez tego przetworzenie zestawu B kasowałoby analizę
zestawu A — [analyze-image.mjs](analyze-image.mjs) przebudowuje `analysis.json`
wyłącznie z plików obecnych w bieżącym folderze.

Zestaw bez zapisanego stanu dostaje wyzerowane pliki, żeby nie odziedziczyć
danych poprzednika. `work/` jest w `.gitignore`.

Zestawy lecą **po kolei, nigdy równolegle** — dzielą te pliki oraz katalogi
`video-frames/` i `public/processed/`, które są czyszczone przed każdym zestawem.
Błąd jednego zestawu nie przerywa reszty; podsumowanie na końcu mówi, co się
udało, a kod wyjścia jest niezerowy, gdy cokolwiek padło.

---

## 4. Pipeline

| # | Krok | Wejście → wyjście |
|---|---|---|
| 1 | `extract-video-frames.mjs` | 20 klatek przeglądowych na film → `video-frames/` |
| 2 | `analyze-video.mjs` | klatki → `video-analysis.json` (ocena całego filmu) |
| 3 | `analyze-video-detail.mjs` | do 4 kandydatów → 12 klatek szczegółowych każdy → precyzyjne fragmenty w `video-analysis.json` |
| 4 | `analyze-image.mjs` | zdjęcia → `analysis.json`; zdjęcia + fragmenty → `edit.json` (plan montażu) |
| 5 | `normalize-videos.mjs` | filmy → `public/processed/*.mp4` (stabilizacja + skala + 30 fps, bez dźwięku) |
| 6 | `select-music.mjs` | `public/music/` → `music.json` |
| 7 | Remotion | `edit.json` + `analysis.json` + `video-analysis.json` + `music.json` → `output/reel-*.mp4` |
| 8 | `generate-description.mjs` | te same analizy → `output/opis-*.txt` |

Zestaw bez filmów przechodzi tą samą ścieżką — kroki 1–3 i 5 same się pomijają.
Nie ma osobnego pipeline'u dla zdjęć.

Wspólne rozpoznawanie zestawu i klasyfikacja plików po rozszerzeniu siedzą
w [reel-set.mjs](reel-set.mjs).

---

## 5. Kadrowanie — kluczowa decyzja

Canvas to 1080×1920, ale **materiał nie wypełnia całego kadru**.

```
┌──────────────────────┐
│  rozmyte tło         │   ta sama klatka, cover,
├──────────────────────┤   skala 1.3, blur 45 px,
│                      │   jasność 0.62
│   MATERIAŁ  4:5      │
│   (albo 1:1)         │
│                      │
├──────────────────────┤
│  rozmyte tło         │
└──────────────────────┘
```

**Dlaczego:** ogrodzenia i bramy są szerokie. Kadr 9:16 wycięty ze zdjęcia
poziomego pokazuje 42% jego szerokości i połowę wysokości — i ta połowa prawie
zawsze zawierała drogę albo murek. Żeby metal wypełnił 70% kadru, trzeba by
zoomu ~2,8×, a wtedy w kadrze zostaje jeden słupek zamiast ogrodzenia.

Pas 4:5 zachowuje kompozycję, a puste miejsce wypełnia rozmyta kopia tego samego
ujęcia — bez czarnych pasów i bez jednolitego tła.

`contentAspectRatio` zwraca AI: `4:5` domyślnie, `1:1` gdy ujęcie jest bardzo
szerokie i przycięcie do 4:5 obcięłoby istotny fragment bramy lub przęsła.

---

## 6. Co ocenia AI

**Dla każdego zdjęcia** (`analysis.json`, schemat v5):

| Pole | Znaczenie |
|---|---|
| `subject` | co przedstawia ujęcie |
| `shotType` | `wide` / `context` / `detail` / `macro` |
| `productProminence` | 0–1, jaką część wysokości kadru zajmuje **sam metal** |
| `deadSpace` | 0–1, ile kadru to nie-produkt (murek, kostka, droga, niebo, dach) |
| `focusX` / `focusY` | punkt skupienia — środek metalowych przęseł |
| `recommendedMotion` | `zoomIn` / `zoomOut` / `panLeft` / `panRight` + `motionStrength` |
| `contentAspectRatio` | `4:5` albo `1:1` |
| `takenAt` | data z EXIF — służy do rozpoznania kilku realizacji w folderze |

**Produktem jest wyłącznie metal.** Murek, podmurówka, słupki murowane, kostka,
droga i niebo liczą się jako `deadSpace`, nawet gdy ładnie wyglądają.

**Dla filmów** (`video-analysis.json`): do 4 fragmentów na film z `qualityScore`,
`refinedStart` / `refinedDuration`, `framing`, `focusX/Y`, `contentAspectRatio`.

## 7. Reguły planera

- **Jedna realizacja na rolkę.** Folder zestawu deklaruje ją wprost, ale reguła
  została jako zabezpieczenie: gdy `takenAt` i opisy pokazują kilka posesji,
  planer wybiera jedną i wypisuje pominięte pliki.
- Długość: 17–20 s materiału, cała rolka 20–23 s, nigdy powyżej 25 s.
- 6–8 scen; zdjęcia 3–4 s (mocne do 4,5 s), fragmenty wideo 4–5 s.
- Ranking **względny w obrębie zestawu** — otwarcie i zakończenie to ujęcia
  frontalne o najwyższym `productProminence`, nigdy `wide` ani najsłabsze
  z zestawu. Progi bezwzględne nie działają, bo przy ogrodzeniu na murku
  `deadSpace` jest wysoki dla wszystkich ujęć.
- Fragmenty wideo: planer dostaje tylko **2 najlepiej ocenione** z każdego filmu
  i wyłącznie te z `qualityScore ≥ 0.8`.
- Gdy większość zdjęć ma niski `productProminence`, a są dobre klipy — rolka
  opiera się na wideo.

## 8. Ruch, dźwięk, plansza

- Zdjęcia dostają delikatny zoom lub panoramę; dystans skaluje się z długością
  ujęcia, żeby dłuższe przytrzymanie nie wyglądało na zamrożone.
- Przejścia: `fade`, 15 klatek.
- Filmy są **bez dźwięku** (`-an` przy normalizacji + `muted`). Ścieżkę niesie
  losowany podkład z `public/music/` — z fade in/out i rotacją, żeby kolejne
  rolki nie dostawały tego samego utworu.
- Plansza końcowa: 3 s, logo, „Ogrodzenia, które robią różnicę", `www.exbram.pl`.

## 9. Opis do rolki

`output/opis-*.txt` powstaje z tych samych analiz (bez ponownego oglądania
zdjęć) i ma stałą strukturę:

1. **Hook** — żywe zdanie budujące ciekawość; suche otwarcia typu
   „Prezentujemy…" są zakazane
2. **Konkrety** — 1–2 zdania, 2–3 najbardziej charakterystyczne cechy, tylko to,
   co potwierdza analiza
3. **Korzyść** — co realizacja daje właścicielom
4. **CTA** + dane kontaktowe (doklejane w kodzie, nie przez model)
5. **Hasztagi** — `#ogrodzenia` i `#EXBRAM` na stałe + 3–6 od modelu, limit 7

---

## 10. Pułapki wykryte przy testach

Rzeczy, które łatwo zepsuć ponownie:

- **`OffthreadVideo` pokazuje klatkę `startFrom + frame`.** Dodanie bieżącej
  klatki do `startFrom` sumuje przesunięcie i materiał leci **2× za szybko**.
- **`transformOrigin` nie centruje kadru** — wyznacza tylko punkt stały
  skalowania. Do wyśrodkowania punktu skupienia potrzebny jest jawny
  `translateY` o `-scale * (focus - 0.5)`.
- **`objectPosition` w osi Y nic nie robi** dla zdjęcia poziomego w kadrze
  pionowym — `cover` nie zostawia tam nadmiaru. Kadrowanie pionowe robi
  wyłącznie transform.
- **Ścieżka w opisie filtra FFmpeg nie może zawierać dwukropka** — `C:/...`
  rozwala parser, bo `:` oddziela opcje. Plik `.trf` dla vidstab jest względny.
- **Pełny potok CUDA** (`-hwaccel cuda` + `hwdownload`/`hwupload_cuda`) potrafił
  zawiesić się na 0 klatkach przy HEVC 4K60 z iPhone'a. Dekodowanie jest
  programowe, na GPU zostaje tylko enkoder.
- **Model honoruje EXIF orientation** — zdjęcia pionowe zapisane jako poziome
  z `orientation=6` są analizowane poprawnie, tak samo jak renderuje je Chromium.
- **`ANALYSIS_SCHEMA_VERSION`** — po zmianie pól albo istotnej zmianie promptu
  trzeba go podbić, inaczej cache w `analysis.json` poda stare wyniki.

---

## 11. Środowisko

- Windows, Node.js 24, NVIDIA (NVENC), FFmpeg z `libvidstab`
- Remotion 4 + React/TypeScript, OpenAI `gpt-5-mini`
- Ścieżki są względne (`process.cwd()`) — projekt nie jest przywiązany do dysku

## 12. Otwarte

- **Wdrożenie na NAS** (Xpenology, Intel N97): enkoder jest na sztywno
  `h264_nvenc` — przed przeniesieniem trzeba go wynieść do zmiennej
  środowiskowej z `libx264` jako wariantem. Uwaga: DSM 7 stoi na kernelu 4.4,
  więc QuickSync na Alder Lake-N nie zadziała. Wąskim gardłem i tak jest render
  Remotion, który liczy się na CPU.
- Kilka wariantów jednej rolki i wybór najlepszego.
- Automatyczna publikacja / integracja z n8n.
- **Cache ma tylko analiza zdjęć.** `analyze-video.mjs` i `analyze-video-detail.mjs`
  analizują filmy od zera przy każdym przebiegu, opis też powstaje na nowo.
  Dlatego dwuklik domyślnie pomija zestawy z gotową rolką.

---

## 13. Materiał źródłowy — co działa

Sprawdzone na kilku realizacjach:

- **Najlepiej wychodzą pionowe kadry z bliska**, gdzie metal wypełnia kadr.
  Przy takich ujęciach `productProminence` sięga 0,8.
- **Szerokie ujęcia wzdłuż drogi** dają `productProminence` 0,2–0,35 niezależnie
  od orientacji. Pas 4:5 znacznie je ratuje, ale nie zrobi z nich mocnych scen.
- Jeden folder = jedna realizacja. Wrzucenie dwóch posesji naraz działa
  (planer wybierze jedną), ale marnuje połowę materiału.
