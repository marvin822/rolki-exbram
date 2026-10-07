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

### Panel w przeglądarce

`panel.bat` uruchamia `panel/server.mjs` — lokalny serwer bez zależności
(sam Node), słuchający wyłącznie na `127.0.0.1:4321` i odrzucający zapytania
z innym nagłówkiem Host. Panel tworzy zestawy, przyjmuje pliki (strumieniowo,
przez plik tymczasowy, tylko zdjęcia i filmy), uruchamia `make-reel.mjs`
dokładnie jak `.bat` i przesyła kroki oraz log na żywo (Server-Sent Events).
Jednocześnie działa jedno zadanie — kroki dzielą pliki stanu w korzeniu.

Zakładka „Napisy i opis” pokazuje 3 wersje napisów od copywritera — „Użyj
i renderuj” przełącza rolkę na wybraną wersję (render bez AI, ok. minuty).
Edytor napisów zmienia w `work/<zestaw>/edit.json` WYŁĄCZNIE teksty (hook,
plansze, wyróżnienia, okładka, opis) — kolejność scen, pliki i czasy zostają
z planu. Potem `--tylko-render`.

### Tryb --tylko-render

`node make-reel.mjs "<zestaw>" --tylko-render` renderuje rolkę z zapisanego
planu bez analizy AI i bez copywritera: przywraca stan zestawu, normalizuje
filmy tylko wtedy, gdy w `public/processed` brakuje filmów tego zestawu,
mierzy korektę kolorów i bierze **ten sam podkład** co poprzednio
(`work/<zestaw>/music.json`, zapisywany po każdym pełnym przebiegu) — więc
cięcia w rytm się nie zmieniają. Opis składa się z tekstów zapisanych w planie.

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

`public/media/` i `public/music/` są w `.gitignore` — materiał realizacji
i licencjonowane podkłady trzymamy lokalnie, poza repozytorium. Pusty (albo
nieistniejący) folder z muzyką oznacza rolkę bez podkładu, nie błąd.

## 3. Wynik

```
output/
└── kowalski-brama/
    ├── reel-RRRR-MM-DD_GG-MM-SS.mp4
    ├── opis-RRRR-MM-DD_GG-MM-SS.txt
    └── okladka-RRRR-MM-DD_GG-MM-SS.jpg
```

Folder wyjściowy nazywa się tak samo jak źródłowy. Każdy przebieg dokłada nowy
komplet plików ze wspólnym znacznikiem czasu — nic nie jest nadpisywane.

Okładka to pierwsza scena z tekstem okładki od copywritera (kompozycja `Cover`) — do ustawienia
ręcznie przy publikacji. Jej błąd nie zatrzymuje pipeline'u.

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
| 4 | `analyze-image.mjs` | zdjęcia → `analysis.json`; planer (`gpt-5`, **ogląda podglądy**) układa historię i dobiera ujęcia → `edit.json` (sceny z rolą i opisem) |
| 4a | `write-copy.mjs` | plan + **podglądy scen** + brief → 3 wersje napisów, okładki i opisu; pierwsza poprawna trafia do rolki |
| 5 | `normalize-videos.mjs` | filmy → `public/processed/*.mp4` (stabilizacja + skala + 30 fps, bez dźwięku) |
| 5a | `measure-grade.mjs` | pomiar jasności i nasycenia każdej sceny → `grade.json` (korekta kolorów per scena) |
| 6 | `select-music.mjs` | `public/music/` → `music.json` (utwór + wykryte tempo i pierwsze uderzenie) |
| 7 | Remotion | `edit.json` + `analysis.json` + `video-analysis.json` + `music.json` → rolka |
| 7a | FFmpeg `loudnorm` (w `make-reel.mjs`) | głośność → -14 LUFS, obraz kopiowany → `output/reel-*.mp4` |
| 7b | Remotion `still Cover` | → `output/okladka-*.jpg` |
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
- Długość: **10–25 s całej rolki**, zależnie od ilości mocnego materiału
  (2–3 mocne ujęcia → ok. 7–11 s materiału, 4–5 → 12–16 s, dużo albo proces →
  17–21 s). Nie wydłużamy na siłę — krótka rolka częściej jest oglądana do końca.
  Kod zdejmuje sceny ponad 21 s materiału (od przedostatniej), bo dociąganie
  cięć do rytmu dokłada kilka klatek.
- 3–7 scen; zdjęcia 3–4 s (mocne do 4,5 s), fragmenty wideo 4–5 s.
- **Najpierw historia, potem ujęcia.** Planer (`gpt-5`) dostaje podglądy
  WSZYSTKICH materiałów (`media-preview.mjs`: zdjęcia 512 px z obrotem
  z EXIF, z filmu — klatka ze środka fragmentu) i układa rolkę jak historię
  z sekcji 14 briefu. Każda scena ma rolę: `hook` (najmocniejsze ujęcie),
  `dom` (ogrodzenie razem z domem — obowiązkowe, gdy takie ujęcie jest),
  `korzysc`, `detal`, `final`, oraz opis `shows` po polsku z punktu
  widzenia klienta (styl domu, gęstość lameli…). Do tego `story` (atut
  realizacji) i `contextFile` — zdjęcie całej realizacji z domem.
  Wcześniej planer otwierał ujęciem „najwięcej metalu w kadrze”, więc domu
  w rolce prawie nie było, a brief sprzedaje efekt dla domu.
- Fragmenty wideo: planer dostaje tylko **2 najlepiej ocenione** z każdego filmu
  i wyłącznie te z `qualityScore ≥ 0.8`.
- **Napisy, okładkę i opis** pisze osobny krok `write-copy.mjs` („copywriter”,
  `gpt-5`), PO ułożeniu montażu, i **ogląda** podglądy scen oraz ujęcie całej
  realizacji z domem. Jedyną instrukcją treści jest **brief właściciela
  [exbram-rolki-instrukcje-agenta.md](exbram-rolki-instrukcje-agenta.md)**,
  wczytywany przy każdym przebiegu. Kod dokłada tylko to, czego brief nie
  wie: rolka jest zmontowana, plansze zmieniają się z cięciem, po ostatniej
  scenie wchodzi plansza z telefonem i stroną (więc ostatnia plansza może być
  miękkim CTA, ale bez kontaktu), na ekranie nie ma `[UZUPEŁNIJ]` ani emoji,
  wynik w JSON zamiast formatu z sekcji 34.
- Copywriter pisze **3 wersje** pod różnymi kątami (sekcja 8 briefu), najlepszą
  pierwszą. Każda: hook (scena 1), 2–5 plansz po 1–3 scenach z wyróżnieniem,
  okładka, opis, braki. Do rolki idzie pierwsza wersja bez uwag kontroli;
  pozostałe są w `edit.json` (`copy.variants`) i w panelu — zmiana wersji
  to render bez AI.
- **Kontrola w kodzie:** liczba słów i znaków (plansza ≤ 56 znaków — dwie
  linie), czas czytania (0,3 s/słowo + 0,5 s, min. 1,5 s), zakazane wzorce
  z sekcji 12, 21 i 32 briefu, fałszywe obietnice (cisza, hałas, wiatr —
  lamele są ażurowe), pytanie bez „?”, sztuczne trójki, wersaliki,
  placeholdery, emoji i kontakt na planszach, **liczby spoza faktów**
  (sekcja „Fakty o EXBRAM”) i opisów scen, powtórzony hook. Przy uwagach
  wersje wracają do modelu z ich listą — najwyżej 3 próby. Tekst nie jest
  ucinany tuż za limitem (urywało zdania); twardy sufit to 80 znaków.
  Strzałki (→) zamieniane na półpauzę — Montserrat ich nie ma.
- **Pamięć hooków:** `work/text-history.json` (lokalnie, wspólne dla zestawów).
  Blokowany jest tylko hook IDENTYCZNY z jednym z 12 ostatnich — szersza
  blokada (parafrazy, tematy) odcinała dobre hooki z briefu i pchała model
  w udziwnienia. Usunięcie pliku czyści pamięć.
- **Serie zdjęć:** zdjęcia zrobione w odstępie ≤ 4 s (`takenAt`) to prawie ten
  sam kadr. Kod nie pozwala postawić ich obok siebie — przenosi drugie dalej
  (bez ruszania zakończenia), a gdy się nie da, pomija je.

## 8. Ruch, dźwięk, plansza

- Zdjęcia dostają delikatny zoom lub panoramę; dystans skaluje się z długością
  ujęcia, żeby dłuższe przytrzymanie nie wyglądało na zamrożone.
- Przejścia: `fade`, 6 klatek między scenami, 12 klatek na planszę końcową
  (wyłania się z ostatniej sceny zamiast wskakiwać cięciem).
- **Cięcia w rytm:** `select-music.mjs` wykrywa tempo i pierwsze uderzenie
  podkładu, a kompozycja przesuwa każde cięcie tak, żeby środek przejścia
  wypadł na beat. Zmiana długości sceny: maks. -0,5 s / +0,5 s (zdjęcie)
  lub +0,2 s (wideo). Przy niewyraźnym rytmie (`beat: null`) nic się nie
  przesuwa.
- Filmy są **bez dźwięku** (`-an` przy normalizacji + `muted`). Ścieżkę niesie
  losowany podkład z `public/music/` — z fade in/out i rotacją, żeby kolejne
  rolki nie dostawały tego samego utworu. Po renderze głośność jest wyrównywana
  do -14 LUFS (bez tego rolka miała ok. -27 LUFS).
- **Napisy** stoją u góry pasa z treścią — w strefie bezpiecznej Instagrama
  i Facebooka (górne ~14% i dolne ~35% kadru zasłania interfejs). Hook: biały,
  Montserrat 800, czerwona belka w kolorze logo, przyciemnienie góry kadru.
  Hasła: ciemna etykieta z czerwoną krawędzią w stałym miejscu kadru, osobna
  warstwa nad scenami — stoi przez całe ujęcia i przejścia, a nie miga przy
  każdym cięciu. Rozmyte pasy zostają czyste.
- **Znak wodny** w lewym dolnym rogu pasa — prawą krawędź zajmuje kolumna
  przycisków. Jedna wersja rolki pasuje do obu platform.
- Plansza końcowa = **jedyne CTA rolki**: 3,5 s, logo, „Ogrodzenia, które robią
  różnicę", „DARMOWA WYCENA" + telefon, `www.exbram.pl` (tylko strona główna, bez linków do podstron) — wszystko powyżej 62%
  wysokości kadru, żeby nie wchodziło pod opis rolki.
- **Korekta kolorów per scena:** `measure-grade.mjs` mierzy FFmpegiem (`signalstats`)
  rozpiętość jasności (10.–90. percentyl), średnią jasność i nasycenie każdego
  ujęcia i liczy filtr sprowadzający je do wspólnego wzorca — płaskie i ciemne
  kadry dostają więcej, dobre prawie nic. Bezpieczniki: kontrast 1,00–1,16,
  jasność 0,95–1,12 i nie wyżej, niż pozwala niebo, łączne nasycenie ±6%
  (antracyt nie może zniebieszczeć). Filmy: jedna korekta na fragment,
  uśredniona z 4 klatek, żeby nie migotało. Wzorzec i progi to stałe na górze
  skryptu. Scena bez pomiaru dostaje `DEFAULT_GRADE` z kompozycji. Tło, logo
  i napisy są poza filtrem.
- Render w przestrzeni barw `bt709` (`yuv420p`, zakres ograniczony) — przy
  domyślnej wychodził `yuvj420p`, który Meta potrafi przekodować z przesunięciem
  kontrastu.

## 9. Opis do rolki

`output/opis-*.txt` pisze copywriter według sekcji 5 briefu, a
`generate-description.mjs` tylko składa plik (bez drugiego zapytania do AI):

1. **Pierwsza linia** — drugi hook, do ~120 znaków (widać ją przed „…więcej”)
2. **2–4 krótkie akapity konkretów** — styl, produkt, materiał, dla kogo
3. **CTA** — doklejane w kodzie: „Darmowa wycena: 502 492 009 lub
   www.exbram.pl”
4. **Hasztagi** — 3–5 tematycznych od modelu + `#exbram` na końcu
5. **DO UZUPEŁNIENIA** — dane, których copywriter nie mógł znać (RAL, wymiary,
   lokalizacja), pod wyraźną kreską: do uzupełnienia albo usunięcia przed
   publikacją

Gdy copywriter nie zadziałał, `generate-description.mjs` pisze opis sam
(stara ścieżka, `gpt-5-mini`).

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

- Windows, Node.js 24, FFmpeg z `libvidstab` (gyan.dev „full”)
- Enkoder filmów: karta NVIDIA (`h264_nvenc`), a bez niej procesor (`libx264`) —
  wybór automatyczny przez próbne kodowanie; `REEL_ENCODER=cpu|nvenc` wymusza
- Remotion 4 + React/TypeScript; OpenAI: `gpt-5` (planer, copywriter),
  `gpt-5-mini` (analiza kadrów, filmów, zapasowy opis)
- Ścieżki są względne (`process.cwd()`) — projekt nie jest przywiązany do dysku

## 12. Otwarte

- **Wdrożenie na NAS** (Xpenology, Intel N97): enkoder sam przełączy się na
  `libx264`, gdy nie ma karty NVIDIA. Uwaga: DSM 7 stoi na kernelu 4.4,
  więc QuickSync na Alder Lake-N nie zadziała. Wąskim gardłem i tak jest render
  Remotion, który liczy się na CPU.
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
