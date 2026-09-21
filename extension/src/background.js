// background.js
// Service worker: единственное место, откуда расширение ходит и на coub.com,
// и на localhost. Content script так не может — его fetch подчиняется CORS
// самой страницы coub.com, и запрос к localhost она не пропустит.

import { MSG } from "./messages.js";
import {
    collectPermalinks,
    fetchCoubMeta,
    inspectCookies,
    pageRequests,
    permalinkFromUrl,
    probe,
    resetTransport,
} from "./coub-api.js";
import * as local from "./local-api.js";
import { downloadInBrowser } from "./transfer.js";

// ─── Состояние текущей долгой операции ──────────────────────────────────────
// Попап может быть закрыт в любой момент, поэтому ход выполнения держим здесь,
// а не в нём: открывшись заново, он спросит и покажет актуальное.

let _job = null; // { category, phase, page, totalPages, collected, queued, done, failed, error }

// Флаг остановки и способ прервать ожидание ответа сервера
let _stop = { requested: false, controller: new AbortController() };

// Сервер качает пачку последовательно и отвечает одним ответом в конце.
// Размер — компромисс: чем меньше пачка, тем чаще двигается прогресс и тем
// быстрее срабатывает «Стоп», но тем больше обращений к серверу.
const CHUNK = 5;

function setJob(patch) {
    _job = { ..._job, ...patch };
    // Попап может быть закрыт — тогда сообщение просто некому принять
    chrome.runtime.sendMessage({ type: MSG.PROGRESS, job: _job }).catch(() => { });
}

// ─── Операции ───────────────────────────────────────────────────────────────

/**
 * Скачать один куб — то, что дёргает кнопка на плеере.
 *
 * Проверять library перед запросом нельзя: ролик может быть уже скачан, но
 * лежать в другом плейлисте, а пользователь выбрал в меню этот. Сервер сам
 * не перекачивает то, что есть на диске, и просто добавляет запись.
 */
async function downloadOne({ permalink, playlist }) {
    const id = permalinkFromUrl(permalink);
    if (!id) throw new Error("Не разобрал ссылку на куб");

    const target = playlist || (await resolveDefaultPlaylist());

    const result = (await local.isBrowserTransfer())
        ? await downloadInBrowser(target, id)
        : (await local.download(target, [id]))[0];

    if (result && !result.success) throw new Error(result.error || "Не удалось скачать куб");

    // В библиотеке прибавилось — метки «уже скачан» на страницах устарели
    forgetLibrary();

    // Выбор запоминаем: в следующий раз он будет первым кандидатом
    if (playlist) await chrome.storage.local.set({ defaultPlaylist: playlist });

    return { id, alreadyExisted: !!result?.alreadyExisted, playlist: target };
}

// ─── Что уже скачано ────────────────────────────────────────────────────────
// Библиотека на восемь тысяч роликов — это сотня килобайт id, и спрашивать её
// на каждую карточку ленты незачем: список меняется только когда что-то
// скачали. Держим здесь, отдаём страницам ответ на их вопрос «а эти — есть?».

const LIBRARY_TTL_MS = 60_000;

let _library = { ids: null, at: 0 };

function forgetLibrary() {
    _library = { ids: null, at: 0 };
}

async function libraryIds() {
    const fresh = _library.ids && Date.now() - _library.at < LIBRARY_TTL_MS;
    if (!fresh) {
        _library = { ids: await local.getLibrary(), at: Date.now() };
    }
    return _library.ids;
}

/**
 * Какие из присланных роликов уже в библиотеке.
 *
 * Страница спрашивает про то, что у неё на экране, и получает короткий ответ:
 * гонять весь список id туда-обратно ради десятка карточек — впустую.
 */
async function libraryHas({ ids } = {}) {
    if (!Array.isArray(ids) || !ids.length) return { have: [] };
    const library = await libraryIds();
    return { have: ids.filter((id) => library.has(id)) };
}

// ─── Куда просится ролик ────────────────────────────────────────────────────

/**
 * Подсказки для ролика, открытого на coub.com.
 *
 * Сервер считает их по коубовским тегам. У скачанного ролика теги уже есть,
 * у остального — нет, и тогда сервер просит метаданные: их мы забираем
 * со страницы и спрашиваем второй раз. Лишний поход в сеть только там,
 * где без него никак.
 */
async function suggestFor({ permalink } = {}) {
    const id = permalinkFromUrl(permalink);
    if (!id) throw new Error("Не разобрал ссылку на куб");

    const first = await local.suggest(id);
    if (!first.needsMeta) return first;

    const meta = await fetchCoubMeta(id);
    return local.suggest(id, meta);
}

/** Плейлисты для меню кнопки — со списком групп и последним выбором. */
async function playlistsFor({ permalink } = {}) {
    const id = permalink ? permalinkFromUrl(permalink) : null;
    const [data, { defaultPlaylist }, base] = await Promise.all([
        local.getPlaylists(id),
        chrome.storage.local.get("defaultPlaylist"),
        local.getBaseUrl(),
    ]);
    return {
        // Сервер отдаёт путь от своего корня, а картинку будет грузить
        // страница coub.com — ей нужен полный адрес
        playlists: (data.playlists || []).map((pl) => ({
            ...pl,
            banner: pl.banner ? base + pl.banner : null,
        })),
        groupOrder: data.groupOrder || [],
        recent: defaultPlaylist || null,
    };
}

/** Заводит плейлист из меню кнопки и сразу делает его выбором по умолчанию. */
async function createPlaylist(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) throw new Error("Пустое название");

    await local.createPlaylist(trimmed);
    await chrome.storage.local.set({ defaultPlaylist: trimmed });
    return { name: trimmed };
}

/** Куда класть одиночный куб, если пользователь не выбрал плейлист. */
async function resolveDefaultPlaylist() {
    const { defaultPlaylist } = await chrome.storage.local.get("defaultPlaylist");
    if (defaultPlaylist) return defaultPlaylist;

    const { playlists } = await local.ping();
    return playlists[0] || "Все";
}

/**
 * Догрузить ленту: собрать permalink'и, вычесть уже скачанное,
 * остаток отдать серверу.
 *
 * @param {object} params
 * @param {"liked"|"bookmarks"} params.category
 * @param {"new"|"all"} [params.mode] "new" — идти по ленте, пока не пошло
 *        уже скачанное; "all" — пройти её целиком
 * @param {number} [params.limit] потолок на число собранных ссылок; -1 — без него
 */
async function sync({ category, mode = "new", limit = -1 }) {
    if (_job && !_job.finished) throw new Error("Загрузка уже идёт");

    _stop = { requested: false, controller: new AbortController() };

    setJob({
        category,
        phase: "collect",
        page: 0,
        totalPages: null,
        collected: 0,
        queued: 0,
        done: 0,
        failed: 0,
        // Для оценки времени: попап сам считает скорость по этим двум числам
        // и тикает обратный отсчёт, не дожидаясь следующей пачки
        downloadStartedAt: null,
        finished: false,
        stoppedByUser: false,
        error: null,
    });

    try {
        await local.ensurePlaylist(category);
        // Сверяемся с самим плейлистом, а не со всей библиотекой: ролик мог
        // быть скачан в другой плейлист, но здесь его всё равно не хватает
        const library = await local.getLibrary(category);

        const { permalinks, stopped } = await collectPermalinks(category, {
            limit,
            onPage: ({ page, totalPages, collected }) =>
                setJob({ page, totalPages, collected }),
            // В режиме «только новое» обрываем обход на первой странице,
            // где всё уже скачано: дальше по ленте лежит то же самое
            stopWhen:
                mode === "new"
                    ? (pagePermalinks) =>
                        pagePermalinks.length > 0 &&
                        pagePermalinks.every((p) => library.has(p))
                    : undefined,
            shouldStop: () => _stop.requested,
        });

        if (_stop.requested) return finishJob({ stoppedByUser: true });

        const missing = permalinks.filter((p) => !library.has(p));
        setJob({
            phase: "download",
            queued: missing.length,
            stoppedEarly: stopped,
            downloadStartedAt: Date.now(),
        });

        if (!missing.length) return finishJob();

        let done = 0;
        let failed = 0;

        // Качая браузером, идём по одному: пачка здесь всё равно разложилась
        // бы в последовательные загрузки, а так прогресс двигается на каждой
        const viaBrowser = await local.isBrowserTransfer();
        const step = viaBrowser ? 1 : CHUNK;

        for (let i = 0; i < missing.length; i += step) {
            if (_stop.requested) return finishJob({ stoppedByUser: true });

            const chunk = missing.slice(i, i + step);
            let results;
            try {
                // Порядок всей ленты идёт с каждой пачкой: по нему сервер
                // ставит ролик на своё место среди уже лежащих в плейлисте
                results = viaBrowser
                    ? [await downloadInBrowser(category, chunk[0], {
                        order: permalinks,
                        signal: _stop.controller.signal,
                    })]
                    : await local.download(category, chunk, {
                        order: permalinks,
                        signal: _stop.controller.signal,
                    });
            } catch (err) {
                // Прервали вручную: сервер текущую пачку всё равно докачает,
                // просто её итог до нас уже не дойдёт
                if (err instanceof local.AbortedError || err?.name === "AbortError") {
                    return finishJob({ stoppedByUser: true });
                }
                throw err;
            }

            for (const r of results) {
                if (r.success) done++;
                else failed++;
            }
            setJob({ done, failed });
        }

        return finishJob();
    } catch (err) {
        setJob({ phase: "error", finished: true, error: String(err.message || err) });
        throw err;
    }
}

/**
 * Выравнивает порядок плейлиста по ленте.
 *
 * Ничего не качает: проходит ленту целиком, чтобы узнать настоящий порядок,
 * и отдаёт его серверу. Поэтому идёт заметно быстрее догрузки — работа тут
 * только в обходе страниц.
 *
 * @param {object} params
 * @param {"liked"|"bookmarks"} params.category
 */
async function align({ category }) {
    if (_job && !_job.finished) throw new Error("Загрузка уже идёт");

    _stop = { requested: false, controller: new AbortController() };

    setJob({
        category,
        phase: "collect",
        page: 0,
        totalPages: null,
        collected: 0,
        queued: 0,
        done: 0,
        failed: 0,
        downloadStartedAt: null,
        finished: false,
        stoppedByUser: false,
        error: null,
    });

    try {
        const { permalinks } = await collectPermalinks(category, {
            limit: -1,
            onPage: ({ page, totalPages, collected }) => setJob({ page, totalPages, collected }),
            shouldStop: () => _stop.requested,
        });

        if (_stop.requested) return finishJob({ stoppedByUser: true });

        // Половина ленты — это половина порядка, и перестановка по ней
        // перемешала бы плейлист сильнее, чем он был. Лучше ничего
        if (!permalinks.length) throw new Error("Лента пустая — выравнивать не по чему");

        setJob({ phase: "align", queued: permalinks.length });
        const { matched, extra } = await local.alignToFeed(category, permalinks);

        return finishJob({ done: matched, aligned: true, extra });
    } catch (err) {
        setJob({ phase: "error", finished: true, error: String(err.message || err) });
        throw err;
    }
}

function finishJob(patch = {}) {
    // Догрузка ленты пополнила библиотеку — прежний список id больше не верен
    forgetLibrary();
    setJob({ phase: "done", finished: true, ...patch });
    return { ..._job };
}

/**
 * Останавливает текущую загрузку. Обход ленты обрывается на ближайшей
 * странице, а ожидание ответа сервера — сразу; пачку, которая уже у него
 * в работе, он докачает до конца, и это не потеря: всё скачанное попадает
 * в плейлист независимо от того, дождались мы ответа или нет.
 */
function stopJob() {
    if (!_job || _job.finished) return { stopped: false };

    _stop.requested = true;
    _stop.controller.abort();
    setJob({ stopping: true });
    return { stopped: true };
}

// ─── Маршрутизация сообщений ────────────────────────────────────────────────

const HANDLERS = {
    [MSG.PING]: () => local.ping(),
    [MSG.COOKIES]: () => inspectCookies(),
    [MSG.PROBE]: () => probe(),
    [MSG.PAGE_REQUESTS]: () => pageRequests(),
    [MSG.DOWNLOAD_ONE]: (payload) => downloadOne(payload),
    [MSG.PLAYLISTS]: (payload) => playlistsFor(payload),
    [MSG.CREATE_PLAYLIST]: ({ name }) => createPlaylist(name),
    [MSG.LIBRARY]: (payload) => libraryHas(payload),
    [MSG.SUGGEST]: (payload) => suggestFor(payload),
    [MSG.SYNC]: (payload) => sync(payload),
    [MSG.ALIGN]: (payload) => align(payload),
    [MSG.STOP]: () => stopJob(),
    [MSG.JOB]: () => _job,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = HANDLERS[message?.type];
    if (!handler) return false;

    // sendResponse асинхронный — обязателен return true, иначе канал закроется
    Promise.resolve(handler(message.payload ?? message))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));

    return true;
});

// Перелогинились на coub.com — прежний выбор способа запроса мог протухнуть
chrome.cookies.onChanged.addListener(({ cookie }) => {
    if (cookie.domain.includes("coub.com")) resetTransport();
});
