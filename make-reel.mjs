import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

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

const steps = [
  {
    name: "Wyciąganie klatek z filmów",
    command: "node",
    args: ["extract-video-frames.mjs"],
  },
  {
    name: "Analiza filmów",
    command: "node",
    args: ["analyze-video.mjs"],
  },
  {
    name: "Szczegółowa analiza wybranych fragmentów filmów",
    command: "node",
    args: ["analyze-video-detail.mjs"],
  },
  {
    name: "Analiza zdjęć i tworzenie planu",
    command: "node",
    args: ["analyze-image.mjs"],
  },
  {
    name: "Normalizacja filmów",
    command: "node",
    args: ["normalize-videos.mjs"],
  },
];

for (const step of steps) {
  console.log(
    "\n========================================",
  );

  console.log(step.name);

  console.log(
    "========================================\n",
  );

  const result = spawnSync(
    step.command,
    step.args,
    {
      stdio: "inherit",
      shell: true,
    },
  );

  if (result.status !== 0) {
    console.error(
      `\nBłąd w kroku: ${step.name}`,
    );

    process.exit(
      result.status ?? 1,
    );
  }
}

if (!fs.existsSync("./edit.json")) {
  console.error(
    "\nNie znaleziono edit.json. Nie można renderować.",
  );

  process.exit(1);
}

const editPlan = JSON.parse(
  fs.readFileSync(
    "./edit.json",
    "utf8",
  ),
);

const getScenePath = (
  scene,
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
    "photos",
    scene.file,
  );
};

const missingSceneFiles =
  editPlan.scenes
    .map((scene) => ({
      scene,
      filePath:
        getScenePath(scene),
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
  console.error(
    "\nPlan montażu zawiera nieistniejące pliki:",
  );

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

  process.exit(1);
}

console.log(
  "\n========================================",
);

console.log(
  "Renderowanie rolki",
);

console.log(
  "========================================\n",
);

fs.mkdirSync(
  "./output",
  {
    recursive: true,
  },
);

const renderResult = spawnSync(
  "npx",
  [
    "remotion",
    "render",
    "MyComp",
    "./output/reel.mp4",
  ],
  {
    stdio: "inherit",
    shell: true,
  },
);

if (
  renderResult.status !== 0
) {
  console.error(
    "\nRenderowanie zakończyło się błędem.",
  );

  process.exit(
    renderResult.status ?? 1,
  );
}

if (!skipDescription) {
  console.log(
    "\n========================================",
  );

  console.log(
    "Opis do rolki",
  );

  console.log(
    "========================================\n",
  );

  const descriptionResult =
    spawnSync(
      "node",
      ["generate-description.mjs"],
      {
        stdio: "inherit",
        shell: true,
      },
    );

  if (
    descriptionResult.status !== 0
  ) {
    console.error(
      "\nBłąd w kroku: Opis do rolki",
    );

    process.exit(
      descriptionResult.status ??
        1,
    );
  }
}

console.log(
  "\n========================================",
);

console.log(
  "PIPELINE ZAKOŃCZONY",
);

console.log(
  "========================================",
);

console.log(
  "\nGotowa rolka:",
);

console.log(
  "./output/reel.mp4",
);

if (!skipDescription) {
  console.log(
    "\nOpis do rolki:",
  );

  console.log(
    "./opis.txt",
  );
}