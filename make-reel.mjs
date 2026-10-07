import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import {
  MEDIA_ROOT,
  getOutputDir,
  getWorkDir,
  listLooseFiles,
  listSets,
} from "./reel-set.mjs";

/*
 * Opis do rolki (opis.txt) powstaje domyślnie po renderze.
 * Można go pominąć flagą --skip-opis (alias --bez-opisu).
 */
const skipDescription =
  process.argv.includes(
    "--skip-opis",
  ) ||
  process.argv.includes(
    "--bez-opisu",
  );

/*
 * Bez argumentów przerabiamy tylko zestawy, które nie mają jeszcze
 * folderu w output/. Powtórka niezmienionego zestawu i tak kosztuje
 * — cache ma wyłącznie analiza zdjęć, więc analiza filmów, opis,
 * stabilizacja i render lecą od nowa.
 *
 * --wszystko wymusza przerobienie wszystkiego.
 * Podanie nazwy zestawu robi ten jeden, niezależnie od output/.
 */
const forceAll =
  process.argv.includes(
    "--wszystko",
  ) ||
  process.argv.includes(
    "--all",
  );

const requestedSets =
  process.argv
    .slice(2)
    .filter(
      (arg) =>
        !arg.startsWith("--"),
    );

const pad = (value) =>
  String(value).padStart(
    2,
    "0",
  );

/*
 * Znacznik daty i godziny do nazw plików wyjściowych,
 * np. 2026-09-06_14-05-32. Ta sama wartość trafia do
 * nazwy rolki i opisu w danym przebiegu, dzięki czemu
 * kolejne przebiegi nie nadpisują poprzednich.
 */
const buildStamp = (
  date = new Date(),
) => {
  return (
    `${date.getFullYear()}-` +
    `${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())}_` +
    `${pad(date.getHours())}-` +
    `${pad(date.getMinutes())}-` +
    `${pad(date.getSeconds())}`
  );
};

const steps = [
  {
    name: "Wyciąganie klatek z filmów",
    args: ["extract-video-frames.mjs"],
  },
  {
    name: "Analiza filmów",
    args: ["analyze-video.mjs"],
  },
  {
    name: "Szczegółowa analiza wybranych fragmentów filmów",
    args: ["analyze-video-detail.mjs"],
  },
  {
    name: "Analiza materiałów i tworzenie planu",
    args: ["analyze-image.mjs"],
  },
  {
    name: "Normalizacja filmów",
    args: ["normalize-videos.mjs"],
  },
  {
    name: "Pomiar ujęć i korekta kolorów",
    args: ["measure-grade.mjs"],
  },
  {
    name: "Wybór podkładu muzycznego",
    args: ["select-music.mjs"],
  },
];

/*
 * Pliki stanu, przez które gadają kolejne kroki.
 *
 * Remotion importuje je statycznie z korzenia projektu, więc muszą
 * tam leżeć w chwili renderu. Jednocześnie każdy zestaw ma trzymać
 * SWOJĄ analizę, żeby przetworzenie kolejnego zestawu nie kasowało
 * cache poprzedniego — stąd kopiowanie z work/<zestaw>/ i z powrotem.
 */
const STATE_FILES = [
  {
    name: "analysis.json",
    empty: "[]\n",
  },
  {
    name: "video-analysis.json",
    empty: "[]\n",
  },
  {
    name: "edit.json",
    empty: null,
  },
];

const restoreState = (
  setName,
) => {
  const workDir =
    getWorkDir(setName);

  for (const file of STATE_FILES) {
    const source = path.join(
      workDir,
      file.name,
    );

    const target = path.join(
      process.cwd(),
      file.name,
    );

    if (
      fs.existsSync(source)
    ) {
      fs.copyFileSync(
        source,
        target,
      );

      continue;
    }

    /*
     * Brak zapisanego stanu — zerujemy plik zamiast go kasować,
     * żeby bundler Remotion zawsze miał co zaimportować i żeby
     * nie zostały dane poprzedniego zestawu.
     */
    fs.writeFileSync(
      target,
      file.empty ??
        `${JSON.stringify(
          {
            set: setName,
            scenes: [],
          },
          null,
          2,
        )}\n`,
      "utf8",
    );
  }
};

const saveState = (
  setName,
) => {
  const workDir =
    getWorkDir(setName);

  fs.mkdirSync(workDir, {
    recursive: true,
  });

  for (const file of STATE_FILES) {
    const source = path.join(
      process.cwd(),
      file.name,
    );

    if (
      !fs.existsSync(source)
    ) {
      continue;
    }

    fs.copyFileSync(
      source,
      path.join(
        workDir,
        file.name,
      ),
    );
  }
};

const banner = (text) => {
  console.log(
    "\n========================================",
  );

  console.log(text);

  console.log(
    "========================================\n",
  );
};

/*
 * Wyrównanie głośności do -14 LUFS — poziomu, do którego
 * Instagram i Facebook sprowadzają dźwięk. Bez tego rolka
 * (sama muzyka na 25% głośności) wychodziła na ok. -27 LUFS
 * i przy przewijaniu była wyraźnie cichsza od sąsiednich.
 *
 * Dwa przebiegi loudnorm: pierwszy mierzy, drugi koryguje
 * liniowo (bez pompowania dynamiki). Obraz jest kopiowany
 * bez ponownego kodowania. FFmpeg dostaje argumenty bez
 * powłoki, więc spacje w nazwie zestawu nie przeszkadzają.
 *
 * Gdy coś pójdzie nie tak, rolka zostaje w oryginalnej
 * głośności — to lepsze niż brak rolki.
 */
const LOUDNESS_TARGET = {
  I: -14,
  TP: -1.5,
  LRA: 11,
};

const normalizeLoudness = (
  inputPath,
  outputPath,
) => {
  const target =
    `I=${LOUDNESS_TARGET.I}:` +
    `TP=${LOUDNESS_TARGET.TP}:` +
    `LRA=${LOUDNESS_TARGET.LRA}`;

  const keepOriginal = (
    reason,
  ) => {
    console.warn(
      `Nie udało się wyrównać głośności (${reason}) — zostawiam oryginał.`,
    );

    fs.renameSync(
      inputPath,
      outputPath,
    );
  };

  const measure = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      inputPath,
      "-vn",
      "-af",
      `loudnorm=${target}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    {
      encoding: "utf8",
    },
  );

  const jsonMatch =
    measure.status === 0
      ? measure.stderr.match(
          /\{[^{}]*"input_i"[^{}]*\}/,
        )
      : null;

  if (!jsonMatch) {
    keepOriginal(
      "pomiar nieudany",
    );

    return;
  }

  const measured = JSON.parse(
    jsonMatch[0],
  );

  /*
   * Cisza (rolka bez podkładu) daje -inf — nie ma czego
   * wyrównywać.
   */
  if (
    !Number.isFinite(
      Number(measured.input_i),
    )
  ) {
    console.log(
      "Rolka bez dźwięku — pomijam wyrównanie głośności.",
    );

    fs.renameSync(
      inputPath,
      outputPath,
    );

    return;
  }

  const apply = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "copy",
      "-af",
      `loudnorm=${target}` +
        `:measured_I=${measured.input_i}` +
        `:measured_TP=${measured.input_tp}` +
        `:measured_LRA=${measured.input_lra}` +
        `:measured_thresh=${measured.input_thresh}` +
        `:offset=${measured.target_offset}` +
        ":linear=true",
      "-ar",
      "48000",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    {
      stdio: "inherit",
    },
  );

  if (apply.status !== 0) {
    if (
      fs.existsSync(outputPath)
    ) {
      fs.rmSync(outputPath);
    }

    keepOriginal(
      "błąd FFmpeg",
    );

    return;
  }

  fs.rmSync(inputPath);

  console.log(
    `Głośność: ${measured.input_i} LUFS → ${LOUDNESS_TARGET.I} LUFS`,
  );
};

/*
 * Nazwa zestawu jedzie zmienną środowiskową, nie argumentem —
 * foldery mają spacje i polskie znaki, a kroki są odpalane
 * przez powłokę, która rozbiłaby argument na spacji.
 */
const runNode = (
  args,
  setName,
  extraEnv = {},
) => {
  return spawnSync(
    "node",
    args,
    {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        REEL_SET: setName,
        ...extraEnv,
      },
    },
  );
};

const getScenePath = (
  scene,
  setName,
) => {
  const extension =
    path.extname(
      scene.file,
    ).toLowerCase();

  const videoExtensions = [
    ".mp4",
    ".mov",
    ".webm",
  ];

  const isVideo =
    videoExtensions.includes(
      extension,
    ) ||
    Boolean(
      scene.fragmentId,
    );

  if (isVideo) {
    return path.join(
      "./public",
      "processed",
      `${path.basename(
        scene.file,
        extension,
      )}.mp4`,
    );
  }

  return path.join(
    "./public",
    "media",
    setName,
    scene.file,
  );
};

/*
 * Jeden zestaw = jedna rolka. Zwraca opis wyniku zamiast kończyć
 * proces, bo w trybie wsadowym felerny zestaw nie może zabić reszty.
 */
const processSet = async (
  setName,
) => {
  banner(
    `ZESTAW: ${setName}`,
  );

  restoreState(setName);

  for (const step of steps) {
    banner(
      `${setName} — ${step.name}`,
    );

    const result = runNode(
      step.args,
      setName,
    );

    if (result.status !== 0) {
      return {
        set: setName,
        ok: false,
        error: `Błąd w kroku: ${step.name}`,
      };
    }
  }

  saveState(setName);

  if (
    !fs.existsSync(
      "./edit.json",
    )
  ) {
    return {
      set: setName,
      ok: false,
      error: "Nie znaleziono edit.json — nie ma czego renderować.",
    };
  }

  const editPlan = JSON.parse(
    fs.readFileSync(
      "./edit.json",
      "utf8",
    ),
  );

  if (
    !Array.isArray(
      editPlan.scenes,
    ) ||
    editPlan.scenes.length === 0
  ) {
    return {
      set: setName,
      ok: false,
      error: "Plan montażu jest pusty.",
    };
  }

  const missingSceneFiles =
    editPlan.scenes
      .map((scene) => ({
        scene,
        filePath:
          getScenePath(
            scene,
            setName,
          ),
      }))
      .filter(
        ({ filePath }) =>
          !fs.existsSync(
            filePath,
          ),
      );

  if (
    missingSceneFiles.length > 0
  ) {
    missingSceneFiles.forEach(
      ({ scene, filePath }) => {
        console.error(
          `- ${scene.file}`,
        );

        console.error(
          `  Szukano: ${filePath}`,
        );
      },
    );

    return {
      set: setName,
      ok: false,
      error: "Plan montażu wskazuje nieistniejące pliki.",
    };
  }

  banner(
    `${setName} — Renderowanie rolki`,
  );

  const outputDir =
    getOutputDir(setName);

  fs.mkdirSync(outputDir, {
    recursive: true,
  });

  const stamp = buildStamp();

  const reelPath = path.join(
    outputDir,
    `reel-${stamp}.mp4`,
  );

  const descriptionPath =
    path.join(
      outputDir,
      `opis-${stamp}.txt`,
    );

  const coverPath = path.join(
    outputDir,
    `okladka-${stamp}.jpg`,
  );

  /*
   * Remotion renderuje do pliku pośredniego — gotowa rolka
   * powstaje z niego po wyrównaniu głośności.
   */
  const renderPath = path.join(
    outputDir,
    `reel-${stamp}.render.mp4`,
  );

  /*
   * Ścieżka idzie przez powłokę (shell: true), a nazwa zestawu
   * może zawierać spacje — stąd jawne cudzysłowy.
   */
  const renderResult =
    spawnSync(
      "npx",
      [
        "remotion",
        "render",
        "MyComp",
        `"${renderPath}"`,
      ],
      {
        stdio: "inherit",
        shell: true,
      },
    );

  if (
    renderResult.status !== 0
  ) {
    return {
      set: setName,
      ok: false,
      error: "Renderowanie zakończyło się błędem.",
    };
  }

  banner(
    `${setName} — Wyrównanie głośności`,
  );

  normalizeLoudness(
    renderPath,
    reelPath,
  );

  banner(
    `${setName} — Okładka`,
  );

  /*
   * Okładka nie jest krytyczna — przy błędzie rolka i opis
   * powstają dalej, a okładkę można wybrać ręcznie w aplikacji.
   */
  const coverResult =
    spawnSync(
      "npx",
      [
        "remotion",
        "still",
        "Cover",
        `"${coverPath}"`,
      ],
      {
        stdio: "inherit",
        shell: true,
      },
    );

  const coverOk =
    coverResult.status === 0;

  if (!coverOk) {
    console.warn(
      "Nie udało się wygenerować okładki — pomijam.",
    );
  }

  if (!skipDescription) {
    banner(
      `${setName} — Opis do rolki`,
    );

    const descriptionResult =
      runNode(
        ["generate-description.mjs"],
        setName,
        {
          REEL_STAMP: stamp,
        },
      );

    if (
      descriptionResult.status !==
      0
    ) {
      return {
        set: setName,
        ok: false,
        error: "Błąd przy generowaniu opisu.",
      };
    }
  }

  return {
    set: setName,
    ok: true,
    reelPath,
    descriptionPath:
      skipDescription
        ? null
        : descriptionPath,
    coverPath: coverOk
      ? coverPath
      : null,
  };
};

const main = async () => {
  const availableSets =
    listSets();

  if (
    availableSets.length === 0
  ) {
    console.error(
      `\nNie znaleziono żadnego zestawu w ${MEDIA_ROOT}.`,
    );

    console.error(
      "Utwórz tam podfolder i wrzuć do niego zdjęcia oraz filmy jednej realizacji.",
    );

    process.exit(1);
  }

  /*
   * Luźne pliki prosto w public/media/ nie należą do żadnego
   * zestawu. Wypisujemy je, żeby nie znikały po cichu.
   */
  const looseFiles =
    listLooseFiles();

  if (looseFiles.length > 0) {
    console.warn(
      `\nUWAGA: ${looseFiles.length} plików leży bezpośrednio w public/media/ i zostanie pominiętych:`,
    );

    looseFiles.forEach(
      (file) =>
        console.warn(
          `- ${file}`,
        ),
    );

    console.warn(
      "Przenieś je do podfolderu, żeby trafiły do rolki.",
    );
  }

  let setsToProcess;

  if (requestedSets.length > 0) {
    const unknown =
      requestedSets.filter(
        (name) =>
          !availableSets.includes(
            name,
          ),
      );

    if (unknown.length > 0) {
      console.error(
        `\nNie znaleziono zestawów: ${unknown.join(", ")}`,
      );

      console.error(
        `Dostępne: ${availableSets.join(", ")}`,
      );

      process.exit(1);
    }

    setsToProcess =
      requestedSets;
  } else if (forceAll) {
    setsToProcess =
      availableSets;
  } else {
    setsToProcess =
      availableSets.filter(
        (name) =>
          !fs.existsSync(
            getOutputDir(name),
          ),
      );
  }

  if (
    setsToProcess.length === 0
  ) {
    console.log(
      "\nWszystkie zestawy mają już gotowe rolki w output/.",
    );

    console.log(
      "Aby przerobić je ponownie: make-reel.bat --wszystko",
    );

    console.log(
      "Albo pojedynczy zestaw: node make-reel.mjs \"nazwa zestawu\"",
    );

    process.exit(0);
  }

  console.log(
    `\nDo przerobienia (${setsToProcess.length}): ${setsToProcess.join(", ")}`,
  );

  const results = [];

  for (const setName of setsToProcess) {
    try {
      results.push(
        await processSet(
          setName,
        ),
      );
    } catch (error) {
      results.push({
        set: setName,
        ok: false,
        error: error.message,
      });
    }
  }

  banner(
    "PODSUMOWANIE",
  );

  results.forEach((result) => {
    if (result.ok) {
      console.log(
        `OK   ${result.set}`,
      );

      console.log(
        `     ${result.reelPath}`,
      );

      if (
        result.descriptionPath
      ) {
        console.log(
          `     ${result.descriptionPath}`,
        );
      }

      if (
        result.coverPath
      ) {
        console.log(
          `     ${result.coverPath}`,
        );
      }
    } else {
      console.log(
        `BŁĄD ${result.set}`,
      );

      console.log(
        `     ${result.error}`,
      );
    }
  });

  const failed =
    results.filter(
      (result) => !result.ok,
    );

  console.log(
    `\nGotowe: ${results.length - failed.length}/${results.length}`,
  );

  if (failed.length > 0) {
    process.exit(1);
  }
};

main();
