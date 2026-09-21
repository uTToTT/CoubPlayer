// local-api.js
// Общение с локальным CoubPlayer. Обычно расширение не скачивает ничего само —
// оно приносит ссылки, а качает, дедуплицирует и раскладывает по плейлистам
// сервер (PlaylistsController.DownloadAndAdd).
//
// Исключение — режим «через браузер»: когда провайдер блокирует coub.com,
// а VPN есть только в браузере, файлы тянет расширение и приносит сюда
// готовыми (plan + upload, см. transfer.js).

const DEFAULT_BASE = "http://localhost:5000";

export async function getBaseUrl() {
    const { serverUrl } = await chrome.storage.local.get("serverUrl");
    return (serverUrl || DEFAULT_BASE).replace(/\/+$/, "");
}

export async function setBaseUrl(url) {
    await chrome.storage.local.set({ serverUrl: url.replace(/\/+$/, "") });
}

// ─── Кто тянет файлы ────────────────────────────────────────────────────────
// По умолчанию сервер: так быстрее и не расходует трафик браузера. Режим
// переключается вручную в попапе — угадать за пользователя нельзя, а
// проверять доступность coub.com перед каждой загрузкой значило бы ждать
// таймаут там, где всё и так работает.

/** @returns {Promise<boolean>} тянуть ли файлы браузером вместо сервера */
export async function isBrowserTransfer() {
    const { transferMode } = await chrome.storage.local.get("transferMode");
    return transferMode === "browser";
}

export async function setBrowserTransfer(enabled) {
    await chrome.storage.local.set({ transferMode: enabled ? "browser" : "server" });
}

/** Ошибка прерванного запроса — вызывающий отличает её от настоящего сбоя. */
export class AbortedError extends Error {
    constructor() {
        super("Запрос прерван");
        this.name = "AbortedError";
    }
}

async function request(path, init) {
    const base = await getBaseUrl();
    let res;
    try {
        res = await fetch(base + path, init);
    } catch (err) {
        if (err?.name === "AbortError") throw new AbortedError();
        // fetch падает и когда сервер не запущен, и когда порт занят кем-то
        // без CORS — для пользователя это один и тот же случай
        throw new Error(`CoubPlayer недоступен по адресу ${base}`);
    }
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res.json();
}

/**
 * Рукопожатие: сервер жив и это действительно CoubPlayer.
 * @returns {Promise<{app: string, api: number, playlists: string[]}>}
 */
export async function ping() {
    const data = await request("/api/extension/ping");
    if (data?.app !== "CoubPlayer") throw new Error("На этом порту отвечает не CoubPlayer");
    return data;
}

/**
 * Что уже есть и присылать заново не нужно.
 *
 * @param {string} [playlist] — сверяться с содержимым этого плейлиста.
 *        Для догрузки ленты нужен именно он: общая библиотека скрыла бы
 *        ролик, скачанный когда-то в другой плейлист, и сюда он бы не попал.
 * @returns {Promise<Set<string>>}
 */
export async function getLibrary(playlist) {
    const query = playlist ? `?playlist=${encodeURIComponent(playlist)}` : "";
    const { ids } = await request(`/api/extension/library${query}`);
    return new Set(ids || []);
}

/**
 * Плейлисты для меню кнопки, в том же порядке, что в плеере. С id ролика
 * у каждого приходит признак hasCoub — лежит ли он там уже.
 *
 * banner — путь к картинке плейлиста относительно сервера (своя картинка,
 * старый значок или кадр первого ролика) либо null; собирает его сервер,
 * он же знает, какие файлы на диске есть.
 *
 * @param {string} [coubId]
 * @returns {Promise<{
 *   playlists: Array<{name: string, count: number, group: string|null,
 *                     hasCoub: boolean, banner: string|null}>,
 *   groupOrder: string[]
 * }>}
 */
export async function getPlaylists(coubId) {
    const query = coubId ? `?coub=${encodeURIComponent(coubId)}` : "";
    return request(`/api/extension/playlists${query}`);
}

/**
 * Ставит записи плейлиста в порядок ленты.
 *
 * Нужно из-за роликов, скачанных кнопкой на странице: ленты у сервера в тот
 * момент нет, и такой ролик ложится в начало. Десяток таких — и порядок уже
 * не тот, что на сайте.
 *
 * Сервер перед перестановкой делает копию сам.
 *
 * @param {string} playlist
 * @param {string[]} feed лента как есть, от новых к старым
 * @returns {Promise<{matched: number, extra: number}>}
 */
export async function alignToFeed(playlist, feed) {
    return request(`/api/playlists/${encodeURIComponent(playlist)}/align`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feed }),
    });
}

/**
 * Куда этот ролик просится: плейлисты, похожие на него по тегам, и теги,
 * которые стоило бы повесить.
 *
 * Считается по тегам, а у нескачанного ролика их в базе нет — тогда сервер
 * отвечает needsMeta, и спрашивать надо второй раз, приложив ответ coub.com.
 *
 * @param {string} id
 * @param {string|null} [meta] ответ coub.com как есть
 * @returns {Promise<{
 *   playlists: Array<{name: string, score: number, matched: string[]}>,
 *   tags: Array<{tag: string, score: number}>,
 *   needsMeta: boolean
 * }>}
 */
export async function suggest(id, meta = null) {
    return request("/api/extension/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, meta }),
    });
}

/**
 * Отдаёт ссылки серверу. Уже скачанные он пропустит сам, так что дубли
 * здесь не ошибка — но лишний трафик, поэтому выше их отсеивает getLibrary.
 *
 * @param {string} playlist
 * @param {string[]} permalinks
 * @param {object} [options]
 * @param {string[]} [options.order] — порядок, которому должен следовать
 *        плейлист: вся собранная лента, от новых к старым. По нему сервер
 *        ставит каждый ролик на своё место, а не просто в начало.
 * @param {AbortSignal} [options.signal] — прерывает ожидание ответа; сервер
 *        при этом текущую пачку всё равно докачает, но она и так уже в работе
 * @returns {Promise<Array<{id: string, success: boolean, error?: string, alreadyExisted?: boolean}>>}
 */
export async function download(playlist, permalinks, { order, signal } = {}) {
    return request(`/api/playlists/${encodeURIComponent(playlist)}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: permalinks, order }),
        signal,
    });
}

// ─── Загрузка силами браузера ───────────────────────────────────────────────

/**
 * Спрашивает сервер, что качать для ролика.
 *
 * Зовётся дважды. Без meta — дешёвый вопрос «файлы уже есть?»: ответ «да»
 * экономит поход в сеть, ради которого всё и затевалось. Получив needsMeta,
 * вызывающий приносит ответ coub.com и спрашивает снова.
 *
 * @param {string} id
 * @param {string|null} [meta] ответ coub.com как есть
 * @returns {Promise<{id: string, title: string|null, alreadyExists: boolean,
 *                    needsMeta: boolean, gone: boolean,
 *                    video: string|null, audio: string|null, audioExt: string}>}
 */
export async function plan(id, meta = null) {
    return request("/api/extension/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, meta }),
    });
}

/**
 * Приносит серверу скачанные браузером файлы.
 *
 * @param {string} playlist
 * @param {{id: string, title?: string, audioExt?: string, order?: string[], meta?: string}} coub
 *        meta — ответ coub.com как есть: мы его всё равно запрашивали ради
 *        ссылок на потоки, и без него ролик осел бы в библиотеке без тегов
 * @param {Blob} video
 * @param {Blob|null} audio — у части роликов звука нет вовсе
 * @param {AbortSignal} [signal]
 * @returns {Promise<{id: string, title?: string, success: boolean, error?: string}>}
 */
export async function upload(playlist, coub, video, audio, signal) {
    const ext = coub.audioExt || "mp3";

    const form = new FormData();
    form.append("id", coub.id);
    if (coub.title) form.append("title", coub.title);
    form.append("audioExt", ext);
    if (coub.meta) form.append("meta", coub.meta);
    if (coub.order?.length) form.append("order", JSON.stringify(coub.order));
    form.append("video", video, "video.mp4");
    if (audio) form.append("audio", audio, `audio.${ext}`);

    return request(`/api/playlists/${encodeURIComponent(playlist)}/upload`, {
        method: "POST",
        // Content-Type не ставим: его выставит сама FormData, вместе с boundary
        body: form,
        signal,
    });
}

/**
 * Заводит новый плейлист.
 * @throws если имя занято — сервер отвечает 400 «Playlist exists»
 */
export async function createPlaylist(name) {
    const base = await getBaseUrl();
    const res = await fetch(base + "/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(
            /exists/i.test(text)
                ? `Плейлист «${name}» уже есть`
                : `Не удалось создать плейлист «${name}»: ${text}`
        );
    }
}

/** Создаёт плейлист, если его ещё нет. */
export async function ensurePlaylist(name) {
    const { playlists } = await ping();
    if (playlists.includes(name)) return;
    await createPlaylist(name);
}
