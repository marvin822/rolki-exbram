import { spawnSync } from "child_process";
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

/*
 * Wykrywanie rytmu podkładu, żeby cięcia między scenami padały
 * na uderzenia (Composition.tsx dociąga do nich długości scen).
 *
 * Prosty detektor bez zależności: FFmpeg dekoduje początek utworu
 * do mono PCM, z obwiedni energii liczymy siłę „ataków", tempo
 * z autokorelacji, a fazę (moment pierwszego uderzenia) z siatki,
 * która trafia w najwięcej ataków. Rolka trwa < 25 s, a podkład
 * gra od początku pliku, więc wystarczy pierwsze 40 s.
 *
 * Zwraca null, gdy rytm jest niewyraźny (ambient, brak perkusji)
 * — wtedy lepiej nie przesuwać cięć wcale niż przesuwać źle.
 */
const BEAT_SAMPLE_RATE = 11025;

const BEAT_HOP = 128;

const BEAT_WINDOW = 512;

const BEAT_SECONDS = 40;

const MIN_BPM = 70;

const MAX_BPM = 180;

const MIN_BEAT_CONFIDENCE = 1.3;

const detectBeat = (
  filePath,
) => {
  const decoded = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-t",
      String(BEAT_SECONDS),
      "-i",
      filePath,
      "-ac",
      "1",
      "-ar",
      String(BEAT_SAMPLE_RATE),
      "-f",
      "f32le",
      "-",
    ],
    {
      maxBuffer:
        64 * 1024 * 1024,
    },
  );

  if (
    decoded.status !== 0 ||
    !decoded.stdout ||
    decoded.stdout.length <
      BEAT_SAMPLE_RATE * 4 * 5
  ) {
    return null;
  }

  const buffer =
    decoded.stdout;

  const samples =
    new Float32Array(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset +
          buffer.length -
          (buffer.length % 4),
      ),
    );

  const frameCount =
    Math.floor(
      (samples.length -
        BEAT_WINDOW) /
        BEAT_HOP,
    );

  // Obwiednia energii w skali logarytmicznej.
  const energy =
    new Float64Array(
      frameCount,
    );

  for (
    let i = 0;
    i < frameCount;
    i += 1
  ) {
    let sum = 0;

    const start =
      i * BEAT_HOP;

    for (
      let j = 0;
      j < BEAT_WINDOW;
      j += 1
    ) {
      const value =
        samples[start + j];

      sum += value * value;
    }

    energy[i] = Math.log(
      1 +
        (1000 * sum) /
          BEAT_WINDOW,
    );
  }

  // Siła ataku: dodatni przyrost energii ponad lokalną średnią.
  const rawOnset =
    new Float64Array(
      frameCount,
    );

  for (
    let i = 1;
    i < frameCount;
    i += 1
  ) {
    rawOnset[i] = Math.max(
      0,
      energy[i] -
        energy[i - 1],
    );
  }

  const meanRadius = 20;

  const onset =
    new Float64Array(
      frameCount,
    );

  for (
    let i = 0;
    i < frameCount;
    i += 1
  ) {
    let sum = 0;
    let count = 0;

    for (
      let j = Math.max(
        0,
        i - meanRadius,
      );
      j <=
      Math.min(
        frameCount - 1,
        i + meanRadius,
      );
      j += 1
    ) {
      sum += rawOnset[j];
      count += 1;
    }

    onset[i] = Math.max(
      0,
      rawOnset[i] -
        sum / count,
    );
  }

  const framesPerSecond =
    BEAT_SAMPLE_RATE /
    BEAT_HOP;

  const minLag = Math.floor(
    (60 / MAX_BPM) *
      framesPerSecond,
  );

  const maxLag = Math.ceil(
    (60 / MIN_BPM) *
      framesPerSecond,
  );

  const autocorrelation =
    (lag) => {
      let sum = 0;

      for (
        let i = lag;
        i < frameCount;
        i += 1
      ) {
        sum +=
          onset[i] *
          onset[i - lag];
      }

      return sum;
    };

  const scores = [];

  for (
    let lag = minLag;
    lag <= maxLag;
    lag += 1
  ) {
    /*
     * Lekkie ważenie w stronę ~120 BPM ogranicza pomyłki
     * o oktawę (wykrycie połowy albo dwukrotności tempa).
     */
    const bpm =
      (60 *
        framesPerSecond) /
      lag;

    const octaves =
      Math.log2(bpm / 120);

    const weight = Math.exp(
      -0.5 *
        (octaves / 0.9) ** 2,
    );

    scores.push({
      lag,
      raw: autocorrelation(
        lag,
      ),
      weighted: 0,
    });

    scores[
      scores.length - 1
    ].weighted =
      scores[
        scores.length - 1
      ].raw * weight;
  }

  const meanRaw =
    scores.reduce(
      (total, item) =>
        total + item.raw,
      0,
    ) / scores.length;

  if (meanRaw <= 0) {
    return null;
  }

  const bestIndex =
    scores.reduce(
      (best, item, index) =>
        item.weighted >
        scores[best].weighted
          ? index
          : best,
      0,
    );

  const confidence =
    scores[bestIndex].raw /
    meanRaw;

  if (
    confidence <
    MIN_BEAT_CONFIDENCE
  ) {
    return null;
  }

  // Dokładniejszy okres: interpolacja paraboliczna wokół szczytu.
  let period =
    scores[bestIndex].lag;

  if (
    bestIndex > 0 &&
    bestIndex <
      scores.length - 1
  ) {
    const left =
      scores[bestIndex - 1]
        .raw;

    const center =
      scores[bestIndex].raw;

    const right =
      scores[bestIndex + 1]
        .raw;

    const denominator =
      left -
      2 * center +
      right;

    if (denominator < 0) {
      period +=
        (0.5 *
          (left - right)) /
        denominator;
    }
  }

  // Faza: przesunięcie siatki trafiające w najwięcej ataków.
  let bestPhase = 0;
  let bestPhaseScore = -1;

  for (
    let phase = 0;
    phase < period;
    phase += 0.5
  ) {
    let score = 0;

    for (
      let position = phase;
      position < frameCount;
      position += period
    ) {
      const index =
        Math.round(position);

      score += Math.max(
        onset[index - 1] ?? 0,
        onset[index] ?? 0,
        onset[index + 1] ?? 0,
      );
    }

    if (
      score > bestPhaseScore
    ) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }

  const round = (
    value,
    digits,
  ) =>
    Number(
      value.toFixed(digits),
    );

  /*
   * Skok energii w ramce i pojawia się, gdy atak wchodzi na
   * koniec jej okna — czyli BEAT_WINDOW próbek za początkiem.
   */
  const offset =
    (bestPhase * BEAT_HOP +
      BEAT_WINDOW) /
    BEAT_SAMPLE_RATE;

  return {
    bpm: round(
      (60 *
        framesPerSecond) /
        period,
      2,
    ),
    offset: round(offset, 3),
    confidence: round(
      confidence,
      2,
    ),
  };
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

const beat = detectBeat(
  path.join(
    MUSIC_DIR,
    picked,
  ),
);

write({
  file: picked,
  recent: newRecent,
  beat,
});

if (beat) {
  console.log(
    `Rytm: ${beat.bpm} BPM, pierwsze uderzenie ${beat.offset} s ` +
      `(pewność ${beat.confidence})`,
  );
} else {
  console.warn(
    "Nie udało się pewnie wykryć rytmu — cięcia zostaną bez dopasowania do muzyki.",
  );
}

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
