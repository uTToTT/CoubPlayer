// indexer.js — построение смыслового индекса по библиотеке.
//
// Один проход: взять ролик, снять кадр, перевести кадр в числа, отправить их
// на сервер. Попутно закрывается и вопрос миниатюр — кадр всё равно снят,
// и если картинки для этого ролика ещё нет, она тут же и появляется.
//
// Узкое место — не модель, а декодирование видео: файл надо прочитать с диска
// и дойти до первого кадра. Поэтому ролики готовятся пачками параллельно,
// а считаются по одному: видеокарта всё равно обрабатывает их по очереди,
// и держать её занятой — единственное, что здесь важно.
//
// Прерывать можно в любой момент: посчитанное уже лежит на сервере, а очередь
// каждый раз берётся заново — «что ещё без вектора». Поэтому продолжение
// с середины получается само, без запоминания места.

import { DIM, MODEL_TAG, embedFrame, hasWebGPU, loadVision } from "./semantic.js";
import { captureThumb, primeThumbs } from "./thumbs.js";
import { getCoubList } from "./api.js";
import { showToast } from "./ui.js";

/** Сколько роликов готовится одновременно. Больше — очередь к видеокарте, а не ускорение. */
const DECODE_AHEAD = 4;

/** По сколько векторов отправлять за раз. */
const UPLOAD_BATCH = 32;

/** Сколько ждать кадр, прежде чем счесть ролик безнадёжным. */
const FRAME_TIMEOUT_MS = 15000;

/** Сторона квадрата, в который вписывается кадр перед моделью. */
const FRAME_SIZE = 256;

let _running = false;
let _stop = false;
let _state = null;

/**
 * Ролики, на которых споткнулись в этом сеансе, и чем именно.
 *
 * Без этого списка проход зацикливается: ролик без вектора очередь выдаёт
 * снова и снова, потому что «ещё не разобран» — это ровно его состояние.
 * Набор живёт до перезагрузки страницы: файл могли вернуть на место, и
 * при следующем запуске такой ролик заслуживает второй попытки.
 */
const _broken = new Map();

function giveUp(id, reason) {
    if (!_broken.has(id)) {
        _broken.set(id, reason);
        _state.failed++;
    }
    console.warn("[Индекс] пропущен", id, "—", reason);
}

/** Ролики, которые не дались, и причина у каждого. */
export function brokenCoubs() {
    return [..._broken].map(([id, reason]) => ({ id, reason }));
}

export function isIndexing() {
    return _running;
}

export function indexerState() {
    return _state ? { ..._state } : null;
}

export function stopIndexing() {
    if (_running) _stop = true;
}

/**
 * Строит индекс, пока не кончится очередь или не попросят остановиться.
 *
 * @param {object} options
 * @param {(state: object) => void} [options.onProgress] зовётся после каждой пачки
 */
export async function startIndexing({ onProgress } = {}) {
    if (_running) return _state;

    _running = true;
    _stop = false;
    _state = {
        phase: "model",
        done: 0,
        failed: 0,
        total: 0,
        perFrameMs: null,
        error: null,
        finished: false,
    };

    const tick = () => onProgress?.({ ..._state });
    tick();

    try {
        // Модель качается один раз и дальше живёт в кэше браузера
        await loadVision((p) => {
            _state.phase = "model";
            _state.model = `${p.file} ${Math.round(p.progress)}%`;
            tick();
        });
        delete _state.model;

        // Ссылки на файлы роликов: очередь приходит одними id
        const videos = new Map((await getCoubList()).map((c) => [c.id, c.video]));
        // Список готовых миниатюр — чтобы не слать те, что уже есть
        await primeThumbs();

        const status = await fetchJson("/api/embeddings/status");
        _state.total = status.pending;
        _state.phase = "work";
        tick();

        const started = performance.now();
        let handled = 0;

        while (!_stop) {
            const { ids } = await fetchJson("/api/embeddings/pending?limit=200");
            const queue = ids.filter((id) => !_broken.has(id));
            if (!queue.length) break;

            for (let i = 0; i < queue.length && !_stop; i += DECODE_AHEAD) {
                const chunk = queue.slice(i, i + DECODE_AHEAD);

                // Готовим кадры параллельно — это ожидание диска, а не работа
                const frames = await Promise.all(
                    chunk.map((id) => grabFrame(id, videos.get(id)))
                );

                const batch = [];
                for (const frame of frames) {
                    if (_stop) break;

                    // Кадр не дался — ролик в безнадёжные. Без этого он
                    // остаётся без вектора, очередь выдаёт его снова, и проход
                    // ходит по кругу, накручивая счётчик неудач
                    if (!frame.canvas) {
                        giveUp(frame.id, "кадр не сняли");
                        continue;
                    }

                    try {
                        const vector = await embedFrame(frame.canvas);
                        batch.push({ id: frame.id, vector: Array.from(vector) });
                        handled++;
                    } catch (err) {
                        giveUp(frame.id, String(err?.message || err));
                    } finally {
                        frame.release();
                    }
                }

                if (batch.length) {
                    // Считаем по ответу сервера, а не по размеру пачки: записи
                    // ролика могло уже не быть, и тогда вектор никуда не лёг
                    const { saved } = await upload(batch);
                    _state.done += saved ?? batch.length;
                }

                _state.perFrameMs = handled ? Math.round((performance.now() - started) / handled) : null;
                tick();

                if (batch.length >= UPLOAD_BATCH) await pause();
            }
        }

        _state.phase = _stop ? "stopped" : "done";
    } catch (err) {
        _state.phase = "error";
        _state.error = String(err?.message || err);
    } finally {
        _state.finished = true;
        _running = false;
        _stop = false;
        tick();
    }

    return { ..._state };
}

/**
 * Снимает первый кадр ролика.
 *
 * Фрагмент #t=0.1 заставляет браузер дойти до кадра, не начиная
 * воспроизведение, — тот же приём, что в плитке и баннерах.
 *
 * В ответе всегда есть id, а canvas равен null, если кадра не дождались:
 * битый файл, отсутствующий файл или слишком долгое чтение. Один такой ролик
 * не повод останавливать проход — но забывать про него нельзя, иначе очередь
 * выдаст его снова.
 */
function grabFrame(id, url) {
    // Ответ всегда с id — иначе про неудачу известно только то, что она была,
    // и такой ролик невозможно отличить от ещё не разобранного
    if (!url) return Promise.resolve({ id, canvas: null });

    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeAttribute("src");
            video.load();
            resolve(value);
        };

        const timer = setTimeout(() => finish({ id, canvas: null }), FRAME_TIMEOUT_MS);

        video.addEventListener("error", () => finish({ id, canvas: null }));
        video.addEventListener("loadeddata", () => {
            if (!video.videoWidth) return finish({ id, canvas: null });

            const canvas = document.createElement("canvas");
            canvas.width = FRAME_SIZE;
            canvas.height = FRAME_SIZE;
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingQuality = "high";

            // Обрезаем по центру, а не сплющиваем: вертикальный ролик,
            // втиснутый в квадрат, для модели выглядит другим сюжетом
            const side = Math.min(video.videoWidth, video.videoHeight);
            ctx.drawImage(
                video,
                (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
                0, 0, FRAME_SIZE, FRAME_SIZE
            );

            // Кадр уже под рукой — заодно закрываем и миниатюру, если её нет
            captureThumb(video, id);

            finish({ id, canvas, release: () => { canvas.width = canvas.height = 0; } });
        });

        video.src = url + "#t=0.1";
    });
}

async function upload(items) {
    const res = await fetch("/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL_TAG, dim: DIM, items }),
    });

    if (res.status === 409) {
        // Индекс строили другой моделью. Дописывать поверх нельзя —
        // останавливаемся и объясняем, а не портим таблицу
        throw new Error(await res.text());
    }
    if (!res.ok) throw new Error(`Сервер не принял пачку: ${res.status}`);

    return res.json();
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
}

/** Отдаём кадр интерфейсу: без этого страница стоит колом весь проход. */
function pause() {
    return new Promise((r) => setTimeout(r, 0));
}

// ─── Панель ─────────────────────────────────────────────────────────────────
// Та же, что у сбора сведений (стили restore-*): обе задачи — долгий проход
// с прогрессом и остановкой, и выглядеть они должны одинаково.

let _panel = null;

export function initSemanticIndex() {
    document.getElementById("buildIndexBtn")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        await handleClick(e.currentTarget);
    });
}

async function handleClick(button) {
    if (_running) { ensurePanel(); return; }

    button.disabled = true;
    try {
        // Без файлов модели считать нечем — сперва они
        if (!(await ensureModel())) return;

        const status = await (await fetch("/api/embeddings/status")).json();

        if (!status.pending) {
            showToast("✓ Кадры разобраны у всех роликов");
            return;
        }

        // Без видеокарты считать будет процессор — те же кадры, но в разы
        // дольше. Лучше сказать заранее, чем оставить человека с зависшим
        // на час плеером
        const gpu = await hasWebGPU();
        const минут = Math.max(1, Math.round((status.pending * (gpu ? 0.05 : 0.5)) / 60));

        const согласен = confirm(
            `Разобрать кадры ${status.pending} роликов?\n\n` +
            `Займёт около ${минут} мин${gpu ? "" : " — видеокарта недоступна, считать будет процессор"}.\n\n` +
            `Первый запуск скачает модель (около 50 МБ), дальше она берётся ` +
            `из кэша браузера.\n\n` +
            `Файлы и плейлисты не изменятся. Заодно появятся недостающие ` +
            `картинки для режима плитки.`
        );
        if (!согласен) return;

        ensurePanel();
        startIndexing({ onProgress: render });
    } catch (err) {
        showToast("⚠ " + (err.message || "Не удалось начать"));
    } finally {
        button.disabled = false;
    }
}

// ─── Файлы модели ───────────────────────────────────────────────────────────
// Качает их сервер, а не браузер, и кладёт рядом с библиотекой. Причина
// простая: браузер такое хранение не тянет — файл в 270 МБ в его кэш не
// попадает вовсе, а что попадает, он вправе вычистить под нехватку места.
// Зато после этой загрузки смысловой поиск работает и без интернета.

const MODEL_POLL_MS = 700;

/**
 * Убеждается, что файлы модели на месте; если нет — спрашивает и качает.
 * @returns {Promise<boolean>} можно ли продолжать
 */
async function ensureModel() {
    const status = await (await fetch("/api/models/status")).json();
    if (status.complete) return true;

    const мб = Math.round(status.bytes / 1024 / 1024);
    const согласен = confirm(
        `Для смыслового поиска нужно скачать модель — ${мб} МБ.\n\n` +
        `Она ляжет рядом с библиотекой, в Data/models, и качается один раз: ` +
        `дальше поиск работает даже без интернета.\n\n` +
        `Скачать сейчас?`
    );
    if (!согласен) return false;

    ensurePanel();
    renderModel({ running: true, doneBytes: 0, totalBytes: status.bytes });

    await fetch("/api/models/download", { method: "POST" });

    // Качает сервер, поэтому спрашиваем его, а не следим сами
    for (;;) {
        await new Promise((r) => setTimeout(r, MODEL_POLL_MS));
        const p = await (await fetch("/api/models/progress")).json();
        renderModel(p);

        if (p.error) { showToast("⚠ " + p.error); return false; }
        if (p.stopped) return false;
        if (p.finished) return true;
    }
}

function renderModel(p) {
    if (!_panel) return;

    _panel.querySelector(".restore-title").textContent = "Качаю модель";
    const мб = (b) => Math.round(b / 1024 / 1024);

    _panel.querySelector(".restore-progress").textContent =
        `${мб(p.doneBytes)} из ${мб(p.totalBytes)} МБ`;
    _panel.querySelector(".restore-eta").textContent = p.current || "";
    _panel.querySelector(".restore-bar").style.width =
        p.totalBytes ? `${(p.doneBytes / p.totalBytes) * 100}%` : "0%";

    const stop = _panel.querySelector(".restore-stop");
    stop.onclick = async () => {
        stop.disabled = true;
        await fetch("/api/models/stop", { method: "POST" });
    };

    if (p.finished) {
        _panel.querySelector(".restore-title").textContent = "Разбираю кадры";
        stop.disabled = false;
        stop.onclick = null;
    }
}

function ensurePanel() {
    if (_panel) return _panel;

    _panel = document.createElement("div");
    _panel.className = "restore-panel";
    _panel.innerHTML = `
        <div class="restore-head">
            <span class="restore-title">Разбираю кадры</span>
            <button class="restore-hide" type="button" title="Свернуть — разбор продолжится">✕</button>
        </div>
        <div class="restore-counts">
            <span class="restore-progress">…</span>
            <span class="restore-eta"></span>
        </div>
        <div class="restore-track"><div class="restore-bar"></div></div>
        <div class="restore-foot">
            <span class="restore-note"></span>
            <button class="restore-stop" type="button">Стоп</button>
        </div>`;

    _panel.querySelector(".restore-hide").addEventListener("click", () => {
        _panel.remove();
        _panel = null;
        // Разбор не останавливаем: он идёт в этой же вкладке и переживёт
        // закрытие панели. Остановить — отдельная кнопка
    });

    _panel.querySelector(".restore-stop").addEventListener("click", (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = "Останавливаю…";
        stopIndexing();
    });

    document.body.appendChild(_panel);
    return _panel;
}

function render(s) {
    if (!_panel) return;

    const progress = _panel.querySelector(".restore-progress");
    const eta = _panel.querySelector(".restore-eta");
    const bar = _panel.querySelector(".restore-bar");
    const note = _panel.querySelector(".restore-note");
    const stop = _panel.querySelector(".restore-stop");

    if (s.phase === "model") {
        progress.textContent = "Загружаю модель";
        eta.textContent = s.model || "";
        bar.style.width = "0%";
        return;
    }

    const handled = s.done + s.failed;
    progress.textContent = `${handled} из ${s.total}`;
    bar.style.width = s.total ? `${(handled / s.total) * 100}%` : "0%";

    if (s.perFrameMs && handled < s.total && !s.finished) {
        const left = Math.round(((s.total - handled) * s.perFrameMs) / 1000);
        eta.textContent = left > 90 ? `осталось ~${Math.round(left / 60)} мин` : `осталось ~${left} с`;
    } else {
        eta.textContent = "";
    }

    // «Не вышло» — это ролики, у которых не удалось прочитать кадр: файла нет
    // на диске или он битый. Каждый считается один раз, и второй попытки
    // в этом проходе не будет
    note.textContent = s.failed ? `не читается файлов: ${s.failed}` : "";
    note.title = s.failed
        ? "Скорее всего, файлы пропали. Их умеет вернуть «Вернуть пропавшие»"
        : "";

    if (s.finished) {
        stop.hidden = true;
        eta.textContent = "";
        progress.textContent =
            s.phase === "error" ? (s.error || "Ошибка")
                : s.phase === "stopped" ? `Остановлено на ${handled} из ${s.total}`
                    : `Готово: ${s.done}`;
    }
}
