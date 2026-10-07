/*
 * Panel EXBRAM — logika interfejsu (bez frameworka).
 *
 * Stan przychodzi z serwera (/api/state) i jest odświeżany na żywo
 * przez Server-Sent Events (/api/events): lista zestawów, bieżące
 * zadanie i jego log.
 */

const state = {
  sets: [],
  job: null,
  log: [],
  selected: null,
  tab: "material",
  view: "welcome",
  plan: null,
};

const $ = (selector) => document.querySelector(selector);

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

const enc = encodeURIComponent;

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];

const extensionOf = (name) => {
  const index = name.lastIndexOf(".");

  return index === -1 ? "" : name.slice(index).toLowerCase();
};

const currentSet = () =>
  state.sets.find((set) => set.name === state.selected) ?? null;

const isRunning = () => state.job?.status === "running";

const isRunningFor = (name) => isRunning() && state.job.set === name;

/*
 * --- Komunikaty ---------------------------------------------------
 */

let toastTimer = null;

const toast = (message, isError = false) => {
  const element = $("#toast");

  element.textContent = message;
  element.classList.toggle("error", isError);
  element.hidden = false;

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 4500);
};

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error ?? `Błąd ${response.status}`);
  }

  return data;
};

/*
 * --- Nawigacja ----------------------------------------------------
 */

const showView = (view) => {
  state.view = view;

  $("#welcome").hidden = view !== "welcome";
  $("#set-view").hidden = view !== "set";
  $("#brief-view").hidden = view !== "brief";
};

const selectSet = (name, tab) => {
  state.selected = name;
  state.plan = null;

  $("#copy-editor").dataset.key = "";
  $("#results").dataset.key = "";
  $("#results").dataset.stamp = "";

  if (tab) {
    state.tab = tab;
  }

  showView("set");
  render();
};

const selectTab = (tab) => {
  state.tab = tab;

  /*
   * Wejście w zakładkę zawsze rysuje ją od nowa (np. po edycji
   * napisów w innym miejscu albo powrocie do wyników).
   */
  $("#copy-editor").dataset.key = "";
  $("#results").dataset.key = "";

  render();
};

/*
 * --- Pasek boczny --------------------------------------------------
 */

const renderSidebar = () => {
  $("#set-list").innerHTML = state.sets.length
    ? state.sets
        .map((set) => {
          const status = isRunningFor(set.name)
            ? "running"
            : set.outputs.length
              ? "done"
              : "";

          const count = set.photos.length + set.videos.length;

          return `
            <button class="set-item ${set.name === state.selected && state.view === "set" ? "active" : ""}"
                    data-set="${escapeHtml(set.name)}">
              <span class="dot ${status}"></span>
              <span class="set-item-name">${escapeHtml(set.name)}</span>
              <span class="set-item-count">${count}</span>
            </button>`;
        })
        .join("")
    : `<p class="hint" style="color:#9d9ea3;padding:0 6px">Brak zestawów — utwórz pierwszy.</p>`;

  const badge = $("#job-badge");

  if (isRunning()) {
    badge.hidden = false;
    badge.innerHTML = `Generuje: <strong>${escapeHtml(state.job.set)}</strong><br>${escapeHtml(state.job.currentStep ?? "start…")}`;
  } else {
    badge.hidden = true;
  }
};

/*
 * --- Materiał ------------------------------------------------------
 */

const renderMaterial = (set) => {
  const files = [
    ...set.photos.map((name) => ({ name, video: false })),
    ...set.videos.map((name) => ({ name, video: true })),
  ];

  $("#media-grid").innerHTML = files.length
    ? files
        .map(
          (file) => `
          <div class="media-tile">
            ${
              file.video
                ? `<div class="video-tile">▶<span>FILM</span></div>`
                : `<img loading="lazy" src="/media/${enc(set.name)}/${enc(file.name)}" alt="">`
            }
            <span class="media-name">${escapeHtml(file.name)}</span>
            <button class="media-delete" title="Usuń z zestawu"
                    data-delete="${escapeHtml(file.name)}">×</button>
          </div>`,
        )
        .join("")
    : `<p class="hint">Zestaw jest pusty — wrzuć zdjęcia i filmy jednej realizacji.</p>`;
};

const uploadFile = (setName, file, row) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open(
      "PUT",
      `/api/sets/${enc(setName)}/files/${enc(file.name)}`,
    );

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        row.querySelector("progress").value = event.loaded / event.total;
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();

        return;
      }

      let message = `Błąd ${request.status}`;

      try {
        message = JSON.parse(request.responseText).error ?? message;
      } catch {
        // zostaje kod błędu
      }

      reject(new Error(message));
    };

    request.onerror = () => reject(new Error("Połączenie przerwane"));

    request.send(file);
  });

const uploadFiles = async (fileList) => {
  const set = currentSet();

  if (!set) {
    return;
  }

  const allowed = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

  const files = [...fileList];

  const rejected = files.filter(
    (file) => !allowed.includes(extensionOf(file.name)),
  );

  if (rejected.length) {
    toast(
      `Pominięto ${rejected.length} plik(ów) — dozwolone są zdjęcia i filmy.`,
      true,
    );
  }

  const container = $("#uploads");

  /*
   * Pliki idą po kolei — równoległe wysyłanie kilku filmów 4K
   * tylko by się nawzajem spowalniało.
   */
  for (const file of files.filter((item) =>
    allowed.includes(extensionOf(item.name)),
  )) {
    const row = document.createElement("div");

    row.className = "upload-row";
    row.innerHTML = `<span>${escapeHtml(file.name)}</span><progress max="1" value="0"></progress>`;

    container.append(row);

    try {
      await uploadFile(set.name, file, row);

      row.remove();
    } catch (error) {
      row.querySelector("span").textContent =
        `${file.name} — ${error.message}`;

      row.querySelector("span").style.color = "var(--red)";
    }
  }
};

/*
 * --- Generowanie ---------------------------------------------------
 */

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const renderRun = (set) => {
  const busy = isRunning();

  $("#run-full").disabled = busy || set.photos.length + set.videos.length === 0;

  $("#run-render").disabled = busy || !set.hasPlan;

  const progress = $("#progress");

  const job = state.job;

  if (!job || job.set !== set.name) {
    progress.hidden = true;

    return;
  }

  progress.hidden = false;

  $("#progress-title").textContent =
    job.mode === "render" ? "Ponowny render" : "Generowanie rolki";

  const steps = job.steps.length ? job.steps : ["Uruchamianie…"];

  $("#step-list").innerHTML =
    steps
      .map((step) => {
        let className = "done";

        if (
          job.status === "running" &&
          (step === job.currentStep || !job.steps.length)
        ) {
          className = "current";
        } else if (
          job.status === "error" &&
          step === steps[steps.length - 1]
        ) {
          className = "failed";
        }

        return `<li class="${className}">${escapeHtml(step)}</li>`;
      })
      .join("") +
    (job.status === "done"
      ? `<li class="status-line ok">Gotowe — rolka jest w zakładce Wyniki</li>`
      : job.status === "error"
        ? `<li class="status-line error">Błąd (kod ${job.exitCode}) — szczegóły w logu poniżej</li>`
        : "");

  if (job.status === "error") {
    $("#log-box").open = true;
  }

  updateTimer();
};

const updateTimer = () => {
  const job = state.job;

  if (!job || job.set !== state.selected) {
    return;
  }

  const end = job.finishedAt ?? Date.now();

  $("#progress-time").textContent = formatDuration(end - job.startedAt);
};

const renderLog = () => {
  const element = $("#log");

  const nearBottom =
    element.scrollHeight - element.scrollTop - element.clientHeight < 40;

  element.textContent = state.log.join("\n");

  if (nearBottom) {
    element.scrollTop = element.scrollHeight;
  }
};

const startRun = async (mode) => {
  const set = currentSet();

  try {
    state.log = [];

    await api(`/api/sets/${enc(set.name)}/run`, {
      method: "POST",
      body: JSON.stringify({
        mode,
        stabilize: $("#stabilize").checked,
      }),
    });

    selectTab("run");
  } catch (error) {
    toast(error.message, true);
  }
};

/*
 * --- Wyniki --------------------------------------------------------
 */

const DESCRIPTION_SEPARATOR = "———— DO UZUPEŁNIENIA";

const renderResults = async (set) => {
  const container = $("#results");

  if (!set.outputs.length) {
    container.dataset.key = "";
    container.innerHTML = `<p class="hint">Ten zestaw nie ma jeszcze gotowej rolki — przejdź do zakładki Generowanie.</p>`;

    return;
  }

  const shownStamp =
    container.dataset.stamp &&
    set.outputs.some((item) => item.stamp === container.dataset.stamp)
      ? container.dataset.stamp
      : set.outputs[0].stamp;

  const output = set.outputs.find((item) => item.stamp === shownStamp);

  /*
   * Zdarzenia z serwera przychodzą często (każdy krok innego
   * zadania) — przerysowanie zatrzymałoby oglądaną rolkę.
   * Rysujemy ponownie tylko, gdy zmieniła się pokazywana wersja.
   */
  const key = `${set.name}|${shownStamp}|${set.outputs.length}`;

  if (container.dataset.key === key) {
    return;
  }

  container.dataset.key = key;

  const base = `/output/${enc(set.name)}`;

  let description = "";

  let missing = [];

  if (output.opis) {
    const text = await fetch(`${base}/${enc(output.opis)}`, {
      cache: "no-store",
    })
      .then((response) => response.text())
      .catch(() => "");

    const [main, rest] = text.split(DESCRIPTION_SEPARATOR);

    description = main.trim();

    missing = (rest ?? "")
      .split("\n")
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter((line) => line && !line.startsWith("("));
  }

  /*
   * Zestaw mógł się zmienić w trakcie pobierania opisu.
   */
  if (state.selected !== set.name || state.tab !== "results") {
    return;
  }

  const label = shownStamp.replace("_", " ").replace(/-(\d\d)-(\d\d)$/, ":$1:$2");

  container.innerHTML = `
    <div class="result">
      <video controls preload="metadata" src="${base}/${enc(output.reel)}"></video>
      <div class="result-side">
        <div class="result-head">
          <h2>Rolka z ${escapeHtml(label)}</h2>
          <div class="downloads">
            <a class="button button-small" href="${base}/${enc(output.reel)}" download>Pobierz rolkę</a>
            ${output.okladka ? `<a class="button button-small" href="${base}/${enc(output.okladka)}" download>Pobierz okładkę</a>` : ""}
          </div>
        </div>

        ${
          missing.length
            ? `<div class="missing-box"><strong>Do uzupełnienia w opisie przed publikacją:</strong>
                 <ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
            : ""
        }

        <div class="card">
          <div class="result-head">
            <h3>Opis pod post</h3>
            <button class="button button-small button-primary" id="copy-description">Kopiuj opis</button>
          </div>
          <div class="description-box" id="description-text">${escapeHtml(description || "Brak opisu dla tej wersji.")}</div>
        </div>

        ${
          output.okladka
            ? `<div class="cover-row">
                 <img src="${base}/${enc(output.okladka)}" alt="Okładka">
                 <p class="hint">Okładkę ustaw ręcznie przy publikacji rolki na Instagramie i Facebooku.</p>
               </div>`
            : ""
        }
      </div>
    </div>

    ${
      set.outputs.length > 1
        ? `<div class="versions"><h3>Poprzednie wersje</h3><ul>${set.outputs
            .map(
              (item) =>
                `<li><button class="button button-small" data-stamp="${item.stamp}" ${item.stamp === shownStamp ? "disabled" : ""}>${escapeHtml(item.stamp.replace("_", " "))}</button></li>`,
            )
            .join("")}</ul></div>`
        : ""
    }`;

  $("#copy-description")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(description);

      toast("Opis skopiowany — wklej go pod rolką.");
    } catch {
      toast("Nie udało się skopiować — zaznacz tekst ręcznie.", true);
    }
  });

  container.querySelectorAll("[data-stamp]").forEach((button) =>
    button.addEventListener("click", () => {
      container.dataset.stamp = button.dataset.stamp;

      renderResults(set);
    }),
  );
};

/*
 * --- Napisy i opis -------------------------------------------------
 */

const LIMITS = {
  hook: 42,
  caption: 56,
  cover: 30,
  firstLine: 120,
};

const counter = (value, limit) =>
  `<span class="counter ${value.length > limit ? "over" : ""}">${value.length}/${limit}</span>`;

const renderCopyEditor = async (set) => {
  const container = $("#copy-editor");

  if (!set.hasPlan) {
    container.innerHTML = `<p class="hint">Napisy pojawią się po pierwszym generowaniu rolki.</p>`;

    return;
  }

  if (!state.plan || state.plan.set !== set.name) {
    container.innerHTML = `<p class="hint">Wczytuję…</p>`;

    try {
      const plan = await api(`/api/sets/${enc(set.name)}/plan`);

      state.plan = { ...plan, set: set.name };
    } catch (error) {
      container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;

      return;
    }

    if (state.selected !== set.name || state.tab !== "copy") {
      return;
    }

    container.dataset.key = `${set.name}|plan|${set.hasPlan}|${isRunning()}`;
  }

  const plan = state.plan;

  const busy = isRunningFor(set.name);

  const sceneRows = plan.scenes
    .map((scene, index) => {
      const isVideo =
        Boolean(scene.fragmentId) ||
        VIDEO_EXTENSIONS.includes(extensionOf(scene.file));

      const thumb = isVideo
        ? `<div class="scene-thumb">▶</div>`
        : `<img class="scene-thumb" loading="lazy" src="/media/${enc(set.name)}/${enc(scene.file)}" alt="">`;

      if (index === 0) {
        return `
          <div class="scene-row">
            ${thumb}
            <div>
              <div class="scene-label">Scena 1 · ${scene.duration} s</div>
              <div class="hint">Na tej scenie stoi hook (wyżej).</div>
            </div>
            <div></div>
          </div>`;
      }

      const previous = plan.scenes[index - 1]?.caption ?? "";

      const continues = scene.caption && scene.caption === previous && index > 1;

      return `
        <div class="scene-row">
          ${thumb}
          <div class="${scene.caption && !continues ? "board-start" : ""}">
            <div class="scene-label">
              Scena ${index + 1} · ${scene.duration} s
              ${continues ? " · ciąg dalszy planszy z poprzedniej sceny" : ""}
            </div>
            <input type="text" data-scene="${index}" data-field="caption"
                   value="${escapeHtml(scene.caption)}" placeholder="bez napisu">
          </div>
          <div>
            <div class="scene-label">Wyróżnij (na czerwono)</div>
            <input type="text" data-scene="${index}" data-field="captionHighlight"
                   value="${escapeHtml(scene.captionHighlight)}" placeholder="słowo z napisu">
          </div>
        </div>`;
    })
    .join("");

  const variantCards = (plan.variants ?? [])
    .map((variant, index) => {
      const isChosen = index === plan.chosen;

      return `
        <article class="variant ${isChosen ? "chosen" : ""}">
          <header class="variant-head">
            <span class="variant-angle">${escapeHtml(variant.angle || `Wersja ${index + 1}`)}</span>
            ${isChosen ? `<span class="variant-badge">${plan.editedByHand ? "w rolce · poprawiona ręcznie" : "w rolce"}</span>` : ""}
          </header>
          <p class="variant-hook">${escapeHtml(variant.hook)}</p>
          <ol class="variant-boards">
            ${variant.boards
              .map(
                (board) =>
                  `<li><span class="variant-scenes">sc. ${board.from}${board.to > board.from ? `–${board.to}` : ""}</span> ${escapeHtml(board.text)}</li>`,
              )
              .join("")}
          </ol>
          <p class="variant-cover">Okładka: ${escapeHtml(variant.cover)}</p>
          ${
            variant.problems.length
              ? `<p class="variant-problems" title="${escapeHtml(variant.problems.join("\n"))}">⚠ ${variant.problems.length} uwag kontroli</p>`
              : ""
          }
          <div class="variant-actions">
            <button class="button button-small" data-variant="${index}" ${busy || isChosen ? "disabled" : ""}>Użyj tej wersji</button>
            <button class="button button-small button-primary" data-variant-render="${index}" ${isRunning() ? "disabled" : ""}>${isChosen ? "Renderuj" : "Użyj i renderuj"}</button>
          </div>
        </article>`;
    })
    .join("");

  container.innerHTML = `
    ${
      plan.story
        ? `<p class="hint"><strong>Historia rolki:</strong> ${escapeHtml(plan.story)}</p>`
        : ""
    }

    ${
      variantCards
        ? `<h2 class="section-title">Wersje napisów od AI</h2>
           <p class="hint">Copywriter przygotował kilka wersji pod różnymi kątami. Wybierz jedną —
           nowa rolka powstanie w ok. minutę, bez kosztów AI. Wybraną wersję możesz niżej poprawić ręcznie.</p>
           <div class="variants">${variantCards}</div>`
        : ""
    }

    <p class="hint">
      ${plan.type ? `Typ materiału: <strong>${escapeHtml(plan.type)}</strong> — ${escapeHtml(plan.angle)}. ` : ""}
      Ten sam tekst na kolejnych scenach = jedna plansza trwająca przez nie.
      Po zapisaniu użyj <strong>Zapisz i renderuj</strong> — nowa wersja powstanie bez kosztów AI.
    </p>

    <h2 class="section-title">Napisy na ekranie${plan.variants?.length ? " — wersja w rolce" : ""}</h2>
    <div class="card copy-grid">
      <div class="field-row">
        <div class="field">
          <label>Hook (scena 1) ${counter(plan.hook, LIMITS.hook)}</label>
          <input type="text" data-field="hook" value="${escapeHtml(plan.hook)}">
        </div>
        <div class="field">
          <label>Wyróżnij w hooku</label>
          <input type="text" data-field="hookHighlight" value="${escapeHtml(plan.hookHighlight)}">
        </div>
      </div>
      <div class="field">
        <label>Tekst okładki ${counter(plan.cover, LIMITS.cover)}</label>
        <input type="text" data-field="cover" value="${escapeHtml(plan.cover)}">
      </div>
      <div>${sceneRows}</div>
    </div>

    <h2 class="section-title">Opis pod post</h2>
    <div class="card copy-grid">
      <div class="field">
        <label>Pierwsza linia (widoczna przed „…więcej”) ${counter(plan.description.firstLine, LIMITS.firstLine)}</label>
        <input type="text" data-field="firstLine" value="${escapeHtml(plan.description.firstLine)}">
      </div>
      <div class="field">
        <label>Treść</label>
        <textarea data-field="body" rows="7">${escapeHtml(plan.description.body)}</textarea>
      </div>
      <div class="field">
        <label>Hasztagi (bez #exbram — dodawany automatycznie)</label>
        <input type="text" data-field="hashtags" value="${escapeHtml(plan.description.hashtags.map((tag) => `#${tag}`).join(" "))}">
      </div>
      <div class="field">
        <label>Do uzupełnienia (po jednej pozycji w linii — pojawią się pod opisem)</label>
        <textarea data-field="missing" rows="3">${escapeHtml(plan.missing.join("\n"))}</textarea>
      </div>
      <p class="hint">CTA „Darmowa wycena: 502 492 009 lub www.exbram.pl” dokleja się automatycznie.</p>
    </div>

    <div class="form-actions">
      <button class="button" id="copy-save" ${busy ? "disabled" : ""}>Zapisz</button>
      <button class="button button-primary" id="copy-save-render" ${isRunning() ? "disabled" : ""}>Zapisz i renderuj</button>
      <span class="save-status" id="copy-status"></span>
    </div>`;

  container.querySelectorAll("input, textarea").forEach((input) =>
    input.addEventListener("input", () => readCopyForm(container)),
  );

  $("#copy-save").addEventListener("click", () => saveCopy(false));
  $("#copy-save-render").addEventListener("click", () => saveCopy(true));

  container.querySelectorAll("[data-variant]").forEach((button) =>
    button.addEventListener("click", () =>
      chooseVariant(Number(button.dataset.variant), false),
    ),
  );

  container.querySelectorAll("[data-variant-render]").forEach((button) =>
    button.addEventListener("click", () =>
      chooseVariant(Number(button.dataset.variantRender), true),
    ),
  );
};

/*
 * Przełączenie rolki na inną wersję napisów od copywritera
 * (opcjonalnie od razu z renderem bez AI).
 */
const chooseVariant = async (index, andRender) => {
  const set = currentSet();

  const plan = state.plan;

  if (
    plan?.editedByHand &&
    index !== plan.chosen &&
    !confirm("Ręczne poprawki obecnej wersji zostaną zastąpione. Kontynuować?")
  ) {
    return;
  }

  try {
    if (index !== plan?.chosen || plan?.editedByHand === false) {
      const saved = await api(`/api/sets/${enc(set.name)}/variant`, {
        method: "PUT",
        body: JSON.stringify({ index }),
      });

      state.plan = { ...saved, set: set.name };
    }

    if (andRender) {
      await startRun("render");

      return;
    }

    $("#copy-editor").dataset.key = "";

    renderCopyEditor(set);

    toast("Wersja wybrana. Użyj „Renderuj”, żeby powstała rolka z tymi napisami.");
  } catch (error) {
    toast(error.message, true);
  }
};

/*
 * Odczyt formularza do state.plan (bez przerysowania — żeby nie
 * gubić kursora przy pisaniu) i odświeżenie liczników znaków.
 */
const readCopyForm = (container) => {
  const plan = state.plan;

  const value = (field) =>
    container.querySelector(`[data-field="${field}"]:not([data-scene])`)?.value ?? "";

  plan.hook = value("hook");
  plan.hookHighlight = value("hookHighlight");
  plan.cover = value("cover");

  plan.description.firstLine = value("firstLine");
  plan.description.body = value("body");
  plan.description.hashtags = value("hashtags")
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#+/, ""))
    .filter(Boolean);

  plan.missing = value("missing")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  container.querySelectorAll("[data-scene]").forEach((input) => {
    plan.scenes[Number(input.dataset.scene)][input.dataset.field] = input.value;
  });

  container.querySelectorAll("label").forEach((label) => {
    const field = label.parentElement.querySelector("[data-field]");

    const counterElement = label.querySelector(".counter");

    if (!field || !counterElement) {
      return;
    }

    const limit = LIMITS[field.dataset.field];

    counterElement.textContent = `${field.value.length}/${limit}`;
    counterElement.classList.toggle("over", field.value.length > limit);
  });
};

const saveCopy = async (andRender) => {
  const set = currentSet();

  const plan = state.plan;

  try {
    const saved = await api(`/api/sets/${enc(set.name)}/plan`, {
      method: "PUT",
      body: JSON.stringify(plan),
    });

    state.plan = { ...saved, set: set.name };

    if (andRender) {
      await startRun("render");

      return;
    }

    renderCopyEditor(set);

    $("#copy-status").textContent = "Zapisano";

    toast("Napisy zapisane. Użyj „Zapisz i renderuj”, żeby powstała nowa wersja rolki.");
  } catch (error) {
    toast(error.message, true);
  }
};

/*
 * --- Brief ---------------------------------------------------------
 */

const loadBrief = async () => {
  try {
    const { text } = await api("/api/brief");

    $("#brief-text").value = text;
    $("#brief-status").textContent = "";
  } catch (error) {
    toast(error.message, true);
  }
};

const saveBrief = async () => {
  try {
    await api("/api/brief", {
      method: "PUT",
      body: JSON.stringify({ text: $("#brief-text").value }),
    });

    $("#brief-status").textContent = "Zapisano — działa od następnej rolki";
  } catch (error) {
    toast(error.message, true);
  }
};

/*
 * --- Rysowanie -----------------------------------------------------
 */

const render = () => {
  renderSidebar();

  if (state.view !== "set") {
    return;
  }

  const set = currentSet();

  if (!set) {
    showView("welcome");

    return;
  }

  $("#set-title").textContent = set.name;

  const parts = [
    `${set.photos.length} zdjęć`,
    `${set.videos.length} filmów`,
    set.outputs.length
      ? `${set.outputs.length} ${set.outputs.length === 1 ? "wersja rolki" : "wersje rolki"}`
      : "bez rolki",
  ];

  $("#set-meta").textContent = parts.join(" · ");

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.tab === state.tab),
  );

  document.querySelectorAll(".tab-panel").forEach((panel) =>
    panel.classList.toggle("active", panel.dataset.panel === state.tab),
  );

  renderMaterial(set);
  renderRun(set);
  renderLog();

  if (state.tab === "results") {
    renderResults(set);
  }

  /*
   * Edytor rysujemy tylko przy zmianie zestawu, zakończeniu
   * zadania albo zmianie blokady przycisków — nie przy każdym
   * zdarzeniu, bo zgubiłby wpisywany tekst i kursor.
   */
  const copyContainer = $("#copy-editor");

  const copyKey = `${set.name}|${state.plan ? "plan" : "none"}|${set.hasPlan}|${isRunning()}`;

  if (state.tab === "copy" && copyContainer.dataset.key !== copyKey) {
    copyContainer.dataset.key = copyKey;

    renderCopyEditor(set);
  }
};

/*
 * --- Zdarzenia -----------------------------------------------------
 */

const bindEvents = () => {
  $("#set-list").addEventListener("click", (event) => {
    const item = event.target.closest("[data-set]");

    if (item) {
      selectSet(item.dataset.set);
    }
  });

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => selectTab(tab.dataset.tab)),
  );

  const dialog = $("#new-set-dialog");

  $("#new-set-button").addEventListener("click", () => {
    $("#new-set-name").value = "";
    $("#new-set-error").textContent = "";

    dialog.showModal();
  });

  $("#new-set-form").addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "create") {
      return;
    }

    event.preventDefault();

    try {
      const { name } = await api("/api/sets", {
        method: "POST",
        body: JSON.stringify({ name: $("#new-set-name").value }),
      });

      dialog.close();

      await refreshState();

      selectSet(name, "material");
    } catch (error) {
      $("#new-set-error").textContent = error.message;
    }
  });

  const dropzone = $("#dropzone");

  ["dragenter", "dragover"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();

      dropzone.classList.add("drag");
    }),
  );

  ["dragleave", "drop"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();

      dropzone.classList.remove("drag");
    }),
  );

  dropzone.addEventListener("drop", (event) =>
    uploadFiles(event.dataTransfer.files),
  );

  $("#file-input").addEventListener("change", (event) => {
    uploadFiles(event.target.files);

    event.target.value = "";
  });

  $("#media-grid").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete]");

    if (!button) {
      return;
    }

    const name = button.dataset.delete;

    if (!confirm(`Usunąć „${name}” z zestawu?`)) {
      return;
    }

    try {
      await api(
        `/api/sets/${enc(state.selected)}/files/${enc(name)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      toast(error.message, true);
    }
  });

  $("#run-full").addEventListener("click", () => startRun("full"));
  $("#run-render").addEventListener("click", () => startRun("render"));

  $("#brief-button").addEventListener("click", () => {
    state.selected = null;

    showView("brief");
    renderSidebar();
    loadBrief();
  });

  $("#brief-save").addEventListener("click", saveBrief);
  $("#brief-reload").addEventListener("click", loadBrief);
};

const refreshState = async () => {
  const data = await api("/api/state");

  state.sets = data.sets;
  state.job = data.job;
  state.log = data.log;
};

const connectEvents = () => {
  const events = new EventSource("/api/events");

  events.addEventListener("sets", (event) => {
    state.sets = JSON.parse(event.data);

    render();
  });

  events.addEventListener("job", (event) => {
    const job = JSON.parse(event.data);

    const finished =
      state.job?.status === "running" &&
      job.id === state.job.id &&
      job.status !== "running";

    if (job.id !== state.job?.id) {
      state.log = [];
    }

    state.job = job;

    if (finished) {
      state.plan = null;

      toast(
        job.status === "done"
          ? `Gotowe: ${job.set} — rolka w zakładce Wyniki`
          : `Błąd generowania: ${job.set}`,
        job.status !== "done",
      );
    }

    render();
  });

  events.addEventListener("log", (event) => {
    const { id, line } = JSON.parse(event.data);

    if (state.job && id !== state.job.id) {
      return;
    }

    state.log.push(line);

    if (state.log.length > 3000) {
      state.log.splice(0, state.log.length - 3000);
    }

    if (state.view === "set" && state.tab === "run") {
      renderLog();
    }
  });
};

const init = async () => {
  bindEvents();

  try {
    await refreshState();
  } catch (error) {
    toast(`Nie udało się połączyć z panelem: ${error.message}`, true);
  }

  if (isRunning()) {
    selectSet(state.job.set, "run");
  } else {
    render();
  }

  connectEvents();

  setInterval(updateTimer, 1000);
};

init();
