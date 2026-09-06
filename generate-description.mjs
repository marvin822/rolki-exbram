import fs from "fs";
import path from "path";
import OpenAI from "openai";

const CWD = process.cwd();

const EDIT_FILE = path.join(
  CWD,
  "edit.json",
);

const ANALYSIS_FILE = path.join(
  CWD,
  "analysis.json",
);

const VIDEO_ANALYSIS_FILE = path.join(
  CWD,
  "video-analysis.json",
);

const OUTPUT_FILE = path.join(
  CWD,
  "opis.txt",
);

/*
 * Elementy doklejane ZAWSZE, niezależnie od tego, co zwróci model:
 * jedno wezwanie do działania, dane kontaktowe i hasztagi marki.
 */
const CTA_LINE =
  "Planujesz ogrodzenie? Napisz do nas — przygotujemy rozwiązanie dopasowane do Twojej posesji.";

const CONTACT_LINES = [
  "www.exbram.pl",
  "biuro@exbram.pl",
  "502 492 009",
];

const BASE_HASHTAGS = [
  "ogrodzenia",
  "EXBRAM",
];

const MAX_HASHTAGS = 7;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const readJson = (
  filePath,
  fallback,
) => {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        filePath,
        "utf8",
      ),
    );
  } catch (error) {
    throw new Error(
      `Nie można odczytać ${filePath}: ${error.message}`,
    );
  }
};

const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
];

const isVideoScene = (scene) => {
  const extension = path
    .extname(scene.file)
    .toLowerCase();

  return (
    VIDEO_EXTENSIONS.includes(
      extension,
    ) ||
    Boolean(scene.fragmentId)
  );
};

/*
 * Dla każdej sceny z planu montażu wyciągamy krótki opis
 * z wcześniejszych analiz AI (analysis.json / video-analysis.json).
 */
const describeScene = ({
  scene,
  photoMap,
  videoMap,
}) => {
  if (isVideoScene(scene)) {
    const video =
      videoMap.get(scene.file);

    if (!video) {
      return {
        typ: "film",
        opis: "fragment realizacji EXBRAM",
      };
    }

    const fragment = Array.isArray(
      video.fragments,
    )
      ? video.fragments.find(
          (item) =>
            item.fragmentId ===
            scene.fragmentId,
        )
      : null;

    const detail =
      fragment?.reason ||
      video.reason ||
      "";

    return {
      typ: "film",
      opis: [
        video.subject,
        detail,
      ]
        .filter(Boolean)
        .join(" — "),
    };
  }

  const photo = photoMap.get(
    scene.file,
  );

  return {
    typ: "zdjęcie",
    opis:
      photo?.subject ||
      "realizacja ogrodzenia EXBRAM",
  };
};

const normalizeHashtag = (tag) => {
  const cleaned = String(tag)
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .replace(
      /[^\p{L}\p{N}_]/gu,
      "",
    );

  return cleaned
    ? `#${cleaned}`
    : "";
};

const buildHashtagLine = (
  modelHashtags,
) => {
  const all = [
    ...BASE_HASHTAGS,
    ...(Array.isArray(
      modelHashtags,
    )
      ? modelHashtags
      : []),
  ]
    .map(normalizeHashtag)
    .filter(Boolean);

  const seen = new Set();
  const unique = [];

  for (const tag of all) {
    const key =
      tag.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(tag);
  }

  return unique
    .slice(0, MAX_HASHTAGS)
    .join(" ");
};

const generateDescription =
  async (materials) => {
    const response =
      await client.responses.create(
        {
          model: "gpt-5-mini",

          input: [
            {
              role: "user",

              content: [
                {
                  type: "input_text",

                  text: `
Jesteś copywriterem marketingowym firmy EXBRAM — producenta ogrodzeń,
bram, furtek oraz balustrad.

Na podstawie listy ujęć z krótkiej rolki (Reel) napisz opis, który klient
wrzuci pod rolką na Facebooku i Instagramie.

UJĘCIA W ROLCE (kolejność montażu):
${JSON.stringify(
  materials,
  null,
  2,
)}

Pole "description" ma zawierać DOKŁADNIE trzy części, jedna po drugiej,
każda jako osobny akapit oddzielony pustą linią:

1. HOOK — jedno zdanie, które zatrzymuje uwagę i mówi, co widzimy.
   Wzór: "Kolejna realizacja EXBRAM — tym razem <co to jest>."
   Dopasuj końcówkę do materiału (np. nowoczesne ogrodzenie posesji,
   ogrodzenie z ażurowym panelem, brama z automatyką).

2. KONKRETY REALIZACJI — 1-3 zdania. Wyciągnij z analizy konkretne cechy:
   - rodzaj ogrodzenia (np. panelowe, ażurowe, poziome, nowoczesne),
   - kolor (np. antracyt, czarny) — tylko jeśli wynika z analizy,
   - materiał (np. stal, aluminium, blacha) — tylko jeśli wynika z analizy,
   - rodzaj bramy / furtki (np. dwuskrzydłowa, przesuwna) — jeśli występuje,
   - charakterystyczne rozwiązania (np. wycinany motyw drzewa, kamienne
     słupki, podmurówka, spójna balustrada w tym samym wzorze).
   Podawaj wyłącznie to, co potwierdza analiza. Nie zgaduj.

3. KORZYŚĆ / EFEKT — jedno zdanie o tym, co ta realizacja daje właścicielowi
   posesji (forma, spójny wygląd, prywatność, zabezpieczenie, trwałość,
   dopasowanie do bryły domu). Nie "wykonaliśmy ogrodzenie", tylko efekt.

W polu "description" NIE dodawaj: wezwania do działania (CTA), adresu strony,
e-maila, telefonu ani hasztagów — dokleimy je osobno.

Język polski, ton naturalny i konkretny, bez clickbaitu i bez wykrzykników.

HASZTAGI (pole "hashtags"):
- zwróć 3-6 hasztagów sensownych dla tej realizacji
  (np. ogrodzenie, brama, posesja, producentogrodzeń, nowoczesneogrodzenie),
- bez znaku #, bez spacji w środku,
- #ogrodzenia i #EXBRAM są dokładane automatycznie, więc ich nie podawaj.

Zwróć wyłącznie JSON zgodny ze schematem.
                `,
                },
              ],
            },
          ],

          text: {
            format: {
              type: "json_schema",

              name: "reel_description",

              strict: true,

              schema: {
                type: "object",

                additionalProperties: false,

                properties: {
                  description: {
                    type: "string",
                  },

                  hashtags: {
                    type: "array",

                    minItems: 3,

                    maxItems: 8,

                    items: {
                      type: "string",
                    },
                  },
                },

                required: [
                  "description",
                  "hashtags",
                ],
              },
            },
          },
        },
      );

    if (!response.output_text) {
      throw new Error(
        "AI nie zwróciło opisu rolki.",
      );
    }

    return JSON.parse(
      response.output_text,
    );
  };

const main = async () => {
  if (
    !process.env.OPENAI_API_KEY
  ) {
    throw new Error(
      "Brak OPENAI_API_KEY w zmiennych środowiskowych.",
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
      "Nie znaleziono prawidłowego edit.json. Najpierw uruchom analizę materiałów.",
    );
  }

  const photoAnalysis = readJson(
    ANALYSIS_FILE,
    [],
  );

  const videoAnalysis = readJson(
    VIDEO_ANALYSIS_FILE,
    [],
  );

  if (
    photoAnalysis.length === 0 &&
    videoAnalysis.length === 0
  ) {
    console.warn(
      "UWAGA: brak analysis.json i video-analysis.json — opis powstanie na uboższych danych.",
    );
  }

  const photoMap = new Map(
    photoAnalysis.map((item) => [
      item.file,
      item,
    ]),
  );

  const videoMap = new Map(
    videoAnalysis.map((item) => [
      item.file,
      item,
    ]),
  );

  const materials =
    editPlan.scenes.map(
      (scene) =>
        describeScene({
          scene,
          photoMap,
          videoMap,
        }),
    );

  console.log(
    `\nMateriały w rolce: ${materials.length}`,
  );

  materials.forEach(
    (item, index) => {
      console.log(
        `${index + 1}. [${item.typ}] ${item.opis}`,
      );
    },
  );

  console.log(
    "\nPiszę opis rolki...",
  );

  const result =
    await generateDescription(
      materials,
    );

  const description = String(
    result.description || "",
  ).trim();

  if (!description) {
    throw new Error(
      "AI zwróciło pusty opis.",
    );
  }

  const hashtagLine =
    buildHashtagLine(
      result.hashtags,
    );

  const fileContent = [
    description,
    "",
    CTA_LINE,
    "",
    ...CONTACT_LINES,
    "",
    hashtagLine,
    "",
  ].join("\n");

  fs.writeFileSync(
    OUTPUT_FILE,
    fileContent,
    "utf8",
  );

  console.log(
    "\n========================================",
  );

  console.log(
    "OPIS ROLKI",
  );

  console.log(
    "========================================\n",
  );

  console.log(fileContent);

  console.log(
    `Zapisano: ${OUTPUT_FILE}`,
  );
};

main().catch((error) => {
  console.error(
    "\nBłąd:",
    error.message,
  );

  process.exit(1);
});
