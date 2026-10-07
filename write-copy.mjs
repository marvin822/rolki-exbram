import fs from "fs";
import path from "path";
import OpenAI from "openai";

/*
 * Copywriter — napisy na ekran, tekst okładki i opis rolki,
 * osobno od planu montażu.
 *
 * Instrukcje to brief właściciela: exbram-rolki-instrukcje-agenta.md.
 * Plik jest wczytywany przy każdym przebiegu, więc zmiana briefu
 * (fakty o firmie, ton, zakazane wzorce) działa od następnej rolki
 * bez zmian w kodzie. Kod dokłada tylko zasady wynikające z tego,
 * jak działa pipeline (rolka już zmontowana, CTA na planszy
 * końcowej, brak placeholderów na ekranie, wynik w JSON).
 *
 * Kod nie wierzy modelowi na słowo: sprawdza limity słów i czasu
 * czytania, zakazane wzorce z briefu, liczby spoza faktów,
 * powtórzenia, parafrazy starych hooków i ułożenie odcinków.
 * Przy problemach odsyła propozycję z listą uwag (najwyżej
 * MAX_ATTEMPTS prób), a na końcu bierze najlepszą. Błąd tego kroku
 * nie zatrzymuje rolki — powstaje wtedy bez napisów, a opis pisze
 * zapasowa ścieżka w generate-description.mjs.
 */

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/*
 * Copywriting to jedno krótkie zapytanie na rolkę, a od jakości
 * tekstu zależy, czy widz zostanie — tu warto mocniejszego modelu.
 */
const COPY_MODEL = "gpt-5";

const ROOT = process.cwd();

const BRIEF_FILE = path.join(
  ROOT,
  "exbram-rolki-instrukcje-agenta.md",
);

const EDIT_FILE = path.join(
  ROOT,
  "edit.json",
);

const ANALYSIS_FILE = path.join(
  ROOT,
  "analysis.json",
);

const VIDEO_ANALYSIS_FILE =
  path.join(
    ROOT,
    "video-analysis.json",
  );

/*
 * Pamięć hooków i haseł z poprzednich rolek — lokalnie, poza gitem,
 * wspólna dla wszystkich zestawów. Usunięcie pliku ją czyści.
 */
const TEXT_HISTORY_FILE =
  path.join(
    ROOT,
    "work",
    "text-history.json",
  );

const TEXT_HISTORY_LIMIT = 24;

/*
 * Limity z briefu (sekcja 4) i z rozmiaru fontu w Composition.tsx
 * (dwie linie tekstu).
 */
const HOOK_WORDS = [3, 7];

const HOOK_MAX_CHARS = 42;

const MESSAGE_MAX_WORDS = 8;

const MESSAGE_MAX_CHARS = 44;

const MESSAGES_RANGE = [2, 5];

const MAX_SCENES_PER_MESSAGE = 3;

const COVER_MAX_WORDS = 4;

const MAX_UPPERCASE_WORDS = 3;

const FIRST_LINE_MAX_CHARS = 120;

const DESCRIPTION_CHARS = [
  280,
  650,
];

const HASHTAGS_RANGE = [3, 5];

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
 * Zakazane wzorce — sekcja 6 briefu i sekcja 4.2 (zakazane hooki).
 */
const FORBIDDEN_PATTERNS = [
  "najwyższa jakość",
  "najwyższej jakości",
  "solidne i stylowe",
  "wizytówk",
  "perfekcyjn",
  "idealn",
  "zobaczcie",
  "w tym filmie",
  "przedstawiamy",
  "prezentujemy",
  "z dumą",
  "nowa realizacja",
  "zobacz naszą",
  "czekaj do końca",
  "wyobraź",
  "najtaniej",
  "bez marży",
  // Tylko strona główna — bez linków do podstron (brief, sekcja 2).
  "kalkulator",
  "exbram.pl/",
];

/*
 * Słowa, które model brał, gdy nie miał nic konkretnego do
 * powiedzenia — brzmią jak opis architekta, nie jak reklama.
 */
const EMPTY_WORDS = [
  "kompozycj",
  "harmoni",
  "rytmik",
  "przestrze",
  "element",
  "całość",
  "estetyk",
];

/*
 * Obietnice, których ogrodzenie nie spełnia — lamele i panele są
 * ażurowe, nie tłumią dźwięku.
 */
const FALSE_PROMISES = [
  "cisz",
  "hałas",
  "wycisz",
  "akustyc",
  "wiatr",
  "kurz",
];

const QUESTION_STARTS = [
  "chcesz",
  "szukasz",
  "planujesz",
  "marzysz",
  "potrzebujesz",
  "myślisz",
  "czy",
  "jak",
  "ile",
  "dlaczego",
];

/*
 * Rdzeń słowa do porównań: pierwsze 5 liter (polska fleksja zmienia
 * końcówki). Krótsze słowa, wypełniacze i nazwy produktów nie liczą
 * się do powtórzeń — brief każe powtarzać nazwy, jakich szuka
 * klient ("brama przesuwna"), bo platformy czytają tekst z ekranu.
 */
const STEM_LENGTH = 5;

const FILLER_PREFIXES = [
  "któr",
  "przez",
  "swoj",
  "twoj",
  "takie",
  "takim",
  "każd",
  "siebi",
  "tylko",
  "wszys",
  "bardz",
  "jeszc",
  "zawsz",
];

const PRODUCT_PREFIXES = [
  "ogrod",
  "bram",
  "furtk",
  "lamel",
  "palis",
  "panel",
  "przęs",
  "stal",
  "ocynk",
  "prosz",
  "balus",
  "autom",
  "grzeb",
  "żaluz",
  "przes",
  "dwusk",
  "połów",
  "exbra",
];

const toWords = (text) =>
  String(text)
    .toLowerCase()
    .split(
      /[^a-ząćęłńóśźż0-9]+/u,
    )
    .filter(Boolean);

const countWords = (text) =>
  String(text)
    .split(/\s+/)
    .filter((word) =>
      /[\p{L}\p{N}]/u.test(word),
    ).length;

const getStemList = (text) =>
  toWords(text)
    .filter(
      (word) =>
        word.length >=
          STEM_LENGTH &&
        !/^\d/.test(word) &&
        ![
          ...FILLER_PREFIXES,
          ...PRODUCT_PREFIXES,
        ].some((prefix) =>
          word.startsWith(prefix),
        ),
    )
    .map((word) =>
      word.slice(
        0,
        STEM_LENGTH,
      ),
    );

const getStems = (text) =>
  new Set(
    getStemList(text),
  );

/*
 * Parafraza hooka z historii: to samo pierwsze słowo treściowe
 * i co najmniej połowa słów wspólna, albo co najmniej dwa wspólne
 * słowa treściowe.
 */
const isParaphrase = (
  text,
  previous,
) => {
  const list =
    getStemList(text);

  const previousList =
    getStemList(previous);

  const stems = new Set(list);

  const previousStems =
    new Set(previousList);

  const smaller = Math.min(
    stems.size,
    previousStems.size,
  );

  if (smaller === 0) {
    return false;
  }

  let shared = 0;

  stems.forEach((stem) => {
    if (
      previousStems.has(stem)
    ) {
      shared += 1;
    }
  });

  return (
    shared >= 2 ||
    (list[0] ===
      previousList[0] &&
      shared / smaller >= 0.5)
  );
};

/*
 * Liczby w tekście, znormalizowane: "5 075 zł" → "5075",
 * "1,6 m" → "1,6".
 */
const getNumbers = (text) =>
  (
    String(text).match(
      /\d[\d\s]*(?:[.,]\d+)?/g,
    ) ?? []
  ).map((number) =>
    number
      .replace(/\s+/g, "")
      .replace(/[.,]$/, ""),
  );

const readJson = (
  filePath,
  fallback,
) => {
  try {
    return JSON.parse(
      fs.readFileSync(
        filePath,
        "utf8",
      ),
    );
  } catch {
    return fallback;
  }
};

const readTextHistory = () => {
  const stored = readJson(
    TEXT_HISTORY_FILE,
    [],
  );

  return Array.isArray(stored)
    ? stored.filter(
        (item) =>
          typeof item ===
          "string",
      )
    : [];
};

const rememberTexts = (
  texts,
) => {
  const merged = [
    ...new Set([
      ...texts,
      ...readTextHistory(),
    ]),
  ].slice(
    0,
    TEXT_HISTORY_LIMIT,
  );

  fs.mkdirSync(
    path.dirname(
      TEXT_HISTORY_FILE,
    ),
    {
      recursive: true,
    },
  );

  fs.writeFileSync(
    TEXT_HISTORY_FILE,
    `${JSON.stringify(
      merged,
      null,
      2,
    )}\n`,
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
 * Ostatnia deska ratunku, gdy po wszystkich próbach tekst wciąż
 * jest za długi: przycięcie na granicy słowa, żeby zmieścił się
 * w kadrze.
 */
const fitText = (
  text,
  maxChars,
) => {
  if (
    text.length <= maxChars
  ) {
    return text;
  }

  return text
    .slice(0, maxChars + 1)
    .replace(/\s+\S*$/, "")
    .replace(
      /[,;:–-]+$/,
      "",
    );
};

const readBrief = () => {
  if (
    !fs.existsSync(BRIEF_FILE)
  ) {
    throw new Error(
      `Brak briefu ${BRIEF_FILE}.`,
    );
  }

  return fs.readFileSync(
    BRIEF_FILE,
    "utf8",
  );
};

/*
 * Fakty o firmie = sekcja 2 briefu. Liczby z niej (ceny, telefon)
 * wolno pokazać na ekranie; liczby z przykładów w dalszych sekcjach
 * już nie.
 */
const getFactsSection = (
  brief,
) => {
  const start =
    brief.indexOf("## 2.");

  const end = brief.indexOf(
    "## 3.",
    start,
  );

  return start === -1
    ? ""
    : brief.slice(
        start,
        end === -1
          ? undefined
          : end,
      );
};

/*
 * Opisy scen dla copywritera: co widać na ujęciu. Zdjęcia mają
 * subject z analizy, fragmenty filmów — uzasadnienie z analizy
 * szczegółowej (pole reason).
 */
const describeScenes = (
  scenes,
) => {
  const photos = readJson(
    ANALYSIS_FILE,
    [],
  );

  const videos = readJson(
    VIDEO_ANALYSIS_FILE,
    [],
  );

  const fragments = new Map();

  videos.forEach((video) => {
    (video.fragments ?? []).forEach(
      (fragment) => {
        fragments.set(
          fragment.fragmentId,
          fragment,
        );
      },
    );
  });

  let elapsed = 0;

  return scenes.map(
    (scene, index) => {
      const from = elapsed;

      elapsed += Number(
        scene.duration,
      );

      const timing = `${from.toFixed(1)}-${elapsed.toFixed(1)} s`;

      if (scene.fragmentId) {
        const fragment =
          fragments.get(
            scene.fragmentId,
          );

        return {
          scene: index + 1,
          type: "film",
          time: timing,
          shows: String(
            fragment?.reason ??
              "",
          ).slice(0, 400),
        };
      }

      const photo =
        photos.find(
          (item) =>
            item.file ===
            scene.file,
        );

      return {
        scene: index + 1,
        type: "zdjęcie",
        time: timing,
        shows:
          photo?.subject ?? "",
        shotType:
          photo?.shotType ?? "",
      };
    },
  );
};

const buildPrompt = ({
  brief,
  sceneList,
  history,
  feedback,
}) => {
  const sceneCount =
    sceneList.length;

  const total =
    sceneList.at(-1)?.time
      ?.split("-")[1] ?? "";

  return `
${brief}

==========================================================
ZASADY TEGO PIPELINE'U — mają PIERWSZEŃSTWO przed briefem powyżej
==========================================================

1. Rolka jest JUŻ zmontowana: ${sceneCount} scen, materiał ${total},
   potem 3,5 s planszy końcowej. Nie zmieniasz ujęć ani długości —
   dobierasz TYP i KĄT do tego, co jest w scenach, i piszesz teksty.

2. Jedyne CTA rolki to PLANSZA KOŃCOWA, która wchodzi automatycznie
   po ostatniej scenie: logo, hasło "Ogrodzenia, które robią różnicę",
   "${END_CARD.cta}", tel. ${END_CARD.phone}, ${END_CARD.web}.
   Dlatego Twoja ostatnia plansza tekstowa NIE jest CTA — daje
   najmocniejszy konkret, który naturalnie prowadzi do wyceny.

3. Plansze = hook (na scenie 1) + ${MESSAGES_RANGE[0]}-${MESSAGES_RANGE[1]} plansz (messages)
   na sceny 2-${sceneCount}; razem 3-6 plansz. Każda plansza obejmuje
   1-${MAX_SCENES_PER_MESSAGE} KOLEJNE sceny (fromScene..toScene), których dotyczy —
   zmienia się z cięciem. Od sceny 2 najwyżej jedna scena z rzędu
   bez napisu. Czas czytania: plansza musi stać co najmniej
   0,3 s na słowo + 0,5 s (min. 1,5 s) — sprawdź czasy scen.

4. Na ekranie i w okładce NIGDY nie wstawiaj "[UZUPEŁNIJ…]" ani liczb,
   których nie ma w faktach (sekcja 2 briefu) ani w opisie sceny —
   napisz planszę bez tej liczby. To, czego brakuje (wymiar, RAL,
   lokalizacja…), wypisz w polu "missing".

5. Bez emoji na ekranie i w okładce (font ich nie ma).

6. hookHighlight / highlight: jedno słowo albo krótka fraza skopiowana
   DOKŁADNIE z tekstu planszy (zwykle słowo kluczowe produktu) —
   pokażemy je kolorem akcentu. Może być "".

7. Ogrodzenie nie wycisza hałasu i nie chroni przed wiatrem ani
   kurzem (lamele i panele są ażurowe) — bez takich obietnic.

8. Hook nie może powtarzać ani parafrazować hooków z poprzednich rolek
   (lista na końcu). Nazwy produktów ("brama przesuwna") wolno powtarzać.

9. Opis: firstLine (do ${FIRST_LINE_MAX_CHARS} znaków, drugi hook), body (2-4 krótkie
   akapity konkretów oddzielone \\n\\n), hashtags (${HASHTAGS_RANGE[0]}-${HASHTAGS_RANGE[1]} tematycznych,
   bez "#", bez "exbram" — dodamy). CTA dokleja kod:
   "Darmowa wycena: ${END_CARD.phone} lub ${END_CARD.web}" — NIE pisz CTA
   ani danych kontaktowych w body. Placeholderów nie wstawiaj także
   w opisie — braki idą do "missing". Całość opisu z CTA ok. 300-600 znaków.

10. Wynik zwróć jako JSON według schematu (zamiast formatu z sekcji 7
    briefu). hookVariants = dwa warianty hooka, hook = wybrany.

SCENY ROLKI (kolejność montażu, czasy materiału):
${JSON.stringify(sceneList, null, 2)}

HOOKI I HASŁA Z POPRZEDNICH ROLEK (hooka nie powtarzaj ani nie parafrazuj):
${history.length > 0 ? history.map((text) => `- ${text}`).join("\n") : "(brak)"}
${feedback ? `\nTWOJA POPRZEDNIA PROPOZYCJA MIAŁA PROBLEMY — popraw je:\n${feedback}\n` : ""}`;
};

const requestCopy = async (
  prompt,
) => {
  const response =
    await client.responses.create({
      model: COPY_MODEL,

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_text",
              text: prompt,
            },
          ],
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
              type: {
                type: "string",
              },

              angle: {
                type: "string",
              },

              hookVariants: {
                type: "array",

                items: {
                  type: "string",
                },
              },

              hook: {
                type: "string",
              },

              hookHighlight: {
                type: "string",
              },

              messages: {
                type: "array",

                items: {
                  type: "object",

                  additionalProperties: false,

                  properties: {
                    text: {
                      type: "string",
                    },

                    highlight: {
                      type: "string",
                    },

                    fromScene: {
                      type: "integer",
                    },

                    toScene: {
                      type: "integer",
                    },
                  },

                  required: [
                    "text",
                    "highlight",
                    "fromScene",
                    "toScene",
                  ],
                },
              },

              cover: {
                type: "string",
              },

              description: {
                type: "object",

                additionalProperties: false,

                properties: {
                  firstLine: {
                    type: "string",
                  },

                  body: {
                    type: "string",
                  },

                  hashtags: {
                    type: "array",

                    items: {
                      type: "string",
                    },
                  },
                },

                required: [
                  "firstLine",
                  "body",
                  "hashtags",
                ],
              },

              missing: {
                type: "array",

                items: {
                  type: "string",
                },
              },
            },

            required: [
              "type",
              "angle",
              "hookVariants",
              "hook",
              "hookHighlight",
              "messages",
              "cover",
              "description",
              "missing",
            ],
          },
        },
      },
    });

  if (
    !response.output_text
  ) {
    throw new Error(
      "AI nie zwróciło napisów.",
    );
  }

  return JSON.parse(
    response.output_text,
  );
};

/*
 * Wyróżnienie musi być fragmentem tekstu — inaczej Composition
 * nie ma czego pokolorować.
 */
const cleanHighlight = (
  highlight,
  text,
) => {
  const value =
    cleanText(highlight);

  return value &&
    text
      .toLowerCase()
      .includes(
        value.toLowerCase(),
      )
    ? value
    : "";
};

/*
 * Porządkuje odcinki plansz: przycina do scen 2..N, odrzuca
 * nakładające się i nadmiarowe, a dziury dłuższe niż jedna scena
 * łata, przedłużając sąsiednią planszę w granicach
 * MAX_SCENES_PER_MESSAGE.
 */
const normalizeSpans = (
  messages,
  sceneCount,
) => {
  const spans = [];

  [...messages]
    .map((message) => {
      const text = cleanText(
        message.text,
      );

      return {
        text,
        highlight:
          cleanHighlight(
            message.highlight,
            text,
          ),
        from: Math.max(
          2,
          Math.round(
            message.fromScene,
          ),
        ),
        to: Math.min(
          sceneCount,
          Math.round(
            message.toScene,
          ),
        ),
      };
    })
    .filter(
      (span) =>
        span.text &&
        span.from <= span.to,
    )
    .sort(
      (a, b) =>
        a.from - b.from,
    )
    .forEach((span) => {
      const last =
        spans[
          spans.length - 1
        ];

      if (
        spans.length >=
          MESSAGES_RANGE[1] ||
        (last &&
          span.from <=
            last.to)
      ) {
        return;
      }

      spans.push({
        ...span,
        to: Math.min(
          span.to,
          span.from +
            MAX_SCENES_PER_MESSAGE -
            1,
        ),
      });
    });

  const length = (span) =>
    span.to - span.from + 1;

  while (
    spans.length > 0 &&
    spans[0].from - 2 > 1 &&
    length(spans[0]) <
      MAX_SCENES_PER_MESSAGE
  ) {
    spans[0].from -= 1;
  }

  spans.forEach(
    (span, index) => {
      const nextFrom =
        spans[index + 1]?.from ??
        sceneCount + 1;

      while (
        nextFrom -
          span.to -
          1 >
          1 &&
        length(span) <
          MAX_SCENES_PER_MESSAGE
      ) {
        span.to += 1;
      }
    },
  );

  return spans;
};

/*
 * Problemy pojedynczego tekstu ekranowego (hook, plansza, okładka).
 */
const checkScreenText = (
  text,
  label,
  allowedNumbers,
) => {
  const problems = [];

  const lower =
    text.toLowerCase();

  const words = toWords(text);

  if (
    /\[|uzupe/i.test(text)
  ) {
    problems.push(
      `${label} "${text}" zawiera placeholder — na ekranie go nie wstawiaj, brak wpisz do missing`,
    );
  }

  if (
    /\p{Extended_Pictographic}/u.test(
      text,
    )
  ) {
    problems.push(
      `${label} "${text}" zawiera emoji — na ekranie bez emoji`,
    );
  }

  const forbidden =
    FORBIDDEN_PATTERNS.find(
      (pattern) =>
        lower.includes(pattern),
    );

  if (forbidden) {
    problems.push(
      `${label} "${text}" zawiera zakazany wzorzec z briefu ("${forbidden}")`,
    );
  }

  const empty =
    EMPTY_WORDS.find(
      (prefix) =>
        words.some((word) =>
          word.startsWith(
            prefix,
          ),
        ),
    );

  if (empty) {
    problems.push(
      `${label} "${text}" zawiera puste słowo (${empty}…)`,
    );
  }

  const promise =
    FALSE_PROMISES.find(
      (prefix) =>
        words.some((word) =>
          word.startsWith(
            prefix,
          ),
        ),
    );

  if (promise) {
    problems.push(
      `${label} "${text}" obiecuje coś, czego ogrodzenie nie daje (${promise}…)`,
    );
  }

  if (
    QUESTION_STARTS.includes(
      words[0] ?? "",
    ) &&
    !text.includes("?")
  ) {
    problems.push(
      `${label} "${text}" to pytanie — musi mieć znak zapytania`,
    );
  }

  if (
    (text.match(/[?!]/g) ?? [])
      .length > 1
  ) {
    problems.push(
      `${label} "${text}" — najwyżej jeden znak ? lub !`,
    );
  }

  // Trójki rytmiczne: "Szybko. Solidnie. Terminowo"
  if (
    (text.match(/\.\s/g) ?? [])
      .length >= 2
  ) {
    problems.push(
      `${label} "${text}" to trójka rytmiczna — zakazana w briefie`,
    );
  }

  const uppercase = String(
    text,
  )
    .split(/\s+/)
    .filter(
      (word) =>
        /\p{Lu}{2,}/u.test(
          word,
        ) &&
        word ===
          word.toUpperCase(),
    );

  if (
    uppercase.length >
    MAX_UPPERCASE_WORDS
  ) {
    problems.push(
      `${label} "${text}" — WERSALIKI najwyżej dla ${MAX_UPPERCASE_WORDS} słów`,
    );
  }

  getNumbers(text)
    .filter(
      (number) =>
        !allowedNumbers.has(
          number,
        ),
    )
    .forEach((number) => {
      problems.push(
        `${label} "${text}" ma liczbę ${number}, której nie ma w faktach ani w opisie scen — nie zgaduj liczb`,
      );
    });

  return problems;
};

/*
 * Lista problemów propozycji — pusta znaczy, że wszystko gra.
 */
const findProblems = ({
  hook,
  spans,
  cover,
  description,
  sceneSeconds,
  history,
  allowedNumbers,
}) => {
  const problems = [];

  const hookWords =
    countWords(hook);

  if (
    hookWords <
      HOOK_WORDS[0] ||
    hookWords > HOOK_WORDS[1]
  ) {
    problems.push(
      `hook "${hook}" ma ${hookWords} słów — ma mieć ${HOOK_WORDS[0]}-${HOOK_WORDS[1]}`,
    );
  }

  if (
    hook.length >
    HOOK_MAX_CHARS
  ) {
    problems.push(
      `hook "${hook}" ma ${hook.length} znaków — maks. ${HOOK_MAX_CHARS} (dwie linie)`,
    );
  }

  problems.push(
    ...checkScreenText(
      hook,
      "hook",
      allowedNumbers,
    ),
  );

  const previousHook =
    history.find((old) =>
      isParaphrase(
        hook,
        old,
      ),
    );

  if (previousHook) {
    problems.push(
      `hook "${hook}" to parafraza "${previousHook}" z poprzedniej rolki`,
    );
  }

  if (
    spans.length <
    MESSAGES_RANGE[0]
  ) {
    problems.push(
      `potrzebne są co najmniej ${MESSAGES_RANGE[0]} plansze po hooku, jest ${spans.length}`,
    );
  }

  spans.forEach((span) => {
    const words = countWords(
      span.text,
    );

    if (
      words >
      MESSAGE_MAX_WORDS
    ) {
      problems.push(
        `plansza "${span.text}" ma ${words} słów — maks. ${MESSAGE_MAX_WORDS}`,
      );
    }

    if (
      span.text.length >
      MESSAGE_MAX_CHARS
    ) {
      problems.push(
        `plansza "${span.text}" ma ${span.text.length} znaków — maks. ${MESSAGE_MAX_CHARS} (dwie linie)`,
      );
    }

    const seconds =
      sceneSeconds
        .slice(
          span.from - 1,
          span.to,
        )
        .reduce(
          (total, value) =>
            total + value,
          0,
        );

    const needed = Math.max(
      1.5,
      0.3 * words + 0.5,
    );

    if (seconds < needed) {
      problems.push(
        `plansza "${span.text}" stoi ${seconds.toFixed(1)} s, a do przeczytania potrzeba ${needed.toFixed(1)} s — skróć ją albo rozciągnij na więcej scen`,
      );
    }

    problems.push(
      ...checkScreenText(
        span.text,
        "plansza",
        allowedNumbers,
      ),
    );
  });

  const screenTexts = [
    hook,
    ...spans.map(
      (span) => span.text,
    ),
  ];

  for (
    let first = 0;
    first < screenTexts.length;
    first += 1
  ) {
    for (
      let second = first + 1;
      second <
      screenTexts.length;
      second += 1
    ) {
      const shared = [
        ...getStems(
          screenTexts[first],
        ),
      ].filter((stem) =>
        getStems(
          screenTexts[second],
        ).has(stem),
      );

      if (shared.length > 0) {
        problems.push(
          `"${screenTexts[first]}" i "${screenTexts[second]}" powtarzają to samo słowo — każda plansza ma wnosić nową informację`,
        );
      }
    }
  }

  let gap = 0;

  for (
    let scene = 2;
    scene <=
    sceneSeconds.length;
    scene += 1
  ) {
    const covered =
      spans.some(
        (span) =>
          scene >= span.from &&
          scene <= span.to,
      );

    gap = covered
      ? 0
      : gap + 1;

    if (gap === 2) {
      problems.push(
        `sceny ${scene - 1}-${scene} są bez napisu — najwyżej jedna scena z rzędu może być pusta`,
      );
    }
  }

  if (
    countWords(cover) >
      COVER_MAX_WORDS ||
    !cover
  ) {
    problems.push(
      `okładka "${cover}" — ma mieć 1-${COVER_MAX_WORDS} słowa`,
    );
  }

  problems.push(
    ...checkScreenText(
      cover,
      "okładka",
      allowedNumbers,
    ),
  );

  const firstLine =
    description.firstLine;

  if (
    !firstLine ||
    firstLine.length >
      FIRST_LINE_MAX_CHARS
  ) {
    problems.push(
      `pierwsza linia opisu ma ${firstLine.length} znaków — maks. ${FIRST_LINE_MAX_CHARS}`,
    );
  }

  const descriptionText = [
    firstLine,
    description.body,
  ].join("\n\n");

  if (
    /\[|uzupe/i.test(
      descriptionText,
    )
  ) {
    problems.push(
      "opis zawiera placeholder — braki wpisz do missing, nie do opisu",
    );
  }

  const forbidden =
    FORBIDDEN_PATTERNS.find(
      (pattern) =>
        descriptionText
          .toLowerCase()
          .includes(pattern),
    );

  if (forbidden) {
    problems.push(
      `opis zawiera zakazany wzorzec z briefu ("${forbidden}")`,
    );
  }

  getNumbers(descriptionText)
    .filter(
      (number) =>
        !allowedNumbers.has(
          number,
        ),
    )
    .forEach((number) => {
      problems.push(
        `opis ma liczbę ${number}, której nie ma w faktach ani w opisie scen`,
      );
    });

  const ctaLength =
    `Darmowa wycena: ${END_CARD.phone} lub ${END_CARD.web}`
      .length;

  const descriptionLength =
    descriptionText.length +
    ctaLength;

  if (
    descriptionLength <
      DESCRIPTION_CHARS[0] ||
    descriptionLength >
      DESCRIPTION_CHARS[1]
  ) {
    problems.push(
      `opis z CTA ma ${descriptionLength} znaków — ma mieć ok. 300-600`,
    );
  }

  const hashtags =
    description.hashtags.length;

  if (
    hashtags <
      HASHTAGS_RANGE[0] ||
    hashtags >
      HASHTAGS_RANGE[1]
  ) {
    problems.push(
      `hasztagów jest ${hashtags} — ma być ${HASHTAGS_RANGE[0]}-${HASHTAGS_RANGE[1]} tematycznych (bez exbram)`,
    );
  }

  return [
    ...new Set(problems),
  ];
};

const main = async () => {
  if (
    !process.env.OPENAI_API_KEY
  ) {
    throw new Error(
      "Brak OPENAI_API_KEY.",
    );
  }

  const editPlan = readJson(
    EDIT_FILE,
    null,
  );

  if (
    !editPlan ||
    !Array.isArray(
      editPlan.scenes,
    ) ||
    editPlan.scenes.length === 0
  ) {
    throw new Error(
      "Brak planu montażu w edit.json.",
    );
  }

  const brief = readBrief();

  const scenes =
    editPlan.scenes;

  const sceneList =
    describeScenes(scenes);

  const sceneSeconds =
    scenes.map((scene) =>
      Number(scene.duration),
    );

  /*
   * Liczby, które wolno pokazać: z faktów briefu i z opisów scen.
   */
  const allowedNumbers =
    new Set(
      getNumbers(
        [
          getFactsSection(
            brief,
          ),
          ...sceneList.map(
            (item) => item.shows,
          ),
        ].join("\n"),
      ),
    );

  const history =
    readTextHistory();

  let best = null;

  let feedback = "";

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt += 1
  ) {
    const raw =
      await requestCopy(
        buildPrompt({
          brief,
          sceneList,
          history,
          feedback,
        }),
      );

    const hook = cleanText(
      raw.hook,
    );

    const proposal = {
      type: cleanText(
        raw.type,
      ),
      angle: cleanText(
        raw.angle,
      ),
      hookVariants: (
        raw.hookVariants ?? []
      ).map(cleanText),
      hook,
      hookHighlight:
        cleanHighlight(
          raw.hookHighlight,
          hook,
        ),
      spans: normalizeSpans(
        raw.messages ?? [],
        scenes.length,
      ),
      cover: cleanText(
        raw.cover,
      ),
      description: {
        firstLine: cleanText(
          raw.description
            ?.firstLine,
        ),
        body: String(
          raw.description
            ?.body ?? "",
        ).trim(),
        hashtags: (
          raw.description
            ?.hashtags ?? []
        )
          .map((tag) =>
            String(tag)
              .replace(/^#+/, "")
              .replace(/\s+/g, "")
              .trim(),
          )
          .filter(Boolean),
      },
      missing: (
        raw.missing ?? []
      )
        .map(cleanText)
        .filter(Boolean),
    };

    const problems =
      findProblems({
        ...proposal,
        sceneSeconds,
        history,
        allowedNumbers,
      });

    console.log(
      `\nPróba ${attempt} (${COPY_MODEL}) — typ ${proposal.type}: ${proposal.angle}`,
    );

    console.log(
      `  hook: "${proposal.hook}"` +
        (proposal.hookHighlight
          ? ` [${proposal.hookHighlight}]`
          : ""),
    );

    proposal.spans.forEach(
      (span) =>
        console.log(
          `  sceny ${span.from}-${span.to}: "${span.text}"` +
            (span.highlight
              ? ` [${span.highlight}]`
              : ""),
        ),
    );

    console.log(
      `  okładka: "${proposal.cover}"`,
    );

    problems.forEach(
      (problem) =>
        console.log(
          `  ! ${problem}`,
        ),
    );

    if (
      !best ||
      problems.length <
        best.problems.length
    ) {
      best = {
        proposal,
        problems,
      };
    }

    if (
      problems.length === 0
    ) {
      break;
    }

    feedback = problems
      .map(
        (problem) =>
          `- ${problem}`,
      )
      .join("\n");
  }

  if (
    best.problems.length > 0
  ) {
    console.warn(
      `\nUWAGA: napisy mają ${best.problems.length} uwag po ${MAX_ATTEMPTS} próbach — biorę najlepszą wersję.`,
    );
  }

  const chosen =
    best.proposal;

  /*
   * Na wypadek, gdy najlepsza wersja wciąż ma za długie teksty —
   * żeby nie wyszły poza kadr.
   */
  const hook = fitText(
    chosen.hook,
    HOOK_MAX_CHARS,
  );

  const updatedScenes =
    scenes.map(
      (scene, index) => {
        const sceneNumber =
          index + 1;

        const span =
          chosen.spans.find(
            (item) =>
              sceneNumber >=
                item.from &&
              sceneNumber <=
                item.to,
          );

        const caption = span
          ? fitText(
              span.text,
              MESSAGE_MAX_CHARS,
            )
          : "";

        return {
          ...scene,
          caption,
          captionHighlight:
            span
              ? cleanHighlight(
                  span.highlight,
                  caption,
                )
              : "",
        };
      },
    );

  fs.writeFileSync(
    EDIT_FILE,
    `${JSON.stringify(
      {
        ...editPlan,
        hook,
        hookHighlight:
          cleanHighlight(
            chosen.hookHighlight,
            hook,
          ),
        cover: chosen.cover,
        scenes:
          updatedScenes,
        copy: {
          model: COPY_MODEL,
          type: chosen.type,
          angle: chosen.angle,
          hookVariants:
            chosen.hookVariants,
          description:
            chosen.description,
          missing:
            chosen.missing,
          problems:
            best.problems,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  rememberTexts([
    hook,
    ...chosen.spans.map(
      (span) => span.text,
    ),
  ]);

  if (
    chosen.missing.length > 0
  ) {
    console.log(
      "\nDo uzupełnienia w opisie:",
    );

    chosen.missing.forEach(
      (item) =>
        console.log(
          `- ${item}`,
        ),
    );
  }

  console.log(
    `\nZapisano napisy w ${EDIT_FILE}`,
  );
};

main().catch((error) => {
  /*
   * Napisy są dodatkiem — bez nich rolka dalej ma sens, więc błąd
   * (np. chwilowy problem z API) nie zatrzymuje pipeline'u.
   */
  console.warn(
    `\nUWAGA: nie udało się napisać napisów (${error.message}) — rolka powstanie bez nich.`,
  );

  const editPlan = readJson(
    EDIT_FILE,
    null,
  );

  if (
    editPlan &&
    Array.isArray(
      editPlan.scenes,
    )
  ) {
    const {
      copy,
      cover,
      hookHighlight,
      ...rest
    } = editPlan;

    fs.writeFileSync(
      EDIT_FILE,
      `${JSON.stringify(
        {
          ...rest,
          hook: "",
          scenes:
            editPlan.scenes.map(
              (scene) => ({
                ...scene,
                caption: "",
                captionHighlight:
                  "",
              }),
            ),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
});
