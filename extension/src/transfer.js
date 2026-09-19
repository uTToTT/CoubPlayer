// transfer.js
// Загрузка ролика силами браузера, а не сервера.
//
// Зачем. Провайдер может блокировать coub.com, и тогда плеер до него не
// достаёт. Встроенный VPN Opera или Edge делу не помогает сам по себе: это
// прокси для трафика браузера, а плеер — отдельный процесс, его запросы идут
// мимо. Здесь порядок обратный: файлы тянет расширение, то есть браузер,
// то есть через его VPN, — и приносит серверу готовыми.
//
// Кто что решает. Расширение приносит байты; какие потоки брать и куда их
// класть, по-прежнему решает сервер. Правила выбора качества остаются у него
// в единственном экземпляре — разъехаться двум реализациям нельзя.

import { fetchCoubMeta, GoneError } from "./coub-api.js";
import * as local from "./local-api.js";

// Та же дисциплина, что у серверной загрузки: без пауз coub.com начинает
// отвечать 403. Выдерживаем их здесь, потому что теперь запросы идут отсюда.
const DELAY_MS = 1500;
const DELAY_JITTER_MS = 800;

/** Раньше этого времени в сеть не ходим. */
let _nextAllowedAt = 0;

/**
 * Скачивает ролик браузером и отдаёт серверу.
 *
 * Ошибки не бросает, а возвращает тем же видом, что и серверная загрузка:
 * один неудавшийся ролик не должен ронять проход по ленте. Исключение —
 * остановка пользователем, её видно по AbortError и её надо пропустить выше.
 *
 * @param {string} playlist
 * @param {string} id
 * @param {object} [options]
 * @param {string[]} [options.order] порядок ленты — по нему сервер ставит
 *        ролик на его место, а не просто в начало плейлиста
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{id: string, title?: string, success: boolean,
 *                    error?: string, gone?: boolean, alreadyExisted?: boolean}>}
 */
export async function downloadInBrowser(playlist, id, { order, signal } = {}) {
    // Файлы могут уже лежать на диске — тогда в сеть идти незачем, и ролик
    // надо только приписать к плейлисту. Обычная загрузка это умеет и на
    // готовом ничего не запрашивает, так что блокировка ей здесь не помеха
    let step;
    try {
        step = await local.plan(id);
        if (step.alreadyExists) {
            const [result] = await local.download(playlist, [id], { order, signal });
            return result ?? { id, success: true, alreadyExisted: true };
        }
    } catch (err) {
        if (isAbort(err)) throw err;
        return { id, success: false, error: String(err.message || err) };
    }

    // Дальше идут обращения к coub.com — темп держим от конца этой работы,
    // как это делает сервер: пауза нужна между запросами к сайту, а не
    // между началами загрузок
    try {
        await pace(signal);

        let meta;
        try {
            meta = await fetchCoubMeta(id);
        } catch (err) {
            if (isAbort(err)) throw err;
            return {
                id,
                success: false,
                gone: err instanceof GoneError,
                error: String(err.message || err),
            };
        }

        step = await local.plan(id, meta);
        if (step.gone) {
            return { id, title: step.title, success: false, gone: true, error: "Ролик удалён с coub.com" };
        }
        if (!step.video) {
            return { id, title: step.title, success: false, error: "Сервер не выбрал видео-поток" };
        }

        const video = await fetchBinary(step.video, signal);
        const audio = step.audio ? await fetchBinary(step.audio, signal) : null;

        return await local.upload(
            playlist,
            { id, title: step.title, audioExt: step.audioExt, order, meta },
            video,
            audio,
            signal
        );
    } catch (err) {
        if (isAbort(err)) throw err;
        return { id, title: step?.title, success: false, error: String(err.message || err) };
    } finally {
        markNetworkUse();
    }
}

/** Файл с CDN. Куки здесь ни к чему — отдаётся он всем. */
async function fetchBinary(url, signal) {
    let res;
    try {
        res = await fetch(url, { credentials: "omit", signal });
    } catch (err) {
        if (isAbort(err)) throw err;
        // Сюда же приходит блокировка: запрос просто не доезжает,
        // и кода ответа у такой неудачи нет вовсе
        throw new Error("файл не скачался — проверьте, включён ли VPN в браузере");
    }

    if (!res.ok) throw new Error(`файл: coub.com ответил ${res.status}`);
    return res.blob();
}

// ─── Темп ───────────────────────────────────────────────────────────────────

async function pace(signal) {
    const wait = _nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait, signal);
}

function markNetworkUse() {
    _nextAllowedAt = Date.now() + DELAY_MS + Math.floor(Math.random() * DELAY_JITTER_MS);
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());

        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(abortError());
            },
            { once: true }
        );
    });
}

function abortError() {
    return new DOMException("Загрузка прервана", "AbortError");
}

/** Остановку пользователем надо пропускать выше, а не записывать в неудачи. */
function isAbort(err) {
    return err?.name === "AbortError" || err instanceof local.AbortedError;
}
