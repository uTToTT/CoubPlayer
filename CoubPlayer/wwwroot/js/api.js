//api.js
async function createPlaylist(name) {

    await fetch("/api/playlists", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(name)
    });

}

async function addVideoToPlaylist(playlist, id, title) {

    await fetch(`/api/playlists/${playlist}/add`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ id, title })
    });

}

async function removeVideoFromPlaylist(playlist, id) {

    await fetch(`/api/playlists/${playlist}/remove`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(id)
    });

}