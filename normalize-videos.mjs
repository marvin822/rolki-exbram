import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const publicDir = "./public";
const videosDir = "./public/media/videos";
const processedDir = "./public/processed";

const supportedVideoExtensions = [
  ".mp4",
  ".mov",
  ".webm",
];

const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000;

/*
 * Stabilizacja obrazu (libvidstab, dwa przebiegi).
 * Materiał z ręki bywa roztrzęsiony — bez tego panoramy
 * w rolce wyglądają nerwowo. Kosztuje dodatkowy przebieg
 * dekodowania; można wyłączyć: REEL_STABILIZE=0.
 */
const STABILIZE =
  process.env.REEL_STABILIZE !==
  "0";

const SCALE_FILTER =
  "scale=1920:1920:force_original_aspect_ratio=decrease";

if (!fs.existsSync(publicDir)) {
  console.error(
    `Nie znaleziono katalogu: ${publicDir}`,
  );

  process.exit(1);
}

if (!fs.existsSync(videosDir)) {
  console.error(
    `Nie znaleziono katalogu filmów: ${videosDir}`,
  );

  process.exit(1);
}

/*
 * Czyścimy stary katalog processed.
 *
 * Dzięki temu w public/processed znajdują się wyłącznie
 * filmy odpowiadające aktualnej zawartości public/media/videos.
 */
fs.rmSync(processedDir, {
  recursive: true,
  force: true,
});

fs.mkdirSync(processedDir, {
  recursive: true,
});

const videoFiles = fs
  .readdirSync(videosDir, {
    withFileTypes: true,
  })
  .filter((entry) => {
    if (!entry.isFile()) {
      return false;
    }

    const extension = path
      .extname(entry.name)
      .toLowerCase();

    if (
      !supportedVideoExtensions.includes(
        extension,
      )
    ) {
      return false;
    }

    const lowerName =
      entry.name.toLowerCase();

    if (
      lowerName.includes(
        "normalized",
      ) ||
      lowerName.includes(
        "selected",
      ) ||
      lowerName.includes(
        "fixed",
      ) ||
      lowerName.includes(
        "test",
      )
    ) {
      return false;
    }

    return true;
  })
  .map(
    (entry) => entry.name,
  )
  .sort();

console.log(
  `Znaleziono ${videoFiles.length} filmów.`,
);

for (const file of videoFiles) {
  const inputPath = path.join(
    videosDir,
    file,
  );

  const baseName =
    path.basename(
      file,
      path.extname(file),
    );

  const outputPath =
    path.join(
      processedDir,
      `${baseName}.mp4`,
    );

  console.log(
    `\nPrzetwarzam: ${file}`,
  );

  /*
   * Dekodowanie programowe + enkoder GPU (h264_nvenc).
   *
   * Wcześniejszy wariant z pełnym potokiem CUDA
   * (-hwaccel cuda + hwdownload/hwupload_cuda) potrafił
   * zawieszać się na 0 klatkach przy materiale HEVC 4K60
   * z iPhone'a. Programowy dekoder jest wolniejszy, ale
   * pewny, a enkoder pozostaje na GPU.
   *
   * Obrót jest zdejmowany automatycznie z metadanych
   * (display matrix), więc nie liczymy transpose ręcznie.
   */
  /*
   * Przebieg 1 (opcjonalny): vidstabdetect liczy drgania kamery
   * i zapisuje transformacje do pliku .trf. Analizę robimy już na
   * przeskalowanym obrazie — jest dużo szybsza, a przebieg 2 używa
   * dokładnie tej samej skali, więc transformacje pasują.
   */
  const transformsPath =
    path.join(
      os.tmpdir(),
      `exbram-vidstab-${baseName.replace(
        /[^a-z0-9]/gi,
        "_",
      )}.trf`,
    );

  let stabilizeFilter = null;

  if (STABILIZE) {
    console.log(
      "Analiza drgań (vidstabdetect)...",
    );

    const detect = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-vf",
        [
          SCALE_FILTER,
          `vidstabdetect=shakiness=6:accuracy=12:result=${transformsPath.replace(
            /\\/g,
            "/",
          )}`,
        ].join(","),
        "-an",
        "-f",
        "null",
        "-",
      ],
      {
        stdio: "inherit",
        timeout: FFMPEG_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );

    if (
      detect.status === 0 &&
      fs.existsSync(transformsPath)
    ) {
      stabilizeFilter = `vidstabtransform=input=${transformsPath.replace(
        /\\/g,
        "/",
      )}:smoothing=30:optzoom=1:interpol=bicubic`;
    } else {
      console.warn(
        "Stabilizacja nieudana — koduję bez niej.",
      );
    }
  }

  const filterGraph = [
    SCALE_FILTER,
    ...(stabilizeFilter
      ? [stabilizeFilter]
      : []),
    "format=yuv420p",
  ].join(",");

  const args = [
    "-y",

    "-i",
    inputPath,

    "-vf",
    filterGraph,

    "-c:v",
    "h264_nvenc",

    "-preset",
    "p5",

    "-b:v",
    "8M",

    "-maxrate",
    "12M",

    "-bufsize",
    "16M",

    "-r",
    "30",

    // Filmy w rolce grają bez własnego dźwięku —
    // ścieżkę dźwiękową daje muzyka w Remotion.
    "-an",

    outputPath,
  ];

  const result = spawnSync(
    "ffmpeg",
    args,
    {
      stdio: "inherit",
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );

  fs.rmSync(transformsPath, {
    force: true,
  });

  if (result.error) {
    console.error(
      `Błąd podczas przetwarzania ${file}: ${result.error.message}`,
    );

    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(
      `Błąd podczas przetwarzania ${file}.`,
    );

    process.exit(
      result.status ?? 1,
    );
  }

  console.log(
    `Gotowe: ${outputPath}`,
  );
}

console.log(
  "\nNormalizacja zakończona.",
);
