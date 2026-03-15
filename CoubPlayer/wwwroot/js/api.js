export async function createPlaylist({ name }) {
    await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
}

export async function addVideoToPlaylist(playlist, id, title) {
    const res = await fetch(`/api/playlists/${encodeURIComponent(playlist)}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, title })
    });
    if (!res.ok) throw new Error("Не удалось добавить видео");
}

export async function removeVideoFromPlaylist(playlist, id) {
    const res = await fetch(`/api/playlists/${encodeURIComponent(playlist)}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error("Не удалось удалить видео");
}

