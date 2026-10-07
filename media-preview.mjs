import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

/*
 * Podglądy materiału dla modeli, które OGLĄDAJĄ ujęcia: planera
 * (wybór scen pod historię) i copywritera (napisy). Zmniejszona
 * klatka JPEG jako data URL — wystarczy, żeby ocenić styl domu,
 * gęstość lameli czy kadr, a zapytanie z kilkunastoma obrazami
 * zostaje małe.
 *
 * Obrót ze znacznika EXIF stosujemy sami (i wyłączamy autorotację
 * FFmpeg), bo to, czy FFmpeg czyta EXIF w JPEG-ach, zależy od jego
 * wersji — a model dostający zdjęcie bokiem źle oceni kadr.
 * Filmy obraca FFmpeg sam (macierz obrotu z iPhone'a działa
 * w każdej wersji).
 */

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];

const PREVIEW_WIDTH = 512;

/*
 * Orientacja z EXIF (tag 0x0112) — minimalny parser bez zależności.
 * 1 = normalnie, 3 = 180°, 6 = 90° w prawo, 8 = 90° w lewo.
 * Zwraca 1, gdy znacznika nie ma albo plik nie jest JPEG-iem.
 */
export const readExifOrientation = (filePath) => {
  let buffer;

  try {
    const handle = fs.openSync(filePath, "r");

    buffer = Buffer.alloc(256 * 1024);

    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);

    fs.closeSync(handle);

    buffer = buffer.subarray(0, bytes);
  } catch {
    return 1;
  }

  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) {
    return 1;
  }

  let offset = 2;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      return 1;
    }

    const marker = buffer[offset + 1];

    // Początek danych obrazu — EXIF jest zawsze wcześniej.
    if (marker === 0xda) {
      return 1;
    }

    const size = buffer.readUInt16BE(offset + 2);

    if (
      marker === 0xe1 &&
      buffer.toString("ascii", offset + 4, offset + 8) === "Exif"
    ) {
      const tiff = offset + 10;

      if (tiff + 8 > buffer.length) {
        return 1;
      }

      const little = buffer.toString("ascii", tiff, tiff + 2) === "II";

      const read16 = (at) =>
        little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);

      const read32 = (at) =>
        little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);

      const ifd = tiff + read32(tiff + 4);

      if (ifd + 2 > buffer.length) {
        return 1;
      }

      const entries = read16(ifd);

      for (let index = 0; index < entries; index += 1) {
        const entry = ifd + 2 + index * 12;

        if (entry + 12 > buffer.length) {
          return 1;
        }

        if (read16(entry) === 0x0112) {
          const value = read16(entry + 8);

          return [1, 2, 3, 4, 5, 6, 7, 8].includes(value) ? value : 1;
        }
      }

      return 1;
    }

    offset += 2 + size;
  }

  return 1;
};

const ORIENTATION_FILTERS = {
  2: ["hflip"],
  3: ["hflip", "vflip"],
  4: ["vflip"],
  5: ["transpose=0"],
  6: ["transpose=1"],
  7: ["transpose=3"],
  8: ["transpose=2"],
};

/*
 * Podgląd jednego materiału jako data URL (image/jpeg) albo null,
 * gdy FFmpeg nie dał rady. Dla filmu — klatka z podanej sekundy.
 */
export const makePreview = (
  filePath,
  { seekSeconds = null, width = PREVIEW_WIDTH } = {},
) => {
  const isVideo = VIDEO_EXTENSIONS.includes(
    path.extname(filePath).toLowerCase(),
  );

  const filters = isVideo
    ? []
    : [...(ORIENTATION_FILTERS[readExifOrientation(filePath)] ?? [])];

  filters.push(`scale='min(${width},iw)':-2`);

  const args = ["-v", "error"];

  if (isVideo && seekSeconds !== null) {
    args.push("-ss", String(Math.max(0, seekSeconds)));
  }

  if (!isVideo) {
    args.push("-noautorotate");
  }

  args.push(
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    filters.join(","),
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "5",
    "-",
  );

  const result = spawnSync("ffmpeg", args, {
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout?.length) {
    return null;
  }

  return `data:image/jpeg;base64,${result.stdout.toString("base64")}`;
};
