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

/**
 * Имена плейлистов, у которых есть старый значок. Одним запросом вместо
 * проверки каждого по отдельности — см. primeLegacyIcons в banner.js.
 * @returns {Promise<string[]>}
 */
export async function getPlaylistIcons() {
    const res = await fetch("/api/playlists/icons");
    if (!res.ok) throw new Error("Failed to load playlist icons");
    const { names } = await res.json();
    return names || [];
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

/**
 * Сохраняет порядок плейлистов. Приходит полный список имён в нужном порядке.
 * @param {string[]} names
 */
export async function reorderPlaylists(names) {
    await post("/api/playlists/order", { names });
}

/** @returns {Promise<{playlists?: string[], tags?: string[]}>} */
export async function getGroupOrder() {
    const res = await fetch("/api/groups/order");
    if (!res.ok) throw new Error("Failed to load group order");
    return res.json();
}

/**
 * @param {"playlists"|"tags"} kind
 * @param {string[]} groups
 */
export async function setGroupOrder(kind, groups) {
    const res = await post("/api/groups/order", { kind, groups });
    return res.json();
}

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

// ─── Восстановление пропавших файлов ──────────────────────────────────────
// Ролики числятся в библиотеке и плейлистах, а файлов на диске нет.
// Докачка возвращает только файлы: плейлисты и порядок не трогаются.

/** @returns {Promise<{missing: number, ids: string[]|null}>} */
export async function getMissingCoubs(withIds = false) {
    const res = await fetch(`/api/restore/missing${withIds ? "?ids=true" : ""}`);
    if (!res.ok) throw new Error("Не удалось проверить библиотеку");
    return res.json();
}

/** @returns {Promise<object>} состояние задачи сразу после запуска */
export async function startRestore() {
    const res = await post("/api/restore/start", {});
    return res.json();
}

export async function getRestoreStatus() {
    const res = await fetch("/api/restore/status");
    if (!res.ok) throw new Error("Не удалось получить состояние");
    return res.json();
}

export async function stopRestore() {
    const res = await post("/api/restore/stop", {});
    return res.json();
}

// ─── Метаданные Coub ──────────────────────────────────────────────────────
// Канал, длительность, размер кадра, nsfw и теги самого сайта. В файлах
// ролика этого нет, а подсказка «куда положить» строится только на них.

/** @returns {Promise<{pending: number}>} */
export async function getMetadataPending() {
    const res = await fetch("/api/metadata/pending");
    if (!res.ok) throw new Error("Не удалось проверить библиотеку");
    return res.json();
}

export async function startMetadata() {
    const res = await post("/api/metadata/start", {});
    return res.json();
}

export async function getMetadataStatus() {
    const res = await fetch("/api/metadata/status");
    if (!res.ok) throw new Error("Не удалось получить состояние");
    return res.json();
}

export async function stopMetadata() {
    const res = await post("/api/metadata/stop", {});
    return res.json();
}

/**
 * Итог последнего прохода: что удалено с coub.com насовсем, а что просто
 * не далось. null — восстановление ещё не запускали.
 * @returns {Promise<{finishedAt: string, total: number, restored: number,
 *                    gone: string[], failed: Record<string,string>, stopped: boolean}|null>}
 */
export async function getRestoreReport() {
    const res = await fetch("/api/restore/report");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("Не удалось получить отчёт");
    return res.json();
}

// ─── Кадры-превью роликов ─────────────────────────────────────────────────
// Сервер декодировать mp4 не умеет, поэтому кадр снимает браузер — когда всё
// равно грузит видео для баннера — и присылает сюда. Со второго раза список
// плейлистов обходится картинками вместо видео.

/** @returns {Promise<string[]>} id роликов, для которых кадр уже есть */
export async function getCoubThumbs() {
    const res = await fetch("/api/coubs/thumbs");
    if (!res.ok) throw new Error("Failed to load thumbs");
    const { ids } = await res.json();
    return ids || [];
}

/**
 * @param {string} id
 * @param {Blob} blob — webp-кадр
 */
export async function saveCoubThumb(id, blob) {
    const form = new FormData();
    form.append("file", blob, `${id}.webp`);

    const res = await fetch(`/api/coubs/${encodeURIComponent(id)}/thumb`, {
        method: "POST",
        body: form,
    });
    if (!res.ok) throw new Error(`Thumb upload failed: ${await res.text()}`);
    return res.json();
}

/**
 * Версия плеера и состояние хранилища.
 * @returns {Promise<{app: string, schema: number, data: string|null, importedAt: string|null}>}
 */
export async function getVersion() {
    const res = await fetch("/api/version");
    if (!res.ok) throw new Error("Failed to load version");
    return res.json();
}

// ─── Резервные копии ──────────────────────────────────────────────────────

/** @returns {Promise<{folder: string, items: Array<{name: string, createdAt: string, bytes: number, automatic: boolean}>}>} */
export async function getBackups() {
    const res = await fetch("/api/backups");
    if (!res.ok) throw new Error("Не удалось получить список копий");
    return res.json();
}

export async function createBackup() {
    const res = await post("/api/backups", {});
    return res.json();
}

export async function openBackupsFolder() {
    await post("/api/backups/open-folder", {});
}

/**
 * Куда этот ролик скорее всего просится и какие теги ему подойдут.
 * Пусто — сведений о ролике ещё нет либо не на что опереться.
 * @returns {Promise<{playlists: Array<{name: string, score: number, matched: string[]}>,
 *                    tags: Array<{tag: string, score: number}>}>}
 */
export async function getSuggestions(id) {
    const res = await fetch(`/api/coubs/${encodeURIComponent(id)}/suggest`);
    if (!res.ok) throw new Error("Не удалось получить подсказки");
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