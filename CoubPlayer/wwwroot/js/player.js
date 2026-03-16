//player.js
import { markVideoViewed } from "./api.js";

export class Player {

    constructor(players, audio, bgVideo, onVideoChange = null) {
        this.players = players;
        this.audio = audio;
        this.bgVideo = bgVideo;

        this.active = 0;
        this.next = 1;
        this.index = 0;
        this.playlist = [];

        this.currentPlaylistName = null;
        this.onVideoChange = onVideoChange;
    }

    seededRandom(seed) {
        let x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    }

    createSeededRNG(seed) {
        let s = seed;
        return () => {
            s += 1;
            let x = Math.sin(s) * 10000;
            return x - Math.floor(x);
        };
    }

    setPlaylist(list, playlistName = null) {
        this.playlist = list;
        if (playlistName) this.currentPlaylistName = playlistName;
    }

    async play(indexToPlay) {
        if (indexToPlay < 0 || indexToPlay >= this.playlist.length) return;

        this.index = indexToPlay;
        const item = this.playlist[this.index];
        const player = this.players[this.active];

        player.src = item.video;
        this.audio.src = item.audio;
        this.bgVideo.src = item.video;

        try {
            await player.play();
            await this.audio.play().catch(() => { });
            await this.bgVideo.play().catch(() => { });
        } catch { }

        if (this.onVideoChange) this.onVideoChange(item);

        // console.log("Marking viewed:", this.currentPlaylistName, item.id);
        if (this.currentPlaylistName && item.id) {
            try {
                await markVideoViewed(this.currentPlaylistName, item.id);
                item.lastViewed = new Date().toISOString();
            } catch (err) {
                console.warn("Не удалось обновить время просмотра:", err);
            }
        }
    }

    nextVideo() {
        this.switchVideo(this.index + 1);
    }

    prevVideo() {
        this.switchVideo(this.index - 1);
    }

    async switchVideo(newIndex) {
        if (newIndex < 0 || newIndex >= this.playlist.length) return;

        const newItem = this.playlist[newIndex];
        const player = this.players[this.next];

        player.src = newItem.video;
        this.audio.src = newItem.audio;

        this.players[this.active].pause();
        this.players[this.active].style.display = "none";

        player.style.display = "block";

        player.play();
        this.audio.play().catch(() => { });
        this.bgVideo.src = newItem.video;
        this.bgVideo.play().catch(() => { });

        [this.active, this.next] = [this.next, this.active];
        this.index = newIndex;

        if (this.onVideoChange) this.onVideoChange(newItem);

        // console.log("Marking viewed:", this.currentPlaylistName, newItem.id);
        if (this.currentPlaylistName && newItem.id) {
            try {
                await markVideoViewed(this.currentPlaylistName, newItem.id);
                newItem.lastViewed = new Date().toISOString();
            } catch (err) {
                console.warn("Не удалось обновить время просмотра:", err);
            }
        }
    }

    togglePause(bgVideo, audio) {
        const video = this.players[this.active];
        if (video.paused) {
            video.play();
            bgVideo.play();
            audio.play().catch(() => { });
        } else {
            video.pause();
            bgVideo.pause();
            audio.pause();
        }
    }

    goToIndex(userIndex) {

        const index = Number(userIndex) - 1; // пользователь вводит 1..N

        if (Number.isNaN(index)) return;

        if (index < 0 || index >= this.playlist.length) {
            console.warn("Index out of range:", userIndex);
            return;
        }

        this.switchVideo(index);
    }

    // --------------------------
    // сортировка по полю order
    buildOrderedPlaylistByOrder(playlistObj, order = 'asc') {
        if (!playlistObj || !playlistObj.videos) return [];

        const arr = Object.entries(playlistObj.videos).map(([id, meta]) => ({
            id,
            title: meta.title,
            order: meta.order,
            lastViewed: meta.lastViewed || null
        }));

        arr.sort((a, b) => {
            return order === 'asc' ? a.order - b.order : b.order - a.order;
        });

        return arr;
    }

    // сортировка по дате просмотра
    buildOrderedPlaylistByDate(playlistObj, order = 'desc') {
        if (!playlistObj || !playlistObj.videos) return [];

        const arr = Object.entries(playlistObj.videos).map(([id, meta]) => ({
            id,
            title: meta.title,
            order: meta.order,
            lastViewed: meta.lastViewed ? new Date(meta.lastViewed) : null
        }));

        arr.sort((a, b) => {
            // если обе даты null, считаем равными
            if (!a.lastViewed && !b.lastViewed) return 0;
            // если только одна дата null
            if (!a.lastViewed) return order === 'asc' ? -1 : 1;
            if (!b.lastViewed) return order === 'asc' ? 1 : -1;

            return order === 'asc'
                ? a.lastViewed - b.lastViewed
                : b.lastViewed - a.lastViewed;
        });

        return arr;
    }

    // сортировка рандомная
    buildRandomPlaylist(playlistObj, seed = 1) {

        if (!playlistObj || !playlistObj.videos) return [];

        const arr = Object.entries(playlistObj.videos).map(([id, meta]) => ({
            id,
            title: meta.title,
            order: meta.order,
            lastViewed: meta.lastViewed || null
        }));

        const rng = this.createSeededRNG(seed);

        for (let i = arr.length - 1; i > 0; i--) {

            const j = Math.floor(rng() * (i + 1));

            [arr[i], arr[j]] = [arr[j], arr[i]];
        }

        return arr;
    }
}