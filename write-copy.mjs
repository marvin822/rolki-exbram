import fs from "fs";
import path from "path";
import OpenAI from "openai";

/*
 * Copywriter — napisy na ekran, tekst okładki i opis rolki,
 * pisane PO ułożeniu montażu.
 *
 * Jedyną instrukcją treści jest brief właściciela
 * (exbram-rolki-instrukcje-agenta.md), wczytywany przy każdym
 * przebiegu. Kod dokłada tylko to, czego brief nie może wiedzieć:
 * jak działa montaż i plansza końcowa oraz w jakim formacie oddać
 * wynik.
 *
 * Napisy powstają z PROFILU REALIZACJI (styl, kolor, brama, mur —
 * zapisuje go planer w analyze-image.mjs) przez scenariusz, a nie
 * z oglądania kadrów. Gdy copywriter oglądał ujęcia, szukał powiązań
 * w kadrze („ciemny kolor nawiązuje do dachu”) — właściciel odrzucił
 * to podejście (brief, sekcje 2 i 6).
 *
 * Hook stoi na scenie 1, potem jeden napis przy każdej kolejnej
 * scenie; ostatni zaprasza do kontaktu („Też chcesz takie
 * ogrodzenie? …”), po nim plansza końcowa.
 *
 * Powstają 3 wersje napisów z różnymi scenariuszami. Pierwsza
 * poprawna trafia do rolki, pozostałe można wybrać w panelu
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
 * Model redaktora, który wybiera wersję do rolki (chooseVariant).
 * Ocenia sam tekst, więc wystarcza tańszy model.
 */
const EDITOR_MODEL = process.env.REEL_EDITOR_MODEL || "gpt-5-mini";

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
    `\nTokeny (copywriter ${COPY_MODEL}, redaktor ${EDITOR_MODEL}; ${usageTotal.calls} wywolan): ` +
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
 * Limity z briefu (sekcje 7, 8, 12) i z rozmiaru fontu
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

const COVER_MAX_WORDS = 4;

/*
 * Ostatni napis zaprasza do kontaktu (brief, sekcja 3). Sprawdzamy
 * tylko, czy w ogóle jest wezwaniem — po rdzeniach czasowników.
 */
const INVITE_WORDS = [
  "napisz",
  "zadzwo",
  "skontaktuj",
  "zapytaj",
  "odezwij",
  "zrobimy",
  "wycen",
  "porozmawiaj",
  "umów",
  "dzwoń",
  "daj",
];

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
 * Zakazane wzorce — brief, sekcje 7 i 11. Zapisane małymi
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
  // Tylko strona główna — bez linków do podstron (brief, sekcja 9).
  "kalkulator",
  "exbram.pl/",
];

/*
 * Obietnice, których ogrodzenie nie spełnia — lamele i panele są
 * ażurowe, nie tłumią dźwięku ani wiatru (brief, sekcja 10).
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
 * Sekcja briefu: od nagłówka pasującego do wzorca do następnego
 * nagłówka tego samego albo wyższego poziomu.
 */
const getSection = (brief, pattern) => {
  const lines = brief.split(/\r?\n/);

  const start = lines.findIndex(
    (line) => /^#{1,6}\s/.test(line) && pattern.test(line),
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
 * Fakty o firmie. Liczby z nich (ceny, telefon, 20 lat) wolno
 * pokazać; liczby z przykładów w innych sekcjach już nie.
 */
const getFactsSection = (brief) => getSection(brief, /fakty o exbram/i);

/*
 * Kryteria redaktora — tylko sekcje briefu o tym, jakie mają być
 * hasła, a nie cały brief: redaktor ocenia gotowe teksty, nie pisze.
 */
const getEditorCriteria = (brief) =>
  [
    getSection(brief, /jakie mają być hasła/i),
    getSection(brief, /czego nie pisać/i),
  ]
    .filter(Boolean)
    .join("\n\n");

/*
 * Sceny rolki dla copywritera: tylko rodzaj, rola i czas. Bez opisu
 * kadru — napisy wychodzą z profilu i scenariusza (brief, sekcja 4:
 * „nie szukaj powiązań w kadrze”).
 */
const describeScenes = (scenes) => {
  let elapsed = 0;

  return scenes.map((scene, index) => {
    elapsed += Number(scene.duration);

    return {
      scene: index + 1,
      type: scene.fragmentId ? "film" : "zdjęcie",
      role: scene.role ?? "",
      seconds: Number(Number(scene.duration).toFixed(1)),
      text:
        index === 0
          ? "HOOK"
          : index === scenes.length - 1
            ? "NAPIS-ZAPROSZENIE"
            : "napis o ogrodzeniu",
    };
  });
};

/*
 * Profil realizacji z planu montażu. Starsze plany mają tylko "story".
 */
const describeProfile = (editPlan) =>
  editPlan.profile
    ? JSON.stringify(editPlan.profile, null, 2)
    : editPlan.story || "(brak profilu — pisz ogólnie o ogrodzeniu stalowym)";

const buildPrompt = ({ brief, editPlan, sceneList, history, feedback }) => {
  const sceneCount = sceneList.length;

  const total = sceneList
    .reduce((sum, item) => sum + item.seconds, 0)
    .toFixed(1);

  return `${brief}

==========================================================
TA ROLKA — dane do napisów
==========================================================

PROFIL REALIZACJI (krok 1 z briefu):
${describeProfile(editPlan)}

Rolka jest JUŻ zmontowana: ${sceneCount} scen, ${total} s materiału, potem
3,5 s planszy końcowej. Ujęć ani ich długości nie zmieniasz.

SCENY:
${JSON.stringify(sceneList, null, 2)}

Co z tego wynika dla napisów:

1. Każda wersja zaczyna się od scenariusza (krok 2 z briefu) — pole
   scenario, 2-3 zdania. Napisy piszesz na jego podstawie.

2. hook stoi na scenie 1. messages to napisy do scen 2..${sceneCount}
   w kolejności — DOKŁADNIE ${Math.max(0, sceneCount - 1)}, po jednym na scenę.
   Ostatni z nich (scena ${sceneCount}) to napis-zaproszenie w stylu
   „Też chcesz takie ogrodzenie? Skontaktuj się z nami!” — za każdym
   razem sformułowany trochę inaczej.

3. Napis musi dać się przeczytać, zanim zniknie: ok. 0,3 s na słowo
   + 0,5 s. Przy scenie 2,5 s to najwyżej 6 słów.

4. Po ostatniej scenie wchodzi automatycznie plansza końcowa: logo,
   "Ogrodzenia, które robią różnicę", "${END_CARD.cta}", tel. ${END_CARD.phone},
   ${END_CARD.web}. Na ekranie BEZ telefonu, adresu strony i e-maila.

5. Na ekranie i w okładce nie ma "[UZUPEŁNIJ…]" ani emoji (font ich nie
   ma). W opisie też bez placeholderów — braki wpisz do "missing".

6. Przygotuj ${VARIANT_COUNT} WERSJE, każdą z INNYM scenariuszem (inna główna
   myśl), najlepszą jako pierwszą. angle to 1-3 słowa nazwy pomysłu.
   Każda wersja to komplet: scenariusz, hook, napisy, okładka, opis.

7. hookHighlight / highlight: 1-2 słowa skopiowane DOKŁADNIE z tekstu
   napisu — pokażemy je kolorem akcentu. Może być "".

8. Opis (sekcja 13 briefu): firstLine (do ${FIRST_LINE_MAX_CHARS} znaków), body
   (2-4 krótkie akapity oddzielone \\n\\n), hashtags (${HASHTAGS_RANGE[0]}-${HASHTAGS_RANGE[1]} tematyczne,
   bez "#" i bez "exbram" — dodamy). CTA "Darmowa wycena: ${END_CARD.phone} lub
   ${END_CARD.web}" dokleja kod — nie pisz go w body.

9. Wynik zwróć jako JSON według schematu.

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
  },
  required: ["text", "highlight"],
};

const VARIANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    angle: { type: "string" },
    scenario: { type: "string" },
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
    "scenario",
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
            variants: { type: "array", items: VARIANT_SCHEMA },
          },
          required: ["variants"],
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
 * Redaktor — wybiera wersję do rolki. Wcześniej szła pierwsza wersja
 * bez usterek mechanicznych, a kontrola liczy słowa i znaki, więc nie
 * odróżnia dobrego hasła od dziwnego. Redaktor dostaje sam tekst
 * (bez obrazów i bez całego briefu), więc to tanie wywołanie.
 */
const chooseVariant = async ({ brief, editPlan, candidates }) => {
  const list = candidates
    .map(
      ({ variant }, index) =>
        `WERSJA ${index + 1} [${variant.angle}]
Hook: ${variant.hook}
${variant.spans.map((span) => `Scena ${span.from}: ${span.text}`).join("\n")}
Okładka: ${variant.cover}`,
    )
    .join("\n\n");

  const response = await client.responses.create({
    model: EDITOR_MODEL,

    input: [
      {
        role: "user",
        content: `Jesteś redaktorem rolek EXBRAM (ogrodzenia stalowe). Copywriter
przygotował ${candidates.length} wersje napisów na ekran. Wybierz JEDNĄ do rolki.

Kryteria, w tej kolejności:
1. Hook zatrzymuje kciuk — chce się przeczytać do końca.
2. Każdy napis brzmi naturalnie i jest zrozumiały w sekundę — nic
   dziwnego, wydumanego ani sloganu z generatora.
3. Napisy mówią o charakterze i wrażeniu, a nie wyliczają elementów
   konstrukcji ani nie opisują kadru.
4. Całość układa się w jedną myśl i kończy zaproszeniem do kontaktu.

Zasady z briefu:
${getEditorCriteria(brief)}

PROFIL REALIZACJI:
${describeProfile(editPlan)}

${list}

W reason napisz jednym zdaniem po polsku, dlaczego ta wersja.`,
      },
    ],

    text: {
      format: {
        type: "json_schema",
        name: "reel_copy_choice",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            chosen: { type: "integer" },
            reason: { type: "string" },
          },
          required: ["chosen", "reason"],
        },
      },
    },
  });

  recordUsage(response.usage);

  const result = JSON.parse(response.output_text || "{}");

  const index = Math.round(Number(result.chosen)) - 1;

  if (!(index >= 0 && index < candidates.length)) {
    throw new Error(`redaktor wskazał nieistniejącą wersję (${result.chosen})`);
  }

  return { index, reason: cleanText(result.reason) };
};

/*
 * Napisy do scen 2..N, po jednym na scenę. Zapisujemy je jako odcinki
 * jednoscenowe (from = to) — w tym formacie czytają je panel
 * i applyVariant. Gdy napisów jest za mało, ostatni (zaproszenie)
 * i tak ląduje na ostatniej scenie; brak zgłasza findProblems.
 */
const normalizeSpans = (messages, sceneCount) => {
  const texts = messages
    .map((message) => {
      const text = screenText(message.text);

      return { text, highlight: cleanHighlight(message.highlight, text) };
    })
    .filter((message) => message.text)
    .slice(0, Math.max(0, sceneCount - 1));

  return texts.map((message, index) => {
    const scene =
      index === texts.length - 1 ? sceneCount : index + 2;

    return { ...message, from: scene, to: scene };
  });
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
    scenario: cleanText(raw.scenario),
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
const checkScreenText = (text, label, allowedNumbers, maxMarks = 1) => {
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

  if ((text.match(/[?!]/g) ?? []).length > maxMarks) {
    problems.push(
      maxMarks === 1
        ? `${label} "${text}" — najwyżej jeden znak ? lub !`
        : `${label} "${text}" — najwyżej jedno pytanie i jeden wykrzyknik`,
    );
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

  const needed = sceneSeconds.length - 1;

  if (spans.length !== needed) {
    problems.push(
      `napisów po hooku ma być ${needed} (po jednym na każdą scenę 2-${sceneSeconds.length}), jest ${spans.length}`,
    );
  }

  const invite = needed > 0 ? spans.at(-1) : null;

  if (
    invite &&
    !toWords(invite.text).some((word) =>
      INVITE_WORDS.some((stem) => word.startsWith(stem)),
    )
  ) {
    problems.push(
      `ostatni napis "${invite.text}" ma zapraszać do kontaktu, w stylu „Też chcesz takie ogrodzenie? Skontaktuj się z nami!”`,
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

    const reading = Math.max(1.5, 0.3 * words + 0.5);

    if (seconds < reading) {
      problems.push(
        `napis "${span.text}" stoi ${seconds.toFixed(1)} s, a do przeczytania potrzeba ${reading.toFixed(1)} s — skróć go`,
      );
    }

    problems.push(
      ...checkScreenText(
        span.text,
        "napis",
        allowedNumbers,
        span === invite ? 2 : 1,
      ),
    );
  });

  const texts = [hook, ...spans.map((span) => span.text)].map(
    normalizeForCompare,
  );

  if (new Set(texts).size < texts.length) {
    problems.push("dwie plansze mają ten sam tekst — każda ma wnosić coś nowego");
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
  scenario: variant.scenario,
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
   * Liczby, które wolno pokazać: z faktów briefu i z profilu realizacji.
   */
  const allowedNumbers = new Set(
    getNumbers([getFactsSection(brief), describeProfile(editPlan)].join("\n")),
  );

  const history = readTextHistory();

  console.log(
    `Copywriter (${COPY_MODEL}) pisze napisy do ${sceneList.length} scen z profilu realizacji...`,
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
    ]);

    const variants = (raw.variants ?? [])
      .slice(0, VARIANT_COUNT)
      .map((item) => normalizeVariant(item, editPlan.scenes.length))
      .map((variant) => ({
        variant,
        problems: findProblems(variant, context),
      }));

    console.log(`\nPróba ${attempt}`);

    variants.forEach(({ variant, problems }, index) => {
      console.log(`\n  Wersja ${index + 1} [${variant.angle}]`);
      console.log(`    scenariusz: ${variant.scenario}`);
      console.log(
        `    hook: "${variant.hook}"${variant.hookHighlight ? ` [${variant.hookHighlight}]` : ""}`,
      );

      variant.spans.forEach((span) =>
        console.log(
          `    scena ${span.from}: "${span.text}"${span.highlight ? ` [${span.highlight}]` : ""}`,
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

  const stored = best.variants.map(({ variant, problems }) =>
    toStoredVariant(variant, problems),
  );

  /*
   * Kandydaci do rolki: wersje z najmniejszą liczbą uwag (zwykle
   * wszystkie bez uwag). Spośród nich wybiera redaktor; gdy redaktor
   * zawiedzie, idzie pierwsza z nich.
   */
  const fewest = Math.min(...stored.map((item) => item.problems.length));

  const candidates = best.variants
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.problems.length === fewest);

  let chosen = candidates[0].index;

  let editor = null;

  if (candidates.length > 1) {
    try {
      const choice = await chooseVariant({ brief, editPlan, candidates });

      chosen = candidates[choice.index].index;

      editor = { model: EDITOR_MODEL, chosen, reason: choice.reason };

      console.log(
        `\nRedaktor (${EDITOR_MODEL}) wybrał wersję ${chosen + 1}: ${choice.reason}`,
      );
    } catch (error) {
      console.warn(
        `\nUWAGA: redaktor nie wybrał wersji (${error.message}) — biorę wersję ${chosen + 1}.`,
      );
    }
  }

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
        editor,
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
