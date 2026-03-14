//playlist.js
export function buildPlaylist(playlists, coubMap, name) {

    const playlistData = playlists[name];
    const videos = playlistData.videos;

    return Object.entries(videos)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([id, meta]) => {

            const coub = coubMap[id];

            return {
                id: id,
                title: meta.title,
                video: coub.video,
                audio: coub.audio
            };
        });
}

