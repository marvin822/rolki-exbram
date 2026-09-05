import fs from "fs";
import path from "path";
import OpenAI from "openai";

const PUBLIC_DIR = path.join(
  process.cwd(),
  "public",
);

const PHOTOS_DIR = path.join(
  PUBLIC_DIR,
  "media",
  "photos",
);

const VIDEOS_DIR = path.join(
  PUBLIC_DIR,
  "media",
  "videos",
);

const ANALYSIS_FILE = path.join(
  process.cwd(),
  "analysis.json",
);

const VIDEO_ANALYSIS_FILE = path.join(
  process.cwd(),
  "video-analysis.json",
);

const EDIT_FILE = path.join(
  process.cwd(),
  "edit.json",
);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
];

const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
];

const getMimeType = (
  extension,
) => {
  switch (
    extension.toLowerCase()
  ) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";

    case ".png":
      return "image/png";

    case ".webp":
      return "image/webp";

    default:
      throw new Error(
        `Nieobsługiwane rozszerzenie obrazu: ${extension}`,
      );
  }
};

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

const writeJson = (
  filePath,
  data,
) => {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      data,
      null,
      2,
    ),
    "utf8",
  );
};

const getBase64Image = (
  filePath,
) => {
  return fs
    .readFileSync(filePath)
    .toString("base64");
};

const getFilesFromDirectory = (
  directory,
  extensions,
) => {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(
      directory,
      {
        withFileTypes: true,
      },
    )
    .filter(
      (entry) =>
        entry.isFile(),
    )
    .map(
      (entry) =>
        entry.name,
    )
    .filter(
      (file) =>
        extensions.includes(
          path
            .extname(file)
            .toLowerCase(),
        ),
    )
    .sort();
};

const getPhotoFiles = () => {
  return getFilesFromDirectory(
    PHOTOS_DIR,
    IMAGE_EXTENSIONS,
  );
};

const getVideoFiles = () => {
  return getFilesFromDirectory(
    VIDEOS_DIR,
    VIDEO_EXTENSIONS,
  );
};

const analyzeImage = async (
  file,
) => {
  const extension =
    path.extname(file);

  const filePath =
    path.join(
      PHOTOS_DIR,
      file,
    );

  const base64 =
    getBase64Image(
      filePath,
    );

  const mimeType =
    getMimeType(
      extension,
    );

  console.log(
    `Analizuję zdjęcie: ${file}`,
  );

  const response =
    await client.responses.create({
      model: "gpt-5-mini",

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_text",

              text: `
Przeanalizuj zdjęcie realizacji firmy produkującej ogrodzenia.

Potrzebujemy wykorzystać to zdjęcie w pionowym Reelu 1080x1920.

Oceń:
- co przedstawia zdjęcie,
- jaki jest główny obiekt/element,
- gdzie znajduje się główny punkt zainteresowania,
- czy lepszy będzie zoom czy przesunięcie obrazu,
- jak silny powinien być ruch.

Zasady:
- zoomIn stosuj, gdy główny obiekt znajduje się centralnie lub względnie centralnie,
- zoomOut stosuj tylko wtedy, gdy pokazanie całej realizacji daje wyraźnie lepszy efekt,
- panLeft stosuj, gdy interesujący obiekt znajduje się bardziej po lewej stronie,
- panRight stosuj, gdy interesujący obiekt znajduje się bardziej po prawej stronie,
- unikaj agresywnego ruchu,
- focusX i focusY podawaj jako procenty 0-100,
- motionStrength podawaj jako wartość 0-1.

Odpowiedz wyłącznie JSON-em zgodnym ze schematem.
              `,
            },

            {
              type: "input_image",

              image_url:
                `data:${mimeType};base64,${base64}`,
            },
          ],
        },
      ],

      text: {
        format: {
          type: "json_schema",

          name: "image_analysis",

          strict: true,

          schema: {
            type: "object",

            additionalProperties: false,

            properties: {
              file: {
                type: "string",
              },

              subject: {
                type: "string",
              },

              focusX: {
                type: "number",
              },

              focusY: {
                type: "number",
              },

              recommendedMotion: {
                type: "string",

                enum: [
                  "zoomIn",
                  "zoomOut",
                  "panLeft",
                  "panRight",
                ],
              },

              motionStrength: {
                type: "number",
              },

              confidence: {
                type: "number",
              },
            },

            required: [
              "file",
              "subject",
              "focusX",
              "focusY",
              "recommendedMotion",
              "motionStrength",
              "confidence",
            ],
          },
        },
      },
    });

  const result =
    JSON.parse(
      response.output_text,
    );

  return {
    ...result,
    file,
  };
};

const generateEditPlan = async ({
  images,
  videos,
}) => {
  const media = [
    ...images.map(
      (item) => ({
        file: item.file,

        type: "photo",

        subject:
          item.subject,

        recommendedMotion:
          item.recommendedMotion,

        motionStrength:
          item.motionStrength,

        confidence:
          item.confidence,
      }),
    ),

    ...videos.flatMap(
      (item) => {
        const fragments =
          Array.isArray(
            item.fragments,
          )
            ? item.fragments
            : [];

        if (
          fragments.length === 0
        ) {
          return [
            {
              file: item.file,

              fragmentId:
                `${item.file}#fragment-1`,

              type: "video",

              subject:
                item.subject,

              qualityScore:
                item.qualityScore,

              usable:
                item.usable,

              recommendedStart:
                item.refinedStart ??
                item.recommendedStart,

              recommendedDuration:
                item.refinedDuration ??
                item.recommendedDuration,

              refinedStart:
                item.refinedStart,

              refinedDuration:
                item.refinedDuration,

              confidence:
                item.confidence,
            },
          ];
        }

        return fragments.map(
          (fragment) => ({
            file: item.file,

            fragmentId:
              fragment.fragmentId,

            type: "video",

            subject:
              item.subject,

            qualityScore:
              fragment.qualityScore ??
              item.qualityScore,

            usable:
              fragment.usable ??
              item.usable,

            recommendedStart:
              fragment.refinedStart,

            recommendedDuration:
              fragment.refinedDuration,

            refinedStart:
              fragment.refinedStart,

            refinedDuration:
              fragment.refinedDuration,

            confidence:
              fragment.confidence ??
              item.confidence,
          }),
        );
      },
    ),
  ];

  console.log(
    "\nTworzę plan montażu...",
  );

  const response =
    await client.responses.create({
      model: "gpt-5-mini",

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_text",

              text: `
Jesteś doświadczonym montażystą krótkich reklamowych Reels dla firmy EXBRAM produkującej ogrodzenia.

Na podstawie dostępnych materiałów przygotuj atrakcyjną, dynamiczną rolkę prezentującą realizację.

MATERIAŁY:
${JSON.stringify(
  media,
  null,
  2,
)}

CEL DŁUGOŚCI:

- docelowa długość materiału przed planszą końcową: około 13-15 sekund,
- preferuj 6-7 scen,
- jeśli dostępnych jest wystarczająco dużo dobrych materiałów, wykorzystaj 6-7 różnych materiałów,
- nie skracaj rolki tylko dlatego, że można użyć mniejszej liczby scen,
- jednocześnie nigdy nie dodawaj słabego materiału wyłącznie po to, żeby osiągnąć długość,
- jakość i atrakcyjność są ważniejsze niż dokładne osiągnięcie czasu.

KOMPOZYCJA:

- zacznij od najmocniejszego wizualnie materiału,
- następnie pokazuj realizację z różnych perspektyw,
- przeplataj szersze ujęcia z detalami,
- unikaj kilku bardzo podobnych zdjęć jedno po drugim,
- mocny materiał może pojawić się bliżej końca,
- zakończ mocnym ujęciem realizacji,
- rolka ma sprawiać wrażenie profesjonalnego materiału reklamowego, a nie pokazu wszystkich zdjęć fotografa.

ZDJĘCIA:

- zwykle 2-3 sekundy,
- bardzo mocne zdjęcie może trwać około 3-3.5 sekundy,
- słabszego zdjęcia nie wydłużaj.

FILMY:

- wykorzystuj tylko wtedy, gdy są atrakcyjne i sprzedażowo przydatne,
- wybieraj konkretny fragment z listy fragmentów filmu,
- NIE wymyślaj nowego fragmentu,
- NIE zmieniaj fragmentId,
- NIE zmieniaj refinedStart,
- NIE zmieniaj refinedDuration,
- decyzja AI dla filmu ma dotyczyć przede wszystkim tego, czy konkretny fragment warto wykorzystać i w którym miejscu rolki go umieścić.

RÓŻNORODNOŚĆ:

- nie używaj tego samego zdjęcia więcej niż raz,
- tego samego fragmentu filmu nie używaj więcej niż raz,
- możesz użyć maksymalnie dwóch różnych fragmentów tego samego filmu,
- preferuj różne widoki tej samej realizacji,
- pokazuj zarówno całość, jak i detale,
- priorytetem jest produkt: ogrodzenie, brama, furtka, panele, detale wykonania.

WAŻNE:

1. Możesz wybierać WYŁĄCZNIE materiały znajdujące się na przekazanej liście.
2. Dla zdjęcia zwróć dokładnie wartość file z listy.
3. Dla filmu zwróć dokładnie wartość file oraz fragmentId z listy.
4. Nigdy nie twórz nazw plików samodzielnie.
5. Nigdy nie twórz własnego fragmentId.
6. Dla filmu nie zmieniaj czasu rozpoczęcia ani długości wybranego fragmentu.
7. Nie dodawaj żadnych innych plików.
8. Nie dodawaj napisów.
9. Nie dodawaj CTA.
10. Nie dodawaj muzyki.
11. Nie wymyślaj treści, których nie potwierdza analiza materiału.
12. Pole reason krótko wyjaśnia decyzję montażową.
13. duration podawaj w sekundach.
14. Dla zdjęć wybieraj zwykle 2-3 sekundy.
15. Preferuj 6-7 scen, jeżeli materiał na to pozwala.
16. Całość materiału przed planszą końcową powinna być zwykle blisko 13-15 sekund.
17. Jeśli do osiągnięcia 13-15 sekund potrzebny jest dodatkowy dobry materiał, wybierz go.
18. Jeśli dodatkowy materiał jest wyraźnie słaby, pomiń go zamiast sztucznie wydłużać rolkę.

Zwróć wyłącznie JSON zgodny ze schematem.
              `,
            },
          ],
        },
      ],

      text: {
        format: {
          type: "json_schema",

          name: "edit_plan",

          strict: true,

          schema: {
            type: "object",

            additionalProperties: false,

            properties: {
              scenes: {
                type: "array",

                minItems: 1,

                maxItems: 8,

                items: {
                  type: "object",

                  additionalProperties: false,

                  properties: {
                    file: {
                      type: "string",
                    },

                    fragmentId: {
                      type: "string",
                    },

                    duration: {
                      type: "number",
                    },

                    start: {
                      type: "number",
                    },

                    reason: {
                      type: "string",
                    },
                  },

                  required: [
                    "file",
                    "fragmentId",
                    "duration",
                    "start",
                    "reason",
                  ],
                },
              },
            },

            required: [
              "scenes",
            ],
          },
        },
      },
    });

  if (
    !response.output_text
  ) {
    throw new Error(
      "AI nie zwróciło planu montażu.",
    );
  }

  const plan =
    JSON.parse(
      response.output_text,
    );

  console.log(
    "\nAI RAW PLAN:",
  );

  console.log(
    JSON.stringify(
      plan,
      null,
      2,
    ),
  );

  const allowedMedia =
    new Map(
      media.map(
        (item) => [
          `${item.file}::${item.fragmentId ?? ""}`,
          item,
        ],
      ),
    );

  const validatedScenes = [];

  for (
    const scene of
      plan.scenes
  ) {
    const fragmentId =
      scene.fragmentId ?? "";

    const key =
      `${scene.file}::${fragmentId}`;

    const item =
      allowedMedia.get(key);

    if (!item) {
      continue;
    }

    if (
      item.type === "photo"
    ) {
      validatedScenes.push({
        file:
          item.file,

        fragmentId: "",

        duration:
          Math.min(
            4,
            Math.max(
              2,
              Number(
                scene.duration,
              ) || 3,
            ),
          ),

        start: 0,

        reason:
          scene.reason,
      });

      continue;
    }

    const start =
      Number(
        item.refinedStart,
      );

    const duration =
      Number(
        item.refinedDuration,
      );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(duration)
    ) {
      continue;
    }

    validatedScenes.push({
      file:
        item.file,

      fragmentId:
        item.fragmentId,

      duration:
        Math.min(
          5,
          Math.max(
            1,
            duration,
          ),
        ),

      start:
        Math.max(
          0,
          start,
        ),

      reason:
        scene.reason,
    });
  }

  const uniqueScenes = [];

  const usedPhotos =
    new Set();

  const usedFragments =
    new Set();

  const videoUsage =
    new Map();

  for (
    const scene of
      validatedScenes
  ) {
    if (
      scene.fragmentId
    ) {
      if (
        usedFragments.has(
          scene.fragmentId,
        )
      ) {
        continue;
      }

      const currentUsage =
        videoUsage.get(
          scene.file,
        ) || 0;

      if (
        currentUsage >= 2
      ) {
        continue;
      }

      usedFragments.add(
        scene.fragmentId,
      );

      videoUsage.set(
        scene.file,
        currentUsage + 1,
      );

      uniqueScenes.push(
        scene,
      );

      continue;
    }

    if (
      usedPhotos.has(
        scene.file,
      )
    ) {
      continue;
    }

    usedPhotos.add(
      scene.file,
    );

    uniqueScenes.push(
      scene,
    );
  }

  if (
    uniqueScenes.length === 0
  ) {
    throw new Error(
      "AI nie wygenerowało żadnej prawidłowej sceny.",
    );
  }

  return {
    scenes:
      uniqueScenes,
  };
};

const main = async () => {
  if (
    !process.env.OPENAI_API_KEY
  ) {
    throw new Error(
      "Brak OPENAI_API_KEY w zmiennych środowiskowych.",
    );
  }

  if (
    !fs.existsSync(
      PHOTOS_DIR,
    )
  ) {
    throw new Error(
      `Nie znaleziono katalogu zdjęć: ${PHOTOS_DIR}`,
    );
  }

  if (
    !fs.existsSync(
      VIDEOS_DIR,
    )
  ) {
    throw new Error(
      `Nie znaleziono katalogu filmów: ${VIDEOS_DIR}`,
    );
  }

  const imageFiles =
    getPhotoFiles();

  const videoFiles =
    getVideoFiles();

  console.log(
    `\nZdjęcia: ${imageFiles.length}`,
  );

  console.log(
    `Filmy: ${videoFiles.length}`,
  );

  console.log(
    "\nMateriały wejściowe:",
  );

  imageFiles.forEach(
    (file) =>
      console.log(
        `- media/photos/${file}`,
      ),
  );

  videoFiles.forEach(
    (file) =>
      console.log(
        `- media/videos/${file}`,
      ),
  );

  let analysis =
    readJson(
      ANALYSIS_FILE,
      [],
    );

  const existingAnalysis =
    new Map(
      analysis.map(
        (item) => [
          item.file,
          item,
        ],
      ),
    );

  for (
    const file of
      imageFiles
  ) {
    if (
      existingAnalysis.has(
        file,
      )
    ) {
      console.log(
        `Pomijam istniejącą analizę: ${file}`,
      );

      continue;
    }

    const result =
      await analyzeImage(
        file,
      );

    existingAnalysis.set(
      file,
      result,
    );
  }

  analysis =
    imageFiles.map(
      (file) =>
        existingAnalysis.get(
          file,
        ),
    );

  writeJson(
    ANALYSIS_FILE,
    analysis,
  );

  console.log(
    `\nZapisano ${ANALYSIS_FILE}`,
  );

  const videoAnalysis =
    readJson(
      VIDEO_ANALYSIS_FILE,
      [],
    );

  const validVideoAnalysis =
    videoFiles
      .map(
        (file) =>
          videoAnalysis.find(
            (item) =>
              item.file ===
              file,
          ),
      )
      .filter(Boolean);

  if (
    videoFiles.length > 0 &&
    validVideoAnalysis.length !==
      videoFiles.length
  ) {
    console.warn(
      "\nUWAGA: Nie wszystkie filmy mają jeszcze video-analysis.json.",
    );
  }

  const editPlan =
    await generateEditPlan({
      images: analysis,
      videos:
        validVideoAnalysis,
    });

  writeJson(
    EDIT_FILE,
    editPlan,
  );

  console.log(
    `\nZapisano ${EDIT_FILE}`,
  );

  console.log(
    "\nPLAN:",
  );

  editPlan.scenes.forEach(
    (scene, index) => {
      console.log(
        `${index + 1}. ${scene.file}` +
        `${
          scene.fragmentId
            ? ` | ${scene.fragmentId}`
            : ""
        }` +
        ` | ${scene.duration}s` +
        ` | start ${scene.start}s`,
      );
    },
  );
};

main().catch(
  (error) => {
    console.error(
      "\nBłąd:",
      error.message,
    );

    process.exit(1);
  },
);