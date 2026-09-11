// api.js
// Все обращения к серверному API. Логика не изменилась, добавлена вспомогательная функция.

/**
 * @param {string} url
 * @param {object} body
 * @returns {Promise<Response>}
 */
async function post(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error [${url}]: ${text}`);
    }
    return res;
}

export async function setPlaylistIcon(playlist, file) {
    const form = new FormData();
    form.append("file", file);

    const res = await fetch(`/api/playlists/${encodeURIComponent(playlist)}/icon`, {
        method: "POST",
        body: form, // Content-Type НЕ выставляем вручную — браузер сам добавит boundary
    });

    if (!res.ok) throw new Error(`Icon upload failed: ${await res.text()}`);
    const { url } = await res.json();
    return url; // "/Data/icons/myplaylist.webp"
}

// ─── Баннеры плейлистов ───────────────────────────────────────────────────

/**
 * Загружает свою картинку баннера. Обрезка под 16:9 делается на клиенте,
 * сюда приходит уже готовый кадр.
 * @param {string} playlist
 * @param {Blob} blob
 * @returns {Promise<{url: string}>}
 */
export async function setPlaylistBanner(playlist, blob) {
    const form = new FormData();
    form.append("file", blob, "banner.webp");

    const res = await fetch(`/api/playlists/${encodeURIComponent(playlist)}/banner`, {
        method: "POST",
        body: form,
    });
    if (!res.ok) throw new Error(`Banner upload failed: ${await res.text()}`);
    return res.json();
}

/**
 * Загружает свой анимированный баннер (mp4 или webm).
 * @param {string} playlist
 * @param {File} file
 * @returns {Promise<{url: string}>}
 */
export async function setPlaylistBannerVideo(playlist, file) {
    const form = new FormData();
    form.append("file", file, file.name);

    const res = await fetch(`/api/playlists/${encodeURIComponent(playlist)}/banner-video`, {
        method: "POST",
        body: form,
    });
    if (!res.ok) throw new Error(`Banner video upload failed: ${await res.text()}`);
    return res.json();
}

/**
 * Сбрасывает баннер к превью первого ролика.
 * @param {string} playlist
 * @param {"image"|"video"|"all"} kind
 */
export async function deletePlaylistBanner(playlist, kind = "all") {
    const res = await fetch(
        `/api/playlists/${encodeURIComponent(playlist)}/banner?kind=${kind}`,
        { method: "DELETE" }
    );
    if (!res.ok) throw new Error(`Banner reset failed: ${await res.text()}`);
}

export async function deletePlaylistIcon(playlist) {
    await fetch(`/api/playlists/${encodeURIComponent(playlist)}/icon`, {
        method: "DELETE",
    });
}

export async function createPlaylist({ name }) {
    await post("/api/playlists", { name });
}

export async function addVideoToPlaylist(playlist, id, title) {
    await post(`/api/playlists/${encodeURIComponent(playlist)}/add`, { id, title });
}

export async function removeVideoFromPlaylist(playlist, id) {
    await post(`/api/playlists/${encodeURIComponent(playlist)}/remove`, { id });
}

/**
 * Сохраняет новый порядок роликов в плейлисте.
 * ids может быть подмножеством плейлиста — сервер переставит только их,
 * по их же позициям, не трогая остальные (см. Reorder в PlaylistsController).
 * @param {string} playlist
 * @param {string[]} ids — в порядке возрастания order
 */
export async function reorderPlaylist(playlist, ids) {
    await post(`/api/playlists/${encodeURIComponent(playlist)}/reorder`, { ids });
}

/**
 * Добавляет в плейлист ещё одну запись того же ролика, сразу за исходной.
 * Файлы не копируются — обе записи ссылаются на один и тот же куб.
 * @param {string} playlist
 * @param {string} key — ключ дублируемой записи
 * @returns {Promise<{key: string}>} ключ созданной копии
 */
export async function duplicateVideo(playlist, key) {
    const res = await post(`/api/playlists/${encodeURIComponent(playlist)}/duplicate`, { id: key });
    return res.json();
}

/**
 * Сохраняет персональную постобработку одной записи плейлиста.
 * @param {string} playlist
 * @param {string} key — ключ записи
 * @param {{fx?: object, bgFx?: object, bgSeparate?: boolean}} settings
 *        пустой fx снимает настройки; bgFx учитывается только при bgSeparate
 */
export async function setVideoFx(playlist, key, { fx, bgFx, bgSeparate } = {}) {
    await post(`/api/playlists/${encodeURIComponent(playlist)}/fx`, {
        id: key,
        fx: fx || null,
        bgFx: bgFx || null,
        bgSeparate: !!bgSeparate,
    });
}

// ─── Пресеты постобработки ────────────────────────────────────────────────

/** @returns {Promise<Array<{name: string, fx?: object, bgFx?: object, bgSeparate: boolean}>>} */
export async function getFxPresets() {
    const res = await fetch("/api/fx-presets");
    if (!res.ok) throw new Error("Failed to load fx presets");
    return res.json();
}

/** Создаёт пресет или перезаписывает существующий с тем же именем. */
export async function saveFxPreset(preset) {
    const res = await post("/api/fx-presets", preset);
    return res.json();
}

export async function deleteFxPreset(name) {
    const res = await fetch(`/api/fx-presets/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Delete preset failed: ${await res.text()}`);
    return res.json();
}

export async function markVideoViewed(playlist, id) {
    await post(`/api/playlists/${encodeURIComponent(playlist)}/viewed`, { id });
}

export async function deletePlaylist(name) {
    await post(`/api/playlists/${encodeURIComponent(name)}/delete`, {});
}

// ─── Группы плейлистов и тегов ────────────────────────────────────────────
// Отдельной сущности «группа» нет: группа существует, пока на неё кто-то
// ссылается. Поэтому создание группы — это просто назначение её имени.

/** @param {string|null} group — пустое значение убирает плейлист из группы */
export async function setPlaylistGroup(playlist, group) {
    await post(`/api/playlists/${encodeURIComponent(playlist)}/group`, { group: group || "" });
}

/** @returns {Promise<Record<string, string>>} карта «тег → группа» */
export async function getTagGroups() {
    const res = await fetch("/api/coubs/tag-groups");
    if (!res.ok) throw new Error("Failed to load tag groups");
    return res.json();
}

/** @param {string|null} group — пустое значение убирает тег из группы */
export async function setTagGroup(tag, group) {
    const res = await post("/api/coubs/tag-groups", { tag, group: group || "" });
    return res.json();
}

export async function renamePlaylist(oldName, newName) {
    await post(`/api/playlists/${encodeURIComponent(oldName)}/rename`, { newName });
}

/**
 * Скачивает один или несколько coub-роликов по ссылкам (или голым id)
 * и добавляет их в указанный плейлист.
 * @param {string} playlist
 * @param {string[]} urls
 * @returns {Promise<Array<{id: string, title?: string, success: boolean, error?: string, alreadyExisted?: boolean}>>}
 */
export async function downloadCoubs(playlist, urls) {
    const res = await post(`/api/playlists/${encodeURIComponent(playlist)}/download`, { urls });
    return res.json();
}

/**
 * Докачивает свежие ролики из личной ленты liked/bookmarks пользователя Coub
 * (требует access token — remember_token из cookie авторизованной сессии).
 * Ролики добавляются в одноимённый плейлист ("liked" или "bookmarks"),
 * который создаётся автоматически, если его ещё нет.
 * @param {"liked"|"bookmarks"} category
 * @param {string} token
 * @param {number} limit — сколько новейших роликов ленты забрать за этот запуск
 * @returns {Promise<Array<{id: string, title?: string, success: boolean, error?: string, alreadyExisted?: boolean}>>}
 */
export async function syncFavorites(category, token, limit) {
    const res = await post("/api/playlists/sync", { category, token, limit });
    return res.json();
}

export async function getAllTags() {
    const res = await fetch("/api/coubs/tags");
    if (!res.ok) throw new Error("Failed to load tags");
    return res.json(); // [{ tag, count }]
}

export async function getCoubTags(id) {
    const res = await fetch(`/api/coubs/${encodeURIComponent(id)}/tags`);
    if (!res.ok) throw new Error("Failed to load coub tags");
    return res.json();
}

export async function addTagToCoub(id, tag) {
    const res = await post(`/api/coubs/${encodeURIComponent(id)}/tags`, { tag });
    return res.json();
}

export async function removeTagFromCoub(id, tag) {
    const res = await fetch(`/api/coubs/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`, {
        method: "DELETE",
    });
    if (!res.ok) throw new Error(`Remove tag failed: ${await res.text()}`);
    return res.json();
}

export async function searchCoubsByTags(tags, mode = "any") {
    const qs = new URLSearchParams({ tags: tags.join(","), mode });
    const res = await fetch(`/api/coubs/search?${qs}`);
    if (!res.ok) throw new Error("Tag search failed");
    return res.json();
}

export async function openCoubFolder(id) {
    await post(`/api/coubs/${encodeURIComponent(id)}/open-folder`, {});
}

export async function renameTag(oldTag, newTag) {
    await post(`/api/coubs/tags/${encodeURIComponent(oldTag)}/rename`, { newName: newTag });
}

export async function deleteTag(tag) {
    const res = await fetch(`/api/coubs/tags/${encodeURIComponent(tag)}`, {
        method: "DELETE",
    });
    if (!res.ok) throw new Error(`Delete tag failed: ${await res.text()}`);
}

export async function deleteAllTags() {
    const res = await fetch(`/api/coubs/tags`, {
        method: "DELETE",
    });
    if (!res.ok) throw new Error(`Delete all tags failed: ${await res.text()}`);
}