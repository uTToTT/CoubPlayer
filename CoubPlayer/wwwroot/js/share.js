// share.js
// Кодирование/декодирование "лёгкой" строки для шаринга плейлиста между пользователями.
// Формат: "CPSHARE1:" + base64(JSON), JSON = { v: 1, title, items: [{id, title}] }

import { coubIdFromKey } from "./playlist.js";

const PREFIX = "CPSHARE1:";

function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(str) {
    return decodeURIComponent(escape(atob(str)));
}

/**
 * @param {string} title
 * @param {Record<string, {title?: string}>} videosMap — playlist.videos
 * @returns {string}
 */
export function encodePlaylistShare(title, videosMap) {
    // Ключи плейлиста могут быть копиями ("id#2") — наружу отдаём id кубов
    // и без повторов: получателю всё равно качать один и тот же ролик один раз.
    const seen = new Set();
    const items = [];
    for (const [key, meta] of Object.entries(videosMap || {})) {
        const id = coubIdFromKey(key);
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, title: meta?.title || id });
    }
    const payload = { v: 1, title: title || "Playlist", items };
    return PREFIX + b64encode(JSON.stringify(payload));
}

/**
 * @param {string} raw
 * @returns {{v: number, title: string, items: {id: string, title: string}[]}}
 */
export function decodePlaylistShare(raw) {
    const str = (raw || "").trim();
    if (!str.startsWith(PREFIX)) {
        throw new Error("Это не похоже на код плейлиста CoubPlayer");
    }

    let payload;
    try {
        payload = JSON.parse(b64decode(str.slice(PREFIX.length)));
    } catch {
        throw new Error("Не удалось прочитать код плейлиста — он повреждён");
    }

    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
        throw new Error("Не удалось прочитать код плейлиста — он повреждён");
    }

    const seen = new Set();
    payload.items = payload.items.filter((it) => {
        if (!it?.id || seen.has(it.id)) return false;
        seen.add(it.id);
        return true;
    });

    return payload;
}