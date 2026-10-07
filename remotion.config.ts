/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");

// Klatki JPEG mają pełny zakres kolorów i przy domyślnej przestrzeni
// barw FFmpeg zapisuje yuvj420p (zakres "pc", macierz bt470bg) — Meta
// przy przekodowaniu potrafi wtedy przesunąć kontrast i kolory.
// bt709 konwertuje do zakresu ograniczonego (yuv420p) i oznacza plik
// tak, jak oczekują tego platformy wideo.
Config.setColorSpace("bt709");
Config.setOverwriteOutput(true);

// Render na GPU: ANGLE skraca render o ok. 35% (26 s → 17 s na 150
// klatkach) przy praktycznie tym samym obrazie (średnia różnica piksela
// 1,5/255). Kodowanie zostaje na CPU — NVENC
// (--hardware-acceleration) nie dawał zysku czasu, a bitrate spadał
// siedmiokrotnie. Gdyby ANGLE sprawiał problemy na innym komputerze:
// REEL_GL=swangle (programowy) albo REEL_GL=swiftshader.
Config.setChromiumOpenGlRenderer(
  (process.env.REEL_GL as "angle" | "swangle" | "swiftshader" | undefined) ??
    "angle",
);
