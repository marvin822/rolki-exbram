import fs from "fs";
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

fs.mkdirSync(processedDir, {
  recursive: true,
});

const getRotation = (filePath) => {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      filePath,
    ],
    {
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `Nie udało się odczytać metadanych: ${filePath}`,
    );
  }

  const data = JSON.parse(
    result.stdout,
  );

  const stream =
    data.streams?.find(
      (item) =>
        item.codec_type ===
        "video",
    );

  if (!stream) {
    return 0;
  }

  const sideDataRotation =
    stream.side_data_list?.find(
      (item) =>
        typeof item.rotation ===
        "number",
    )?.rotation;

  if (
    typeof sideDataRotation ===
    "number"
  ) {
    return sideDataRotation;
  }

  const tagRotation = Number(
    stream.tags?.rotate,
  );

  if (
    Number.isFinite(
      tagRotation,
    )
  ) {
    return tagRotation;
  }

  return 0;
};

const getTransposeFilter = (
  rotation,
) => {
  const normalized =
    ((rotation % 360) + 360) % 360;

  switch (normalized) {
    case 90:
      return "transpose=2";

    case 180:
      return "transpose=2,transpose=2";

    case 270:
      return "transpose=1";

    case 0:
    default:
      return null;
  }
};

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

  let rotation;

  try {
    rotation =
      getRotation(
        inputPath,
      );
  } catch (error) {
    console.error(
      `Nie udało się odczytać rotacji: ${error.message}`,
    );

    process.exit(1);
  }

  console.log(
    `Wykryta rotacja: ${rotation}°`,
  );

  const transpose =
    getTransposeFilter(
      rotation,
    );

  console.log(
    `Transformacja: ${
      transpose ?? "brak"
    }`,
  );

  const filters = [];

  if (transpose) {
    filters.push(
      transpose,
    );
  }

  filters.push(
    "scale=1920:1920:force_original_aspect_ratio=decrease",
  );

  filters.push(
    "format=nv12",
  );

  filters.push(
    "hwupload_cuda",
  );

  const filterGraph = [
    "hwdownload",
    "format=nv12",
    ...filters,
  ].join(",");

  const args = [
    "-y",

    "-hwaccel",
    "cuda",

    "-hwaccel_output_format",
    "cuda",

    "-i",
    inputPath,

    "-vf",
    filterGraph,

    "-c:v",
    "h264_nvenc",

    "-preset",
    "p4",

    "-r",
    "30",

    "-c:a",
    "aac",

    outputPath,
  ];

  const result = spawnSync(
    "ffmpeg",
    args,
    {
      stdio: "inherit",
    },
  );

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