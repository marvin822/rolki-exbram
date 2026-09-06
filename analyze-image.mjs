import fs from "fs";
import path from "path";
import OpenAI from "openai";

const PUBLIC_DIR = path.join(
  process.cwd(),
  "public",
);

const PHOTOS_DIR = path.join(
  PUBLIC_DIR,
  "media",
  "photos",
);

const VIDEOS_DIR = path.join(
  PUBLIC_DIR,
  "media",
  "videos",
);

const ANALYSIS_FILE = path.join(
  process.cwd(),
  "analysis.json",
);

const VIDEO_ANALYSIS_FILE = path.join(
  process.cwd(),
  "video-analysis.json",
);

const EDIT_FILE = path.join(
  process.cwd(),
  "edit.json",
);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
];

const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
];

/*
 * Minimalna jakość fragmentu wideo, żeby w ogóle trafił
 * do planera. Poniżej tej wartości (albo usable=false)
 * fragment jest pomijany — zwykle są to rozmyte najazdy
 * albo makro, na którym nie widać, że to ogrodzenie.
 */
const MIN_VIDEO_FRAGMENT_QUALITY = 0.8;

/*
 * Wersja schematu analizy zdjęcia. Zwiększ, gdy zmienią się
 * pola albo istotnie prompt — starsze wpisy w analysis.json
 * zostaną wtedy przeanalizowane od nowa zamiast wziąć z cache.
 */
const ANALYSIS_SCHEMA_VERSION = 4;

const getMimeType = (
  extension,
) => {
  switch (
    extension.toLowerCase()
  ) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";

    case ".png":
      return "image/png";

    case ".webp":
      return "image/webp";

    default:
      throw new Error(
        `Nieobsługiwane rozszerzenie obrazu: ${extension}`,
      );
  }
};

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
  } catch (error) {
    throw new Error(
      `Nie można odczytać ${filePath}: ${error.message}`,
    );
  }
};

const writeJson = (
  filePath,
  data,
) => {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      data,
      null,
      2,
    ),
    "utf8",
  );
};

const getBase64Image = (
  filePath,
) => {
  return fs
    .readFileSync(filePath)
    .toString("base64");
};

/*
 * Data wykonania zdjęcia z EXIF (DateTimeOriginal, tag 0x9003).
 *
 * Służy do rozpoznania, że w jednym folderze leżą zdjęcia z KILKU
 * realizacji — sesje robione o różnych porach tworzą wyraźne grupy.
 * Bez tego planer sklejał w jedną rolkę dwie różne posesje.
 */
const getTakenAt = (
  filePath,
) => {
  try {
    const buffer =
      fs.readFileSync(filePath);

    for (
      let i = 2;
      i < buffer.length - 4;

    ) {
      if (buffer[i] !== 0xff) {
        break;
      }

      const marker =
        buffer[i + 1];

      const length =
        buffer.readUInt16BE(
          i + 2,
        );

      if (
        marker === 0xe1 &&
        buffer.toString(
          "ascii",
          i + 4,
          i + 8,
        ) === "Exif"
      ) {
        const tiff = i + 10;

        const little =
          buffer.toString(
            "ascii",
            tiff,
            tiff + 2,
          ) === "II";

        const readU16 = (
          offset,
        ) =>
          little
            ? buffer.readUInt16LE(
                offset,
              )
            : buffer.readUInt16BE(
                offset,
              );

        const readU32 = (
          offset,
        ) =>
          little
            ? buffer.readUInt32LE(
                offset,
              )
            : buffer.readUInt32BE(
                offset,
              );

        const readDate = (
          ifd,
        ) => {
          const count =
            readU16(ifd);

          for (
            let k = 0;
            k < count;
            k++
          ) {
            const entry =
              ifd + 2 + k * 12;

            const tag =
              readU16(entry);

            if (
              tag === 0x9003 ||
              tag === 0x0132
            ) {
              const offset =
                tiff +
                readU32(
                  entry + 8,
                );

              return buffer
                .toString(
                  "ascii",
                  offset,
                  offset + 19,
                )
                .trim();
            }

            if (
              tag === 0x8769
            ) {
              const sub =
                readDate(
                  tiff +
                    readU32(
                      entry + 8,
                    ),
                );

              if (sub) {
                return sub;
              }
            }
          }

          return null;
        };

        return readDate(
          tiff + readU32(tiff + 4),
        );
      }

      i += 2 + length;
    }
  } catch {
    return null;
  }

  return null;
};

const getFilesFromDirectory = (
  directory,
  extensions,
) => {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(
      directory,
      {
        withFileTypes: true,
      },
    )
    .filter(
      (entry) =>
        entry.isFile(),
    )
    .map(
      (entry) =>
        entry.name,
    )
    .filter(
      (file) =>
        extensions.includes(
          path
            .extname(file)
            .toLowerCase(),
        ),
    )
    .sort();
};

const getPhotoFiles = () => {
  return getFilesFromDirectory(
    PHOTOS_DIR,
    IMAGE_EXTENSIONS,
  );
};

const getVideoFiles = () => {
  return getFilesFromDirectory(
    VIDEOS_DIR,
    VIDEO_EXTENSIONS,
  );
};

const analyzeImage = async (
  file,
) => {
  const extension =
    path.extname(file);

  const filePath =
    path.join(
      PHOTOS_DIR,
      file,
    );

  const base64 =
    getBase64Image(
      filePath,
    );

  const mimeType =
    getMimeType(
      extension,
    );

  console.log(
    `Analizuję zdjęcie: ${file}`,
  );

  const response =
    await client.responses.create({
      model: "gpt-5-mini",

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_text",

              text: `
Przeanalizuj zdjęcie realizacji firmy produkującej ogrodzenia.

Potrzebujemy wykorzystać to zdjęcie w pionowym Reelu 1080x1920.

CO JEST PRODUKTEM EXBRAM (najważniejsze):

Produktem są WYŁĄCZNIE elementy METALOWE: przęsła, panele, lamele,
brama, furtka, balustrada, kute ozdoby.

Murek, podmurówka, słupki murowane/kamienne/betonowe, ściana, dach,
kostka, podjazd, droga, trawnik i niebo to TŁO — nie produkt.
Mur i podmurówka są sprawą drugorzędną; nie liczą się jako produkt,
nawet jeśli ładnie wyglądają.

Oceń:
- co przedstawia zdjęcie,
- jaki jest główny obiekt/element,
- gdzie znajduje się główny punkt zainteresowania,
- czy lepszy będzie zoom czy przesunięcie obrazu,
- jak silny powinien być ruch.

Oceń dodatkowo:
- shotType:
  - "wide" — cała realizacja z dużej odległości, ogrodzenie to mała część kadru,
  - "context" — ogrodzenie/brama wyraźnie widoczne razem z otoczeniem (dom, słupki),
  - "detail" — zbliżenie na przęsła / lamele / bramę, wciąż jasno widać, że to ogrodzenie,
  - "macro" — bardzo ciasny kadr na pojedynczy element (śruba, wspornik, narożnik) bez kontekstu,
- productProminence 0-1 — jaką część WYSOKOŚCI kadru zajmuje sam METAL
  (przęsła, panele, lamele, brama, furtka, balustrada). Murek i podmurówka
  pod przęsłami NIE liczą się do tej wartości. Jeśli sam metal to poziomy pas
  zajmujący mniej niż ~1/3 wysokości zdjęcia, productProminence <= 0.5.
- deadSpace 0-1 — jaka część kadru to powierzchnia NIEBĘDĄCA metalem EXBRAM:
  murek, podmurówka, słupki murowane/kamienne/betonowe, ściana, dach, niebo,
  goła ziemia, trawnik, asfalt, droga, chodnik, podjazd, kostka brukowa,
  samochody. Ładna kostka, równy podjazd czy efektowny murek to nadal
  deadSpace — liczy się tylko to, że nie jest to metalowe ogrodzenie ani brama.

Zasady:
- zoomIn stosuj, gdy główny obiekt znajduje się centralnie lub względnie centralnie,
- zoomOut stosuj tylko wtedy, gdy pokazanie całej realizacji daje wyraźnie lepszy efekt,
- panLeft stosuj, gdy interesujący obiekt znajduje się bardziej po lewej stronie,
- panRight stosuj, gdy interesujący obiekt znajduje się bardziej po prawej stronie,
- unikaj agresywnego ruchu,
- focusX i focusY podawaj jako procenty 0-100,
- focusX/focusY ustaw DOKŁADNIE na METALOWEJ części ogrodzenia lub bramy,
  gdziekolwiek jest w kadrze: gdy metal jest wysoko, focusY może być 25-40;
  gdy nisko — 60-80; nigdy nie zostawiaj 50 „na wszelki wypadek",
- focusY NIE może wskazywać na murek/podmurówkę pod przęsłami ani na
  podjazd, kostkę, drogę, trawnik, dach czy niebo — celuj w środek
  metalowych przęseł,
- motionStrength podawaj jako wartość 0-1.

Odpowiedz wyłącznie JSON-em zgodnym ze schematem.
              `,
            },

            {
              type: "input_image",

              image_url:
                `data:${mimeType};base64,${base64}`,
            },
          ],
        },
      ],

      text: {
        format: {
          type: "json_schema",

          name: "image_analysis",

          strict: true,

          schema: {
            type: "object",

            additionalProperties: false,

            properties: {
              file: {
                type: "string",
              },

              subject: {
                type: "string",
              },

              focusX: {
                type: "number",
              },

              focusY: {
                type: "number",
              },

              recommendedMotion: {
                type: "string",

                enum: [
                  "zoomIn",
                  "zoomOut",
                  "panLeft",
                  "panRight",
                ],
              },

              motionStrength: {
                type: "number",
              },

              shotType: {
                type: "string",

                enum: [
                  "wide",
                  "context",
                  "detail",
                  "macro",
                ],
              },

              productProminence: {
                type: "number",
              },

              deadSpace: {
                type: "number",
              },

              confidence: {
                type: "number",
              },
            },

            required: [
              "file",
              "subject",
              "focusX",
              "focusY",
              "recommendedMotion",
              "motionStrength",
              "shotType",
              "productProminence",
              "deadSpace",
              "confidence",
            ],
          },
        },
      },
    });

  const result =
    JSON.parse(
      response.output_text,
    );

  return {
    ...result,
    file,
    takenAt:
      getTakenAt(filePath),
    schemaVersion:
      ANALYSIS_SCHEMA_VERSION,
  };
};

const MAX_FRAGMENTS_PER_VIDEO = 2;

const generateEditPlan = async ({
  images,
  videos,
}) => {
  /*
   * Z każdego filmu podsuwamy planerowi tylko 2 najlepiej
   * ocenione fragmenty. Wcześniej mógł wybrać dwa słabsze
   * (np. boczny najazd + ujęcie z pustym murem) zamiast
   * jednego mocnego, frontalnego.
   */
  const trimmedVideos =
    videos.map((item) => {
      const fragments =
        Array.isArray(
          item.fragments,
        )
          ? item.fragments
          : [];

      if (
        fragments.length <=
        MAX_FRAGMENTS_PER_VIDEO
      ) {
        return item;
      }

      return {
        ...item,
        fragments: [
          ...fragments,
        ]
          .sort(
            (a, b) =>
              (Number(
                b.qualityScore,
              ) || 0) -
              (Number(
                a.qualityScore,
              ) || 0),
          )
          .slice(
            0,
            MAX_FRAGMENTS_PER_VIDEO,
          ),
      };
    });

  const media = [
    ...images.map(
      (item) => ({
        file: item.file,

        type: "photo",

        subject:
          item.subject,

        recommendedMotion:
          item.recommendedMotion,

        motionStrength:
          item.motionStrength,

        shotType:
          item.shotType,

        productProminence:
          item.productProminence,

        deadSpace:
          item.deadSpace,

        takenAt:
          item.takenAt,

        confidence:
          item.confidence,
      }),
    ),

    ...trimmedVideos.flatMap(
      (item) => {
        const fragments =
          Array.isArray(
            item.fragments,
          )
            ? item.fragments
            : [];

        if (
          fragments.length === 0
        ) {
          return [
            {
              file: item.file,

              fragmentId:
                `${item.file}#fragment-1`,

              type: "video",

              subject:
                item.subject,

              qualityScore:
                item.qualityScore,

              usable:
                item.usable,

              recommendedStart:
                item.refinedStart ??
                item.recommendedStart,

              recommendedDuration:
                item.refinedDuration ??
                item.recommendedDuration,

              refinedStart:
                item.refinedStart,

              refinedDuration:
                item.refinedDuration,

              confidence:
                item.confidence,
            },
          ];
        }

        return fragments.map(
          (fragment) => ({
            file: item.file,

            fragmentId:
              fragment.fragmentId,

            type: "video",

            subject:
              item.subject,

            qualityScore:
              fragment.qualityScore ??
              item.qualityScore,

            usable:
              fragment.usable ??
              item.usable,

            recommendedStart:
              fragment.refinedStart,

            recommendedDuration:
              fragment.refinedDuration,

            refinedStart:
              fragment.refinedStart,

            refinedDuration:
              fragment.refinedDuration,

            confidence:
              fragment.confidence ??
              item.confidence,
          }),
        );
      },
    ),
  ];

  /*
   * P1: odfiltrowujemy słabe fragmenty wideo, żeby planer
   * wybierał tylko spośród ujęć, na których produkt jest
   * wyraźnie widoczny (bez rozmytych najazdów i makro).
   */
  const usableMedia =
    media.filter(
      (entry) =>
        entry.type !== "video" ||
        (entry.usable !==
          false &&
          Number(
            entry.qualityScore,
          ) >=
            MIN_VIDEO_FRAGMENT_QUALITY),
    );

  const droppedVideos =
    media.length -
    usableMedia.length;

  if (droppedVideos > 0) {
    console.log(
      `Pominięto ${droppedVideos} słabych fragmentów wideo (jakość < ${MIN_VIDEO_FRAGMENT_QUALITY}).`,
    );
  }

  console.log(
    "\nTworzę plan montażu...",
  );

  const response =
    await client.responses.create({
      model: "gpt-5-mini",

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_text",

              text: `
Jesteś doświadczonym montażystą krótkich reklamowych Reels dla firmy EXBRAM produkującej ogrodzenia.

Na podstawie dostępnych materiałów przygotuj atrakcyjną, dynamiczną rolkę prezentującą realizację.

MATERIAŁY:
${JSON.stringify(
  usableMedia,
  null,
  2,
)}

CEL DŁUGOŚCI:

- cała rolka ma trwać 20-23 sekundy i NIGDY więcej niż 25 sekund;
  plansza końcowa to około 3 sekundy, więc materiał przed planszą
  to około 17-20 sekund,
- preferuj 6-8 scen (średnie ujęcie ok. 3-3.5 s, żeby wyjść na 17-20 s),
- jeśli dostępnych jest wystarczająco dużo dobrych materiałów, wykorzystaj 6-8 różnych materiałów,
- ujęcia mają być trochę dłuższe i spokojniejsze — daj widzowi obejrzeć kadr,
- nie skracaj rolki tylko dlatego, że można użyć mniejszej liczby scen,
- jednocześnie nigdy nie dodawaj słabego materiału wyłącznie po to, żeby osiągnąć długość,
- jakość i atrakcyjność są ważniejsze niż dokładne osiągnięcie czasu.

JEDNA REALIZACJA (sprawdź to NAJPIERW):

- rolka pokazuje JEDNĄ realizację u JEDNEGO klienta,
- w folderze mogą leżeć zdjęcia z kilku różnych posesji — rozpoznasz to
  po polu takenAt (sesje robione o różnych porach/dniach tworzą grupy)
  oraz po opisach (inny budynek, inne otoczenie, inny typ produktu),
- jeśli materiały dzielą się na kilka realizacji, wybierz TĘ JEDNĄ,
  która ma najwięcej mocnych ujęć, i zignoruj pozostałe — nawet jeśli
  przez to rolka będzie krótsza od docelowej długości,
- NIGDY nie mieszaj w jednej rolce dwóch różnych posesji: widz zobaczy
  wtedy kilka różnych budynków i przekaz się rozjeżdża.

KOMPOZYCJA:

- zacznij od najmocniejszego wizualnie materiału,
- następnie pokazuj realizację z różnych perspektyw,
- przeplataj szersze ujęcia z detalami,
- unikaj kilku bardzo podobnych zdjęć jedno po drugim,
- mocny materiał może pojawić się bliżej końca,
- zakończ mocnym ujęciem realizacji,
- rolka ma sprawiać wrażenie profesjonalnego materiału reklamowego, a nie pokazu wszystkich zdjęć fotografa.

JAKOŚĆ KADRU (używaj pól shotType, productProminence, deadSpace):

- na OTWARCIE i ZAKOŃCZENIE wybieraj ujęcie FRONTALNE, na którym brama
  lub ogrodzenie wypełnia dużą część kadru — nigdy ujęcia bocznego,
  oddalonego, „w perspektywie" wzdłuż płotu ani z dużym pierwszym planem
  drogi / ziemi / muru,
- dla filmu na otwarcie/zakończenie wybieraj fragment, którego opis mówi
  o ujęciu frontalnym / symetrycznym / „produkt wypełnia kadr",
- oceniaj productProminence i deadSpace WZGLĘDNIE, porównując materiały
  między sobą w tym zestawie — progi bezwzględne nie mają sensu, bo przy
  ogrodzeniu na murku deadSpace bywa wysoki dla wszystkich ujęć,
- na otwarcie weź materiał z NAJWYŻSZYM productProminence w zestawie;
  nigdy nie otwieraj ujęciem shotType="wide" ani takim z najgorszym
  wynikiem w zestawie,
- materiałów z dolnej połowy rankingu (niski productProminence, wysoki
  deadSpace) użyj tylko, jeśli brakuje scen do docelowej długości,
  i nigdy dwóch obok siebie,
- lepiej dać 5 mocnych ujęć trochę dłuższych niż dołożyć dwa słabe,
- shotType="macro" użyj maksymalnie raz w całej rolce i nigdy jako
  pierwsze ani ostatnie ujęcie,
- preferuj shotType="context" i "detail"; "wide" najwyżej jedno,
  w środkowej części rolki.

ZDJĘCIA:

- zwykle 3-4 sekundy,
- bardzo mocne zdjęcie może trwać około 4-4.5 sekundy,
- słabszego zdjęcia nie wydłużaj (zostaw około 3 sekund).

FILMY:

- wykorzystuj tylko wtedy, gdy są atrakcyjne i sprzedażowo przydatne,
- jeśli na liście jest fragment filmowy z qualityScore >= 0.85,
  wykorzystaj przynajmniej jeden — ruch kamery ożywia rolkę
  i odróżnia ją od serii nieruchomych zdjęć,
- jeśli WIĘKSZOŚĆ dostępnych zdjęć ma productProminence < 0.4
  (produkt zajmuje mało kadru), a masz fragmenty wideo z
  qualityScore >= 0.9 — oprzyj rolkę głównie na wideo (3-4 fragmenty),
  a zdjęcia daj tylko jako krótkie przerywniki; na takim materiale
  film jest zwykle jedynym ujęciem, gdzie brama wypełnia kadr,
- nie wstawiaj kilku fragmentów wideo obok siebie ani słabszych
  fragmentów tylko po to, żeby w rolce było wideo,
- fragment filmowy może trwać około 4-5 sekund, jeśli ujęcie na to zasługuje,
- wybieraj konkretny fragment z listy fragmentów filmu,
- NIE wymyślaj nowego fragmentu,
- NIE zmieniaj fragmentId,
- NIE zmieniaj refinedStart,
- NIE zmieniaj refinedDuration,
- decyzja AI dla filmu ma dotyczyć przede wszystkim tego, czy konkretny fragment warto wykorzystać i w którym miejscu rolki go umieścić.

RÓŻNORODNOŚĆ:

- nie używaj tego samego zdjęcia więcej niż raz,
- tego samego fragmentu filmu nie używaj więcej niż raz,
- możesz użyć maksymalnie dwóch różnych fragmentów tego samego filmu,
- preferuj różne widoki tej samej realizacji,
- pokazuj zarówno całość, jak i detale,
- priorytetem jest produkt: ogrodzenie, brama, furtka, panele, detale wykonania.

WAŻNE:

1. Możesz wybierać WYŁĄCZNIE materiały znajdujące się na przekazanej liście.
2. Dla zdjęcia zwróć dokładnie wartość file z listy.
3. Dla filmu zwróć dokładnie wartość file oraz fragmentId z listy.
4. Nigdy nie twórz nazw plików samodzielnie.
5. Nigdy nie twórz własnego fragmentId.
6. Dla filmu nie zmieniaj czasu rozpoczęcia ani długości wybranego fragmentu.
7. Nie dodawaj żadnych innych plików.
8. Nie dodawaj napisów.
9. Nie dodawaj CTA.
10. Nie dodawaj muzyki.
11. Nie wymyślaj treści, których nie potwierdza analiza materiału.
12. Pole reason krótko wyjaśnia decyzję montażową.
13. duration podawaj w sekundach.
14. Dla zdjęć wybieraj zwykle 3-4 sekundy.
15. Preferuj 6-8 scen, jeżeli materiał na to pozwala.
16. Całość materiału przed planszą końcową powinna być zwykle blisko 17-20 sekund (cała rolka 20-23 s, max 25 s).
17. Jeśli do osiągnięcia 17-20 sekund potrzebny jest dodatkowy dobry materiał, wybierz go.
18. Jeśli dodatkowy materiał jest wyraźnie słaby, pomiń go zamiast sztucznie wydłużać rolkę.

Zwróć wyłącznie JSON zgodny ze schematem.
              `,
            },
          ],
        },
      ],

      text: {
        format: {
          type: "json_schema",

          name: "edit_plan",

          strict: true,

          schema: {
            type: "object",

            additionalProperties: false,

            properties: {
              scenes: {
                type: "array",

                minItems: 1,

                maxItems: 10,

                items: {
                  type: "object",

                  additionalProperties: false,

                  properties: {
                    file: {
                      type: "string",
                    },

                    fragmentId: {
                      type: "string",
                    },

                    duration: {
                      type: "number",
                    },

                    start: {
                      type: "number",
                    },

                    reason: {
                      type: "string",
                    },
                  },

                  required: [
                    "file",
                    "fragmentId",
                    "duration",
                    "start",
                    "reason",
                  ],
                },
              },
            },

            required: [
              "scenes",
            ],
          },
        },
      },
    });

  if (
    !response.output_text
  ) {
    throw new Error(
      "AI nie zwróciło planu montażu.",
    );
  }

  const plan =
    JSON.parse(
      response.output_text,
    );

  console.log(
    "\nAI RAW PLAN:",
  );

  console.log(
    JSON.stringify(
      plan,
      null,
      2,
    ),
  );

  const allowedMedia =
    new Map(
      usableMedia.map(
        (item) => [
          `${item.file}::${item.fragmentId ?? ""}`,
          item,
        ],
      ),
    );

  const validatedScenes = [];

  for (
    const scene of
      plan.scenes
  ) {
    const fragmentId =
      scene.fragmentId ?? "";

    const key =
      `${scene.file}::${fragmentId}`;

    const item =
      allowedMedia.get(key);

    if (!item) {
      continue;
    }

    if (
      item.type === "photo"
    ) {
      validatedScenes.push({
        file:
          item.file,

        fragmentId: "",

        duration:
          Math.min(
            4.5,
            Math.max(
              2.5,
              Number(
                scene.duration,
              ) || 3.5,
            ),
          ),

        start: 0,

        reason:
          scene.reason,
      });

      continue;
    }

    const start =
      Number(
        item.refinedStart,
      );

    const duration =
      Number(
        item.refinedDuration,
      );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(duration)
    ) {
      continue;
    }

    validatedScenes.push({
      file:
        item.file,

      fragmentId:
        item.fragmentId,

      duration:
        Math.min(
          5,
          Math.max(
            2,
            duration,
          ),
        ),

      start:
        Math.max(
          0,
          start,
        ),

      reason:
        scene.reason,
    });
  }

  const uniqueScenes = [];

  const usedPhotos =
    new Set();

  const usedFragments =
    new Set();

  const videoUsage =
    new Map();

  for (
    const scene of
      validatedScenes
  ) {
    if (
      scene.fragmentId
    ) {
      if (
        usedFragments.has(
          scene.fragmentId,
        )
      ) {
        continue;
      }

      const currentUsage =
        videoUsage.get(
          scene.file,
        ) || 0;

      if (
        currentUsage >= 2
      ) {
        continue;
      }

      usedFragments.add(
        scene.fragmentId,
      );

      videoUsage.set(
        scene.file,
        currentUsage + 1,
      );

      uniqueScenes.push(
        scene,
      );

      continue;
    }

    if (
      usedPhotos.has(
        scene.file,
      )
    ) {
      continue;
    }

    usedPhotos.add(
      scene.file,
    );

    uniqueScenes.push(
      scene,
    );
  }

  if (
    uniqueScenes.length === 0
  ) {
    throw new Error(
      "AI nie wygenerowało żadnej prawidłowej sceny.",
    );
  }

  return {
    scenes:
      uniqueScenes,
  };
};

const main = async () => {
  if (
    !process.env.OPENAI_API_KEY
  ) {
    throw new Error(
      "Brak OPENAI_API_KEY w zmiennych środowiskowych.",
    );
  }

  if (
    !fs.existsSync(
      PHOTOS_DIR,
    )
  ) {
    throw new Error(
      `Nie znaleziono katalogu zdjęć: ${PHOTOS_DIR}`,
    );
  }

  if (
    !fs.existsSync(
      VIDEOS_DIR,
    )
  ) {
    throw new Error(
      `Nie znaleziono katalogu filmów: ${VIDEOS_DIR}`,
    );
  }

  const imageFiles =
    getPhotoFiles();

  const videoFiles =
    getVideoFiles();

  console.log(
    `\nZdjęcia: ${imageFiles.length}`,
  );

  console.log(
    `Filmy: ${videoFiles.length}`,
  );

  console.log(
    "\nMateriały wejściowe:",
  );

  imageFiles.forEach(
    (file) =>
      console.log(
        `- media/photos/${file}`,
      ),
  );

  videoFiles.forEach(
    (file) =>
      console.log(
        `- media/videos/${file}`,
      ),
  );

  let analysis =
    readJson(
      ANALYSIS_FILE,
      [],
    );

  const existingAnalysis =
    new Map(
      analysis.map(
        (item) => [
          item.file,
          item,
        ],
      ),
    );

  for (
    const file of
      imageFiles
  ) {
    const cached =
      existingAnalysis.get(
        file,
      );

    /*
     * Cache jest ważny tylko, gdy pochodzi z aktualnej wersji
     * schematu analizy. Po zmianie pól lub istotnej zmianie
     * promptu (ANALYSIS_SCHEMA_VERSION) starsze wpisy są
     * analizowane od nowa.
     */
    const cacheComplete =
      cached &&
      cached.schemaVersion ===
        ANALYSIS_SCHEMA_VERSION &&
      typeof cached.shotType ===
        "string" &&
      typeof cached.productProminence ===
        "number" &&
      typeof cached.deadSpace ===
        "number";

    if (cacheComplete) {
      console.log(
        `Pomijam istniejącą analizę: ${file}`,
      );

      continue;
    }

    const result =
      await analyzeImage(
        file,
      );

    existingAnalysis.set(
      file,
      result,
    );
  }

  analysis =
    imageFiles.map(
      (file) =>
        existingAnalysis.get(
          file,
        ),
    );

  writeJson(
    ANALYSIS_FILE,
    analysis,
  );

  console.log(
    `\nZapisano ${ANALYSIS_FILE}`,
  );

  const videoAnalysis =
    readJson(
      VIDEO_ANALYSIS_FILE,
      [],
    );

  const validVideoAnalysis =
    videoFiles
      .map(
        (file) =>
          videoAnalysis.find(
            (item) =>
              item.file ===
              file,
          ),
      )
      .filter(Boolean);

  if (
    videoFiles.length > 0 &&
    validVideoAnalysis.length !==
      videoFiles.length
  ) {
    console.warn(
      "\nUWAGA: Nie wszystkie filmy mają jeszcze video-analysis.json.",
    );
  }

  const editPlan =
    await generateEditPlan({
      images: analysis,
      videos:
        validVideoAnalysis,
    });

  writeJson(
    EDIT_FILE,
    editPlan,
  );

  console.log(
    `\nZapisano ${EDIT_FILE}`,
  );

  console.log(
    "\nPLAN:",
  );

  editPlan.scenes.forEach(
    (scene, index) => {
      console.log(
        `${index + 1}. ${scene.file}` +
        `${
          scene.fragmentId
            ? ` | ${scene.fragmentId}`
            : ""
        }` +
        ` | ${scene.duration}s` +
        ` | start ${scene.start}s`,
      );
    },
  );

  /*
   * Wypisujemy materiały pominięte przez planer — najczęściej to
   * słabsze ujęcia, ale jeśli w folderze były dwie realizacje,
   * to właśnie tu widać, że druga została świadomie odrzucona.
   */
  const usedFiles = new Set(
    editPlan.scenes.map(
      (scene) => scene.file,
    ),
  );

  const skipped =
    imageFiles.filter(
      (file) =>
        !usedFiles.has(file),
    );

  if (skipped.length > 0) {
    console.log(
      `\nNiewykorzystane zdjęcia (${skipped.length}):`,
    );

    skipped.forEach((file) =>
      console.log(`- ${file}`),
    );
  }
};

main().catch(
  (error) => {
    console.error(
      "\nBłąd:",
      error.message,
    );

    process.exit(1);
  },
);