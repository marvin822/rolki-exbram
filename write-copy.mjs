import fs from "fs";
import path from "path";
import OpenAI from "openai";

import { makePreview } from "./media-preview.mjs";
import { getSetDir } from "./reel-set.mjs";

/*
 * Copywriter — napisy na ekran, tekst okładki i opis rolki,
 * pisane PO ułożeniu montażu.
 *
 * Jedyną instrukcją treści jest brief właściciela
 * (exbram-rolki-instrukcje-agenta.md), wczytywany przy każdym
 * przebiegu. Kod dokłada tylko to, czego brief nie może wiedzieć:
 * jak działa montaż i plansza końcowa oraz w jakim formacie oddać
 * wynik. Wcześniej te dodatki były długą listą reguł, z których
 * część przeczyła briefowi (np. zakaz CTA na ostatniej planszy) —
 * model zgadywał, czego słuchać.
 *
 * Copywriter OGLĄDA ujęcia rolki i jedno ujęcie całej realizacji
 * z domem. Z samych opisów analizy („metal horizontal-slat fence”)
 * nie dało się ocenić stylu domu, gęstości lameli ani tego, co
 * realizacja daje klientowi — wychodziły ogólniki.
 *
 * Powstają 3 wersje napisów pod różnymi kątami (brief, sekcja 8).
 * Pierwsza poprawna trafia do rolki, pozostałe można wybrać w panelu
 * i przerenderować bez kosztów AI.
 *
 * Kod sprawdza każdą wersję: limity słów i czasu czytania, zakazane
 * wzorce z briefu, liczby spoza faktów, kontakt na planszach
 * (jest na planszy końcowej), placeholdery i emoji na ekranie.
 * Przy uwagach wersje wracają do modelu z ich listą — najwyżej
 * MAX_ATTEMPTS prób. Błąd kroku nie zatrzymuje rolki: powstaje bez
 * napisów, a opis pisze zapasowa ścieżka w generate-description.mjs.
 */

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/*
 * Model copywritera. Da sie podmienic bez ruszania kodu:
 * REEL_COPY_MODEL=gpt-6.1-sol node write-copy.mjs
 */
const COPY_MODEL = process.env.REEL_COPY_MODEL || "gpt-5";

/*
 * Zuzycie tokenow sumowane przez caly krok - copywriter potrafi
 * wykonac kilka prob (MAX_ATTEMPTS), wiec pojedyncze wywolanie
 * niewiele mowi o koszcie.
 */
const usageTotal = {
  calls: 0,
  input: 0,
  cachedInput: 0,
  output: 0,
  reasoning: 0,
};

const recordUsage = (usage) => {
  if (!usage) {
    return;
  }

  usageTotal.calls += 1;
  usageTotal.input += usage.input_tokens ?? 0;
  usageTotal.cachedInput += usage.input_tokens_details?.cached_tokens ?? 0;
  usageTotal.output += usage.output_tokens ?? 0;
  usageTotal.reasoning += usage.output_tokens_details?.reasoning_tokens ?? 0;
};

const reportUsage = () => {
  if (usageTotal.calls === 0) {
    return;
  }

  const n = (value) => value.toLocaleString("pl-PL");

  console.log(
    `\nTokeny (${COPY_MODEL}, ${usageTotal.calls} wywolan): ` +
      `wejscie ${n(usageTotal.input)}` +
      (usageTotal.cachedInput > 0
        ? ` (w tym ${n(usageTotal.cachedInput)} z cache)`
        : "") +
      `, wyjscie ${n(usageTotal.output)}` +
      (usageTotal.reasoning > 0
        ? ` (w tym ${n(usageTotal.reasoning)} rozumowania)`
        : "") +
      `, razem ${n(usageTotal.input + usageTotal.output)}`,
  );
};

const ROOT = process.cwd();

const BRIEF_FILE = path.join(ROOT, "exbram-rolki-instrukcje-agenta.md");

const EDIT_FILE = path.join(ROOT, "edit.json");

const ANALYSIS_FILE = path.join(ROOT, "analysis.json");

const VIDEO_ANALYSIS_FILE = path.join(ROOT, "video-analysis.json");

/*
 * Pamięć hooków z poprzednich rolek — lokalnie, poza gitem, wspólna
 * dla zestawów. Blokujemy tylko IDENTYCZNE hooki: dobre, sprawdzone
 * sformułowania z briefu („Chcesz więcej prywatności?”) mogą wracać,
 * byle nie słowo w słowo w kolejnych rolkach. Szersza blokada
 * (parafrazy, całe tematy) pchała model w udziwnienia.
 */
const TEXT_HISTORY_FILE = path.join(ROOT, "work", "text-history.json");

const TEXT_HISTORY_LIMIT = 24;

const HOOK_HISTORY_CHECK = 12;

/*
 * Limity z briefu (sekcje 10, 15, 31) i z rozmiaru fontu
 * w Composition.tsx (dwie linie tekstu).
 */
const HOOK_WORDS = [4, 9];

/*
 * Sprawdzone renderem: przy 66 px w jednej linii mieści się około
 * 20 znaków, więc dwie linie to ~42 znaki, a dziewięciowyrazowy hook
 * (~57 znaków) zajmuje TRZY linie. Trzy linie wyglądają dobrze —
 * mieszczą się w gradiencie i nie zasłaniają ogrodzenia — więc limit
 * znaków idzie za liczbą słów z briefu, a nie odwrotnie.
 */
const HOOK_MAX_CHARS = 60;

const MESSAGE_MAX_WORDS = 8;

// Plansze lecą 54 px: dwie linie to ~45 znaków, typowe 3-6 słów mieści
// się bez problemu.
const MESSAGE_MAX_CHARS = 56;

/*
 * Twardy sufit — dopiero powyżej niego tekst jest przycinany. Limity
 * wyżej sterują modelem (uwagi kontroli); przycinanie tuż za nimi
 * urywało zdania w połowie ("Zapytaj o" bez "wycenę"), a tekst
 * o kilka znaków dłuższy po prostu zajmie trzecią linię.
 */
const HARD_MAX_CHARS = 80;

/*
 * Liczba plansz PO hooku. Brief (sekcja 13) mówi o 2-4 planszach razem
 * z hookiem i wprost pozwala zostawić ujęcie bez napisu, więc dolna
 * granica to jedna. Wcześniejsze minimum 2 wymuszało co najmniej cztery
 * plansze w rolce i to właśnie produkowało wypełniacze.
 */
const MESSAGES_RANGE = [1, 3];

const MAX_SCENES_PER_MESSAGE = 3;

const COVER_MAX_WORDS = 4;

const MAX_UPPERCASE_WORDS = 3;

const FIRST_LINE_MAX_CHARS = 120;

const DESCRIPTION_CHARS = [200, 700];

const DESCRIPTION_MAX_EMOJI = 3;

// Brief: 3-5 hasztagów razem z #exbram, który dokleja kod.
const HASHTAGS_RANGE = [2, 4];

const VARIANT_COUNT = 3;

const MAX_ATTEMPTS = 3;

/*
 * Musi się zgadzać z planszą końcową (Composition.tsx) i opisem
 * (generate-description.mjs).
 */
const END_CARD = {
  cta: "DARMOWA WYCENA",
  phone: "502 492 009",
  web: "www.exbram.pl",
};

/*
 * Zakazane wzorce — brief, sekcje 12, 21 i 32. Zapisane małymi
 * literami, porównywane z tekstem małymi literami.
 */
const FORBIDDEN_PATTERNS = [
  "zobacz naszą realizację",
  "nowa realizacja",
  "kolejna realizacja",
  "sprawdź naszą ofertę",
  "solidnie i stylowo",
  "solidne i stylowe",
  "piękne ogrodzenie",
  "nowoczesne rozwiązanie dla twojego domu",
  "elegancja i funkcjonalność",
  "elegancja i nowoczesność",
  "styl i funkcjonalność",
  "ogrodzenie z charakterem",
  "najwyższa jakość",
  "najwyższej jakości",
  "perfekcyjn",
  "najlepsze rozwiązanie",
  "idealne połączenie",
  "idealne rozwiązanie",
  "design spotyka",
  "wizytówk",
  "piękno tkwi",
  "w najlepszym wydaniu",
  "robi wrażenie",
  "premium",
  "zobaczcie",
  "w tym filmie",
  "przedstawiamy",
  "prezentujemy",
  "z dumą",
  "czekaj do końca",
  "wyobraź sobie",
  "zwala z nóg",
  "niesamowit",
  "sztos",
  "najlepsze ogrodzenia",
  "najtrwalsze",
  "bezobsługow",
  "najtańsz",
  "najtaniej",
  "bez marży",
  // Tylko strona główna — bez linków do podstron (brief, sekcja 4).
  "kalkulator",
  "exbram.pl/",
];

/*
 * Obietnice, których ogrodzenie nie spełnia — lamele i panele są
 * ażurowe, nie tłumią dźwięku ani wiatru (brief, sekcja 22).
 */
const FALSE_PROMISES = ["cisz", "hałas", "wycisz", "akustyc", "wiatr", "kurz"];

/*
 * Puste słowa architekta — model sięgał po nie, gdy nie miał nic
 * konkretnego do powiedzenia.
 */
const EMPTY_WORDS = ["kompozycj", "harmoni", "rytmik"];

const QUESTION_STARTS = [
  "chcesz",
  "szukasz",
  "planujesz",
  "marzysz",
  "potrzebujesz",
  "myślisz",
  "czy",
  "jak",
  "jaki",
  "jaka",
  "jakie",
  "ile",
  "dlaczego",
  "nie chcesz",
];

const toWords = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^a-ząćęłńóśźż0-9]+/u)
    .filter(Boolean);

const countWords = (text) =>
  String(text)
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

const normalizeForCompare = (text) =>
  toWords(text).join(" ");

/*
 * Liczby w tekście, znormalizowane: "5 075 zł" → "5075",
 * "1,6 m" → "1,6".
 */
const getNumbers = (text) =>
  (String(text).match(/\d[\d\s]*(?:[.,]\d+)?/g) ?? []).map((number) =>
    number.replace(/\s+/g, "").replace(/[.,]$/, ""),
  );

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const readTextHistory = () => {
  const stored = readJson(TEXT_HISTORY_FILE, []);

  return Array.isArray(stored)
    ? stored.filter((item) => typeof item === "string")
    : [];
};

const rememberTexts = (texts) => {
  const merged = [...new Set([...texts, ...readTextHistory()])].slice(
    0,
    TEXT_HISTORY_LIMIT,
  );

  fs.mkdirSync(path.dirname(TEXT_HISTORY_FILE), { recursive: true });

  fs.writeFileSync(
    TEXT_HISTORY_FILE,
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );
};

/*
 * Brief zostawia "!" i "?" (jeden znak), zabrania kropki na końcu.
 */
const cleanText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");

/*
 * Ostatnia deska ratunku, gdy po wszystkich próbach tekst wciąż jest
 * za długi: przycięcie na granicy słowa, żeby zmieścił się w kadrze.
 */
const fitText = (text, maxChars) => {
  if (text.length <= maxChars) {
    return text;
  }

  return text
    .slice(0, maxChars + 1)
    .replace(/\s+\S*$/, "")
    .replace(/[,;:–-]+$/, "");
};

/*
 * Wyróżnienie musi być fragmentem tekstu — inaczej kompozycja nie
 * ma czego pokolorować.
 */
const cleanHighlight = (highlight, text) => {
  const value = cleanText(highlight);

  return value && text.toLowerCase().includes(value.toLowerCase())
    ? value
    : "";
};

const readBrief = () => {
  if (!fs.existsSync(BRIEF_FILE)) {
    throw new Error(`Brak briefu ${BRIEF_FILE}.`);
  }

  return fs.readFileSync(BRIEF_FILE, "utf8");
};

/*
 * Fakty o firmie = sekcja briefu z „Fakty o EXBRAM” w nagłówku, do
 * następnego nagłówka tego samego albo wyższego poziomu. Liczby
 * z niej (ceny, telefon, 20 lat) wolno pokazać; liczby z przykładów
 * w dalszych sekcjach („6-metrowa brama”) już nie.
 */
const getFactsSection = (brief) => {
  const lines = brief.split(/\r?\n/);

  const start = lines.findIndex(
    (line) => /^#{1,6}\s/.test(line) && /fakty o exbram/i.test(line),
  );

  if (start === -1) {
    return "";
  }

  const level = lines[start].match(/^#+/)[0].length;

  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      /^#{1,6}\s/.test(line) &&
      line.match(/^#+/)[0].length <= level,
  );

  return lines.slice(start, end === -1 ? undefined : end).join("\n");
};

/*
 * Sceny rolki dla copywritera: rola w historii, czas i opis od
 * planera (co widać z punktu widzenia klienta), a w razie braku —
 * opis z analizy kadru.
 */
const describeScenes = (scenes) => {
  const photos = readJson(ANALYSIS_FILE, []);

  const videos = readJson(VIDEO_ANALYSIS_FILE, []);

  const fragments = new Map();

  videos.forEach((video) => {
    (video.fragments ?? []).forEach((fragment) => {
      fragments.set(fragment.fragmentId, fragment);
    });
  });

  let elapsed = 0;

  return scenes.map((scene, index) => {
    const from = elapsed;

    elapsed += Number(scene.duration);

    const fallback = scene.fragmentId
      ? String(fragments.get(scene.fragmentId)?.reason ?? "")
      : String(
          photos.find((item) => item.file === scene.file)?.subject ?? "",
        );

    return {
      scene: index + 1,
      type: scene.fragmentId ? "film" : "zdjęcie",
      role: scene.role ?? "",
      time: `${from.toFixed(1)}-${elapsed.toFixed(1)} s`,
      shows: (scene.shows || fallback).slice(0, 400),
    };
  });
};

/*
 * Obrazy dla copywritera: każda scena rolki (dla filmu — środek
 * fragmentu) i ujęcie całej realizacji z domem, jeśli planer je
 * wskazał, a nie ma go w scenach.
 */
const buildScenePreviews = (editPlan) => {
  const setDir = getSetDir(editPlan.set);

  const content = [];

  editPlan.scenes.forEach((scene, index) => {
    const preview = makePreview(
      path.join(setDir, scene.file),
      scene.fragmentId
        ? {
            seekSeconds:
              Number(scene.start ?? 0) + Number(scene.duration ?? 0) / 2,
          }
        : {},
    );

    if (preview) {
      content.push(
        {
          type: "input_text",
          text: `SCENA ${index + 1}`,
        },
        {
          type: "input_image",
          image_url: preview,
          detail: "low",
        },
      );
    }
  });

  const contextFile = editPlan.contextFile;

  if (
    contextFile &&
    !editPlan.scenes.some((scene) => scene.file === contextFile)
  ) {
    const preview = makePreview(path.join(setDir, contextFile));

    if (preview) {
      content.push(
        {
          type: "input_text",
          text: "CAŁA REALIZACJA Z DOMEM (poza montażem — dla kontekstu)",
        },
        {
          type: "input_image",
          image_url: preview,
          detail: "low",
        },
      );
    }
  }

  return content;
};

const buildPrompt = ({ brief, editPlan, sceneList, history, feedback }) => {
  const sceneCount = sceneList.length;

  const total = sceneList.at(-1)?.time?.split("-")[1] ?? "";

  return `${brief}

==========================================================
JAK DZIAŁA TEN MONTAŻ — dopełnienie briefu
==========================================================

Rolka jest JUŻ zmontowana: ${sceneCount} scen, materiał ${total}, potem
3,5 s planszy końcowej. Obrazy scen są poniżej (SCENA 1, 2, …) — oglądaj
je, a opisy scen traktuj jako pomoc. Ujęć ani ich długości nie zmieniasz.

Historia od montażysty: ${editPlan.story || "(brak)"}

SCENY:
${JSON.stringify(sceneList, null, 2)}

Co z tego wynika dla napisów:

1. Hook stoi na scenie 1. Kolejne plansze (messages) obejmują 1-${MAX_SCENES_PER_MESSAGE}
   KOLEJNE sceny (fromScene..toScene, od sceny 2) i zmieniają się z cięciem —
   jedna plansza = jedna myśl o tym, co widać w jej scenach. Od sceny 2 do
   końca najwyżej jedna scena z rzędu bez napisu.

2. Po ostatniej scenie wchodzi automatycznie plansza końcowa: logo,
   "Ogrodzenia, które robią różnicę", "${END_CARD.cta}", tel. ${END_CARD.phone},
   ${END_CARD.web}. Ostatnia plansza tekstowa może więc być miękkim CTA
   z briefu (np. pytanie o podobny efekt) — ale BEZ telefonu, adresu
   strony i e-maila: te są na planszy końcowej.

3. Na ekranie i w okładce nie ma "[UZUPEŁNIJ…]": napisz planszę bez
   brakującej danej, a brak dopisz do "missing". Bez emoji na ekranie
   (font ich nie ma). W opisie też bez placeholderów — braki idą do
   "missing" i trafią pod opis jako lista do uzupełnienia.

4. Możesz pisać, do jakiego DOMU pasuje ten styl — ale na poziomie bryły
   i charakteru ("pasuje do nowoczesnej bryły", "nie przytłacza niskiego
   domu"), nigdy przez zestawienie z pojedynczym elementem budynku.
   Nikt nie dobiera ogrodzenia do dachu, rynien, okien ani kostki na
   podjeździe — patrz brief, sekcja 16, błąd 3.

5. Przygotuj ${VARIANT_COUNT} WERSJE napisów, każdą pod INNYM kątem z sekcji 8
   briefu (np. prywatność / dopasowanie do architektury / inspiracja),
   najlepszą jako pierwszą. Każda wersja to komplet: hook, plansze,
   okładka, opis.

6. hookHighlight / highlight: 1-2 słowa skopiowane DOKŁADNIE z tekstu
   planszy — pokażemy je kolorem akcentu. Może być "".

7. Opis (sekcja 29 briefu): firstLine (do ${FIRST_LINE_MAX_CHARS} znaków), body
   (2-4 krótkie akapity oddzielone \\n\\n), hashtags (${HASHTAGS_RANGE[0]}-${HASHTAGS_RANGE[1]} tematyczne,
   bez "#" i bez "exbram" — dodamy). CTA "Darmowa wycena: ${END_CARD.phone} lub
   ${END_CARD.web}" dokleja kod — nie pisz go w body.

8. Wynik zwróć jako JSON według schematu — zamiast formatu z sekcji 34
   briefu. Analizę z sekcji 34 wpisz w pole analysis.

HOOKI Z POPRZEDNICH ROLEK (nie powtarzaj ich słowo w słowo):
${history.length > 0 ? history.map((text) => `- ${text}`).join("\n") : "(brak)"}
${feedback ? `\nPOPRZEDNIA PROPOZYCJA MIAŁA PROBLEMY — popraw je:\n${feedback}\n` : ""}`;
};

const MESSAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    highlight: { type: "string" },
    fromScene: { type: "integer" },
    toScene: { type: "integer" },
  },
  required: ["text", "highlight", "fromScene", "toScene"],
};

const VARIANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    angle: { type: "string" },
    hook: { type: "string" },
    hookHighlight: { type: "string" },
    messages: { type: "array", items: MESSAGE_SCHEMA },
    cover: { type: "string" },
    description: {
      type: "object",
      additionalProperties: false,
      properties: {
        firstLine: { type: "string" },
        body: { type: "string" },
        hashtags: { type: "array", items: { type: "string" } },
      },
      required: ["firstLine", "body", "hashtags"],
    },
    missing: { type: "array", items: { type: "string" } },
  },
  required: [
    "angle",
    "hook",
    "hookHighlight",
    "messages",
    "cover",
    "description",
    "missing",
  ],
};

const requestCopy = async (content) => {
  const response = await client.responses.create({
    model: COPY_MODEL,

    input: [
      {
        role: "user",
        content,
      },
    ],

    text: {
      format: {
        type: "json_schema",
        name: "reel_copy",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            // Typ materiału z sekcji 7 briefu.
            type: {
              type: "string",
              enum: ["A", "B", "C", "D", "E", "F", "G", "H"],
            },
            analysis: {
              type: "object",
              additionalProperties: false,
              properties: {
                atut: { type: "string" },
                potrzeba: { type: "string" },
                efekt: { type: "string" },
                dlaczego: { type: "string" },
              },
              required: ["atut", "potrzeba", "efekt", "dlaczego"],
            },
            variants: { type: "array", items: VARIANT_SCHEMA },
          },
          required: ["type", "analysis", "variants"],
        },
      },
    },
  });

  recordUsage(response.usage);

  if (!response.output_text) {
    throw new Error("AI nie zwróciło napisów.");
  }

  return JSON.parse(response.output_text);
};

/*
 * Porządkuje odcinki plansz: przycina do scen 2..N, odrzuca
 * nakładające się i nadmiarowe, a dziury dłuższe niż jedna scena
 * łata, przedłużając sąsiednią planszę w granicach
 * MAX_SCENES_PER_MESSAGE.
 */
const normalizeSpans = (messages, sceneCount) => {
  const spans = [];

  [...messages]
    .map((message) => {
      const text = screenText(message.text);

      return {
        text,
        highlight: cleanHighlight(message.highlight, text),
        from: Math.max(2, Math.round(message.fromScene)),
        to: Math.min(sceneCount, Math.round(message.toScene)),
      };
    })
    .filter((span) => span.text && span.from <= span.to)
    .sort((a, b) => a.from - b.from)
    .forEach((span) => {
      const last = spans[spans.length - 1];

      if (
        spans.length >= MESSAGES_RANGE[1] ||
        (last && span.from <= last.to)
      ) {
        return;
      }

      spans.push({
        ...span,
        to: Math.min(span.to, span.from + MAX_SCENES_PER_MESSAGE - 1),
      });
    });

  const length = (span) => span.to - span.from + 1;

  while (
    spans.length > 0 &&
    spans[0].from - 2 > 1 &&
    length(spans[0]) < MAX_SCENES_PER_MESSAGE
  ) {
    spans[0].from -= 1;
  }

  spans.forEach((span, index) => {
    const nextFrom = spans[index + 1]?.from ?? sceneCount + 1;

    while (
      nextFrom - span.to - 1 > 1 &&
      length(span) < MAX_SCENES_PER_MESSAGE
    ) {
      span.to += 1;
    }
  });

  return spans;
};

/*
 * Tekst na ekran: strzałki i podobne symbole rysowałyby się czcionką
 * zapasową (Montserrat ich nie ma), więc zamieniamy je na półpauzę.
 */
const screenText = (value) =>
  cleanText(value).replace(/\s*[→⇒➔➜]\s*/g, " – ");

const normalizeVariant = (raw, sceneCount) => {
  const hook = screenText(raw.hook);

  return {
    angle: cleanText(raw.angle),
    hook,
    hookHighlight: cleanHighlight(raw.hookHighlight, hook),
    spans: normalizeSpans(raw.messages ?? [], sceneCount),
    cover: screenText(raw.cover),
    description: {
      firstLine: cleanText(raw.description?.firstLine),
      body: String(raw.description?.body ?? "")
        .replace(/\r\n/g, "\n")
        .trim(),
      hashtags: (raw.description?.hashtags ?? [])
        .map((tag) =>
          String(tag).replace(/^#+/, "").replace(/\s+/g, "").trim(),
        )
        .filter((tag) => tag && tag.toLowerCase() !== "exbram"),
    },
    missing: (raw.missing ?? []).map(cleanText).filter(Boolean),
  };
};

/*
 * Problemy pojedynczego tekstu ekranowego (hook, plansza, okładka).
 */
const checkScreenText = (text, label, allowedNumbers) => {
  const problems = [];

  const lower = text.toLowerCase();

  const words = toWords(text);

  if (/\[|uzupe/i.test(text)) {
    problems.push(
      `${label} "${text}" zawiera placeholder — na ekranie go nie wstawiaj, brak wpisz do missing`,
    );
  }

  if (/\p{Extended_Pictographic}/u.test(text)) {
    problems.push(`${label} "${text}" zawiera emoji — na ekranie bez emoji`);
  }

  if (
    lower.includes("exbram.pl") ||
    lower.includes("@") ||
    getNumbers(text).some((number) => number.replace(/\D/g, "").length >= 9)
  ) {
    problems.push(
      `${label} "${text}" zawiera kontakt — telefon i strona są na planszy końcowej`,
    );
  }

  const forbidden = FORBIDDEN_PATTERNS.find((pattern) =>
    lower.includes(pattern),
  );

  if (forbidden) {
    problems.push(
      `${label} "${text}" zawiera zakazany wzorzec z briefu ("${forbidden}")`,
    );
  }

  const empty = EMPTY_WORDS.find((prefix) =>
    words.some((word) => word.startsWith(prefix)),
  );

  if (empty) {
    problems.push(`${label} "${text}" zawiera puste słowo (${empty}…)`);
  }

  const promise = FALSE_PROMISES.find((prefix) =>
    words.some((word) => word.startsWith(prefix)),
  );

  if (promise) {
    problems.push(
      `${label} "${text}" obiecuje coś, czego ogrodzenie nie daje (${promise}…)`,
    );
  }

  const opening = words.slice(0, 2).join(" ");

  if (
    QUESTION_STARTS.some(
      (start) => opening === start || opening.startsWith(`${start} `),
    ) &&
    !text.includes("?")
  ) {
    problems.push(`${label} "${text}" to pytanie — musi mieć znak zapytania`);
  }

  if ((text.match(/[?!]/g) ?? []).length > 1) {
    problems.push(`${label} "${text}" — najwyżej jeden znak ? lub !`);
  }

  /*
   * Sztuczne trójki z briefu: „Szybko. Solidnie. Terminowo” —
   * trzy (i więcej) jednowyrazowe hasła. „Wracasz autem. Klikasz.
   * Wjeżdżasz” (przykład z briefu) przechodzi.
   */
  const segments = text
    .split(/[.!?]\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (
    segments.length >= 3 &&
    segments.every((segment) => countWords(segment) === 1)
  ) {
    problems.push(`${label} "${text}" to sztuczna trójka — zakazana w briefie`);
  }

  const uppercase = text
    .split(/\s+/)
    .filter(
      (word) => /\p{Lu}{2,}/u.test(word) && word === word.toUpperCase(),
    );

  if (uppercase.length > MAX_UPPERCASE_WORDS) {
    problems.push(
      `${label} "${text}" — WERSALIKI najwyżej dla ${MAX_UPPERCASE_WORDS} słów`,
    );
  }

  getNumbers(text)
    .filter((number) => !allowedNumbers.has(number))
    .forEach((number) => {
      problems.push(
        `${label} "${text}" ma liczbę ${number}, której nie ma w faktach ani w opisie scen — nie zgaduj liczb`,
      );
    });

  return problems;
};

/*
 * Lista problemów jednej wersji — pusta znaczy, że wszystko gra.
 */
const findProblems = (variant, { sceneSeconds, history, allowedNumbers }) => {
  const problems = [];

  const { hook, spans, cover, description } = variant;

  const hookWords = countWords(hook);

  if (hookWords < HOOK_WORDS[0] || hookWords > HOOK_WORDS[1]) {
    problems.push(
      `hook "${hook}" ma ${hookWords} słów — ma mieć ${HOOK_WORDS[0]}-${HOOK_WORDS[1]}`,
    );
  }

  if (hook.length > HOOK_MAX_CHARS) {
    problems.push(
      `hook "${hook}" ma ${hook.length} znaków — maks. ${HOOK_MAX_CHARS} (dwie linie)`,
    );
  }

  problems.push(...checkScreenText(hook, "hook", allowedNumbers));

  const repeated = history
    .slice(0, HOOK_HISTORY_CHECK)
    .find((old) => normalizeForCompare(old) === normalizeForCompare(hook));

  if (repeated) {
    problems.push(
      `hook "${hook}" był już w jednej z ostatnich rolek — napisz inny`,
    );
  }

  if (spans.length < MESSAGES_RANGE[0]) {
    problems.push(
      `potrzebne są co najmniej ${MESSAGES_RANGE[0]} plansze po hooku, jest ${spans.length}`,
    );
  }

  spans.forEach((span) => {
    const words = countWords(span.text);

    if (words > MESSAGE_MAX_WORDS) {
      problems.push(
        `plansza "${span.text}" ma ${words} słów — maks. ${MESSAGE_MAX_WORDS}`,
      );
    }

    if (span.text.length > MESSAGE_MAX_CHARS) {
      problems.push(
        `plansza "${span.text}" ma ${span.text.length} znaków — maks. ${MESSAGE_MAX_CHARS} (dwie linie)`,
      );
    }

    const seconds = sceneSeconds
      .slice(span.from - 1, span.to)
      .reduce((total, value) => total + value, 0);

    const needed = Math.max(1.5, 0.3 * words + 0.5);

    if (seconds < needed) {
      problems.push(
        `plansza "${span.text}" stoi ${seconds.toFixed(1)} s, a do przeczytania potrzeba ${needed.toFixed(1)} s — skróć ją albo rozciągnij na więcej scen`,
      );
    }

    problems.push(...checkScreenText(span.text, "plansza", allowedNumbers));
  });

  const texts = [hook, ...spans.map((span) => span.text)].map(
    normalizeForCompare,
  );

  if (new Set(texts).size < texts.length) {
    problems.push("dwie plansze mają ten sam tekst — każda ma wnosić coś nowego");
  }

  let gap = 0;

  for (let scene = 2; scene <= sceneSeconds.length; scene += 1) {
    const covered = spans.some(
      (span) => scene >= span.from && scene <= span.to,
    );

    gap = covered ? 0 : gap + 1;

    if (gap === 2) {
      problems.push(
        `sceny ${scene - 1}-${scene} są bez napisu — najwyżej jedna scena z rzędu może być pusta`,
      );
    }
  }

  if (!cover || countWords(cover) > COVER_MAX_WORDS) {
    problems.push(`okładka "${cover}" — ma mieć 1-${COVER_MAX_WORDS} słowa`);
  }

  problems.push(...checkScreenText(cover, "okładka", allowedNumbers));

  const { firstLine, body, hashtags } = description;

  if (!firstLine || firstLine.length > FIRST_LINE_MAX_CHARS) {
    problems.push(
      `pierwsza linia opisu ma ${firstLine.length} znaków — maks. ${FIRST_LINE_MAX_CHARS}`,
    );
  }

  if (normalizeForCompare(firstLine) === normalizeForCompare(hook)) {
    problems.push("pierwsza linia opisu powtarza hook — ma być drugim hookiem");
  }

  const descriptionText = `${firstLine}\n\n${body}`;

  if (/\[|uzupe/i.test(descriptionText)) {
    problems.push(
      "opis zawiera placeholder — braki wpisz do missing, nie do opisu",
    );
  }

  const forbidden = FORBIDDEN_PATTERNS.find((pattern) =>
    descriptionText.toLowerCase().includes(pattern),
  );

  if (forbidden) {
    problems.push(`opis zawiera zakazany wzorzec z briefu ("${forbidden}")`);
  }

  if (
    (descriptionText.match(/\p{Extended_Pictographic}/gu) ?? []).length >
    DESCRIPTION_MAX_EMOJI
  ) {
    problems.push(`opis ma więcej niż ${DESCRIPTION_MAX_EMOJI} emoji`);
  }

  getNumbers(descriptionText)
    .filter((number) => !allowedNumbers.has(number))
    .forEach((number) => {
      problems.push(
        `opis ma liczbę ${number}, której nie ma w faktach ani w opisie scen`,
      );
    });

  if (
    descriptionText.length < DESCRIPTION_CHARS[0] ||
    descriptionText.length > DESCRIPTION_CHARS[1]
  ) {
    problems.push(
      `opis bez CTA ma ${descriptionText.length} znaków — ma mieć ok. ${DESCRIPTION_CHARS[0]}-${DESCRIPTION_CHARS[1]}`,
    );
  }

  if (
    hashtags.length < HASHTAGS_RANGE[0] ||
    hashtags.length > HASHTAGS_RANGE[1]
  ) {
    problems.push(
      `hasztagów jest ${hashtags.length} — ma być ${HASHTAGS_RANGE[0]}-${HASHTAGS_RANGE[1]} tematyczne (bez exbram)`,
    );
  }

  return [...new Set(problems)];
};

/*
 * Wersja zapisana w planie: odcinki plansz razem z tekstami, żeby
 * panel mógł później przełączyć rolkę na inną wersję bez AI.
 */
const toStoredVariant = (variant, problems) => ({
  angle: variant.angle,
  hook: fitText(variant.hook, HARD_MAX_CHARS),
  hookHighlight: cleanHighlight(
    variant.hookHighlight,
    fitText(variant.hook, HARD_MAX_CHARS),
  ),
  spans: variant.spans.map((span) => {
    const text = fitText(span.text, HARD_MAX_CHARS);

    return {
      from: span.from,
      to: span.to,
      text,
      highlight: cleanHighlight(span.highlight, text),
    };
  }),
  cover: variant.cover,
  description: variant.description,
  missing: variant.missing,
  problems,
});

/*
 * Nakłada wersję na plan: hook, napisy scen (ta sama plansza na
 * scenach z jej odcinka), okładka, opis. Ta sama logika jest
 * w panelu (panel/server.mjs) przy zmianie wersji.
 */
const applyVariant = (editPlan, variant, index) => ({
  ...editPlan,
  hook: variant.hook,
  hookHighlight: variant.hookHighlight,
  cover: variant.cover,
  scenes: editPlan.scenes.map((scene, sceneIndex) => {
    const span = variant.spans.find(
      (item) => sceneIndex + 1 >= item.from && sceneIndex + 1 <= item.to,
    );

    return {
      ...scene,
      caption: span?.text ?? "",
      captionHighlight: span?.highlight ?? "",
    };
  }),
  copy: {
    ...editPlan.copy,
    chosen: index,
    description: variant.description,
    missing: variant.missing,
    problems: variant.problems,
  },
});

const main = async () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Brak OPENAI_API_KEY.");
  }

  const editPlan = readJson(EDIT_FILE, null);

  if (
    !editPlan ||
    !Array.isArray(editPlan.scenes) ||
    editPlan.scenes.length === 0
  ) {
    throw new Error("Brak planu montażu w edit.json.");
  }

  const brief = readBrief();

  const sceneList = describeScenes(editPlan.scenes);

  const sceneSeconds = editPlan.scenes.map((scene) => Number(scene.duration));

  /*
   * Liczby, które wolno pokazać: z faktów briefu i z opisów scen.
   */
  const allowedNumbers = new Set(
    getNumbers(
      [getFactsSection(brief), editPlan.story ?? "", ...sceneList.map((item) => item.shows)].join("\n"),
    ),
  );

  const history = readTextHistory();

  const previews = buildScenePreviews(editPlan);

  console.log(
    `Copywriter (${COPY_MODEL}) ogląda ${previews.filter((item) => item.type === "input_image").length} ujęć...`,
  );

  const context = { sceneSeconds, history, allowedNumbers };

  let best = null;

  let feedback = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const raw = await requestCopy([
      {
        type: "input_text",
        text: buildPrompt({ brief, editPlan, sceneList, history, feedback }),
      },
      ...previews,
    ]);

    const variants = (raw.variants ?? [])
      .slice(0, VARIANT_COUNT)
      .map((item) => normalizeVariant(item, editPlan.scenes.length))
      .map((variant) => ({
        variant,
        problems: findProblems(variant, context),
      }));

    console.log(`\nPróba ${attempt} — typ ${raw.type}`);

    variants.forEach(({ variant, problems }, index) => {
      console.log(`\n  Wersja ${index + 1} [${variant.angle}]`);
      console.log(
        `    hook: "${variant.hook}"${variant.hookHighlight ? ` [${variant.hookHighlight}]` : ""}`,
      );

      variant.spans.forEach((span) =>
        console.log(
          `    sceny ${span.from}-${span.to}: "${span.text}"${span.highlight ? ` [${span.highlight}]` : ""}`,
        ),
      );

      console.log(`    okładka: "${variant.cover}"`);

      problems.forEach((problem) => console.log(`    ! ${problem}`));
    });

    /*
     * Wynik próby: ile wersji jest czystych i ile uwag ma najlepsza.
     * Kończymy, gdy co najmniej dwie wersje są bez uwag.
     */
    const clean = variants.filter((item) => item.problems.length === 0).length;

    const score = clean * 100 - Math.min(...variants.map((item) => item.problems.length), 99);

    if (variants.length > 0 && (!best || score > best.score)) {
      best = { raw, variants, score };
    }

    if (clean >= Math.min(2, variants.length) && variants.length > 0) {
      break;
    }

    feedback = variants
      .map(({ problems }, index) =>
        problems.length
          ? `Wersja ${index + 1}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`
          : `Wersja ${index + 1}: bez uwag — możesz ją zostawić.`,
      )
      .join("\n\n");
  }

  if (!best) {
    throw new Error("AI nie zwróciło żadnej wersji napisów.");
  }

  /*
   * Do rolki idzie pierwsza wersja bez uwag (model ustawia najlepszą
   * na początku), a gdy takiej nie ma — ta z najmniejszą liczbą uwag.
   */
  const stored = best.variants.map(({ variant, problems }) =>
    toStoredVariant(variant, problems),
  );

  const cleanIndex = stored.findIndex((item) => item.problems.length === 0);

  const chosen =
    cleanIndex !== -1
      ? cleanIndex
      : stored.reduce(
          (bestIndex, item, index) =>
            item.problems.length < stored[bestIndex].problems.length
              ? index
              : bestIndex,
          0,
        );

  if (stored[chosen].problems.length > 0) {
    console.warn(
      `\nUWAGA: żadna wersja nie jest bez uwag po ${MAX_ATTEMPTS} próbach — biorę wersję ${chosen + 1}.`,
    );
  }

  const planWithCopy = applyVariant(
    {
      ...editPlan,
      copy: {
        model: COPY_MODEL,
        type: cleanText(best.raw.type),
        analysis: best.raw.analysis,
        variants: stored,
      },
    },
    stored[chosen],
    chosen,
  );

  fs.writeFileSync(
    EDIT_FILE,
    `${JSON.stringify(planWithCopy, null, 2)}\n`,
    "utf8",
  );

  rememberTexts([
    stored[chosen].hook,
    ...stored[chosen].spans.map((span) => span.text),
  ]);

  console.log(
    `\nDo rolki: wersja ${chosen + 1} [${stored[chosen].angle}]. Pozostałe wersje można wybrać w panelu (zakładka Napisy i opis).`,
  );

  if (stored[chosen].missing.length > 0) {
    console.log("\nDo uzupełnienia w opisie:");

    stored[chosen].missing.forEach((item) => console.log(`- ${item}`));
  }

  console.log(`\nZapisano napisy w ${EDIT_FILE}`);

  reportUsage();
};

main().catch((error) => {
  /*
   * Napisy są dodatkiem — bez nich rolka dalej ma sens, więc błąd
   * (np. chwilowy problem z API) nie zatrzymuje pipeline'u.
   */
  console.warn(
    `\nUWAGA: nie udało się napisać napisów (${error.message}) — rolka powstanie bez nich.`,
  );

  const editPlan = readJson(EDIT_FILE, null);

  if (editPlan && Array.isArray(editPlan.scenes)) {
    const { copy, cover, hookHighlight, ...rest } = editPlan;

    fs.writeFileSync(
      EDIT_FILE,
      `${JSON.stringify(
        {
          ...rest,
          hook: "",
          scenes: editPlan.scenes.map((scene) => ({
            ...scene,
            caption: "",
            captionHighlight: "",
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
});
