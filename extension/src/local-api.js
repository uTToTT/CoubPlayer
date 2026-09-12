// local-api.js
// Общение с локальным CoubPlayer. Расширение ничего не скачивает само —
// оно только приносит ссылки, а качает, дедуплицирует и раскладывает
// по плейлистам сервер (PlaylistsController.DownloadAndAdd).

const DEFAULT_BASE = "http://localhost:5000";

export async function getBaseUrl() {
    const { serverUrl } = await chrome.storage.local.get("serverUrl");
    return (serverUrl || DEFAULT_BASE).replace(/\/+$/, "");
}

export async function setBaseUrl(url) {
    await chrome.storage.local.set({ serverUrl: url.replace(/\/+$/, "") });
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
 * @param {string} [coubId]
 * @returns {Promise<{
 *   playlists: Array<{name: string, count: number, group: string|null, hasCoub: boolean}>,
 *   groupOrder: string[]
 * }>}
 */
export async function getPlaylists(coubId) {
    const query = coubId ? `?coub=${encodeURIComponent(coubId)}` : "";
    return request(`/api/extension/playlists${query}`);
}

/**
 * Отдаёт ссылки серверу. Уже скачанные он пропустит сам, так что дубли
 * здесь не ошибка — но лишний трафик, поэтому выше их отсеивает getLibrary.
 *
 * @param {string} playlist
 * @param {string[]} permalinks
 * @param {AbortSignal} [signal] — прерывает ожидание ответа; сервер при этом
 *        текущую пачку всё равно докачает, но она и так уже в работе
 * @returns {Promise<Array<{id: string, success: boolean, error?: string, alreadyExisted?: boolean}>>}
 */
export async function download(playlist, permalinks, signal) {
    return request(`/api/playlists/${encodeURIComponent(playlist)}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: permalinks }),
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
