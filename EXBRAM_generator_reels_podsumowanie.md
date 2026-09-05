# EXBRAM — podsumowanie prac nad generatorem Reels

## 1. Cel projektu

Budujemy automatyczny generator rolek dla EXBRAM.

Docelowy przepływ:

1. Fotograf wrzuca zdjęcia i filmy.
2. AI analizuje materiał.
3. AI wybiera najlepsze zdjęcia i fragmenty filmów.
4. AI ustala kolejność, długość ujęć, sposób kadrowania i punkt skupienia.
5. Filmy są normalizowane przez FFmpeg z wykorzystaniem GPU.
6. Remotion składa materiał w pionowy format 1080×1920.
7. Finalnie `node make-reel.mjs` ma tworzyć:
   `output/reel.mp4`

Stack:
- Node.js
- Remotion + React/TypeScript
- FFmpeg
- OpenAI API
- NVIDIA CUDA / NVDEC / NVENC
- docelowo możliwa dalsza automatyzacja, np. n8n

---

## 2. Środowisko

Aktualne środowisko testowe:

- Windows
- Node.js v24.15.0
- npm 12.0.2
- NVIDIA RTX 3060
- sterownik NVIDIA 616.64
- CUDA UMD 13.4
- działające NVENC

Ustaliliśmy, że projekt nie jest przywiązany do dysku C:. Skrypty korzystają z `process.cwd()`, więc ścieżki są względne względem katalogu projektu.

Projekt znajduje się obecnie w:

`C:\dev-gpt`

---

## 3. Struktura katalogów

Uporządkowaliśmy materiały wejściowe:

```text
public/
├── media/
│   ├── photos/
│   └── videos/
├── music/
│   ├── ciche-godziny.mp3
│   ├── cyfrowa-samotno.mp3
│   └── fresh-start.mp3
├── others/
│   └── logo_duze_bez_tla.png
└── processed/
    ├── 26-07-10 12-36-02 5696.mp4
    ├── 26-08-13 14-08-46 5854.mp4
    ├── 26-08-13 14-10-15 5855.mp4
    ├── 26-08-13 14-10-24 5856.mp4
    └── 26-08-13 14-10-30 5857.mp4
```

Istotna decyzja: AI analizuje wyłącznie:

- `public/media/photos`
- `public/media/videos`

Nie analizuje folderów `music` ani `others`, dzięki czemu logo nie może zostać przypadkowo wybrane jako zwykła scena.

---

## 4. Pipeline

Aktualny pipeline wygląda tak:

```text
extract-video-frames.mjs
        ↓
video-frames/
        ↓
analyze-video.mjs
        ↓
video-analysis.json
        ↓
analyze-video-detail.mjs
        ↓
video-analysis.json
        ↓
analyze-image.mjs
        ↓
edit.json
        ↓
normalize-videos.mjs
        ↓
Remotion
        ↓
output/reel.mp4
```

Główny `make-reel.mjs` uruchamia te etapy po kolei.

---

## 5. Analiza filmów

### `extract-video-frames.mjs`

Skrypt został zmieniony tak, aby szukał filmów w:

`public/media/videos`

Zamiast bezpośrednio w `public/`.

Tworzy klatki overview w:

`video-frames/`

Testowany film:

`26-07-10 12-36-02 5696.mov`

Parametry:
- długość około 38,12 s
- 20 klatek overview
- materiał pochodzi z iPhone'a 13
- źródło 3840×2160
- 60 fps
- HEVC
- materiał wymagał odpowiedniego obrotu podczas normalizacji

---

## 6. Szczegółowa analiza filmu

`analyze-video-detail.mjs` został poprawiony tak, aby również korzystał z:

`public/media/videos`

Skrypt wykonuje analizę wieloetapową:

1. analizuje cały film,
2. wyszukuje potencjalne fragmenty,
3. wybiera kandydatów,
4. wyciąga szczegółowe klatki dla kandydatów,
5. ponownie analizuje kandydatów,
6. precyzyjnie ustala początek i koniec fragmentu,
7. określa `framing`, `focusX`, `focusY`, confidence i uzasadnienie.

Dla testowego filmu AI znalazło 3 dobre fragmenty:

| Fragment | Zakres | Ocena |
|---|---:|---:|
| #1 | 5,20–7,70 s | 0,98 |
| #2 | 13,00–15,50 s | 0,93 |
| #3 | 34,80–37,30 s | 0,97 |

Najlepsze fragmenty dotyczą dekoracyjnego panelu z motywem drzewa i są dobrze przygotowane do pionowego kadrowania 9:16.

Wynik jest zapisywany do:

`video-analysis.json`

---

## 7. Plan montażu AI

`analyze-image.mjs` analizuje zdjęcia oraz dostępne fragmenty filmów i tworzy:

`edit.json`

Podczas ostatniego testu AI stworzyło plan:

1. `26-07-10 12-37-05 5697.jpg` — 2,8 s
2. film, fragment #3 — 2,5 s
3. `26-07-10 12-37-30 5701.jpg` — około 2 s
4. `26-07-10 12-37-36 5702.jpg` — około 2 s
5. film, fragment #2 — 2,5 s
6. `26-07-10 12-38-26 5705.jpg` — około 2 s
7. `26-07-10 12-37-15 5698.jpg` — około 2 s

Kolejność jest logiczna:

**otwarcie → ruch → szeroki kadr → detal → ruch → detal → finał**

AI nie wybrało tego samego fragmentu filmu dwa razy.

---

## 8. Problem z logo — znaleziony i rozwiązany koncepcyjnie

Podczas wcześniejszego renderu pojawił się problem:

- po normalnej części materiałowej pojawiał się czarny ekran,
- następnie duże logo,
- dopiero później właściwa jasna plansza końcowa.

Przyczyną nie był błąd `TransitionSeries`.

AI wcześniej potraktowało plik:

`logo_duze_bez_tla.png`

jako zwykłą scenę.

Rozwiązanie:
- logo zostało przeniesione do `public/others/`,
- `analyze-image.mjs` analizuje tylko `media/photos` i `media/videos`,
- logo nie powinno już trafić do `edit.json`,
- właściwe logo ma być używane wyłącznie przez `EndCard`.

---

## 9. Remotion / Composition

`Composition.tsx` wykorzystuje:

- `TransitionSeries`
- `linearTiming`
- `fade`
- `OffthreadVideo`

`OffthreadVideo` zostało użyte dla płynniejszej obsługi materiału wideo.

Format końcowy:

- 1080×1920
- 30 FPS
- H.264

Zdjęcia mają delikatny ruch:
- zoom in
- zoom out
- pan left
- pan right

Parametry ruchu są pobierane z analizy AI.

Filmy mogą mieć:
- `crop`
- `fit`

oraz punkt skupienia:
- `focusX`
- `focusY`

Plansza końcowa ma:
- jasne tło,
- logo EXBRAM,
- tekst „Ogrodzenia, które robią różnicę”,
- `www.exbram.pl`.

---

## 10. Normalizacja filmów

`normalize-videos.mjs` został dostosowany do nowej struktury:

`public/media/videos`

i zapisuje przygotowane materiały do:

`public/processed`

Normalizacja wykorzystuje GPU i przygotowuje pliki do dalszego renderowania przez Remotion.

Finalne kodowanie H.264 działa szybko; głównym ograniczeniem wydajności pozostaje renderowanie klatek przez Chromium/Remotion.

---

## 11. Ostatni błąd

Pierwszy pełny render po reorganizacji folderów zakończył się utworzeniem:

`output/reel.mp4`

ale w konsoli pojawiły się błędy 404.

Remotion próbował pobierać:

```text
/public/26-07-10 12-37-05 5697.jpg
/public/26-07-10 12-37-30 5701.jpg
/public/26-07-10 12-37-36 5702.jpg
/public/26-07-10 12-38-23 5704.jpg
/public/logo_duze_bez_tla.png
```

Poprawne lokalizacje są natomiast:

```text
/public/media/photos/...
/public/others/logo_duze_bez_tla.png
```

Przyczyna: `Composition.tsx` nadal korzystał ze starych ścieżek.

Przygotowaliśmy poprawioną wersję `Composition.tsx`, w której:
- zdjęcia powinny być pobierane z `media/photos`,
- logo z `others`.

To jest obecny punkt projektu.

---

# Co zostało do zrobienia

## Priorytet 1 — sprawdzić poprawiony render

Podmienić aktualny `Composition.tsx` poprawioną wersją i uruchomić:

```powershell
node .\make-reel.mjs
```

Sprawdzić, czy:
- nie ma żadnych 404,
- zdjęcia są widoczne,
- filmy są widoczne,
- plansza końcowa poprawnie pokazuje logo.

---

## Priorytet 2 — obejrzeć finalną rolkę

Nie wystarczy sprawdzić, czy plik MP4 się utworzył.

Trzeba wizualnie ocenić:
- pierwsze sekundy,
- kadrowanie zdjęć,
- ruch zdjęć,
- przejścia,
- fragmenty filmów,
- płynność,
- momenty cięć,
- końcową planszę,
- ogólną dynamikę,
- czy produkt EXBRAM jest wystarczająco dobrze widoczny.

---

## Priorytet 3 — wyciszenie filmów

Docelowo wszystkie filmy używane w rolce mają być **bez własnego dźwięku**.

Audio z materiałów źródłowych nie powinno konkurować z muzyką.

---

## Priorytet 4 — muzyka

W `public/music/` mamy obecnie:

```text
ciche-godziny.mp3
cyfrowa-samotno.mp3
fresh-start.mp3
```

Docelowo:
- AI lub logika projektu powinna wybrać odpowiednią muzykę,
- jeden utwór ma grać przez całą rolkę,
- muzyka powinna być odpowiednio przycięta/loopowana,
- głośność powinna być ustawiona na bezpiecznym poziomie.

---

## Priorytet 5 — lepsze zarządzanie długością rolki

Obecnie AI ustala długości scen.

Trzeba później ustalić docelowy zakres długości, np.:
- krótka rolka około 12–15 s,
- standardowa około 15–20 s,
- ewentualnie dłuższa wersja.

Możemy również wymusić minimalną/maksymalną długość pojedynczego zdjęcia i filmu.

---

## Priorytet 6 — dopracowanie decyzji AI

Po obejrzeniu kilku rzeczywistych rolek trzeba ocenić, czy AI prawidłowo:
- wybiera najlepsze zdjęcia,
- wybiera właściwe fragmenty filmów,
- unika podobnych ujęć,
- buduje dobre tempo,
- wybiera właściwe zakończenie,
- odpowiednio kadruje produkt w 9:16.

Dopiero po testach warto zmieniać prompty.

---

## Priorytet 7 — obsługa większej liczby filmów

Aktualnie pipeline jest testowany na konkretnym materiale.

Docelowo trzeba sprawdzić:
- kilka filmów,
- różne proporcje obrazu,
- pionowe filmy,
- poziome filmy,
- różne rozdzielczości,
- różne kodeki,
- różne długości materiału.

---

## Priorytet 8 — muzyka, warianty i automatyzacja

Późniejsze możliwości:

- generowanie kilku wersji jednej rolki,
- wybór najlepszego wariantu,
- automatyczny dobór muzyki,
- automatyczne generowanie opisów do Facebooka/Instagrama,
- automatyczne generowanie napisów,
- automatyczny eksport,
- uruchamianie całego procesu po wrzuceniu materiałów,
- integracja z n8n.

---

# Najbliższy krok

**Nie dodajemy jeszcze nowych funkcji.**

Najpierw:

```powershell
node .\make-reel.mjs
```

i sprawdzamy poprawiony `Composition.tsx`.

Jeżeli render będzie bez błędów, przechodzimy do wizualnej oceny rolki. Dopiero potem dodajemy kolejną funkcję.
