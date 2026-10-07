import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
  VIDEO_EXTENSIONS,
  getSetDir,
  getSetName,
} from "./reel-set.mjs";

const publicDir = "./public";
const setName = getSetName();
const videosDir = getSetDir(
  setName,
);
const processedDir = "./public/processed";

const supportedVideoExtensions =
  VIDEO_EXTENSIONS;

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

/*
 * Enkoder: karta NVIDIA (h264_nvenc), a gdy jej nie ma — procesor
 * (libx264). FFmpeg z gyan.dev ma oba, ale NVENC działa tylko
 * z kartą NVIDIA i jej sterownikiem, więc sprawdzamy to krótkim
 * próbnym kodowaniem zamiast zakładać.
 *
 * REEL_ENCODER=nvenc albo REEL_ENCODER=cpu wymusza wybór.
 */
const nvencWorks = () => {
  const probe = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x240:d=0.2",
      "-c:v",
      "h264_nvenc",
      "-f",
      "null",
      "-",
    ],
    {
      timeout: 30000,
    },
  );

  return probe.status === 0;
};

const pickEncoder = () => {
  const forced = (
    process.env.REEL_ENCODER ?? ""
  ).toLowerCase();

  if (forced === "cpu") {
    return "cpu";
  }

  if (forced === "nvenc") {
    return "nvenc";
  }

  return nvencWorks()
    ? "nvenc"
    : "cpu";
};

const ENCODER = pickEncoder();

const ENCODER_ARGS =
  ENCODER === "nvenc"
    ? [
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
      ]
    : [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-maxrate",
        "12M",
        "-bufsize",
        "16M",
      ];

console.log(
  ENCODER === "nvenc"
    ? "Enkoder: karta NVIDIA (h264_nvenc)"
    : "Enkoder: procesor (libx264) — brak karty NVIDIA albo wymuszony REEL_ENCODER=cpu",
);

if (!fs.existsSync(publicDir)) {
  console.error(
    `Nie znaleziono katalogu: ${publicDir}`,
  );

  process.exit(1);
}

if (!fs.existsSync(videosDir)) {
  console.error(
    `Nie znaleziono zestawu: ${videosDir}`,
  );

  process.exit(1);
}

/*
 * Czyścimy stary katalog processed.
 *
 * Zestawy lecą po kolei i dzielą ten katalog, więc bez
 * czyszczenia zostałyby w nim filmy poprzedniego zestawu.
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
   * Dekodowanie programowe + enkoder GPU (h264_nvenc), a bez karty
   * NVIDIA — enkoder procesora (ENCODER_ARGS wyżej).
   *
   * Wcześniejszy wariant z pełnym potokiem CUDA
   * (-hwaccel cuda + hwdownload/hwupload_cuda) potrafił
   * zawieszać się na 0 klatkach przy materiale HEVC 4K60
   * z iPhone'a. Programowy dekoder jest wolniejszy, ale
   * pewny, a enkoder pozostaje na GPU.
   *
   * Obrót jest zdejmowany automatycznie z metadanych
   * (display matrix), więc nie liczymy transpose ręcznie.
   *
   * Przebieg 1 (opcjonalny): vidstabdetect liczy drgania kamery
   * i zapisuje transformacje do pliku .trf. Analizę robimy już na
   * przeskalowanym obrazie — jest dużo szybsza, a przebieg 2 używa
   * dokładnie tej samej skali, więc transformacje pasują.
   *
   * Ścieżka .trf MUSI być względna i bez dwukropka — w opisie filtra
   * FFmpeg dwukropek oddziela opcje, więc "C:/..." rozwala parser.
   */
  const transformsPath = `vidstab-${baseName.replace(
    /[^a-z0-9]/gi,
    "_",
  )}.trf`;

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
          `vidstabdetect=shakiness=6:accuracy=12:result=${transformsPath}`,
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
      stabilizeFilter =
        `vidstabtransform=input=${transformsPath}` +
        ":smoothing=30:optzoom=1:interpol=bicubic";
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

    ...ENCODER_ARGS,

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
