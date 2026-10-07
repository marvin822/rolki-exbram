import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

/*
 * Panel EXBRAM — interfejs w przeglądarce do generatora rolek.
 *
 * Lokalny serwer bez zależności: tylko Node. Słucha wyłącznie na
 * 127.0.0.1, więc panel jest dostępny tylko z tego komputera.
 * Pipeline uruchamia dokładnie tak, jak make-reel.bat
 * (node make-reel.mjs <zestaw>), a jego log i kroki przesyła do
 * przeglądarki na żywo (Server-Sent Events).
 *
 * Jednocześnie działa najwyżej jedno zadanie — kroki pipeline'u
 * dzielą pliki stanu w korzeniu projektu (edit.json, music.json…).
 */

const PANEL_DIR = path.dirname(
  fileURLToPath(import.meta.url),
);

const ROOT = path.resolve(PANEL_DIR, "..");

const HOST = "127.0.0.1";

const PORT =
  Number(
    process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ??
      process.env.PANEL_PORT,
  ) || 4321;

const MEDIA_ROOT = path.join(ROOT, "public", "media");

const OUTPUT_ROOT = path.join(ROOT, "output");

const WORK_ROOT = path.join(ROOT, "work");

const BRIEF_FILE = path.join(ROOT, "exbram-rolki-instrukcje-agenta.md");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];

const MAX_LOG_LINES = 3000;

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

/*
 * Klucz OpenAI z .env obok make-reel.bat — tak samo jak robi to
 * make-reel.bat, żeby panel działał po zwykłym dwukliku.
 */
const loadEnvFile = () => {
  const envFile = path.join(ROOT, ".env");

  if (!fs.existsSync(envFile)) {
    return;
  }

  fs.readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/);

      if (!match || line.trim().startsWith("#")) {
        return;
      }

      if (process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    });
};

/*
 * Nazwa zestawu = nazwa folderu. Dopuszczamy litery (także polskie),
 * cyfry, spacje, myślnik i podkreślnik — bez ukośników i kropek,
 * więc nazwa nigdy nie wyjdzie poza public/media/.
 */
const isValidSetName = (name) =>
  typeof name === "string" &&
  name.length >= 1 &&
  name.length <= 60 &&
  /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name);

const isValidFileName = (name) =>
  typeof name === "string" &&
  name.length <= 200 &&
  name === path.basename(name) &&
  !name.startsWith(".") &&
  [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].includes(
    path.extname(name).toLowerCase(),
  );

/*
 * Ścieżka wewnątrz katalogu bazowego albo null — ostatnia linia
 * obrony przed "../" w adresie.
 */
const insideDir = (base, ...parts) => {
  const resolved = path.resolve(base, ...parts);

  return resolved.startsWith(path.resolve(base) + path.sep)
    ? resolved
    : null;
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/*
 * Wyniki zestawu: komplety reel/opis/okładka ze wspólnym
 * znacznikiem czasu, najnowsze pierwsze. Pliki pośrednie
 * (reel-*.render.mp4) pomijamy.
 */
const listOutputs = (setName) => {
  const dir = path.join(OUTPUT_ROOT, setName);

  return listDir(dir)
    .map((entry) =>
      entry.name.match(
        /^reel-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.mp4$/,
      ),
    )
    .filter(Boolean)
    .map(([, stamp]) => {
      const file = (prefix, extension) => {
        const name = `${prefix}-${stamp}${extension}`;

        return fs.existsSync(path.join(dir, name)) ? name : null;
      };

      return {
        stamp,
        reel: `reel-${stamp}.mp4`,
        opis: file("opis", ".txt"),
        okladka: file("okladka", ".jpg"),
      };
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
};

const getPlanFile = (setName) =>
  path.join(WORK_ROOT, setName, "edit.json");

const listSets = () =>
  listDir(MEDIA_ROOT)
    .filter((entry) => entry.isDirectory() && isValidSetName(entry.name))
    .map((entry) => {
      const files = listDir(path.join(MEDIA_ROOT, entry.name))
        .filter((file) => file.isFile())
        .map((file) => file.name)
        .sort();

      const plan = readJson(getPlanFile(entry.name), null);

      return {
        name: entry.name,
        photos: files.filter((name) =>
          IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase()),
        ),
        videos: files.filter((name) =>
          VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()),
        ),
        outputs: listOutputs(entry.name),
        hasPlan: Array.isArray(plan?.scenes) && plan.scenes.length > 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pl"));

/*
 * --- Zadanie (jedno naraz) ---------------------------------------
 */

let job = null;

const eventClients = new Set();

const publicJob = () =>
  job && {
    id: job.id,
    set: job.set,
    mode: job.mode,
    status: job.status,
    steps: job.steps,
    currentStep: job.currentStep,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
  };

const broadcast = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  eventClients.forEach((client) => client.write(payload));
};

const addLogLine = (line) => {
  job.log.push(line);

  if (job.log.length > MAX_LOG_LINES) {
    job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }

  broadcast("log", { id: job.id, line });

  /*
   * make-reel.mjs ogłasza każdy krok banerem "<zestaw> — <krok>".
   */
  const prefix = `${job.set} — `;

  if (line.startsWith(prefix)) {
    const step = line.slice(prefix.length).trim();

    if (!job.steps.includes(step)) {
      job.steps.push(step);
    }

    job.currentStep = step;

    broadcast("job", publicJob());
  }
};

const startJob = ({ set, mode, stabilize }) => {
  const args = ["make-reel.mjs", set];

  if (mode === "render") {
    args.push("--tylko-render");
  }

  const env = {
    ...process.env,
    FORCE_COLOR: "0",
  };

  if (!stabilize) {
    env.REEL_STABILIZE = "0";
  }

  job = {
    id: Date.now(),
    set,
    mode,
    status: "running",
    steps: [],
    currentStep: null,
    log: [],
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
  };

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    windowsHide: true,
  });

  /*
   * Remotion i FFmpeg rysują postęp przez "\r" — dzielimy także
   * po nim, żeby każdy stan postępu był osobną linią.
   */
  const attach = (stream) => {
    let buffer = "";

    stream.setEncoding("utf8");

    stream.on("data", (chunk) => {
      buffer += chunk;

      const parts = buffer.split(/\r\n|\n|\r/);

      buffer = parts.pop();

      parts
        .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
        .filter((line) => line.trim() !== "")
        .forEach(addLogLine);
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        addLogLine(buffer);
      }
    });
  };

  attach(child.stdout);
  attach(child.stderr);

  child.on("close", (code) => {
    job.status = code === 0 ? "done" : "error";
    job.exitCode = code;
    job.finishedAt = Date.now();
    job.currentStep = null;

    broadcast("job", publicJob());
    broadcast("sets", listSets());
  });

  child.on("error", (error) => {
    addLogLine(`Nie udało się uruchomić pipeline'u: ${error.message}`);
  });

  broadcast("job", publicJob());
};

/*
 * --- Plan i napisy -----------------------------------------------
 */

const cleanText = (value, maxLength) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

/*
 * Wyróżnienie musi być fragmentem tekstu — inaczej kompozycja nie
 * ma czego pokolorować.
 */
const cleanHighlight = (highlight, text) => {
  const value = cleanText(highlight, 60);

  return value && text.toLowerCase().includes(value.toLowerCase())
    ? value
    : "";
};

const readPlanForEditor = (setName) => {
  const plan = readJson(getPlanFile(setName), null);

  if (!plan || !Array.isArray(plan.scenes)) {
    return null;
  }

  return {
    hook: plan.hook ?? "",
    hookHighlight: plan.hookHighlight ?? "",
    cover: plan.cover ?? "",
    scenes: plan.scenes.map((scene) => ({
      file: scene.file,
      fragmentId: scene.fragmentId ?? "",
      duration: scene.duration,
      caption: scene.caption ?? "",
      captionHighlight: scene.captionHighlight ?? "",
    })),
    description: {
      firstLine: plan.copy?.description?.firstLine ?? "",
      body: plan.copy?.description?.body ?? "",
      hashtags: plan.copy?.description?.hashtags ?? [],
    },
    missing: plan.copy?.missing ?? [],
    type: plan.copy?.type ?? "",
    angle:
      plan.copy?.variants?.[plan.copy?.chosen]?.angle ??
      plan.copy?.angle ??
      "",
    story: plan.story ?? "",
    chosen: Number.isInteger(plan.copy?.chosen) ? plan.copy.chosen : null,
    editedByHand: Boolean(plan.copy?.editedByHand),
    variants: (plan.copy?.variants ?? []).map((variant) => ({
      angle: variant.angle ?? "",
      hook: variant.hook ?? "",
      hookHighlight: variant.hookHighlight ?? "",
      cover: variant.cover ?? "",
      boards: (variant.spans ?? []).map((span) => ({
        from: span.from,
        to: span.to,
        text: span.text,
        highlight: span.highlight ?? "",
      })),
      firstLine: variant.description?.firstLine ?? "",
      problems: variant.problems ?? [],
    })),
  };
};

/*
 * Przełączenie rolki na inną wersję napisów od copywritera —
 * ta sama logika co applyVariant w write-copy.mjs: hook, plansza
 * na każdej scenie z jej odcinka, okładka, opis.
 */
const chooseVariant = (setName, index) => {
  const file = getPlanFile(setName);

  const plan = readJson(file, null);

  const variant = plan?.copy?.variants?.[index];

  if (!variant) {
    throw new Error("Nie ma takiej wersji napisów.");
  }

  plan.hook = variant.hook;
  plan.hookHighlight = variant.hookHighlight;
  plan.cover = variant.cover;

  plan.scenes = plan.scenes.map((scene, sceneIndex) => {
    const span = (variant.spans ?? []).find(
      (item) => sceneIndex + 1 >= item.from && sceneIndex + 1 <= item.to,
    );

    return {
      ...scene,
      caption: span?.text ?? "",
      captionHighlight: span?.highlight ?? "",
    };
  });

  plan.copy = {
    ...plan.copy,
    chosen: index,
    description: variant.description,
    missing: variant.missing ?? [],
    problems: variant.problems ?? [],
    editedByHand: false,
  };

  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
};

/*
 * Zapis poprawek z edytora do work/<zestaw>/edit.json. Zmieniamy
 * WYŁĄCZNIE teksty — kolejność scen, pliki i czasy zostają z planu,
 * więc ręczna edycja nie może zepsuć montażu.
 */
const savePlanFromEditor = (setName, input) => {
  const file = getPlanFile(setName);

  const plan = readJson(file, null);

  if (!plan || !Array.isArray(plan.scenes)) {
    throw new Error("Ten zestaw nie ma jeszcze planu montażu.");
  }

  const hook = cleanText(input.hook, 60);

  plan.hook = hook;
  plan.hookHighlight = cleanHighlight(input.hookHighlight, hook);
  plan.cover = cleanText(input.cover, 40);

  plan.scenes = plan.scenes.map((scene, index) => {
    const edited = input.scenes?.[index] ?? {};

    const caption = index === 0 ? "" : cleanText(edited.caption, 60);

    return {
      ...scene,
      caption,
      captionHighlight: cleanHighlight(edited.captionHighlight, caption),
    };
  });

  const description = input.description ?? {};

  plan.copy = {
    ...(plan.copy ?? {}),
    description: {
      firstLine: cleanText(description.firstLine, 200),
      body: String(description.body ?? "")
        .replace(/\r\n/g, "\n")
        .trim()
        .slice(0, 2000),
      hashtags: (Array.isArray(description.hashtags)
        ? description.hashtags
        : String(description.hashtags ?? "").split(/[\s,]+/)
      )
        .map((tag) => String(tag).replace(/^#+/, "").trim())
        .filter(Boolean)
        .slice(0, 8),
    },
    missing: (Array.isArray(input.missing) ? input.missing : [])
      .map((item) => cleanText(item, 120))
      .filter(Boolean),
    editedByHand: true,
  };

  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
};

/*
 * --- HTTP --------------------------------------------------------
 */

const sendJson = (response, status, data) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  response.end(JSON.stringify(data));
};

const sendError = (response, status, message) =>
  sendJson(response, status, { error: message });

const readBody = (request, limit = 1_000_000) =>
  new Promise((resolve, reject) => {
    let size = 0;

    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;

      if (size > limit) {
        reject(new Error("Za duże zapytanie."));

        request.destroy();

        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const readJsonBody = async (request) => {
  const text = await readBody(request);

  return text ? JSON.parse(text) : {};
};

/*
 * Pliki z obsługą Range — bez tego przeglądarka nie przewija
 * odtwarzacza wideo.
 */
const serveFile = (request, response, file) => {
  let stat;

  try {
    stat = fs.statSync(file);
  } catch {
    sendError(response, 404, "Nie ma takiego pliku.");

    return;
  }

  if (!stat.isFile()) {
    sendError(response, 404, "Nie ma takiego pliku.");

    return;
  }

  const type =
    CONTENT_TYPES[path.extname(file).toLowerCase()] ??
    "application/octet-stream";

  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);

  if (range) {
    const start = range[1] ? Number(range[1]) : 0;

    const end = range[2]
      ? Math.min(Number(range[2]), stat.size - 1)
      : stat.size - 1;

    if (start > end || start >= stat.size) {
      response.writeHead(416, {
        "Content-Range": `bytes */${stat.size}`,
      });

      response.end();

      return;
    }

    response.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });

    fs.createReadStream(file, { start, end }).pipe(response);

    return;
  }

  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });

  fs.createReadStream(file).pipe(response);
};

const isJobRunningFor = (setName) =>
  job?.status === "running" && job.set === setName;

const handleApi = async (request, response, parts) => {
  const method = request.method;

  // /api/state
  if (parts[0] === "state" && method === "GET") {
    sendJson(response, 200, {
      sets: listSets(),
      job: publicJob(),
      log: job?.log.slice(-500) ?? [],
    });

    return;
  }

  // /api/events — strumień zmian dla przeglądarki
  if (parts[0] === "events" && method === "GET") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });

    response.write(": polaczono\n\n");

    eventClients.add(response);

    const keepAlive = setInterval(() => response.write(": ping\n\n"), 20000);

    request.on("close", () => {
      clearInterval(keepAlive);
      eventClients.delete(response);
    });

    return;
  }

  // /api/brief
  if (parts[0] === "brief") {
    if (method === "GET") {
      sendJson(response, 200, {
        text: fs.existsSync(BRIEF_FILE)
          ? fs.readFileSync(BRIEF_FILE, "utf8")
          : "",
      });

      return;
    }

    if (method === "PUT") {
      const { text } = await readJsonBody(request);

      if (typeof text !== "string" || text.trim().length < 100) {
        sendError(response, 400, "Brief jest pusty albo za krótki.");

        return;
      }

      fs.writeFileSync(BRIEF_FILE, text.replace(/\r\n/g, "\n"), "utf8");

      sendJson(response, 200, { ok: true });

      return;
    }
  }

  if (parts[0] !== "sets") {
    sendError(response, 404, "Nieznany adres.");

    return;
  }

  // POST /api/sets — nowy zestaw
  if (parts.length === 1 && method === "POST") {
    const { name } = await readJsonBody(request);

    const setName = cleanText(name, 60);

    if (!isValidSetName(setName)) {
      sendError(
        response,
        400,
        "Nazwa może mieć litery, cyfry, spacje, myślnik i podkreślnik (do 60 znaków).",
      );

      return;
    }

    const dir = path.join(MEDIA_ROOT, setName);

    if (fs.existsSync(dir)) {
      sendError(response, 409, "Taki zestaw już istnieje.");

      return;
    }

    fs.mkdirSync(dir, { recursive: true });

    broadcast("sets", listSets());

    sendJson(response, 201, { name: setName });

    return;
  }

  const setName = parts[1];

  if (!isValidSetName(setName)) {
    sendError(response, 400, "Niepoprawna nazwa zestawu.");

    return;
  }

  const setDir = path.join(MEDIA_ROOT, setName);

  if (!fs.existsSync(setDir)) {
    sendError(response, 404, "Nie ma takiego zestawu.");

    return;
  }

  // /api/sets/:set/files/:file
  if (parts[2] === "files" && parts[3]) {
    const fileName = parts[3];

    if (!isValidFileName(fileName)) {
      sendError(
        response,
        400,
        "Dozwolone są zdjęcia (.jpg, .png, .webp) i filmy (.mp4, .mov, .webm).",
      );

      return;
    }

    if (isJobRunningFor(setName)) {
      sendError(
        response,
        409,
        "Dla tego zestawu trwa generowanie — poczekaj, aż się skończy.",
      );

      return;
    }

    const target = insideDir(setDir, fileName);

    if (!target) {
      sendError(response, 400, "Niepoprawna nazwa pliku.");

      return;
    }

    if (method === "PUT") {
      /*
       * Plik przychodzi jako surowe ciało zapytania i od razu leci
       * na dysk — także wielogigabajtowe filmy 4K. Zapis idzie do
       * pliku tymczasowego, żeby przerwane wysyłanie nie zostawiło
       * uciętego materiału.
       */
      const temporary = `${target}.upload`;

      const output = fs.createWriteStream(temporary);

      request.pipe(output);

      output.on("finish", () => {
        fs.renameSync(temporary, target);

        broadcast("sets", listSets());

        sendJson(response, 200, { name: fileName });
      });

      const fail = (error) => {
        output.destroy();

        fs.rmSync(temporary, { force: true });

        if (!response.headersSent) {
          sendError(response, 500, `Wysyłanie przerwane: ${error.message}`);
        }
      };

      request.on("aborted", () => fail(new Error("połączenie zerwane")));
      output.on("error", fail);

      return;
    }

    if (method === "DELETE") {
      fs.rmSync(target, { force: true });

      broadcast("sets", listSets());

      sendJson(response, 200, { ok: true });

      return;
    }
  }

  // POST /api/sets/:set/run
  if (parts[2] === "run" && method === "POST") {
    const { mode, stabilize } = await readJsonBody(request);

    if (job?.status === "running") {
      sendError(
        response,
        409,
        `Trwa już generowanie zestawu „${job.set}”. Jednocześnie działa jedno.`,
      );

      return;
    }

    const files = listDir(setDir).filter(
      (entry) => entry.isFile() && isValidFileName(entry.name),
    );

    if (files.length === 0) {
      sendError(response, 400, "Zestaw jest pusty — najpierw wrzuć materiał.");

      return;
    }

    if (mode === "render" && !readPlanForEditor(setName)) {
      sendError(
        response,
        400,
        "Ten zestaw nie ma jeszcze planu — najpierw pełne generowanie.",
      );

      return;
    }

    if (mode !== "render" && !process.env.OPENAI_API_KEY) {
      sendError(
        response,
        400,
        "Brak OPENAI_API_KEY — dodaj go do pliku .env obok make-reel.bat.",
      );

      return;
    }

    startJob({
      set: setName,
      mode: mode === "render" ? "render" : "full",
      stabilize: stabilize !== false,
    });

    sendJson(response, 202, publicJob());

    return;
  }

  // PUT /api/sets/:set/variant — wybór wersji napisów od copywritera
  if (parts[2] === "variant" && method === "PUT") {
    if (isJobRunningFor(setName)) {
      sendError(
        response,
        409,
        "Dla tego zestawu trwa generowanie — poczekaj, aż się skończy.",
      );

      return;
    }

    const { index } = await readJsonBody(request);

    chooseVariant(setName, Number(index));

    sendJson(response, 200, readPlanForEditor(setName));

    return;
  }

  // /api/sets/:set/plan
  if (parts[2] === "plan") {
    if (method === "GET") {
      const plan = readPlanForEditor(setName);

      if (!plan) {
        sendError(response, 404, "Ten zestaw nie ma jeszcze planu.");

        return;
      }

      sendJson(response, 200, plan);

      return;
    }

    if (method === "PUT") {
      if (isJobRunningFor(setName)) {
        sendError(
          response,
          409,
          "Dla tego zestawu trwa generowanie — poczekaj, aż się skończy.",
        );

        return;
      }

      savePlanFromEditor(setName, await readJsonBody(request));

      sendJson(response, 200, readPlanForEditor(setName));

      return;
    }
  }

  sendError(response, 404, "Nieznany adres.");
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);

  /*
   * Panel jest tylko dla przeglądarki z tego komputera. Odrzucamy
   * zapytania z innym nagłówkiem Host (ochrona przed DNS rebinding).
   */
  const host = (request.headers.host ?? "").split(":")[0];

  if (!["127.0.0.1", "localhost"].includes(host)) {
    sendError(response, 403, "Panel działa tylko lokalnie.");

    return;
  }

  try {
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (parts[0] === "api") {
      await handleApi(request, response, parts.slice(1));

      return;
    }

    // /media/<zestaw>/<plik> i /output/<zestaw>/<plik>
    if ((parts[0] === "media" || parts[0] === "output") && parts.length === 3) {
      const base = parts[0] === "media" ? MEDIA_ROOT : OUTPUT_ROOT;

      const file =
        isValidSetName(parts[1]) && parts[2] === path.basename(parts[2])
          ? insideDir(base, parts[1], parts[2])
          : null;

      if (!file) {
        sendError(response, 400, "Niepoprawna ścieżka.");

        return;
      }

      serveFile(request, response, file);

      return;
    }

    const asset = STATIC_FILES[url.pathname];

    if (asset && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": asset[1],
        "Cache-Control": "no-cache",
      });

      fs.createReadStream(path.join(PANEL_DIR, asset[0])).pipe(response);

      return;
    }

    sendError(response, 404, "Nie ma takiej strony.");
  } catch (error) {
    if (!response.headersSent) {
      sendError(response, 500, error.message);
    }
  }
});

const openBrowser = (url) => {
  if (
    process.env.PANEL_NO_BROWSER ||
    process.argv.includes("--bez-przegladarki")
  ) {
    return;
  }

  const command =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
};

loadEnvFile();

fs.mkdirSync(MEDIA_ROOT, { recursive: true });

const url = `http://localhost:${PORT}`;

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`Panel już działa — otwieram ${url}`);

    openBrowser(url);

    process.exit(0);
  }

  console.error(`Błąd serwera: ${error.message}`);

  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(" EXBRAM — panel generatora rolek");
  console.log("========================================");
  console.log(` Adres: ${url}`);
  console.log(" Zamknij to okno, żeby wyłączyć panel.");
  console.log("");

  if (!process.env.OPENAI_API_KEY) {
    console.log(
      " UWAGA: brak OPENAI_API_KEY — pełne generowanie nie zadziała.",
    );
  }

  openBrowser(url);
});
