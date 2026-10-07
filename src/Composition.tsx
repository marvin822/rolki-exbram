import React from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  staticFile,
  useCurrentFrame,
  Img,
  OffthreadVideo,
  Still,
  interpolate,
  spring,
  Easing,
} from "remotion";
import {
  TransitionSeries,
  linearTiming,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { loadFont } from "@remotion/google-fonts/Montserrat";

import editPlan from "../edit.json";
import analysis from "../analysis.json";
import videoAnalysis from "../video-analysis.json";
import musicSelection from "../music.json";
import gradeData from "../grade.json";

type Props = {};

type PhotoMotion =
  | "zoomIn"
  | "zoomOut"
  | "panLeft"
  | "panRight";

type PhotoAnalysis = {
  file: string;
  subject: string;
  focusX: number;
  focusY: number;
  recommendedMotion: PhotoMotion;
  motionStrength: number;
  productProminence?: number;
  contentAspectRatio?: ContentAspect;
  confidence: number;
};

type VideoAnalysis = {
  file: string;
  framing: "crop" | "fit";
  focusX: number;
  focusY: number;
  contentAspectRatio?: ContentAspect;
  confidence: number;
};

type EditScene = {
  file: string;
  duration: number;
  start: number;
  reason: string;
  caption?: string;
};

type EditPlan = {
  set?: string;
  hook?: string;
  scenes: EditScene[];
};

/*
 * Napis na scenie: hook na pierwszej, krótki podpis na kilku
 * kolejnych. Treść układa planer (analyze-image.mjs).
 */
type SceneOverlay = {
  text: string;
  variant: "hook" | "caption";
};

type Scene =
  | {
      type: "photo";
      src: string;
      duration: number;
      overlay?: SceneOverlay;
      grade: string;
    }
  | {
      type: "video";
      src: string;
      originalFile: string;
      duration: number;
      start: number;
      overlay?: SceneOverlay;
      grade: string;
    };

type MusicSelection = {
  file: string | null;
  beat?: {
    bpm: number;
    offset: number;
    confidence: number;
  } | null;
};

const FPS = 30;

/*
 * Krótkie przenikanie między scenami — w rolkach dłuższe fade'y
 * wyglądają ospale (6 scen x 0.5 s to 3 s rozmycia). Na planszę
 * końcową wchodzimy wolniej, bo to zmiana z ciemnego kadru na jasny.
 */
const TRANSITION_DURATION = 6;

const END_TRANSITION_DURATION = 12;

const END_CARD_DURATION = 3.5;

const BRAND_RED = "#a31f22";

const PHONE_NUMBER =
  "502 492 009";

const { fontFamily: FONT_FAMILY } =
  loadFont("normal", {
    weights: [
      "600",
      "700",
      "800",
    ],
    subsets: [
      "latin",
      "latin-ext",
    ],
  });

/*
 * Muzyka w tle.
 *
 * Utwór losuje select-music.mjs spośród plików w public/music/
 * i zapisuje do music.json. Gra przez całą rolkę z krótkim
 * fade in / fade out. Gdy folder jest pusty, music.json ma
 * file === null i rolka powstaje bez podkładu.
 *
 * Filmy są wyciszone (normalize-videos.mjs dodaje -an,
 * a VideoScene ustawia muted), więc dźwięk źródłowy
 * nie konkuruje z muzyką.
 */
const MUSIC_TRACK = (
  musicSelection as MusicSelection
).file;

const MUSIC_BEAT = MUSIC_TRACK
  ? (
      musicSelection as MusicSelection
    ).beat ?? null
  : null;

const MUSIC_VOLUME = 0.25;

const MUSIC_FADE_FRAMES = 18;

// Ruch zdjęć. Dystans skaluje się z długością ujęcia
// (durationFactor w PhotoScene), MAX_ZOOM to twardy sufit.
const PHOTO_SCALE = 1.18;
const BASE_ZOOM = 0.1;
const MAX_ZOOM = 0.2;

const CANVAS_WIDTH = 1080;

/*
 * Ogrodzenia i bramy to obiekty szerokie. Wciśnięte w pełny kadr
 * 9:16 traciły większość kompozycji, a wolne miejsce zajmowała
 * droga albo murek.
 *
 * Dlatego materiał pokazujemy w węższym pasie 4:5 (domyślnie) albo
 * 1:1 (gdy trzeba zachować szerokość), a resztę kadru wypełnia
 * rozmyta, przyciemniona kopia tego samego ujęcia.
 */
type ContentAspect = "4:5" | "1:1";

const CONTENT_HEIGHTS: Record<
  ContentAspect,
  number
> = {
  "4:5": Math.round(
    (CANVAS_WIDTH * 5) / 4,
  ),
  "1:1": CANVAS_WIDTH,
};

const getContentHeight = (
  aspect: ContentAspect | undefined,
) => {
  return (
    CONTENT_HEIGHTS[
      aspect ?? "4:5"
    ] ?? CONTENT_HEIGHTS["4:5"]
  );
};

// Tło: powiększone, żeby rozmycie nie odsłoniło krawędzi kadru.
// Blur na tyle mocny, żeby nie było ostrych detali, ale nie tak
// duży, żeby tło zrobiło się jednolitą plamą.
const BACKDROP_SCALE = 1.3;
const BACKDROP_BLUR = 45;
const BACKDROP_BRIGHTNESS = 0.62;

/*
 * Korekta kolorów ostrego materiału (zdjęcia i filmy).
 *
 * Każda scena dostaje własną korektę z grade.json — liczy ją
 * measure-grade.mjs z pomiaru jasności i nasycenia ujęcia, żeby
 * płaskie i ciemne kadry dociągnąć do wspólnego wzorca, a już
 * dobre zostawić prawie bez zmian. Tam też są bezpieczniki
 * (m.in. łączne nasycenie ±6%, żeby antracyt nie niebieszczał).
 *
 * DEFAULT_GRADE to awaryjna korekta dla sceny bez pomiaru:
 * umiarkowany kontrast z lekkim rozjaśnieniem, a nasycenie
 * odjęte tyle, ile dokłada sam kontrast — przy saturate(1.12)
 * antracyt (RAL 7016) wyraźnie niebieszczał (B−R z 52 do 65).
 *
 * Logo, napisy i rozmyte tło leżą poza filtrem, więc kolory
 * marki się nie zmieniają.
 */
type Grade = {
  contrast: number;
  brightness: number;
  saturate: number;
};

const DEFAULT_GRADE: Grade = {
  contrast: 1.08,
  brightness: 1.03,
  saturate: 0.97,
};

const measuredGrades = (
  gradeData as {
    scenes?: Record<
      string,
      Grade
    >;
  }
).scenes ?? {};

/*
 * Klucz jak w measure-grade.mjs: plik + początek fragmentu.
 */
const getGradeFilter = (
  file: string,
  start: number,
) => {
  const grade =
    measuredGrades[
      `${file}@${Number(start) || 0}`
    ] ?? DEFAULT_GRADE;

  return (
    `contrast(${grade.contrast}) ` +
    `brightness(${grade.brightness}) ` +
    `saturate(${grade.saturate})`
  );
};

/*
 * Znak wodny — logo w lewym dolnym rogu PASA Z TREŚCIĄ,
 * nie całego kadru 1080x1920.
 *
 * W rogu canvasu wylądowałoby na rozmytym tle, gdzie wygląda jak
 * doklejone, a na Instagramie dolny pas kadru zasłania interfejs.
 * Lewa strona, bo prawą krawędź od ~55% wysokości zajmuje kolumna
 * przycisków (polub / komentarz / udostępnij) — na Facebooku
 * i Instagramie w tym samym miejscu, więc jedna wersja wystarcza.
 * Górę pasa zajmują napisy.
 *
 * Bez cienia i mocno przezroczyste — ma być delikatną sygnaturą,
 * a nie elementem konkurującym z ogrodzeniem.
 */
const WATERMARK_FILE =
  "others/exbra_logo_biale_400.png";

const WATERMARK_WIDTH = 230;

const WATERMARK_MARGIN = 40;

const WATERMARK_OPACITY = 0.6;

const analysisData =
  analysis as PhotoAnalysis[];

const videoAnalysisData =
  videoAnalysis as VideoAnalysis[];

const editData =
  editPlan as EditPlan;

/*
 * Nazwa zestawu (podfolder public/media/) przychodzi w planie
 * montażu — importy JSON są statyczne, więc kompozycja nie ma
 * jak przeczytać zmiennej środowiskowej z pipeline'u.
 */
const SET_NAME =
  editData.set ?? "";

const durationInFrames = (
  seconds: number,
) => {
  return Math.round(
    seconds * FPS,
  );
};

const clamp = (
  value: number,
  min: number,
  max: number,
) => {
  return Math.min(
    Math.max(value, min),
    max,
  );
};

const getAnalysisForImage = (
  src: string,
): PhotoAnalysis => {
  const result =
    analysisData.find(
      (item) =>
        item.file === src,
    );

  if (!result) {
    return {
      file: src,
      subject: "",
      focusX: 50,
      focusY: 50,
      recommendedMotion:
        "zoomIn",
      motionStrength: 0.5,
      productProminence: 0.6,
      contentAspectRatio: "4:5",
      confidence: 0,
    };
  }

  return result;
};

const getAnalysisForVideo = (
  originalFile: string,
): VideoAnalysis => {
  const result =
    videoAnalysisData.find(
      (item) =>
        item.file === originalFile,
    );

  if (!result) {
    return {
      file: originalFile,
      framing: "crop",
      focusX: 50,
      focusY: 50,
      contentAspectRatio: "4:5",
      confidence: 0,
    };
  }

  return result;
};

const getProcessedVideoPath = (
  src: string,
) => {
  const extensionIndex =
    src.lastIndexOf(".");

  if (extensionIndex === -1) {
    return `processed/${src}.mp4`;
  }

  const baseName =
    src.slice(
      0,
      extensionIndex,
    );

  return `processed/${baseName}.mp4`;
};

/*
 * Napis dla sceny: hook z planu na pierwszej, podpis (caption)
 * na tych, którym planer go dał. Pusty tekst = czysty kadr.
 */
const getSceneOverlay = (
  scene: EditScene,
  index: number,
): SceneOverlay | undefined => {
  const text =
    index === 0
      ? editData.hook?.trim()
      : scene.caption?.trim();

  if (!text) {
    return undefined;
  }

  return {
    text,
    variant:
      index === 0
        ? "hook"
        : "caption",
  };
};

const plannedScenes: Scene[] =
  editData.scenes.map(
    (scene, index) => {
      const extension =
        scene.file
          .split(".")
          .pop()
          ?.toLowerCase();

      const isVideo =
        extension === "mp4" ||
        extension === "mov" ||
        extension === "webm";

      const overlay =
        getSceneOverlay(
          scene,
          index,
        );

      if (isVideo) {
        return {
          type: "video",
          src:
            getProcessedVideoPath(
              scene.file,
            ),
          originalFile:
            scene.file,
          duration:
            scene.duration,
          start:
            scene.start,
          overlay,
          grade:
            getGradeFilter(
              scene.file,
              scene.start,
            ),
        };
      }

      return {
        type: "photo",
        src: `media/${SET_NAME}/${scene.file}`,
        duration:
          scene.duration,
        overlay,
        grade:
          getGradeFilter(
            scene.file,
            0,
          ),
      };
    },
  );

/*
 * Przejście PO danej scenie: między scenami krótkie, przed
 * planszą końcową dłuższe.
 */
const getTailFrames = (
  index: number,
  sceneCount: number,
) => {
  return index <
    sceneCount - 1
    ? TRANSITION_DURATION
    : END_TRANSITION_DURATION;
};

/*
 * Cięcia w rytm muzyki.
 *
 * select-music.mjs wykrywa tempo i moment pierwszego uderzenia
 * podkładu. Muzyka gra od klatki 0, więc uderzenia leżą na
 * offset + k * (60 / bpm) sekund osi czasu rolki.
 *
 * Każde cięcie przesuwamy na najbliższe uderzenie tak, żeby
 * ŚRODEK przejścia wypadł na beat. Zmiana długości sceny jest
 * ograniczona — plan AI zostaje praktycznie nienaruszony,
 * a przy braku wykrytego rytmu nic się nie przesuwa.
 *
 * Fragment wideo może się wydłużyć mniej niż zdjęcie: dalej
 * leci już materiał spoza wybranego przez AI fragmentu.
 */
const MAX_BEAT_SHRINK = 0.5;
const MAX_PHOTO_BEAT_GROW = 0.5;
const MAX_VIDEO_BEAT_GROW = 0.2;
const MIN_SCENE_SECONDS = 2;

const snapScenesToBeat = (
  input: Scene[],
): Scene[] => {
  if (
    !MUSIC_BEAT ||
    !(MUSIC_BEAT.bpm > 0)
  ) {
    return input;
  }

  const interval =
    60 / MUSIC_BEAT.bpm;

  let elapsedFrames = 0;

  return input.map(
    (scene, index) => {
      const plannedFrames =
        durationInFrames(
          scene.duration,
        );

      const halfTail =
        getTailFrames(
          index,
          input.length,
        ) / 2;

      const plannedMid =
        (elapsedFrames +
          plannedFrames +
          halfTail) /
        FPS;

      const nearest =
        Math.round(
          (plannedMid -
            MUSIC_BEAT.offset) /
            interval,
        );

      const maxGrow =
        scene.type === "video"
          ? MAX_VIDEO_BEAT_GROW
          : MAX_PHOTO_BEAT_GROW;

      let bestFrames =
        plannedFrames;

      let bestDistance =
        Infinity;

      for (const k of [
        nearest - 1,
        nearest,
        nearest + 1,
      ]) {
        const beatTime =
          MUSIC_BEAT.offset +
          k * interval;

        const frames =
          Math.round(
            beatTime * FPS -
              halfTail,
          ) - elapsedFrames;

        const delta =
          (frames -
            plannedFrames) /
          FPS;

        if (
          delta <
            -MAX_BEAT_SHRINK ||
          delta > maxGrow ||
          frames <
            MIN_SCENE_SECONDS *
              FPS
        ) {
          continue;
        }

        if (
          Math.abs(delta) <
          bestDistance
        ) {
          bestDistance =
            Math.abs(delta);

          bestFrames = frames;
        }
      }

      elapsedFrames +=
        bestFrames;

      return {
        ...scene,
        duration:
          bestFrames / FPS,
      };
    },
  );
};

const scenes: Scene[] =
  snapScenesToBeat(
    plannedScenes,
  );

/*
 * TransitionSeries nakłada przejścia
 * pomiędzy scenami.
 *
 * Każda scena dostaje dodatkowe klatki
 * przejścia, które są następnie
 * kompensowane przez nakładkę przejścia
 * (ostatnia — przejścia na planszę).
 *
 * Dzięki temu rzeczywisty czas całej
 * części materiałowej odpowiada sumie
 * czasów scen.
 */
const getSequenceDurationInFrames = (
  duration: number,
  tailFrames: number,
) => {
  return (
    durationInFrames(
      duration,
    ) + tailFrames
  );
};

const getMediaDurationInFrames =
  () => {
    return scenes.reduce(
      (
        total,
        scene,
      ) =>
        total +
        durationInFrames(
          scene.duration,
        ),
      0,
    );
  };

const getTotalDurationInFrames =
  () => {
    return (
      getMediaDurationInFrames() +
      durationInFrames(
        END_CARD_DURATION,
      )
    );
  };

export const MyComposition =
  () => {
    return (
      <>
        <Composition
          id="MyComp"
          component={
            MyComponent
          }
          durationInFrames={
            getTotalDurationInFrames()
          }
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Still
          id="Cover"
          component={
            CoverImage
          }
          width={1080}
          height={1920}
        />
      </>
    );
  };

/*
 * Układ kadru: rozmyte tło na pełnym 1080x1920 + ostry pas
 * z materiałem (4:5 albo 1:1) na środku.
 *
 * Tło to ta sama treść, powiększona i mocno rozmyta, żeby nie
 * konkurowała z głównym ujęciem i żeby nie było czarnych pasów.
 * Powiększenie jest konieczne, bo blur przy krawędziach próbkuje
 * przezroczystość i bez zapasu widać ciemną obwódkę.
 */
const Watermark: React.FC =
  () => {
    return (
      <div
        style={{
          position:
            "absolute",
          left:
            WATERMARK_MARGIN,
          bottom:
            WATERMARK_MARGIN,
          width:
            WATERMARK_WIDTH,
          opacity:
            WATERMARK_OPACITY,
        }}
      >
        <Img
          src={staticFile(
            WATERMARK_FILE,
          )}
          style={{
            width: "100%",
            height: "auto",
            display:
              "block",
          }}
        />
      </div>
    );
  };

/*
 * Napisy na ekranie — u góry PASA Z TREŚCIĄ.
 *
 * Instagram i Facebook zasłaniają górne ~14% kadru (nagłówek)
 * i dolne ~35% (opis, nazwa konta, przyciski). Góra pasa 4:5
 * zaczyna się na 285 px (15%), więc napis tuż pod jej krawędzią
 * jest w strefie bezpiecznej, a na zdjęciu przykrywa zwykle dach
 * albo niebo, nie ogrodzenie — kadrowanie i tak spycha metal
 * do środka pasa.
 *
 * Rozmyte pasy nad i pod treścią zostają czyste: górny leży pod
 * nagłówkiem aplikacji, dolny pod opisem.
 */
const TEXT_INSET = 56;

const HOOK_SHADOW =
  "0 4px 18px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.5)";

/*
 * Polska typografia: jednoliterowe słowa (w, z, i, a, o, u) nie mogą
 * zostać na końcu linii — sklejamy je z następnym słowem twardą
 * spacją. Lookbehind nie zjada poprzedzającej spacji, więc jeden
 * przebieg łapie też łańcuchy typu "i w tle".
 */
const attachShortWords = (
  text: string,
) => {
  return text.replace(
    /(?<=^|\s)([aiouwzAIOUWZ]) +/g,
    "$1\u00a0",
  );
};

const SceneText: React.FC<{
  overlay: SceneOverlay;
  sceneFrames: number;
  isStatic?: boolean;
}> = ({
  overlay,
  sceneFrames,
  isStatic = false,
}) => {
  const frame =
    useCurrentFrame();

  const isHook =
    overlay.variant === "hook";

  const delay = isHook
    ? 3
    : 6;

  const enter = isStatic
    ? 1
    : spring({
        frame:
          frame - delay,
        fps: FPS,
        durationInFrames: 14,
        config: {
          damping: 200,
        },
      });

  /*
   * Napis znika tuż przed przejściem, żeby dwa napisy nie
   * przenikały się w trakcie zmiany sceny.
   */
  const exit = isStatic
    ? 1
    : interpolate(
        frame,
        [
          sceneFrames - 8,
          sceneFrames - 1,
        ],
        [1, 0],
        {
          extrapolateLeft:
            "clamp",
          extrapolateRight:
            "clamp",
        },
      );

  const visibility =
    enter * exit;

  const offsetY =
    (1 - enter) * 26;

  if (isHook) {
    const fontSize =
      overlay.text.length <= 26
        ? 78
        : 66;

    return (
      <>
        <div
          style={{
            position:
              "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "48%",
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.25) 55%, rgba(0,0,0,0) 100%)",
            opacity:
              visibility,
          }}
        />

        <div
          style={{
            position:
              "absolute",
            top: TEXT_INSET,
            left: TEXT_INSET,
            right: TEXT_INSET,
            display: "flex",
            gap: 26,
            opacity:
              visibility,
            transform: `translateY(${offsetY}px)`,
          }}
        >
          <div
            style={{
              width: 10,
              flexShrink: 0,
              backgroundColor:
                BRAND_RED,
              transform: `scaleY(${enter})`,
              transformOrigin:
                "top",
            }}
          />

          <div
            style={{
              fontFamily:
                FONT_FAMILY,
              fontWeight: 800,
              fontSize,
              lineHeight: 1.12,
              textWrap:
                "balance",
              color: "white",
              textShadow:
                HOOK_SHADOW,
            }}
          >
            {attachShortWords(
              overlay.text,
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <div
      style={{
        position:
          "absolute",
        top: TEXT_INSET,
        left: TEXT_INSET,
        maxWidth:
          CANVAS_WIDTH -
          2 * TEXT_INSET,
        opacity:
          visibility,
        transform: `translateX(${-offsetY}px)`,
        backgroundColor:
          "rgba(15,15,16,0.66)",
        borderLeft: `8px solid ${BRAND_RED}`,
        padding:
          "16px 28px",
        fontFamily:
          FONT_FAMILY,
        fontWeight: 700,
        fontSize: 46,
        lineHeight: 1.18,
        textWrap: "balance",
        color: "white",
      }}
    >
      {attachShortWords(
        overlay.text,
      )}
    </div>
  );
};

const FramedMedia: React.FC<{
  aspect?: ContentAspect;
  backdrop: React.ReactNode;
  children: React.ReactNode;
  overlay?: React.ReactNode;
  grade: string;
}> = ({
  aspect,
  backdrop,
  children,
  overlay,
  grade,
}) => {
  const contentHeight =
    getContentHeight(aspect);

  return (
    <AbsoluteFill
      style={{
        backgroundColor:
          "#0f0f10",
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          transform: `scale(${BACKDROP_SCALE})`,
          filter: `blur(${BACKDROP_BLUR}px) brightness(${BACKDROP_BRIGHTNESS}) saturate(0.85)`,
        }}
      >
        {backdrop}
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          alignItems:
            "center",
          justifyContent:
            "center",
        }}
      >
        <div
          style={{
            width:
              CANVAS_WIDTH,
            height:
              contentHeight,
            overflow:
              "hidden",
            position:
              "relative",
          }}
        >
          <AbsoluteFill
            style={{
              filter: grade,
            }}
          >
            {children}
          </AbsoluteFill>

          <Watermark />

          {overlay}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const getSafePanAmount = (
  scale: number,
) => {
  const geometricLimit =
    ((scale - 1) /
      (2 * scale)) *
    100;

  return (
    geometricLimit * 0.85
  );
};

/*
 * Przesunięcie, które USTAWIA punkt skupienia na środku kadru.
 *
 * Sam transformOrigin tego nie robi — wyznacza jedynie punkt stały
 * skalowania, więc przy origin=40% i scale=1.6 widoczne pasmo to
 * 15-77.5% zdjęcia, czyli środek wypada na 46%, nie na 40%.
 * Przy mocnym zoomie kadr uciekał przez to w dół, na drogę.
 *
 * Dla origin=center i skali s punkt f trafia na y = 0.5 + s*(f-0.5),
 * więc żeby wylądował na środku, przesuwamy o -s*(f-0.5).
 * Wynik przycinamy do zwisu obrazu, żeby nie odsłonić krawędzi.
 */
const getFocusShift = (
  focusPercent: number,
  scale: number,
) => {
  const limit =
    ((scale - 1) / 2) * 100;

  const shift =
    -scale *
    (focusPercent / 100 - 0.5) *
    100;

  return clamp(
    shift,
    -limit,
    limit,
  );
};

/*
 * Ogrodzenie to poziome pasmo — niższe niż kadr 9:16, więc kadr
 * zawsze złapie coś nad i pod nim. Nadmiar wolimy oddać GÓRZE
 * (dom, drzewa, niebo) niż DOŁOWI, bo pod ogrodzeniem jest zwykle
 * kostka, podjazd albo asfalt, czyli najbrzydsza część kadru.
 *
 * Dlatego im niżej w zdjęciu leży produkt, tym mocniej podciągamy
 * punkt skupienia do góry.
 */
const getFramingFocusY = (
  focusY: number,
) => {
  const bias = clamp(
    (focusY - 28) * 0.7,
    0,
    16,
  );

  return clamp(
    focusY - bias,
    0,
    100,
  );
};

const PhotoScene: React.FC<{
  src: string;
  duration: number;
  tailFrames: number;
  overlay?: React.ReactNode;
  grade: string;
}> = ({
  src,
  duration,
  tailFrames,
  overlay,
  grade,
}) => {
  const frame =
    useCurrentFrame();

  const imageAnalysis =
    getAnalysisForImage(
      src,
    );

  const motion =
    imageAnalysis.recommendedMotion;

  const motionStrength =
    clamp(
      imageAnalysis.motionStrength,
      0,
      1,
    );

  /*
   * Punkt skupienia z analizy AI — zwykle produkt
   * (ogrodzenie/brama) leży niżej niż środek kadru,
   * a nad nim jest niebo. Kadrujemy zdjęcie tak, aby
   * ten punkt został w kadrze zamiast geometrycznego środka.
   */
  const focusX =
    clamp(
      imageAnalysis.focusX,
      0,
      100,
    );

  const focusY =
    clamp(
      imageAnalysis.focusY,
      0,
      100,
    );

  /*
   * Ruch zdjęcia trwa przez właściwy czas
   * zdjęcia + czas przejścia.
   *
   * Dzięki temu ruch nie zatrzymuje się
   * przed rozpoczęciem fade.
   */
  const animationFrames =
    durationInFrames(
      duration,
    ) + tailFrames;

  const progress =
    animationFrames <= 1
      ? 1
      : Math.min(
          frame /
            (animationFrames - 1),
          1,
        );

  /*
   * Zdjęcia, na których metalowe ogrodzenie zajmuje małą część
   * kadru (niski productProminence — dużo murku, podjazdu, drogi,
   * nieba), dostają bazowe przybliżenie, żeby produkt wypełnił
   * kadr. productProminence >= 0.6 → bez dodatku.
   *
   * Przy 2x widoczny wycinek to wciąż ok. 1500 px wysokości
   * zdjęcia z telefonu, więc miękkość jest pomijalna.
   */
  const productProminence =
    clamp(
      imageAnalysis.productProminence ??
        0.6,
      0,
      1,
    );

  const baseCropScale =
    clamp(
      interpolate(
        productProminence,
        [0.25, 0.6],
        [1.25, 1],
      ),
      1,
      1.25,
    );

  /*
   * P3: dłuższe ujęcie dostaje większy dystans ruchu, żeby
   * dłuższe przytrzymanie kadru nie wyglądało na zamrożone.
   * 3 s ≈ ruch bazowy, ~4.5 s ≈ 1.5× dystansu.
   */
  const durationFactor =
    clamp(
      durationInFrames(
        duration,
      ) /
        durationInFrames(3),
      0.9,
      1.6,
    );

  const zoomAmount =
    Math.min(
      BASE_ZOOM *
        (1 +
          motionStrength *
            0.5) *
        durationFactor,
      MAX_ZOOM,
    );

  let scale = 1;
  let translateX = 0;

  const panBaseScale =
    Math.max(
      PHOTO_SCALE,
      baseCropScale,
    );

  switch (motion) {
    case "zoomIn": {
      scale =
        baseCropScale *
        (1 +
          zoomAmount *
            progress);

      break;
    }

    case "zoomOut": {
      /*
       * Start od 1 + zoomAmount, koniec dokładnie na 1 —
       * skala nigdy nie spada poniżej 1, więc nie odsłania
       * czarnych krawędzi.
       */
      scale =
        baseCropScale *
        (1 +
          zoomAmount *
            (1 - progress));

      break;
    }

    case "panLeft": {
      scale =
        panBaseScale;

      const safePan =
        getSafePanAmount(
          scale,
        );

      const requestedPan =
        safePan *
        (0.85 +
          motionStrength *
            0.15) *
        durationFactor;

      const pan =
        Math.min(
          requestedPan,
          safePan,
        );

      translateX =
        progress * -pan;

      break;
    }

    case "panRight": {
      scale =
        panBaseScale;

      const safePan =
        getSafePanAmount(
          scale,
        );

      const requestedPan =
        safePan *
        (0.85 +
          motionStrength *
            0.15) *
        durationFactor;

      const pan =
        Math.min(
          requestedPan,
          safePan,
        );

      translateX =
        progress * pan;

      break;
    }
  }

  /*
   * Pion: przesuwamy kadr tak, żeby metal wylądował na środku.
   * Poziom: objectFit "cover" zostawia nadmiar w poziomie, więc
   * tam wystarczy objectPosition — a translateX niesie panoramę.
   */
  const translateY =
    getFocusShift(
      getFramingFocusY(focusY),
      scale,
    );

  return (
    <FramedMedia
      aspect={
        imageAnalysis.contentAspectRatio
      }
      overlay={overlay}
      grade={grade}
      backdrop={
        <Img
          src={staticFile(src)}
          style={{
            width: "100%",
            height: "100%",
            objectFit:
              "cover",
          }}
        />
      }
    >
      <Img
        src={staticFile(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit:
            "cover",
          objectPosition: `${focusX}% 50%`,
          transform: `
            translateX(${translateX}%)
            translateY(${translateY}%)
            scale(${scale})
          `,
          transformOrigin:
            "center center",
        }}
      />
    </FramedMedia>
  );
};

const VideoScene: React.FC<{
  src: string;
  originalFile: string;
  start: number;
  duration: number;
  overlay?: React.ReactNode;
  grade: string;
}> = ({
  src,
  originalFile,
  start,
  duration,
  overlay,
  grade,
}) => {
  const videoAnalysis =
    getAnalysisForVideo(
      originalFile,
    );

  const framing =
    videoAnalysis.framing;

  const focusX =
    clamp(
      videoAnalysis.focusX,
      0,
      100,
    );

  const focusY =
    clamp(
      videoAnalysis.focusY,
      0,
      100,
    );

  const objectFit =
    framing === "fit"
      ? "contain"
      : "cover";

  const objectPosition =
    `${focusX}% ${focusY}%`;

  /*
   * Film jest odtwarzany dokładnie przez
   * czas wybrany przez AI.
   *
   * Podczas przejścia ostatnia klatka
   * zostaje chwilowo utrzymana.
   */
  const videoFrames =
    durationInFrames(
      duration,
    );

  const frame =
    useCurrentFrame();

  const clampedFrame =
    Math.min(
      frame,
      videoFrames - 1,
    );

  /*
   * OffthreadVideo pokazuje klatkę (startFrom + frame), więc
   * startFrom musi być STAŁY, żeby film leciał w tempie 1:1.
   * Wcześniej dodawaliśmy tu clampedFrame, przez co przesunięcie
   * sumowało się z przesunięciem Remotiona i materiał leciał 2x
   * za szybko.
   *
   * Kompensujemy frame, żeby wyświetlana klatka źródła wynosiła
   * dokładnie startBase + clampedFrame — dzięki temu po końcu
   * fragmentu (dodatkowe klatki przejścia) obraz zatrzymuje się
   * na ostatniej klatce zamiast lecieć dalej.
   */
  const startBase =
    Math.round(
      start * FPS,
    );

  const startFrom =
    Math.max(
      0,
      startBase +
        clampedFrame -
        frame,
    );

  return (
    <FramedMedia
      aspect={
        videoAnalysis.contentAspectRatio
      }
      overlay={overlay}
      grade={grade}
      backdrop={
        <OffthreadVideo
          src={staticFile(src)}
          muted
          startFrom={startFrom}
          style={{
            width: "100%",
            height: "100%",
            objectFit:
              "cover",
          }}
        />
      }
    >
      <OffthreadVideo
        src={staticFile(src)}
        muted
        startFrom={startFrom}
        style={{
          width: "100%",
          height: "100%",
          objectFit,
          objectPosition,
        }}
      />
    </FramedMedia>
  );
};

const SceneComponent: React.FC<{
  scene: Scene;
  tailFrames: number;
  isStatic?: boolean;
}> = ({
  scene,
  tailFrames,
  isStatic = false,
}) => {
  const overlay =
    scene.overlay ? (
      <SceneText
        overlay={
          scene.overlay
        }
        sceneFrames={durationInFrames(
          scene.duration,
        )}
        isStatic={isStatic}
      />
    ) : undefined;

  if (
    scene.type === "photo"
  ) {
    return (
      <PhotoScene
        src={scene.src}
        duration={
          scene.duration
        }
        tailFrames={
          tailFrames
        }
        overlay={overlay}
        grade={scene.grade}
      />
    );
  }

  return (
    <VideoScene
      src={scene.src}
      originalFile={
        scene.originalFile
      }
      start={
        scene.start
      }
      duration={
        scene.duration
      }
      overlay={overlay}
      grade={scene.grade}
    />
  );
};
/*
 * Plansza końcowa: logo, hasło i wezwanie do kontaktu.
 *
 * Wszystko, co ważne, leży między 14% a 62% wysokości — niżej
 * na Instagramie i Facebooku wchodzi opis rolki i nazwa konta,
 * więc telefon postawiony na dole byłby zasłonięty.
 */
const EndCard: React.FC =
  () => {
    /*
     * Klatka lokalna dla sekwencji planszy — zaczyna się od 0
     * w chwili, gdy plansza zaczyna się wyłaniać z ostatniej sceny.
     */
    const frame =
      useCurrentFrame();

    const appear = (
      startFrame: number,
      distance = 0,
    ) => {
      const progress =
        interpolate(
          frame,
          [
            startFrame,
            startFrame + 14,
          ],
          [0, 1],
          {
            extrapolateLeft:
              "clamp",
            extrapolateRight:
              "clamp",
            easing:
              Easing.out(
                Easing.cubic,
              ),
          },
        );

      return {
        opacity: progress,
        transform: `translate(-50%, ${(1 - progress) * distance}px)`,
      };
    };

    const lineWidth =
      interpolate(
        frame,
        [30, 46],
        [0, 260],
        {
          extrapolateLeft:
            "clamp",
          extrapolateRight:
            "clamp",
          easing:
            Easing.out(
              Easing.cubic,
            ),
        },
      );

    const centered = {
      position:
        "absolute" as const,
      left: "50%",
      width: "90%",
      textAlign:
        "center" as const,
      fontFamily:
        FONT_FAMILY,
    };

    return (
      <AbsoluteFill
        style={{
          backgroundColor:
            "#f2f0eb",
          overflow:
            "hidden",
        }}
      >
        <div
          style={{
            position:
              "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 50% 28%, rgba(255,255,255,0.9), rgba(242,240,235,0) 55%)",
          }}
        />

        <div
          style={{
            position:
              "absolute",
            top: 300,
            left: "50%",
            width: 720,
            ...appear(0),
          }}
        >
          <Img
            src={staticFile(
              "others/logo_duze_bez_tla.png",
            )}
            style={{
              width: "100%",
              height: "auto",
              display:
                "block",
            }}
          />
        </div>

        <div
          style={{
            ...centered,
            top: 640,
            color:
              "#1c1c1c",
            fontSize: 54,
            fontWeight: 600,
            lineHeight: 1.2,
            ...appear(14, 20),
          }}
        >
          Ogrodzenia,
          <br />
          które robią różnicę
        </div>

        <div
          style={{
            position:
              "absolute",
            top: 812,
            left: "50%",
            transform:
              "translateX(-50%)",
            width:
              lineWidth,
            height: 3,
            backgroundColor:
              BRAND_RED,
          }}
        />

        <div
          style={{
            ...centered,
            top: 858,
            color:
              BRAND_RED,
            fontSize: 44,
            fontWeight: 800,
            letterSpacing: 5,
            ...appear(32, 15),
          }}
        >
          BEZPŁATNA WYCENA
        </div>

        <div
          style={{
            ...centered,
            top: 920,
            color:
              "#111111",
            fontSize: 104,
            fontWeight: 800,
            letterSpacing: 2,
            whiteSpace:
              "nowrap",
            ...appear(38, 15),
          }}
        >
          {PHONE_NUMBER}
        </div>

        <div
          style={{
            ...centered,
            top: 1068,
            color:
              "#2a2a2a",
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: 2,
            whiteSpace:
              "nowrap",
            ...appear(46, 15),
          }}
        >
          www.exbram.pl
        </div>
      </AbsoluteFill>
    );
  };

const MusicTrack: React.FC =
  () => {
    const totalFrames =
      getTotalDurationInFrames();

    if (!MUSIC_TRACK) {
      return null;
    }

    return (
      <Audio
        src={staticFile(
          `music/${MUSIC_TRACK}`,
        )}
        loop
        volume={(f) =>
          interpolate(
            f,
            [
              0,
              MUSIC_FADE_FRAMES,
              totalFrames -
                MUSIC_FADE_FRAMES,
              totalFrames,
            ],
            [
              0,
              MUSIC_VOLUME,
              MUSIC_VOLUME,
              0,
            ],
            {
              extrapolateLeft:
                "clamp",
              extrapolateRight:
                "clamp",
            },
          )
        }
      />
    );
  };

export const MyComponent: React.FC<Props> =
  () => {
    /*
     * Plansza końcowa jest ostatnim elementem TransitionSeries,
     * więc wyłania się z ostatniej sceny przez przenikanie,
     * zamiast wskakiwać twardym cięciem z ciemnego kadru na jasny.
     * Muzyka leży poza serią i gra przez całą rolkę.
     */
    return (
      <AbsoluteFill
        style={{
          backgroundColor:
            "black",
        }}
      >
        <MusicTrack />

        <TransitionSeries>
          {scenes.map(
            (
              scene,
              index,
            ) => {
              const tailFrames =
                getTailFrames(
                  index,
                  scenes.length,
                );

              return (
                <React.Fragment
                  key={`${scene.src}-${index}`}
                >
                  <TransitionSeries.Sequence
                    durationInFrames={getSequenceDurationInFrames(
                      scene.duration,
                      tailFrames,
                    )}
                  >
                    <SceneComponent
                      scene={
                        scene
                      }
                      tailFrames={
                        tailFrames
                      }
                    />
                  </TransitionSeries.Sequence>

                  <TransitionSeries.Transition
                    timing={linearTiming(
                      {
                        durationInFrames:
                          tailFrames,
                      },
                    )}
                    presentation={
                      fade()
                    }
                  />
                </React.Fragment>
              );
            },
          )}

          <TransitionSeries.Sequence
            durationInFrames={durationInFrames(
              END_CARD_DURATION,
            )}
          >
            <EndCard />
          </TransitionSeries.Sequence>
        </TransitionSeries>
      </AbsoluteFill>
    );
  };

/*
 * Okładka rolki (render: npx remotion still Cover).
 *
 * Pierwsza scena z hookiem w pełnej widoczności. Siatka profilu
 * na Instagramie przycina okładkę do 3:4 ze środka kadru
 * (y 240-1680), a napis stoi od ~340 px, więc mieści się w obu
 * widokach.
 */
export const CoverImage: React.FC =
  () => {
    const firstScene =
      scenes[0];

    if (!firstScene) {
      return (
        <AbsoluteFill
          style={{
            backgroundColor:
              "black",
          }}
        />
      );
    }

    return (
      <SceneComponent
        scene={firstScene}
        tailFrames={
          TRANSITION_DURATION
        }
        isStatic
      />
    );
  };
