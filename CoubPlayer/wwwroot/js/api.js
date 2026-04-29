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
