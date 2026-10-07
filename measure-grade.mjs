import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import {
  VIDEO_EXTENSIONS,
  getSetDir,
} from "./reel-set.mjs";

/*
 * Korekta kolorów dobierana osobno dla każdej sceny.
 *
 * Materiał jest bardzo nierówny: zdjęcia z pochmurnego dnia są
 * płaskie i ciemne, ujęcia w pełnym słońcu już kontrastowe.
 * Jedna stała korekta albo nie ratuje płaskich, albo przepala
 * ostre. Dlatego mierzymy każde ujęcie FFmpegiem i liczymy
 * filtr, który sprowadza je do wspólnego wzorca — rolka wygląda
 * wtedy spójnie, jakby była kręcona jednego dnia.
 *
 * Pomiar, nie AI: jest darmowy, powtarzalny i liczbowy, a model
 * słabo ocenia wartości typu „kontrast 1.07".
 *
 * Wynik trafia do grade.json, który Composition.tsx importuje
 * statycznie. Brak wpisu = domyślna korekta z kompozycji.
 */

const EDIT_FILE = path.join(
  process.cwd(),
  "edit.json",
);

const OUTPUT_FILE = path.join(
  process.cwd(),
  "grade.json",
);

const PROCESSED_DIR = path.join(
  process.cwd(),
  "public",
  "processed",
);

/*
 * Wzorzec (wartości 0-255 w pełnym zakresie, po zmniejszeniu
 * kadru do 320 px). Dobrany na kadrach z dotychczasowych
 * realizacji: rozpiętość 10.-90. percentyla jasności wahała się
 * tam od 104 do 170, średnia od 84 do 133, nasycenie od 13 do 32.
 */
const TARGET_SPREAD = 160;

const TARGET_MEAN = 116;

const TARGET_SATURATION = 22;

/*
 * Bezpieczniki.
 *
 * Kontrast tylko w górę — obniżanie kontrastu daje mętny obraz.
 *
 * Łączna zmiana nasycenia (kontrast i jasność też je zmieniają)
 * jest ograniczona do ±6%: antracyt (RAL 7016) jest
 * szaroniebieski i przy mocniejszym podbiciu wyraźnie niebieszczeje,
 * a klient wybiera produkt po kolorze.
 *
 * Najjaśniejsze partie (90. percentyl, zwykle niebo) nie mogą
 * wyjść ponad MAX_HIGHLIGHT, żeby rozjaśnienie ich nie przepaliło.
 */
const CONTRAST_RANGE = [
  1.0,
  1.16,
];

const BRIGHTNESS_RANGE = [
  0.95,
  1.12,
];

const CHROMA_RANGE = [
  0.95,
  1.06,
];

const MAX_HIGHLIGHT = 232;

/*
 * Filmy: jedna korekta na cały fragment, uśredniona z kilku
 * klatek — korekta zmieniana w trakcie ujęcia migotałaby.
 */
const VIDEO_SAMPLES = 4;

const clamp = (
  value,
  [min, max],
) => {
  return Math.min(
    Math.max(value, min),
    max,
  );
};

const round = (value) =>
  Number(value.toFixed(3));

/*
 * Statystyki jednej klatki: YLOW / YHIGH to 10. i 90. percentyl
 * jasności (odporne na pojedyncze czarne i białe piksele),
 * SATAVG — średnie nasycenie.
 *
 * out_range=full sprowadza wideo (zakres ograniczony 16-235)
 * i JPEG (pełny zakres) do wspólnej skali.
 */
const measureFrame = (
  filePath,
  seekSeconds = null,
) => {
  /*
   * Wyniki czytamy z logu (stderr), nie przez metadata=print:file=-.
   * Przy dużych zdjęciach z iPhone'a (4032x3024 z EXIF i ICC)
   * FFmpeg nie wypisywał nic na stdout, choć mniejsze JPEG-i
   * i filmy działały — log działa dla wszystkich.
   */
  const args = [
    "-hide_banner",
    "-nostats",
  ];

  if (seekSeconds !== null) {
    args.push(
      "-ss",
      String(seekSeconds),
    );
  }

  args.push(
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    "scale=320:-2:out_range=full,format=yuv444p,signalstats,metadata=print",
    "-f",
    "null",
    "-",
  );

  const result = spawnSync(
    "ffmpeg",
    args,
    {
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    return null;
  }

  const read = (key) => {
    const match =
      result.stderr.match(
        new RegExp(
          `lavfi\\.signalstats\\.${key}=([0-9.]+)`,
        ),
      );

    return match
      ? Number(match[1])
      : NaN;
  };

  const stats = {
    low: read("YLOW"),
    mean: read("YAVG"),
    high: read("YHIGH"),
    saturation:
      read("SATAVG"),
  };

  return Object.values(
    stats,
  ).every(Number.isFinite)
    ? stats
    : null;
};

const averageStats = (
  samples,
) => {
  const valid =
    samples.filter(Boolean);

  if (valid.length === 0) {
    return null;
  }

  const average = (key) =>
    valid.reduce(
      (total, item) =>
        total + item[key],
      0,
    ) / valid.length;

  return {
    low: average("low"),
    mean: average("mean"),
    high: average("high"),
    saturation:
      average("saturation"),
  };
};

/*
 * Przeliczenie statystyk na filtry CSS.
 *
 * contrast(c) w CSS rozciąga wartości wokół środka (128),
 * brightness(b) mnoży, saturate(s) skaluje odległość koloru
 * od szarości. Liczymy je po kolei, każdy na wartościach już
 * zmienionych przez poprzedni.
 */
const computeGrade = (
  stats,
) => {
  const spread = Math.max(
    stats.high - stats.low,
    1,
  );

  const contrast = clamp(
    TARGET_SPREAD / spread,
    CONTRAST_RANGE,
  );

  const afterContrast = (
    value,
  ) =>
    128 +
    contrast * (value - 128);

  const meanAfterContrast =
    Math.max(
      afterContrast(
        stats.mean,
      ),
      1,
    );

  const highAfterContrast =
    Math.max(
      afterContrast(
        stats.high,
      ),
      1,
    );

  const brightness = Math.min(
    clamp(
      TARGET_MEAN /
        meanAfterContrast,
      BRIGHTNESS_RANGE,
    ),
    Math.max(
      MAX_HIGHLIGHT /
        highAfterContrast,
      BRIGHTNESS_RANGE[0],
    ),
  );

  /*
   * Kontrast i jasność same zwiększają nasycenie mniej więcej
   * proporcjonalnie — saturate dopełnia (albo odejmuje) resztę,
   * a łączny efekt mieści się w CHROMA_RANGE.
   */
  const inherited =
    contrast * brightness;

  const wantedChroma =
    TARGET_SATURATION /
    Math.max(
      stats.saturation,
      1,
    );

  const chroma = clamp(
    wantedChroma,
    CHROMA_RANGE,
  );

  const saturate =
    chroma / inherited;

  return {
    contrast:
      round(contrast),
    brightness:
      round(brightness),
    saturate:
      round(saturate),
  };
};

const isVideoScene = (
  scene,
) => {
  return (
    VIDEO_EXTENSIONS.includes(
      path
        .extname(scene.file)
        .toLowerCase(),
    ) ||
    Boolean(
      scene.fragmentId,
    )
  );
};

const measureScene = (
  scene,
) => {
  if (isVideoScene(scene)) {
    const processed =
      path.join(
        PROCESSED_DIR,
        `${path.basename(
          scene.file,
          path.extname(
            scene.file,
          ),
        )}.mp4`,
      );

    if (
      !fs.existsSync(processed)
    ) {
      return null;
    }

    const start = Number(
      scene.start,
    ) || 0;

    const duration = Math.max(
      Number(
        scene.duration,
      ) || 1,
      0.5,
    );

    const samples = [];

    for (
      let index = 0;
      index < VIDEO_SAMPLES;
      index += 1
    ) {
      samples.push(
        measureFrame(
          processed,
          start +
            (duration *
              (index + 0.5)) /
              VIDEO_SAMPLES,
        ),
      );
    }

    return averageStats(
      samples,
    );
  }

  const photo = path.join(
    getSetDir(),
    scene.file,
  );

  if (!fs.existsSync(photo)) {
    return null;
  }

  return measureFrame(photo);
};

/*
 * Klucz sceny: plik + początek fragmentu. Ten sam film może
 * dać dwa fragmenty o zupełnie innym świetle.
 */
const getGradeKey = (
  file,
  start,
) => {
  return `${file}@${Number(
    start,
  ) || 0}`;
};

const main = () => {
  if (
    !fs.existsSync(EDIT_FILE)
  ) {
    console.error(
      "Brak edit.json — korekta kolorów wymaga planu montażu.",
    );

    process.exit(1);
  }

  const editPlan = JSON.parse(
    fs.readFileSync(
      EDIT_FILE,
      "utf8",
    ),
  );

  const scenes = Array.isArray(
    editPlan.scenes,
  )
    ? editPlan.scenes
    : [];

  const grades = {};

  for (const scene of scenes) {
    const stats =
      measureScene(scene);

    const label =
      scene.fragmentId ||
      scene.file;

    if (!stats) {
      console.warn(
        `- ${label}: pomiar nieudany, zostaje korekta domyślna`,
      );

      continue;
    }

    const grade =
      computeGrade(stats);

    grades[
      getGradeKey(
        scene.file,
        scene.start,
      )
    ] = grade;

    console.log(
      `- ${label}: ` +
        `jasność ${stats.mean.toFixed(0)}, ` +
        `rozpiętość ${(stats.high - stats.low).toFixed(0)}, ` +
        `nasycenie ${stats.saturation.toFixed(1)} → ` +
        `contrast ${grade.contrast}, ` +
        `brightness ${grade.brightness}, ` +
        `saturate ${grade.saturate}`,
    );
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    `${JSON.stringify(
      {
        scenes: grades,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(
    `\nZapisano ${OUTPUT_FILE}`,
  );
};

main();
