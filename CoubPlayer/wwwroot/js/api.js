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

export async function markVideoViewed(playlist, id) {
    await post(`/api/playlists/${encodeURIComponent(playlist)}/viewed`, { id });
}

export async function deletePlaylist(name) {
    await post(`/api/playlists/${encodeURIComponent(name)}/delete`, {});
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