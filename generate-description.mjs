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
 * Stała stopka doklejana ZAWSZE na końcu opisu,
 * niezależnie od tego, co zwróci model.
 */
const CONTACT_LINES = [
  "www.exbram.pl",
  "biuro@exbram.pl",
  "502 492 009",
];

/*
 * Hasztagi marki, które zawsze mają się znaleźć w opisie.
 * Model dokłada do nich hasztagi związane z treścią ujęć.
 */
const BASE_HASHTAGS = [
  "exbram",
  "ogrodzenia",
];

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
    )
    .toLowerCase();

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
    .slice(0, 15)
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
Jesteś copywriterem marketingowym firmy EXBRAM — producenta nowoczesnych
i klasycznych ogrodzeń, bram, furtek oraz balustrad.

Na podstawie listy ujęć z krótkiej rolki (Reel) napisz opis, który klient
wrzuci pod rolką na Facebooku i Instagramie.

UJĘCIA W ROLCE (kolejność montażu):
${JSON.stringify(
  materials,
  null,
  2,
)}

ZASADY OPISU:
- język polski,
- 2-4 krótkie zdania,
- ton marketingowy, ale naturalny i przystępny — bez clickbaitu,
  bez wielkich obietnic, bez nadmiaru wykrzykników,
- opisz krótko, co widać w materiale (rodzaj ogrodzenia, brama, furtka,
  panele, balustrada, motyw zdobienia, kontekst realizacji),
- możesz delikatnie zachęcić do kontaktu, ale NIE podawaj w tym polu
  adresu strony, e-maila ani telefonu — dane kontaktowe dokleimy osobno,
- NIE dodawaj hasztagów w polu description,
- nie wymyślaj szczegółów, których nie ma na liście ujęć.

HASZTAGI:
- zwróć 8-12 hasztagów po polsku,
- bez znaku #, bez spacji w środku,
- połącz hasztagi marki i branży (np. ogrodzenia, brama, furtka, panele,
  kowalstwo, realizacja) z hasztagami wynikającymi z treści ujęć,
- małe litery.

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

                    minItems: 5,

                    maxItems: 15,

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
