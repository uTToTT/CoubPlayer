// background.js
// Service worker: единственное место, откуда расширение ходит и на coub.com,
// и на localhost. Content script так не может — его fetch подчиняется CORS
// самой страницы coub.com, и запрос к localhost она не пропустит.

import { MSG } from "./messages.js";
import {
    collectPermalinks,
    inspectCookies,
    pageRequests,
    permalinkFromUrl,
    probe,
    resetTransport,
} from "./coub-api.js";
import * as local from "./local-api.js";

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

    const [result] = await local.download(target, [id]);
    if (result && !result.success) throw new Error(result.error || "Сервер не смог скачать куб");

    // Выбор запоминаем: в следующий раз он будет первым кандидатом
    if (playlist) await chrome.storage.local.set({ defaultPlaylist: playlist });

    return { id, alreadyExisted: !!result?.alreadyExisted, playlist: target };
}

/** Плейлисты для меню кнопки — со списком групп и последним выбором. */
async function playlistsFor({ permalink } = {}) {
    const id = permalink ? permalinkFromUrl(permalink) : null;
    const [data, { defaultPlaylist }] = await Promise.all([
        local.getPlaylists(id),
        chrome.storage.local.get("defaultPlaylist"),
    ]);
    return {
        playlists: data.playlists || [],
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

        for (let i = 0; i < missing.length; i += CHUNK) {
            if (_stop.requested) return finishJob({ stoppedByUser: true });

            const chunk = missing.slice(i, i + CHUNK);
            let results;
            try {
                results = await local.download(category, chunk, _stop.controller.signal);
            } catch (err) {
                // Прервали вручную: сервер текущую пачку всё равно докачает,
                // просто её итог до нас уже не дойдёт
                if (err instanceof local.AbortedError) return finishJob({ stoppedByUser: true });
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

function finishJob(patch = {}) {
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
    [MSG.SYNC]: (payload) => sync(payload),
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
