import fs from "fs";
import path from "path";

const MUSIC_DIR = path.join(
  process.cwd(),
  "public",
  "music",
);

const OUTPUT_FILE = path.join(
  process.cwd(),
  "music.json",
);

const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
];

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
  } catch {
    return fallback;
  }
};

const listTracks = () => {
  if (
    !fs.existsSync(MUSIC_DIR)
  ) {
    return [];
  }

  return fs
    .readdirSync(MUSIC_DIR, {
      withFileTypes: true,
    })
    .filter((entry) =>
      entry.isFile(),
    )
    .map((entry) => entry.name)
    .filter((name) =>
      AUDIO_EXTENSIONS.includes(
        path
          .extname(name)
          .toLowerCase(),
      ),
    )
    .sort();
};

const write = (data) => {
  fs.writeFileSync(
    OUTPUT_FILE,
    `${JSON.stringify(
      data,
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const tracks = listTracks();

if (tracks.length === 0) {
  console.warn(
    `Brak plików muzycznych w ${MUSIC_DIR} — rolka powstanie bez podkładu.`,
  );

  write({
    file: null,
    recent: [],
  });

  process.exit(0);
}

const stored = readJson(
  OUTPUT_FILE,
  {},
);

const recent = Array.isArray(
  stored.recent,
)
  ? stored.recent.filter(
      (name) =>
        tracks.includes(name),
    )
  : stored.file
    ? [stored.file]
    : [];

/*
 * Wykluczamy ostatnio grane utwory, żeby kolejne rolki nie
 * dostawały w kółko tego samego podkładu. Okno wykluczenia
 * rośnie z liczbą utworów, ale zawsze zostawia z czego losować:
 * przy 3 plikach wymusza pełną rotację, przy większej puli
 * pilnuje różnorodności, zachowując element losowości.
 */
const excludeCount = Math.min(
  tracks.length - 1,
  Math.ceil(tracks.length / 2),
);

const avoid = new Set(
  recent.slice(0, excludeCount),
);

let pool = tracks.filter(
  (name) => !avoid.has(name),
);

if (pool.length === 0) {
  pool = tracks;
}

const picked =
  pool[
    Math.floor(
      Math.random() *
        pool.length,
    )
  ];

const newRecent = [
  picked,
  ...recent.filter(
    (name) => name !== picked,
  ),
].slice(0, excludeCount);

write({
  file: picked,
  recent: newRecent,
});

console.log(
  `Podkład muzyczny: ${picked} ` +
    `(dostępne: ${tracks.length}` +
    `${
      recent.length > 0
        ? `, ostatnio: ${recent
            .slice(0, excludeCount)
            .join(", ")}`
        : ""
    })`,
);
