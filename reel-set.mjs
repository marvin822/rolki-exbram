import fs from "fs";
import path from "path";

/*
 * Zestaw materiałów = jeden podfolder w public/media/.
 *
 * W środku leżą zdjęcia i filmy razem — o tym, którą ścieżką
 * pójdzie plik, decyduje rozszerzenie. Jeden zestaw daje jedną
 * rolkę, a jego nazwa wraca w output/<nazwa>/.
 *
 * Nazwa zestawu jest przekazywana zmienną środowiskową REEL_SET,
 * a nie argumentem — nazwy folderów mają spacje i polskie znaki,
 * a skrypty są odpalane przez powłokę.
 */

export const MEDIA_ROOT =
  path.join(
    process.cwd(),
    "public",
    "media",
  );

export const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
];

export const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
];

export const getSetName =
  () => {
    const name =
      process.env.REEL_SET;

    if (!name) {
      console.error(
        "Brak REEL_SET — nie wiadomo, który zestaw przetwarzać.",
      );

      console.error(
        "Uruchom pipeline przez make-reel.mjs albo ustaw REEL_SET na nazwę folderu w public/media/.",
      );

      process.exit(1);
    }

    return name;
  };

export const getSetDir =
  (name = getSetName()) => {
    return path.join(
      MEDIA_ROOT,
      name,
    );
  };

/*
 * Lista plików zestawu o podanych rozszerzeniach.
 *
 * Świadomie płaska — materiał leży bezpośrednio w folderze
 * zestawu, bez zagnieżdżeń.
 */
export const listSetFiles = (
  extensions,
  name = getSetName(),
) => {
  const directory =
    getSetDir(name);

  if (
    !fs.existsSync(directory)
  ) {
    return [];
  }

  return fs
    .readdirSync(directory, {
      withFileTypes: true,
    })
    .filter(
      (entry) =>
        entry.isFile() &&
        extensions.includes(
          path
            .extname(entry.name)
            .toLowerCase(),
        ),
    )
    .map(
      (entry) => entry.name,
    )
    .sort();
};

/*
 * Zestawy do przetworzenia: podfoldery public/media/, które
 * zawierają choć jeden plik zdjęciowy albo filmowy.
 *
 * Puste foldery i luźne pliki wrzucone prosto do public/media/
 * są pomijane — make-reel.mjs raportuje je osobno, żeby nie
 * znikały po cichu.
 */
export const listSets =
  () => {
    if (
      !fs.existsSync(
        MEDIA_ROOT,
      )
    ) {
      return [];
    }

    return fs
      .readdirSync(
        MEDIA_ROOT,
        {
          withFileTypes: true,
        },
      )
      .filter((entry) =>
        entry.isDirectory(),
      )
      .map(
        (entry) => entry.name,
      )
      .filter(
        (name) =>
          listSetFiles(
            [
              ...IMAGE_EXTENSIONS,
              ...VIDEO_EXTENSIONS,
            ],
            name,
          ).length > 0,
      )
      .sort();
  };

export const listLooseFiles =
  () => {
    if (
      !fs.existsSync(
        MEDIA_ROOT,
      )
    ) {
      return [];
    }

    const extensions = [
      ...IMAGE_EXTENSIONS,
      ...VIDEO_EXTENSIONS,
    ];

    return fs
      .readdirSync(
        MEDIA_ROOT,
        {
          withFileTypes: true,
        },
      )
      .filter(
        (entry) =>
          entry.isFile() &&
          extensions.includes(
            path
              .extname(
                entry.name,
              )
              .toLowerCase(),
          ),
      )
      .map(
        (entry) => entry.name,
      )
      .sort();
  };

export const getWorkDir = (
  name = getSetName(),
) => {
  return path.join(
    process.cwd(),
    "work",
    name,
  );
};

export const getOutputDir = (
  name = getSetName(),
) => {
  return path.join(
    process.cwd(),
    "output",
    name,
  );
};
