import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import OpenAI from "openai";

const publicDir = "./public";
const videosDir = path.join(
  publicDir,
  "media",
  "videos",
);
const framesDir = "./video-frames";
const detailFramesDir = "./video-frames-detail";
const analysisFile = "./video-analysis.json";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DETAIL_FRAME_COUNT = 12;
const SAFE_END_MARGIN = 0.08;
const MAX_CANDIDATES = 4;
const CANDIDATE_DURATION = 5;

function getVideoDuration(filePath) {
  const output = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    {
      encoding: "utf8",
    },
  ).trim();

  const duration = Number(output);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      `Nieprawidłowa długość filmu: ${output}`,
    );
  }

  return duration;
}

function imageToDataUrl(filePath) {
  const extension =
    path.extname(filePath).toLowerCase();

  let mimeType = "image/jpeg";

  if (extension === ".png") {
    mimeType = "image/png";
  } else if (extension === ".webp") {
    mimeType = "image/webp";
  }

  const base64 = fs
    .readFileSync(filePath)
    .toString("base64");

  return `data:${mimeType};base64,${base64}`;
}

function getOverviewFrames(fileName) {
  const baseName = path.parse(fileName).name;

  const directory = path.join(
    framesDir,
    baseName,
  );

  if (!fs.existsSync(directory)) {
    throw new Error(
      `Nie znaleziono klatek overview: ${directory}`,
    );
  }

  const files = fs
    .readdirSync(directory)
    .filter((file) =>
      /\.(jpg|jpeg|png|webp)$/i.test(file),
    )
    .sort();

  if (files.length === 0) {
    throw new Error(
      `Brak klatek overview dla: ${fileName}`,
    );
  }

  return files.map((file, index) => ({
    file,
    path: path.join(directory, file),
    index,
  }));
}

function getFrameTimestamp(
  index,
  frameCount,
  duration,
) {
  /*
   * extract-video-frames.mjs tworzy klatki mniej więcej
   * w pozycjach:
   *
   * (i + 1) / (FRAME_COUNT + 1)
   *
   * Odtwarzamy tutaj tę samą logikę.
   */

  return (
    duration *
    ((index + 1) /
      (frameCount + 1))
  );
}

async function findVideoCandidates({
  fileName,
  actualDuration,
}) {
  const overviewFrames =
    getOverviewFrames(fileName);

  console.log(
    `\nAnalizuję cały film: ${fileName}`,
  );

  console.log(
    `Długość: ${actualDuration.toFixed(2)} s`,
  );

  console.log(
    `Klatek overview: ${overviewFrames.length}`,
  );

  const content = [
    {
      type: "input_text",
      text: `
Jesteś ekspertem od montażu reklamowych Reels dla firmy EXBRAM,
producenta ogrodzeń, bram, furtek i balustrad.

Masz znaleźć NAJLEPSZE MOMENTY z całego filmu.

Film:
${fileName}

Rzeczywista długość:
${actualDuration.toFixed(3)} s

Otrzymujesz reprezentatywne klatki z całego filmu.
Każda klatka ma podany dokładny przybliżony czas.

Twoim zadaniem jest wskazać maksymalnie ${MAX_CANDIDATES}
najlepszych fragmentów, które później zostaną dokładnie przeanalizowane.

To NIE jest jeszcze finalny wybór fragmentów.
Szukasz dobrych KANDYDATÓW.

NAJWAŻNIEJSZE KRYTERIA:

1. Produkt EXBRAM musi być dobrze widoczny.
2. Ogrodzenie, brama, furtka, panel lub balustrada powinny
   zajmować dużą część kadru.
3. Kadr powinien dobrze działać po przycięciu do 9:16.
4. Preferuj momenty sprzedażowe i estetyczne.
5. Preferuj momenty, w których produkt jest łatwy do rozpoznania.
6. Unikaj dużych powierzchni asfaltu, kostki, nieba,
   pustych ścian i innych nieistotnych elementów.
7. Płynny ruch kamery jest zaletą, ale NIE jest ważniejszy
   od widoczności produktu.
8. Nie wybieraj fragmentu tylko dlatego, że kamera się porusza.
9. Szukaj różnych części realizacji.
10. Jeżeli film pokazuje kilka różnych elementów ogrodzenia,
    mogą one być osobnymi kandydatami.

BARDZO WAŻNE:

- Kandydaci mogą być oddaleni od siebie.
- Nie wybieraj czterech fragmentów pokazujących praktycznie to samo.
- Jeżeli cały film jest słaby, zwróć mniej kandydatów.
- Nie wymyślaj momentów, których nie widać.
- Czas startu powinien znajdować się w pobliżu analizowanych klatek.
- Kandydat powinien mieć zwykle około 4-5 sekund.
- Możesz podać krótszy lub dłuższy zakres, jeśli sytuacja tego wymaga.
- Nie wychodź poza długość filmu.

DLA KAŻDEGO KANDYDATA ZWRÓĆ:

- start
- duration
- qualityScore
- reason

qualityScore:
0-1, gdzie 1 oznacza bardzo dobry materiał reklamowy.

Zwróć maksymalnie ${MAX_CANDIDATES} kandydatów.
Nie musisz wykorzystać całego limitu.

Zwróć WYŁĄCZNIE JSON.
      `,
    },
  ];

  overviewFrames.forEach(
    (frame, index) => {
      const timestamp =
        getFrameTimestamp(
          index,
          overviewFrames.length,
          actualDuration,
        );

      content.push({
        type: "input_text",
        text: `KLATKA ${String(index + 1).padStart(2, "0")} — około ${timestamp.toFixed(2)} s`,
      });

      content.push({
        type: "input_image",
        image_url:
          imageToDataUrl(
            frame.path,
          ),
        detail: "high",
      });
    },
  );

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

          name: "video_candidates",

          strict: true,

          schema: {
            type: "object",

            additionalProperties: false,

            properties: {
              candidates: {
                type: "array",

                minItems: 1,

                maxItems: MAX_CANDIDATES,

                items: {
                  type: "object",

                  additionalProperties: false,

                  properties: {
                    start: {
                      type: "number",
                    },

                    duration: {
                      type: "number",
                    },

                    qualityScore: {
                      type: "number",
                    },

                    reason: {
                      type: "string",
                    },
                  },

                  required: [
                    "start",
                    "duration",
                    "qualityScore",
                    "reason",
                  ],
                },
              },
            },

            required: [
              "candidates",
            ],
          },
        },
      },
    });

  const result =
    JSON.parse(
      response.output_text,
    );

  return result.candidates || [];
}

function normalizeCandidate(
  candidate,
  actualDuration,
) {
  const safeDuration = Math.max(
    0.1,
    actualDuration -
      SAFE_END_MARGIN,
  );

  let start =
    Number(candidate.start);

  let duration =
    Number(candidate.duration);

  if (!Number.isFinite(start)) {
    start = 0;
  }

  if (!Number.isFinite(duration)) {
    duration = CANDIDATE_DURATION;
  }

  duration = Math.max(
    2,
    Math.min(6, duration),
  );

  start = Math.max(
    0,
    Math.min(
      start,
      safeDuration - 0.1,
    ),
  );

  if (
    start + duration >
    safeDuration
  ) {
    start = Math.max(
      0,
      safeDuration - duration,
    );
  }

  duration = Math.min(
    duration,
    safeDuration - start,
  );

  return {
    start,
    duration,
    end: start + duration,
    qualityScore: Math.max(
      0,
      Math.min(
        1,
        Number(
          candidate.qualityScore,
        ) || 0,
      ),
    ),
    reason:
      candidate.reason ||
      "Kandydat wybrany przez analizę całego filmu.",
  };
}

function candidatesOverlap(
  a,
  b,
) {
  const overlapStart =
    Math.max(a.start, b.start);

  const overlapEnd =
    Math.min(a.end, b.end);

  const overlap =
    Math.max(
      0,
      overlapEnd -
        overlapStart,
    );

  const shorter =
    Math.min(
      a.duration,
      b.duration,
    );

  if (shorter <= 0) {
    return false;
  }

  return (
    overlap / shorter >
    0.45
  );
}

function removeOverlappingCandidates(
  candidates,
) {
  const sorted =
    [...candidates].sort(
      (a, b) =>
        b.qualityScore -
        a.qualityScore,
    );

  const selected = [];

  for (
    const candidate of sorted
  ) {
    const overlaps =
      selected.some(
        (existing) =>
          candidatesOverlap(
            existing,
            candidate,
          ),
      );

    if (overlaps) {
      continue;
    }

    selected.push(
      candidate,
    );

    if (
      selected.length >=
      MAX_CANDIDATES
    ) {
      break;
    }
  }

  return selected.sort(
    (a, b) =>
      a.start - b.start,
  );
}

function extractDetailFrames(
  fileName,
  requestedStart,
  requestedDuration,
  fragmentIndex,
) {
  const inputPath = path.join(
    videosDir,
    fileName,
  );

  const actualDuration =
    getVideoDuration(inputPath);

  const safeDuration = Math.max(
    0.1,
    actualDuration -
      SAFE_END_MARGIN,
  );

  let start = Math.max(
    0,
    Number(requestedStart) || 0,
  );

  let duration = Math.max(
    0.5,
    Number(requestedDuration) || 1,
  );

  duration = Math.min(
    6,
    duration,
  );

  if (
    start >= safeDuration
  ) {
    start = Math.max(
      0,
      safeDuration - duration,
    );
  }

  if (
    start + duration >
    safeDuration
  ) {
    start = Math.max(
      0,
      safeDuration - duration,
    );
  }

  duration = Math.min(
    duration,
    safeDuration - start,
  );

  if (duration <= 0) {
    start = 0;
    duration = safeDuration;
  }

  const end =
    start + duration;

  const baseName =
    path.parse(fileName).name;

  const outputDir =
    path.join(
      detailFramesDir,
      `${baseName}-fragment-${fragmentIndex + 1}`,
    );

  fs.rmSync(outputDir, {
    recursive: true,
    force: true,
  });

  fs.mkdirSync(outputDir, {
    recursive: true,
  });

  console.log(
    `\nFragment #${fragmentIndex + 1}: ${start.toFixed(3)}s → ${end.toFixed(3)}s`,
  );

  const frames = [];

  for (
    let i = 0;
    i < DETAIL_FRAME_COUNT;
    i++
  ) {
    const position =
      (i + 0.5) /
      DETAIL_FRAME_COUNT;

    const timestamp =
      start +
      duration * position;

    const safeTimestamp =
      Math.min(
        timestamp,
        Math.max(
          0,
          actualDuration -
            SAFE_END_MARGIN,
        ),
      );

    const outputPath =
      path.join(
        outputDir,
        `detail-${String(
          i + 1,
        ).padStart(2, "0")}.jpg`,
      );

    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        safeTimestamp.toFixed(3),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        outputPath,
      ],
      {
        stdio: "ignore",
      },
    );

    if (
      !fs.existsSync(
        outputPath,
      )
    ) {
      throw new Error(
        `FFmpeg nie utworzył klatki: ${outputPath}`,
      );
    }

    frames.push(
      outputPath,
    );
  }

  return {
    frames,
    actualDuration,
    start,
    end,
    duration,
  };
}

async function analyzeDetail({
  fileName,
  overview,
  candidate,
  extracted,
  fragmentIndex,
}) {
  const content = [
    {
      type: "input_text",
      text: `
Jesteś ekspertem od montażu krótkich rolek reklamowych firmy EXBRAM,
producenta nowoczesnych i klasycznych ogrodzeń, bram, furtek i balustrad.

Analizujesz szczegółowo KANDYDATA nr ${
        fragmentIndex + 1
      } znalezionego w długim filmie.

Film:
${fileName}

Rzeczywista długość filmu:
${extracted.actualDuration.toFixed(3)} s

Analizowany zakres:
${extracted.start.toFixed(3)} → ${extracted.end.toFixed(3)} s

Wstępny kandydat:
${JSON.stringify(
  candidate,
  null,
  2,
)}

Wstępna analiza całego filmu:
${JSON.stringify(
  overview,
  null,
  2,
)}

Otrzymujesz ${extracted.frames.length} szczegółowych klatek.

Twoim zadaniem jest wybrać NAJLEPSZY konkretny fragment
wewnątrz tego zakresu do reklamowego Reela 9:16.

PRIORYTETY:

1. Produkt musi być dobrze widoczny.
2. Ogrodzenie, brama, furtka, panel lub balustrada powinny
   zajmować możliwie dużą część kadru.
3. Produkt powinien być łatwy do rozpoznania bez zatrzymywania filmu.
4. Preferuj atrakcyjne ujęcie sprzedażowe zamiast przypadkowego
   ruchu kamery.
5. Unikaj asfaltu, nieba, pustej ściany i innych dużych obszarów
   niezwiązanych z produktem.
6. Uwzględnij wygląd po przycięciu do 9:16.
7. Jeżeli widać bramę, ogrodzenie, furtkę lub detal wykonania,
   jest to ważniejsze niż sam ruch kamery.
8. Nie wybieraj fragmentu tylko dlatego, że kamera porusza się płynnie.
9. Szukaj najlepszego momentu prezentującego realizację EXBRAM.
10. Jeśli początek lub koniec zakresu jest słabszy,
    skróć fragment.

DODATKOWE ZASADY:

- Możesz zmienić refinedStart.
- Możesz zmienić refinedEnd.
- Nie możesz wyjść poza rzeczywistą długość filmu.
- refinedStart >= 0.
- refinedEnd <= rzeczywista długość filmu.
- refinedEnd > refinedStart.
- refinedDuration = refinedEnd - refinedStart.
- Najczęściej wybieraj około 3.5-5 sekund.
- Jeżeli dobry moment trwa krócej, wybierz krótszy fragment.
- Jeżeli dobry moment jest dłuższy, możesz wybrać maksymalnie około 6 sekund.
- Nie wymuszaj długości kosztem jakości.

Zwróć WYŁĄCZNIE JSON.
      `,
    },
  ];

  for (
    const framePath of
      extracted.frames
  ) {
    content.push({
      type: "input_image",
      image_url:
        imageToDataUrl(
          framePath,
        ),
      detail: "high",
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

          name: "video_detail",

          strict: true,

          schema: {
            type: "object",

            additionalProperties: false,

            properties: {
              file: {
                type: "string",
              },

              usable: {
                type: "boolean",
              },

              qualityScore: {
                type: "number",
              },

              refinedStart: {
                type: "number",
              },

              refinedEnd: {
                type: "number",
              },

              refinedDuration: {
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

              reason: {
                type: "string",
              },
            },

            required: [
              "file",
              "usable",
              "qualityScore",
              "refinedStart",
              "refinedEnd",
              "refinedDuration",
              "framing",
              "focusX",
              "focusY",
              "confidence",
              "reason",
            ],
          },
        },
      },
    });

  const result =
    JSON.parse(
      response.output_text,
    );

  result.file =
    fileName;

  result.refinedStart =
    Math.max(
      0,
      Math.min(
        extracted.actualDuration,
        Number(
          result.refinedStart,
        ) || extracted.start,
      ),
    );

  result.refinedEnd =
    Math.max(
      result.refinedStart +
        0.1,
      Math.min(
        extracted.actualDuration,
        Number(
          result.refinedEnd,
        ) || extracted.end,
      ),
    );

  result.refinedDuration =
    result.refinedEnd -
    result.refinedStart;

  return result;
}

function createFallbackFragment(
  overview,
  actualDuration,
) {
  const start =
    Math.max(
      0,
      Number(
        overview.recommendedStart,
      ) || 0,
    );

  const duration =
    Math.min(
      6,
      Math.max(
        1,
        Number(
          overview.recommendedDuration,
        ) || 5,
      ),
      Math.max(
        0.1,
        actualDuration -
          start -
          SAFE_END_MARGIN,
      ),
    );

  return {
    fragmentId:
      `${overview.file}#fragment-1`,

    file:
      overview.file,

    usable:
      overview.usable !== false,

    qualityScore:
      Number(
        overview.qualityScore,
      ) || 0.5,

    refinedStart:
      start,

    refinedEnd:
      start + duration,

    refinedDuration:
      duration,

    framing:
      overview.framing ||
      "crop",

    focusX:
      overview.focusX ??
      50,

    focusY:
      overview.focusY ??
      50,

    confidence:
      overview.confidence ??
      0.5,

    reason:
      "Zachowano fragment z analizy wstępnej.",
  };
}

async function main() {
  if (
    !process.env.OPENAI_API_KEY
  ) {
    console.error(
      "Brak OPENAI_API_KEY.",
    );
    process.exit(1);
  }

  if (
    !fs.existsSync(
      analysisFile,
    )
  ) {
    console.error(
      `Nie znaleziono pliku: ${analysisFile}`,
    );
    process.exit(1);
  }

  const overviewResults =
    JSON.parse(
      fs.readFileSync(
        analysisFile,
        "utf8",
      ),
    );

  const videoResults =
    overviewResults.filter(
      (item) =>
        item &&
        typeof item.file ===
          "string" &&
        item.usable !== false &&
        item.recommendedStart !==
          undefined,
    );

  if (
    videoResults.length === 0
  ) {
    console.log(
      "Brak filmów do szczegółowej analizy.",
    );
    return;
  }

  fs.mkdirSync(
    detailFramesDir,
    {
      recursive: true,
    },
  );

  const detailedResults =
    [];

  for (
    const overview of
      videoResults
  ) {
    console.log(
      "\n========================================",
    );

    console.log(
      `ANALIZA FILMU: ${overview.file}`,
    );

    console.log(
      "========================================",
    );

    try {
      const inputPath =
        path.join(
          videosDir,
          overview.file,
        );

      const actualDuration =
        getVideoDuration(
          inputPath,
        );

      /*
       * ETAP 1
       *
       * AI ogląda reprezentatywne klatki
       * z całego filmu i szuka kilku kandydatów.
       */

      let candidates =
        await findVideoCandidates({
          fileName:
            overview.file,

          actualDuration,
        });

      candidates =
        candidates
          .map(
            (candidate) =>
              normalizeCandidate(
                candidate,
                actualDuration,
              ),
          )
          .filter(
            (candidate) =>
              candidate.duration >=
              1.2,
          );

      candidates =
        removeOverlappingCandidates(
          candidates,
        );

      /*
       * Jeżeli AI nie znalazło sensownych kandydatów,
       * zachowujemy dotychczasową metodę.
       */

      if (
        candidates.length === 0
      ) {
        console.warn(
          "AI nie znalazło kandydatów — używam fragmentu overview.",
        );

        const fallback =
          createFallbackFragment(
            overview,
            actualDuration,
          );

        detailedResults.push({
          file:
            overview.file,

          usable:
            fallback.usable,

          qualityScore:
            fallback.qualityScore,

          recommendedStart:
            fallback.refinedStart,

          recommendedDuration:
            fallback.refinedDuration,

          refinedStart:
            fallback.refinedStart,

          refinedDuration:
            fallback.refinedDuration,

          framing:
            fallback.framing,

          focusX:
            fallback.focusX,

          focusY:
            fallback.focusY,

          confidence:
            fallback.confidence,

          reason:
            fallback.reason,

          fragments: [
            fallback,
          ],
        });

        continue;
      }

      console.log(
        `\nZnaleziono ${candidates.length} kandydatów:`,
      );

      candidates.forEach(
        (candidate, index) => {
          console.log(
            `${index + 1}. ${candidate.start.toFixed(
              2,
            )}s → ${candidate.end.toFixed(
              2,
            )}s | score ${candidate.qualityScore.toFixed(
              2,
            )}`,
          );

          console.log(
            `   ${candidate.reason}`,
          );
        },
      );

      /*
       * ETAP 2
       *
       * Każdy kandydat dostaje własną szczegółową analizę.
       */

      const fragments = [];

      for (
        let i = 0;
        i < candidates.length;
        i++
      ) {
        const candidate =
          candidates[i];

        try {
          const extracted =
            extractDetailFrames(
              overview.file,
              candidate.start,
              candidate.duration,
              i,
            );

          const result =
            await analyzeDetail({
              fileName:
                overview.file,

              overview,

              candidate,

              extracted,

              fragmentIndex: i,
            });

          const fragment = {
            ...result,

            fragmentId:
              `${overview.file}#fragment-${
                i + 1
              }`,
          };

          fragments.push(
            fragment,
          );

          console.log(
            `\nFRAGMENT #${i + 1} — WYNIK:`,
          );

          console.log(
            JSON.stringify(
              fragment,
              null,
              2,
            ),
          );
        } catch (error) {
          console.error(
            `\nBłąd analizy fragmentu #${
              i + 1
            }:`,
          );

          console.error(
            error.message,
          );
        }
      }

      if (
        fragments.length === 0
      ) {
        const fallback =
          createFallbackFragment(
            overview,
            actualDuration,
          );

        detailedResults.push({
          file:
            overview.file,

          usable:
            fallback.usable,

          qualityScore:
            fallback.qualityScore,

          recommendedStart:
            fallback.refinedStart,

          recommendedDuration:
            fallback.refinedDuration,

          refinedStart:
            fallback.refinedStart,

          refinedDuration:
            fallback.refinedDuration,

          framing:
            fallback.framing,

          focusX:
            fallback.focusX,

          focusY:
            fallback.focusY,

          confidence:
            fallback.confidence,

          reason:
            fallback.reason,

          fragments: [
            fallback,
          ],
        });

        continue;
      }

      /*
       * Najlepszy fragment zapisujemy również na poziomie
       * głównego obiektu dla kompatybilności ze starszym kodem.
       */

      const best =
        [...fragments].sort(
          (a, b) =>
            Number(
              b.qualityScore,
            ) -
            Number(
              a.qualityScore,
            ),
        )[0];

      detailedResults.push({
        file:
          overview.file,

        usable:
          fragments.some(
            (fragment) =>
              fragment.usable !==
              false,
          ),

        qualityScore:
          best.qualityScore,

        recommendedStart:
          best.refinedStart,

        recommendedDuration:
          best.refinedDuration,

        refinedStart:
          best.refinedStart,

        refinedDuration:
          best.refinedDuration,

        framing:
          best.framing,

        focusX:
          best.focusX,

        focusY:
          best.focusY,

        confidence:
          best.confidence,

        reason:
          best.reason,

        fragments,
      });
    } catch (error) {
      console.error(
        "\nBŁĄD ANALIZY FILMU:",
      );

      console.error(
        error.message,
      );

      /*
       * Nie zatrzymujemy całego pipeline'u.
       */

      try {
        const inputPath =
          path.join(
            videosDir,
            overview.file,
          );

        const actualDuration =
          getVideoDuration(
            inputPath,
          );

        const fallback =
          createFallbackFragment(
            overview,
            actualDuration,
          );

        detailedResults.push({
          file:
            overview.file,

          usable:
            fallback.usable,

          qualityScore:
            fallback.qualityScore,

          recommendedStart:
            fallback.refinedStart,

          recommendedDuration:
            fallback.refinedDuration,

          refinedStart:
            fallback.refinedStart,

          refinedDuration:
            fallback.refinedDuration,

          framing:
            fallback.framing,

          focusX:
            fallback.focusX,

          focusY:
            fallback.focusY,

          confidence:
            fallback.confidence,

          reason:
            fallback.reason,

          fragments: [
            fallback,
          ],
        });
      } catch {
        detailedResults.push(
          overview,
        );
      }
    }
  }

  fs.writeFileSync(
    analysisFile,
    JSON.stringify(
      detailedResults,
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `\nZapisano szczegółową analizę do: ${analysisFile}`,
  );

  console.log(
    "\n========================================",
  );

  console.log(
    "PODSUMOWANIE FRAGMENTÓW",
  );

  console.log(
    "========================================",
  );

  detailedResults.forEach(
    (video) => {
      console.log(
        `\n${video.file}`,
      );

      if (
        Array.isArray(
          video.fragments,
        )
      ) {
        video.fragments.forEach(
          (
            fragment,
            index,
          ) => {
            console.log(
              `  ${index + 1}. ${fragment.refinedStart.toFixed(
                2,
              )}s → ${(
                fragment.refinedStart +
                fragment.refinedDuration
              ).toFixed(
                2,
              )}s | score ${Number(
                fragment.qualityScore,
              ).toFixed(2)}`,
            );
          },
        );
      }
    },
  );
}

main().catch(
  (error) => {
    console.error(
      "\nBŁĄD KRYTYCZNY:",
    );

    console.error(
      error.message,
    );

    process.exit(1);
  },
);