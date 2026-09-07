import React from "react";
import {
  AbsoluteFill,
  Audio,
  Composition,
  staticFile,
  useCurrentFrame,
  Img,
  OffthreadVideo,
  interpolate,
  Easing,
} from "remotion";
import {
  TransitionSeries,
  linearTiming,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";

import editPlan from "../edit.json";
import analysis from "../analysis.json";
import videoAnalysis from "../video-analysis.json";
import musicSelection from "../music.json";

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
};

type EditPlan = {
  set?: string;
  scenes: EditScene[];
};

type Scene =
  | {
      type: "photo";
      src: string;
      duration: number;
    }
  | {
      type: "video";
      src: string;
      originalFile: string;
      duration: number;
      start: number;
    };

const FPS = 30;

const TRANSITION_DURATION = 15;

const END_CARD_DURATION = 3;

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
  musicSelection as {
    file: string | null;
  }
).file;

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
 * Znak wodny — logo w prawym dolnym rogu PASA Z TREŚCIĄ,
 * nie całego kadru 1080x1920.
 *
 * W rogu canvasu wylądowałoby na rozmytym tle, gdzie wygląda jak
 * doklejone, a na Instagramie dolny pas kadru zasłania interfejs.
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

const scenes: Scene[] =
  editData.scenes.map(
    (scene) => {
      const extension =
        scene.file
          .split(".")
          .pop()
          ?.toLowerCase();

      const isVideo =
        extension === "mp4" ||
        extension === "mov" ||
        extension === "webm";

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
        };
      }

      return {
        type: "photo",
        src: `media/${SET_NAME}/${scene.file}`,
        duration:
          scene.duration,
      };
    },
  );

/*
 * TransitionSeries nakłada przejścia
 * pomiędzy scenami.
 *
 * Każda scena poza ostatnią dostaje
 * dodatkowe 15 klatek, które są następnie
 * kompensowane przez przejście.
 *
 * Dzięki temu rzeczywisty czas całej
 * części materiałowej odpowiada sumie
 * czasów podanych przez AI.
 */
const getSequenceDurationInFrames = (
  duration: number,
  hasNextScene: boolean,
) => {
  return (
    durationInFrames(
      duration,
    ) +
    (hasNextScene
      ? TRANSITION_DURATION
      : 0)
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
      ) +
      2
    );
  };

export const MyComposition =
  () => {
    return (
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
          right:
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

const FramedMedia: React.FC<{
  aspect?: ContentAspect;
  backdrop: React.ReactNode;
  children: React.ReactNode;
}> = ({
  aspect,
  backdrop,
  children,
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
          {children}

          <Watermark />
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
}> = ({
  src,
  duration,
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
    ) +
    TRANSITION_DURATION;

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
}> = ({
  src,
  originalFile,
  start,
  duration,
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
}> = ({
  scene,
}) => {
  if (
    scene.type === "photo"
  ) {
    return (
      <PhotoScene
        src={scene.src}
        duration={
          scene.duration
        }
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
    />
  );
};

const EndCard: React.FC<{
  frame: number;
}> = ({
  frame,
}) => {
  /*
   * frame jest lokalny dla EndCard.
   * Zawsze zaczyna od 0 niezależnie od
   * długości całej rolki.
   */

  const logoOpacity =
    interpolate(
      frame,
      [0, 15],
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

  const taglineOpacity =
    interpolate(
      frame,
      [18, 35],
      [0, 1],
      {
        extrapolateLeft:
          "clamp",
        extrapolateRight:
          "clamp",
      },
    );

  const taglineY =
    interpolate(
      frame,
      [18, 35],
      [20, 0],
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

  const websiteOpacity =
    interpolate(
      frame,
      [38, 52],
      [0, 1],
      {
        extrapolateLeft:
          "clamp",
        extrapolateRight:
          "clamp",
      },
    );

  const websiteY =
    interpolate(
      frame,
      [38, 52],
      [15, 0],
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

  const lineWidth =
    interpolate(
      frame,
      [34, 50],
      [0, 240],
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

  return (
    <AbsoluteFill
      style={{
        backgroundColor:
          "#f2f0eb",
        alignItems:
          "center",
        justifyContent:
          "center",
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
            "radial-gradient(circle at 50% 35%, rgba(255,255,255,0.9), rgba(242,240,235,0) 55%)",
        }}
      />

      <div
        style={{
          position:
            "absolute",
          top: "30%",
          left: "50%",
          transform:
            "translate(-50%, -50%)",
          opacity:
            logoOpacity,
          width: 780,
          display:
            "flex",
          justifyContent:
            "center",
          alignItems:
            "center",
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
          position:
            "absolute",
          top: "53%",
          left: "50%",
          transform:
            `translate(-50%, ${taglineY}px)`,
          opacity:
            taglineOpacity,
          width:
            "90%",
          textAlign:
            "center",
          color:
            "#1c1c1c",
          fontFamily:
            "Arial, Helvetica, sans-serif",
          fontSize:
            48,
          fontWeight:
            400,
          letterSpacing:
            1.2,
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
          top: "67%",
          left: "50%",
          transform:
            "translateX(-50%)",
          width:
            lineWidth,
          height: 2,
          backgroundColor:
            "#b99a5b",
          opacity:
            websiteOpacity,
        }}
      />

      <div
        style={{
          position:
            "absolute",
          top: "71%",
          left: "50%",
          transform:
            `translate(-50%, ${websiteY}px)`,
          opacity:
            websiteOpacity,
          color:
            "#1c1c1c",
          fontFamily:
            "Arial, Helvetica, sans-serif",
          fontSize:
            42,
          fontWeight:
            400,
          letterSpacing:
            3,
          whiteSpace:
            "nowrap",
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
    const frame =
      useCurrentFrame();

    const mediaDuration =
      getMediaDurationInFrames();

    /*
     * KLUCZOWA ZMIANA
     *
     * W danym momencie renderujemy wyłącznie
     * jedną z dwóch rzeczy:
     *
     * 1. część materiałową
     * 2. EndCard
     *
     * Nie ma żadnego Sequence nakładającego
     * planszę na TransitionSeries.
     */
    if (
      frame >= mediaDuration
    ) {
      const endCardFrame =
        frame -
        mediaDuration;

      return (
        <AbsoluteFill
          style={{
            backgroundColor:
              "#f2f0eb",
          }}
        >
          <MusicTrack />

          <EndCard
            frame={
              endCardFrame
            }
          />
        </AbsoluteFill>
      );
    }

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
              const hasNextScene =
                index <
                scenes.length - 1;

              return (
                <React.Fragment
                  key={`${scene.src}-${index}`}
                >
                  <TransitionSeries.Sequence
                    durationInFrames={getSequenceDurationInFrames(
                      scene.duration,
                      hasNextScene,
                    )}
                  >
                    <SceneComponent
                      scene={
                        scene
                      }
                    />
                  </TransitionSeries.Sequence>

                  {hasNextScene && (
                    <TransitionSeries.Transition
                      timing={linearTiming(
                        {
                          durationInFrames:
                            TRANSITION_DURATION,
                        },
                      )}
                      presentation={
                        fade()
                      }
                    />
                  )}
                </React.Fragment>
              );
            },
          )}
        </TransitionSeries>
      </AbsoluteFill>
    );
  };