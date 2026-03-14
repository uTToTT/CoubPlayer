export async function createPlaylist({ name }) {
    await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
}

export async function addVideoToPlaylist(playlist, id, title) {
    await fetch(`/api/playlists/${encodeURIComponent(playlist)}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, title })
    });
}

export async function removeVideoFromPlaylist(playlist, id) {
    await fetch(`/api/playlists/${encodeURIComponent(playlist)}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });
}

