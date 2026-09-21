// indexer.js — построение смыслового индекса по библиотеке.
//
// Один проход: взять ролик, снять кадры, перевести кадры в числа, отправить их
// на сервер. Попутно закрывается и вопрос миниатюр — кадр всё равно снят,
// и если картинки для этого ролика ещё нет, она тут же и появляется.
//
// Кадров пять, а не один. Коуб — это десять секунд, и за них успевает
// смениться сцена; первым кадром запросто оказывается затемнение, заставка
// или чёрный переход, и ролик про мотоциклы уходит в индекс как «темнота».
// Пять кадров по всей длине описывают ролик целиком, а близость к запросу
// потом считается по лучшему из них.
//
// Узкое место — не модель, а декодирование видео: файл надо прочитать с диска
// и перемотать. Поэтому ролики готовятся пачками параллельно, а считаются по
// одному: видеокарта всё равно обрабатывает их по очереди, и держать её
// занятой — единственное, что здесь важно. Пять кадров одного ролика при этом
// уезжают в модель одним вызовом и обходятся куда дешевле пяти отдельных.
//
// Прерывать можно в любой момент: посчитанное уже лежит на сервере, а очередь
// каждый раз берётся заново — «кому кадров не хватает». Поэтому продолжение
// с середины получается само, без запоминания места.

import { DIM, MODEL_TAG, embedFrames, hasWebGPU, loadVision } from "./semantic.js";
import { captureThumb, primeThumbs } from "./thumbs.js";
import { getCoubList } from "./api.js";
import { showToast } from "./ui.js";

/** Сколько роликов готовится одновременно. Больше — очередь к видеокарте, а не ускорение. */
const DECODE_AHEAD = 4;

/**
 * Где снимать кадры. Первое число — секунды от начала, остальные — доли
 * длины ролика.
 *
 * Начало задано секундами, а не долей, намеренно: этот же кадр уходит в
 * миниатюру, а её в плитке и баннерах снимают ровно на 0.1 с. Менять
 * привычную картинку ради индекса незачем.
 *
 * Остальные доли добирают то, чего начало не показывает. До самого конца не
 * дотягиваемся: последние кадры часто уже затемнение.
 */
const FIRST_AT_S = 0.1;
const SEEK_AT = [0.25, 0.45, 0.65, 0.85];

/** Сколько векторов на ролик кладётся в базу. */
const FRAMES = 1 + SEEK_AT.length;

/** Сколько ждать кадры одного ролика, прежде чем брать что успели. */
const FRAME_TIMEOUT_MS = 15000;

/** Сторона квадрата, в который вписывается кадр перед моделью. */
const FRAME_SIZE = 256;

/**
 * Сколько секунд уходит на ролик — только чтобы назвать срок перед началом.
 * Числа с замеров на живой библиотеке, а не расчётные: перемотка и чтение
 * файла стоят дороже самой модели, и «пять кадров» вовсе не значит «впятеро».
 */
const PER_COUB_GPU_S = 0.12;
const PER_COUB_CPU_S = 1.2;

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
        perCoubMs: null,
        error: null,
        finished: false,
    };

    const tick = () => onProgress?.({ ..._state });
    tick();

    try {
        // Файлы модели уже на диске, рядом с библиотекой (см. ensureModel) —
        // здесь только поднять её в память
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

        const status = await fetchJson(`/api/embeddings/status?frames=${FRAMES}`);
        _state.total = status.pending;
        _state.phase = "work";
        tick();

        const started = performance.now();
        let handled = 0;

        while (!_stop) {
            const { ids } = await fetchJson(
                `/api/embeddings/pending?limit=200&frames=${FRAMES}`);
            const queue = ids.filter((id) => !_broken.has(id));
            if (!queue.length) break;

            for (let i = 0; i < queue.length && !_stop; i += DECODE_AHEAD) {
                const chunk = queue.slice(i, i + DECODE_AHEAD);

                // Готовим кадры параллельно — это ожидание диска, а не работа
                const shots = await Promise.all(
                    chunk.map((id) => grabFrames(id, videos.get(id)))
                );

                const batch = [];
                for (const shot of shots) {
                    if (_stop) break;

                    // Ни одного кадра — ролик в безнадёжные. Без этого он
                    // остаётся без векторов, очередь выдаёт его снова, и проход
                    // ходит по кругу, накручивая счётчик неудач
                    if (!shot.canvases.length) {
                        giveUp(shot.id, "кадры не сняли");
                        continue;
                    }

                    try {
                        const vectors = await embedFrames(shot.canvases);

                        // Кадров вышло меньше — добираем последним. Держать у
                        // всех одинаковое число проще, чем объяснять очереди,
                        // что этому ролику больше и не снять: на поиск
                        // повторы не влияют, максимум из одинаковых — то же
                        // самое число
                        while (vectors.length < FRAMES) vectors.push(vectors.at(-1));

                        batch.push({
                            id: shot.id,
                            vectors: vectors.map((v) => Array.from(v)),
                        });
                        handled++;
                    } catch (err) {
                        giveUp(shot.id, String(err?.message || err));
                    } finally {
                        shot.release();
                    }
                }

                if (batch.length) {
                    // Считаем по ответу сервера, а не по размеру пачки: записи
                    // ролика могло уже не быть, и тогда векторы никуда не легли
                    const { saved } = await upload(batch);
                    _state.done += saved ?? batch.length;
                }

                _state.perCoubMs = handled ? Math.round((performance.now() - started) / handled) : null;
                tick();

                // Отдаём кадр интерфейсу: без этого страница стоит колом
                // весь проход
                await pause();
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
 * Снимает кадры ролика: ставим currentTime, ждём seeked, рисуем в canvas.
 *
 * Все кадры берутся одинаково — перемоткой, включая самый первый. Соблазн
 * снять его сразу по loadeddata, а перематывать только за остальными, стоит
 * обойти: фрагмент вроде #t=0.1 сам по себе перемотка, и его seeked приходит
 * вперемешку с нашими. На замерах это давало шесть кадров вместо пяти, причём
 * два одинаковых. Одна дорога до кадра — одно событие, и путаться нечему.
 *
 * В ответе всегда есть id, а canvases пуст, если не сняли ничего: битый файл,
 * отсутствующий файл или слишком долгое чтение. Один такой ролик не повод
 * останавливать проход — но забывать про него нельзя, иначе очередь выдаст
 * его снова.
 */
function grabFrames(id, url) {
    // Ответ всегда с id — иначе про неудачу известно только то, что она была,
    // и такой ролик невозможно отличить от ещё не разобранного
    if (!url) return Promise.resolve({ id, canvases: [], release() {} });

    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";

        const canvases = [];
        let times = null;
        let at = 0;
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeAttribute("src");
            video.load();
            resolve({
                id,
                canvases,
                release: () => { for (const c of canvases) c.width = c.height = 0; },
            });
        };

        // Время на все кадры разом. Успели меньше — берём что есть: неполный
        // набор всё равно лучше, чем ничего
        const timer = setTimeout(finish, FRAME_TIMEOUT_MS);

        const capture = () => {
            if (!video.videoWidth) return;

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

            canvases.push(canvas);

            // Первый кадр уже под рукой — заодно закрываем и миниатюру,
            // если её нет
            if (canvases.length === 1) captureThumb(video, id);
        };

        const seekNext = () => {
            // times ещё нет — значит seeked пришло раньше loadedmetadata, чего
            // мы не просили. Так падал первый вариант с фрагментом #t=0.1:
            // браузер перематывал сам, событие приходило до готовности, и
            // обработчик спотыкался о пустой список
            if (settled || !times) return;
            if (at >= times.length) return finish();
            video.currentTime = times[at++];
        };

        video.addEventListener("error", finish);

        video.addEventListener("loadedmetadata", () => {
            if (settled || times) return; // событие может прийти и повторно
            // Картинки нет вовсе — перематывать незачем
            if (!video.videoWidth) return finish();

            // Длительности может не быть у битого файла — тогда доли считать
            // не от чего, и остаётся только начало
            const length = video.duration;
            times = Number.isFinite(length) && length > 0
                ? [FIRST_AT_S, ...SEEK_AT.map((share) => share * length)]
                : [FIRST_AT_S];

            seekNext();
        });

        video.addEventListener("seeked", () => {
            if (settled) return;
            capture();
            seekNext();
        });

        video.src = url;
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

        const status = await (await fetch(
            `/api/embeddings/status?frames=${FRAMES}`)).json();

        if (!status.pending) {
            showToast("✓ Кадры разобраны у всех роликов");
            return;
        }

        // Без видеокарты считать будет процессор — те же кадры, но в разы
        // дольше. Лучше сказать заранее, чем оставить человека с зависшим
        // на час плеером
        const gpu = await hasWebGPU();
        const минут = Math.max(1, Math.round((status.pending * (gpu ? PER_COUB_GPU_S : PER_COUB_CPU_S)) / 60));

        // Разобранные прошлой версией индекса — это не «ещё не начинали».
        // Человек помнит, что проход уже делал, и «разобрать 8716 роликов»
        // выглядело бы так, будто прошлая работа пропала
        const доснять = status.indexed - status.full;
        const что = доснять > 0
            ? `Доснять кадры ${status.pending} роликов?\n\n` +
              `У ${доснять} из них кадров меньше, чем нужно: индекс собирали, ` +
              `когда с ролика брали не столько. Теперь их ${FRAMES} — по всей ` +
              `длине ролика, и поиск от этого заметно точнее.`
            : `Разобрать кадры ${status.pending} роликов?\n\n` +
              `С каждого берётся ${FRAMES} кадров по всей длине ролика.`;

        const согласен = confirm(
            `${что}\n\n` +
            `Займёт около ${минут} мин${gpu ? "" : " — видеокарта недоступна, считать будет процессор"}.\n\n` +
            `Первый запуск скачает модель (около 50 МБ) — она ляжет рядом ` +
            `с библиотекой и больше не понадобится.\n\n` +
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

    if (s.perCoubMs && handled < s.total && !s.finished) {
        const left = Math.round(((s.total - handled) * s.perCoubMs) / 1000);
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
