# EXBRAM — generator rolek: przekazanie kontekstu (napisy na ekranie)

Dokument do wklejenia w nowy czat. Zawiera stan projektu, historię problemu
z napisami i zadanie do wykonania.

---

## 1. Czym jest projekt

Automatyczny generator pionowych rolek (1080×1920) na Instagram/Facebook dla
producenta ogrodzeń EXBRAM. Wrzucasz zdjęcia i filmy z realizacji, pipeline
sam analizuje materiał, układa montaż, pisze napisy na ekran, renderuje film,
robi okładkę i opis posta.

- Katalog roboczy: `C:\claude\dev-gpt`
- Repo: https://github.com/marvin822/rolki-exbram (remote nazywa się `rolki-exbram`)
- Stack: Node.js 24 (ESM, `.mjs`), Remotion 4.0.520 + React/TypeScript, FFmpeg, OpenAI
- System: Windows 11, NVIDIA RTX 3060 Laptop

### Materiały i wynik

```
public/media/<nazwa zestawu>/   ← zdjęcia i filmy RAZEM, jeden folder = jedna realizacja
output/<nazwa zestawu>/         ← reel-<stamp>.mp4, opis-<stamp>.txt, okladka-<stamp>.jpg
```

Nazwa zestawu jedzie do kroków zmienną środowiskową `REEL_SET` (nie argumentem —
nazwy folderów mają spacje). Stan per zestaw leży w `work/<zestaw>/`.

Uruchomienie: `make-reel.bat` (dwuklik, bierze zestawy bez gotowej rolki),
`--wszystko` (wszystkie), `node make-reel.mjs "nazwa zestawu"` (jeden).

---

## 2. Kroki pipeline'u

| # | Skrypt | Co robi |
|---|---|---|
| 1 | `extract-video-frames.mjs` | 20 klatek przeglądowych na film |
| 2 | `analyze-video.mjs` | ocena filmów (OpenAI) |
| 3 | `analyze-video-detail.mjs` | wybór precyzyjnych fragmentów (OpenAI) |
| 4 | `analyze-image.mjs` | analiza zdjęć + **plan montażu** `edit.json` (OpenAI) |
| 5 | **`write-copy.mjs`** | **napisy na ekran, okładka, opis** (OpenAI) ← tu jest problem |
| 6 | `normalize-videos.mjs` | stabilizacja + skala (FFmpeg) |
| 7 | `measure-grade.mjs` | pomiar ujęć i korekcja koloru |
| 8 | `select-music.mjs` | losowanie podkładu z rotacją |
| 9 | Remotion | render `src/Composition.tsx` |
| 10 | `generate-description.mjs` | zapasowa ścieżka opisu |

Pliki stanu w korzeniu: `analysis.json`, `video-analysis.json`, `edit.json`,
`music.json`, `grade.json`. Remotion importuje je statycznie, więc muszą tam
leżeć w chwili renderu.

### Jak działa copywriter (`write-copy.mjs`, 1250 linii)

- Model: `const COPY_MODEL = process.env.REEL_COPY_MODEL || "gpt-5"`
  (przełącznik dodany dzisiaj — `REEL_COPY_MODEL=gpt-6.1-sol node write-copy.mjs`)
- **Jedyną instrukcją treści jest brief** `exbram-rolki-instrukcje-agenta.md`
  (2003 linie), wczytywany z dysku przy każdym przebiegu i wklejany do promptu
  w całości. Kod dokłada tylko to, czego brief nie może wiedzieć: jak działa
  montaż, co jest na planszy końcowej i w jakim formacie oddać wynik (JSON schema).
- Copywriter **ogląda** ujęcia rolki (podglądy obrazów) plus jedno ujęcie
  kontekstowe z domem.
- Generuje **3 warianty** napisów pod różnymi kątami. Kod sprawdza każdy
  mechanicznie (limity słów/znaków, zakazane wzorce, emoji, placeholdery,
  liczby spoza faktów) i przy uwagach zawraca do modelu, maks. `MAX_ATTEMPTS`.
- Zużycie: ~15–16 tys. tokenów na rolkę (licznik dodany dzisiaj, drukuje się
  na końcu kroku). Większość wejścia to brief + obrazy.

---

## 3. Problem: napisy są złe. Trzy odrzucone podejścia

Właściciel odrzucił kolejno trzy rodzaje napisów. Każdy błąd ma inną przyczynę
i wszystkie trzy są dziś opisane w briefie (sekcja 16) — ale problem nie został
rozwiązany.

### Błąd 1 — oczywistość podana jak osiągnięcie

> „Jeden motyw w bramie i furtce"

Komentarz właściciela: *„przecież to jest oczywiste, nie ma innej możliwości
żeby zmieniać motyw w bramie i furtce, nie możemy tego pisać bo to jest śmieszne"*

### Błąd 2 — prawda bez wartości

> „Dopracowany detal, równe łączenia"

Komentarz: *„może i jest prawdziwe ale nie brzmi marketingowo"*.
Równe łączenia to minimum poprawnego montażu, nie argument sprzedażowy.

### Błąd 3 — kryterium, którego klient nie ma

> „Szukasz ogrodzenia do domu ze spadzistym dachem?"
> „Ciemny kolor nawiązuje do dachu"

Komentarz: *„ludzie nie dobierają ogrodzenia do spadzistego dachu, do żadnego
dachu"*, *„ludzie nie dobierają ogrodzenia do dachu, a już na pewno nie trzeba
tego pisać"*.

Napis jest prawdziwy i widać to na zdjęciu — ale opisuje zależność, której
nikt nie bierze pod uwagę, kupując ogrodzenie. To obserwacja osoby
analizującej fotografię, nie myśl osoby planującej ogrodzenie.

Po tym właściciel napisał: *„nie wiem już jak mam poprawić te napisy.
cały czas jest źle."*

---

## 4. Ustalenia techniczne (ważne dla kolejnego kroku)

### a) Dach wszedł UPSTREAM, nie w copywriterze

`analyze-image.mjs` (krok 4, montażysta) zapisuje w `edit.json` pole `story`.
W ostatnim przebiegu brzmiało ono:

> „(…) spójna linia bramy i przęseł **dopasowana do domu z grafitowym dachem**,
> ażurowe wypełnienie porządkuje front i nie zamyka widoku."

Copywriter dostaje `story` jako wejście i tylko wzmocnił to, co już tam było.
Naprawianie samego copywritera nie wystarczy.

### b) O wyborze wariantu decyduje KOLEJNOŚĆ, nie jakość

```js
const cleanIndex = stored.findIndex((item) => item.problems.length === 0);
```

Do rolki trafia **pierwszy wariant bez usterki mechanicznej**. Kontrola liczy
słowa i znaki — nie odróżnia dobrego napisu od śmiesznego. W dwóch kolejnych
przebiegach najlepszy merytorycznie był wariant 3, a do rolki szedł wariant 1.
Prompt prosi „najlepszą jako pierwszą", ale model tego nie dotrzymuje.

Zaproponowano **redaktora**: osobne, tanie wywołanie (sam tekst, bez obrazów,
~1–2 tys. tokenów), które dostaje 3 warianty i wybiera jeden z uzasadnieniem.
Właściciel zaakceptował pomysł, ale **najpierw chce zmienić brief**.

### c) Limity w kodzie muszą zgadzać się z briefem

Sprawdzone renderem (nie z komentarza w kodzie, który kłamał):
- hook 2 linie ≈ 42 znaki przy 66 px; **9 słów ≈ 57 znaków = TRZY linie**
  (wygląda dobrze, mieści się w gradiencie)
- plansza: 2 linie ≈ 45 znaków przy 54 px

Aktualne stałe: `HOOK_WORDS = [4, 9]`, `HOOK_MAX_CHARS = 60`,
`MESSAGE_MAX_WORDS = 8`, `MESSAGE_MAX_CHARS = 56`, `MESSAGES_RANGE = [1, 3]`
(liczba plansz PO hooku), `COVER_MAX_WORDS = 4`.

**Jeżeli zmienisz regułę w briefie, sprawdź odpowiadającą jej stałą w kodzie** —
rozjazd powoduje, że walidacja odbija teksty, które brief każe pisać.

### d) Ten konkretny zestaw ma niski sufit

Zestaw testowy `public/media/5/` to 10 niemal identycznych zdjęć jednego
przęsła (pionowe lamele + ozdobny pas z greckim motywem, ciemna stal,
murowane słupki). Bez filmu. Analiza opisuje za każdym razem to samo.
Uczciwie jest tu jedna rzecz do powiedzenia: ozdobne, ale ażurowe.
Dlatego wszystkie warianty krążą wokół tego samego.

### e) Render na GPU

`--gl=angle` skraca render o ~35% (26 s → 17 s na 150 klatkach) przy
praktycznie identycznym obrazie (średnia różnica piksela 1,5/255).
`--hardware-acceleration=if-possible` (NVENC) **nie opłaca się** — zero zysku
czasu i siedmiokrotny spadek bitrate'u. Flaga nie jest jeszcze dodana do
`make-reel.mjs` (wywołanie renderu ok. linii 791).

---

## 5. Stan repozytorium

HEAD: `5b6631f` „Build reels around a story and let the copywriter see the footage"

**Niezacommitowane zmiany** (zrobione dzisiaj, przed zmianą kierunku):

- `exbram-rolki-instrukcje-agenta.md` — scalono nowe instrukcje właściciela:
  przepisane sekcje 10–16 (hook 4–9 słów, „nie wymuszaj liczby plansz",
  „czyste ujęcie bez napisu też pełni funkcję", tabela ujęcie→kierunek,
  trzy błędy z testami), sekcja 6.3 zamieniona z listy rzeczowników na zdania,
  które klient wypowiada, wzmocniony zakaz zmyślania, CTA dobierane do celu,
  lista kontrolna.
- `write-copy.mjs` — `REEL_COPY_MODEL`, licznik tokenów, limity hooka,
  `MESSAGES_RANGE = [1, 3]`, poprawiony punkt 4 promptu (zakaz dopasowywania
  do pojedynczych elementów budynku).
- Pliki stanu (`analysis.json`, `edit.json`, `grade.json`, `music.json`,
  `video-analysis.json`) — wynik ostatniego przebiegu na zestawie `5`.

**Uwaga:** część tych zmian zostanie unieważniona przez nowe polecenie poniżej
(punkt 4 nowego podejścia odwraca regułę „czyste ujęcie bez napisu").

---

## 6. ZADANIE — nowe podejście do napisów

Polecenie właściciela, dosłownie:

> teraz napisy będziemy tworzyć inaczej:
>
> 1. ma początku przeglądmy wszystkie materiały które są wrzucone, poprzez
>    zapytanie do api ustalamy w jakim stylu jest ogrodzenie, jaki ma kolor,
>    czy jest nowoczesne, czy klasyczne itd, czy jest brama, furtka, czy jest
>    mur, jaki kolor muru, nowoczesny mur?
>
> 2. tworzony jest scenariusz
>
> 3. na podstawie scenariusza tworzymy kilka napisów mogą być ogólne, ale
>    związane ze stylem ogrodzenia, na podstawie scenariusza, nie trzymamy się
>    sztywno tego co na zdjęciu/filmie.
>
> 4. nowy napis dodajemy przy każdym nowym ujęciu
>
> 5. chce aby napisy tyczyły się ogordzenia, ale też jeden napis pod koniec był
>    w stylu: też chcesz takie ogrodzenie? skontaktuj się z nami! => i ostatnia
>    plansza z CTA
>
> 6. nie zagłebiajmy się za bardzo w to co jest na zdjęciu i szukaniu powiązań,
>    to ma być ogólne, ale hasła muszą być chwytliwe, celem jest zatrzymanie
>    użytkownika, ale hasła nie mogą być dziwne
>
> zastąp poprzedni brief tym co napisałem

Kolejność prac ustalona z właścicielem: **najpierw brief, potem redaktor.**

### Co z tego wynika

Nowe podejście jest wewnętrznie spójne i stanowi odpowiedź na trzy błędy wyżej:
wszystkie brały się z wymuszania konkretnej wypowiedzi o konkretnym ujęciu.
Punkt 6 mówi: przestań szukać powiązań w kadrze.

Zmiany kierunku, których trzeba być świadomym:
- punkt 4 (napis przy każdym ujęciu) **odwraca** dopiero co dodaną regułę
  „czyste ujęcie bez napisu też pełni funkcję" — i stałą `MESSAGES_RANGE`
  oraz regułę w prompcie „najwyżej jedna scena z rzędu bez napisu"
- punkt 6 **odwraca** regułę „każdy napis odpowiada ujęciu"
- punkty 1 i 2 wymagają zmian w kodzie, nie tylko w briefie:
  - etap 1 (profil realizacji: styl, kolor, nowoczesne/klasyczne, brama,
    furtka, mur, kolor muru) powinien zastąpić dzisiejsze pole `story`
    generowane w `analyze-image.mjs` — to ono wprowadziło dach
  - etap 2 (scenariusz) odpowiada dzisiejszemu polu `analysis`
    (`atut`/`potrzeba`/`efekt`/`dlaczego`) w schemacie `write-copy.mjs`,
    ale framing „potrzeba/efekt" jest właśnie tym, co generowało
    wymyślone kryteria

### Do rozstrzygnięcia przy pisaniu briefu

Brief zawiera sekcje **faktyczne**, których model nie może wymyślić i których
pipeline potrzebuje — zachowaj je:

- **sekcja 4: Fakty o EXBRAM** (adres Trzebina 51e, 26-340 Drzewica; montaż
  w całej Polsce; 20 lat; „nawet 3–4 tygodnie"; projekt→produkcja→montaż;
  na wymiar; style ogrodzeń; produkty; usługi: CNC, gięcie, malowanie
  proszkowe, piaskowanie, cynkowanie ogniowe; zabezpieczenie: ocynk +
  proszek; ceny orientacyjne: panel 73–168 zł, brama połówkowa od 3 500 zł,
  brama przesuwna od 5 075 zł, furtka od 1 000 zł; kontakt: 502 492 009,
  www.exbram.pl, biuro@exbram.pl)
- **sekcja 29: Opis rolki** (pierwsza linia do ~120 znaków jako drugi hook,
  2–4 krótkie linie rozwinięcia, CTA, 3–5 hashtagów)
- **sekcja 30: SEO** (naturalne frazy: ogrodzenie nowoczesne, palisadowe,
  żaluzjowe, brama przesuwna, furtka, panelowe 3D)
- **sekcja 31: Okładka** (maks. 4 słowa, komunikuje temat albo efekt)

Pipeline wymaga od modelu kompletu: `hook`, `messages`, `cover`, `description`
(`firstLine`, `body`, `hashtags`), `missing`. Format wyjścia definiuje JSON
schema w kodzie — brief nie powinien narzucać własnego formatu odpowiedzi.

Plansza końcowa jest renderowana automatycznie po ostatniej scenie i zawiera
logo, „Ogrodzenia, które robią różnicę", CTA, telefon i adres strony. Napisy
na ekranie **nie** mogą zawierać telefonu, e-maila ani adresu www.
