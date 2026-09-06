import OpenAI from "openai";
import fs from "fs";
import path from "path";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const framesDir = "./video-frames";
const videoAnalysisPath = "./video-analysis.json";

const supportedImageExtensions = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
];

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "Brak OPENAI_API_KEY.",
  );
  process.exit(1);
}

if (!fs.existsSync(framesDir)) {
  console.error(
    `Nie znaleziono katalogu: ${framesDir}`,
  );
  process.exit(1);
}

const getMimeType = (filePath) => {
  const extension = path
    .extname(filePath)
    .toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";

    case ".png":
      return "image/png";

    case ".webp":
      return "image/webp";

    default:
      throw new Error(
        `Nieobsługiwany format obrazu: ${extension}`,
      );
  }
};

const getBase64 = (filePath) => {
  return fs
    .readFileSync(filePath)
    .toString("base64");
};

const getFrameFiles = (videoDir) => {
  return fs
    .readdirSync(videoDir)
    .filter((file) => {
      const extension = path
        .extname(file)
        .toLowerCase();

      return (
        supportedImageExtensions.includes(
          extension,
        )
      );
    })
    .sort();
};

const getFramePercentage = (
  fileName,
  totalFrames,
) => {
  const match =
    fileName.match(
      /frame-(\d+)/i,
    );

  if (!match) {
    return null;
  }

  const frameNumber =
    Number(match[1]);

  if (
    !Number.isFinite(frameNumber) ||
    !Number.isFinite(totalFrames) ||
    totalFrames <= 0
  ) {
    return null;
  }

  return (
    ((frameNumber) /
      (totalFrames + 1)) *
    100
  );
};

const analyzeVideo = async (
  videoFile,
  frameFiles,
) => {
  console.log(
    `\nAnalizuję film: ${videoFile}`,
  );

  const totalFrames =
    frameFiles.length;

  const content = [
    {
      type: "input_text",
      text: `
Przeanalizuj materiał filmowy z realizacji firmy EXBRAM produkującej ogrodzenia.

Dostałeś ${totalFrames} reprezentatywnych klatek filmu.

Klatki są rozmieszczone równomiernie w całym materiale.
Odpowiadają mniej więcej następującym momentom filmu:

${frameFiles
  .map((file) => {
    const percentage =
      getFramePercentage(
        file,
        totalFrames,
      );

    return `- ${file}: około ${percentage?.toFixed(1) ?? "nieznany"}% filmu`;
  })
  .join("\n")}

Na podstawie wszystkich klatek oceń:

1. Co przedstawia film.
2. Czy film nadaje się do wykorzystania w krótkim Reelu reklamowym.
3. Jakość materiału.
4. Który fragment całego filmu jest najlepszy.
5. Od którego miejsca warto rozpocząć pokazanie filmu.
6. Jak długo najlepiej go pokazywać.
7. Czy materiał powinien być pokazany jako:
   - "crop" — wypełnić cały pionowy kadr 1080x1920, przycinając boki,
   - "fit" — zachować cały kadr i dopasować go do pionowego formatu.
8. Jeśli wybrano "crop", określ główny punkt zainteresowania.
9. focusX i focusY podaj jako procenty 0-100.
10. Nie wybieraj agresywnego kadrowania, jeśli mogłoby ono uciąć najważniejszy element ogrodzenia.

Przy wyborze fragmentu kieruj się przede wszystkim:

- widocznością ogrodzenia,
- wielkością ogrodzenia w kadrze,
- czytelnością bramy, przęseł i innych elementów realizacji,
- atrakcyjnością wizualną dla potencjalnego klienta,
- kompozycją odpowiednią do pionowego Reela 9:16,
- ilością pustej przestrzeni,
- jakością obrazu,
- ruchem kamery,
- możliwością pokazania realizacji w sposób atrakcyjny marketingowo.

Nie wybieraj fragmentu tylko dlatego, że kamera wykonuje płynny ruch.

Najważniejsze jest pokazanie produktu EXBRAM w atrakcyjny i czytelny sposób.

Ważne:
- analizujesz rzeczywisty materiał,
- nie wymyślaj szczegółów, których nie widać,
- jeśli film jest słabej jakości, możesz ustawić usable=false,
- recommendedStart podaj w sekundach,
- recommendedDuration podaj w sekundach,
- framing musi być "crop" albo "fit",
- focusX/focusY opisują punkt, który powinien pozostać w centrum podczas kadrowania,
- recommendedStart i recommendedDuration mają wskazywać najlepszy rzeczywisty fragment całego filmu, a nie tylko jedną z dostarczonych klatek,
- możesz wybrać fragment znajdujący się pomiędzy dostarczonymi klatkami,
- nie zakładaj, że najlepszy fragment znajduje się w środku filmu.

Zwróć wyłącznie JSON zgodny ze schematem.
      `,
    },
  ];

  for (const file of frameFiles) {
    const framePath = path.join(
      framesDir,
      path.parse(videoFile)
        .name,
      file,
    );

    const mimeType =
      getMimeType(framePath);

    const base64 =
      getBase64(framePath);

    content.push({
      type: "input_image",
      image_url:
        `data:${mimeType};base64,${base64}`,
    });
  }

  const response =
    await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "user",
          content,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "video_analysis",
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

              qualityScore: {
                type: "number",
              },

              usable: {
                type: "boolean",
              },

              startDescription: {
                type: "string",
              },

              endDescription: {
                type: "string",
              },

              recommendedStart: {
                type: "number",
              },

              recommendedDuration: {
                type: "number",
              },

              framing: {
                type: "string",
                enum: [
                  "crop",
                  "fit",
                ],
              },

              focusX: {
                type: "number",
              },

              focusY: {
                type: "number",
              },

              confidence: {
                type: "number",
              },
            },

            required: [
              "file",
              "subject",
              "qualityScore",
              "usable",
              "startDescription",
              "endDescription",
              "recommendedStart",
              "recommendedDuration",
              "framing",
              "focusX",
              "focusY",
              "confidence",
            ],
          },
        },
      },
    });

  if (!response.output_text) {
    throw new Error(
      `AI nie zwróciło analizy filmu ${videoFile}.`,
    );
  }

  return JSON.parse(
    response.output_text,
  );
};

const main = async () => {
  const videoDirs = fs
    .readdirSync(
      framesDir,
      {
        withFileTypes: true,
      },
    )
    .filter(
      (entry) =>
        entry.isDirectory(),
    )
    .map(
      (entry) => entry.name,
    );

  if (
    videoDirs.length === 0
  ) {
    console.log(
      "Nie znaleziono klatek filmów.",
    );

    /*
     * Zestaw bez filmów (same zdjęcia). Czyścimy analizę wideo,
     * żeby nie został po poprzednim zestawie wpis wskazujący na
     * nieistniejący już plik — inaczej kolejne kroki próbują go
     * czytać i sypią błędami.
     */
    fs.writeFileSync(
      videoAnalysisPath,
      "[]\n",
      "utf8",
    );

    process.exit(0);
  }

  const videos = [];

  for (
    const videoFile of videoDirs
  ) {
    const videoDir =
      path.join(
        framesDir,
        videoFile,
      );

    const frameFiles =
      getFrameFiles(
        videoDir,
      );

    if (
      frameFiles.length === 0
    ) {
      console.warn(
        `Brak klatek dla ${videoFile}. Pomijam.`,
      );
      continue;
    }

    const result =
      await analyzeVideo(
        `${videoFile}.mov`,
        frameFiles,
      );

    result.file =
      `${videoFile}.mov`;

    result.qualityScore =
      Math.min(
        1,
        Math.max(
          0,
          Number(
            result.qualityScore,
          ) || 0,
        ),
      );

    result.confidence =
      Math.min(
        1,
        Math.max(
          0,
          Number(
            result.confidence,
          ) || 0,
        ),
      );

    result.focusX =
      Math.min(
        100,
        Math.max(
          0,
          Number(
            result.focusX,
          ) || 50,
        ),
      );

    result.focusY =
      Math.min(
        100,
        Math.max(
          0,
          Number(
            result.focusY,
          ) || 50,
        ),
      );

    result.recommendedStart =
      Math.max(
        0,
        Number(
          result.recommendedStart,
        ) || 0,
      );

    result.recommendedDuration =
      Math.min(
        8,
        Math.max(
          1,
          Number(
            result.recommendedDuration,
          ) || 4,
        ),
      );

    videos.push(
      result,
    );
  }

  fs.writeFileSync(
    videoAnalysisPath,
    JSON.stringify(
      videos,
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `\nZapisano ${videoAnalysisPath}`,
  );

  console.log(
    "\nANALIZA FILMÓW:",
  );

  for (const video of videos) {
    console.log(
      `\n${video.file}`,
    );

    console.log(
      `usable: ${video.usable}`,
    );

    console.log(
      `qualityScore: ${video.qualityScore}`,
    );

    console.log(
      `start: ${video.recommendedStart}s`,
    );

    console.log(
      `duration: ${video.recommendedDuration}s`,
    );

    console.log(
      `framing: ${video.framing}`,
    );

    console.log(
      `focus: ${video.focusX}, ${video.focusY}`,
    );
  }
};

main().catch(
  (error) => {
    console.error(
      "\nBŁĄD:",
    );

    console.error(
      error.message,
    );

    process.exit(1);
  },
);