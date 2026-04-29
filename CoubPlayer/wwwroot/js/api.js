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

