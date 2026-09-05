import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const publicDir = "./public";
const videosDir = path.join(
  publicDir,
  "media",
  "videos",
);

const outputDir = "./video-frames";

const supportedVideoExtensions = [
  ".mp4",
  ".mov",
  ".webm",
];

if (!fs.existsSync(publicDir)) {
  console.error(
    `Nie znaleziono katalogu: ${publicDir}`,
  );
  process.exit(1);
}

if (!fs.existsSync(videosDir)) {
  console.error(
    `Nie znaleziono katalogu z filmami: ${videosDir}`,
  );
  process.exit(1);
}

/*
 * Czyścimy stare klatki.
 *
 * Dzięki temu analiza zawsze dotyczy wyłącznie
 * filmów znajdujących się aktualnie w public/media/videos.
 */
fs.rmSync(outputDir, {
  recursive: true,
  force: true,
});

fs.mkdirSync(outputDir, {
  recursive: true,
});

const videoFiles = fs
  .readdirSync(videosDir)
  .filter((file) => {
    const extension = path
      .extname(file)
      .toLowerCase();

    return supportedVideoExtensions.includes(
      extension,
    );
  })
  .sort();

if (videoFiles.length === 0) {
  console.log(
    "Nie znaleziono żadnych filmów w public/media/videos.",
  );
  process.exit(0);
}

console.log(
  `Znaleziono ${videoFiles.length} filmów.`,
);

for (const fileName of videoFiles) {
  const inputPath = path.join(
    videosDir,
    fileName,
  );

  const baseName = path.parse(
    fileName,
  ).name;

  const videoOutputDir = path.join(
    outputDir,
    baseName,
  );

  fs.mkdirSync(videoOutputDir, {
    recursive: true,
  });

  console.log(
    `\nPrzetwarzam: ${fileName}`,
  );

  try {
    const durationOutput =
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          inputPath,
        ],
        {
          encoding: "utf8",
        },
      ).trim();

    const duration = Number(
      durationOutput,
    );

    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new Error(
        `Nieprawidłowa długość filmu: ${durationOutput}`,
      );
    }

    console.log(
      `Długość: ${duration.toFixed(2)} s`,
    );

    const FRAME_COUNT = 20;

    /*
     * Pobieramy klatki równomiernie rozmieszczone
     * wewnątrz filmu.
     *
     * Nie pobieramy dokładnie z 0 s ani dokładnie
     * z końca filmu, żeby uniknąć problemów
     * z dekodowaniem ostatniej klatki.
     */
    for (
      let i = 0;
      i < FRAME_COUNT;
      i++
    ) {
      const position =
        (i + 1) /
        (FRAME_COUNT + 1);

      const timestamp =
        duration * position;

      const outputPath = path.join(
        videoOutputDir,
        `frame-${String(i + 1).padStart(2, "0")}.jpg`,
      );

      console.log(
        `  Klatka ${i + 1}/${FRAME_COUNT}: ${timestamp.toFixed(2)} s`,
      );

      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-ss",
          timestamp.toFixed(3),
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
    }

    console.log(
      `Gotowe: ${videoOutputDir}`,
    );
  } catch (error) {
    console.error(
      `Błąd dla ${fileName}:`,
      error.message,
    );
  }
}

console.log(
  "\nWyciąganie klatek zakończone.",
);