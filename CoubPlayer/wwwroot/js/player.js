// player.js
// Отвечает исключительно за воспроизведение: play, pause, switch, volume.
// Вся логика сортировки перенесена в playlist.js.

import { markVideoViewed } from "./api.js";

export class Player {
    /**
     * @param {HTMLVideoElement[]} videoEls — два буфера видео (A и B)
     * @param {HTMLAudioElement} audioEl
     * @param {HTMLVideoElement} bgVideoEl
     */
    constructor(videoEls, audioEl, bgVideoEl) {
        this.videoEls = videoEls;
        this.audio = audioEl;
        this.bgVideo = bgVideoEl;

        this.activeIdx = 0; // индекс активного буфера (0 или 1)
        this.index = 0;     // индекс текущего элемента в playlist
        this.playlist = [];
        this.currentPlaylistName = null;

        /** @type {(() => void) | null} Вызывается при смене видео */
        this.onVideoChange = null;
    }

    // ─── Публичный API ────────────────────────────────────────────────────────

    get activeVideo() {
        return this.videoEls[this.activeIdx];
    }

    get nextVideo() {
        return this.videoEls[1 - this.activeIdx];
    }

    /**
     * @param {import("./playlist.js").ResolvedItem[]} list
     * @param {string | null} playlistName
     */
    setPlaylist(list, playlistName = null) {
        this.playlist = list;
        if (playlistName !== null) this.currentPlaylistName = playlistName;
    }

    setVolume(value) {
        const vol = Math.max(0, Math.min(1, value / 100));
        this.audio.volume = vol;
        this.bgVideo.volume = vol;
        this.videoEls.forEach((v) => (v.volume = vol));
    }

    /** Запустить видео по индексу (первый запуск или после setPlaylist) */
    async play(index) {
        if (!this._isValidIndex(index)) return;

        this.index = index;
        const item = this.playlist[index];

        this.activeVideo.src = item.video;
        this.audio.src = item.audio;
        this.bgVideo.src = item.video;

        await this._playAll();
        this._notifyChange(item);
        this._markViewed(item);
    }

    async goToNext() {
        await this._switchTo(this.index + 1);
    }

    async goToPrev() {
        await this._switchTo(this.index - 1);
    }

    async goToIndex(userIndex) {
        const index = Number(userIndex) - 1; // пользователь вводит 1..N
        if (!Number.isNaN(index)) await this._switchTo(index);
    }

    togglePause() {
        if (this.activeVideo.paused) {
            this._resumeAll();
        } else {
            this._pauseAll();
        }
    }

    pause() {
        this._pauseAll();
    }

    async restart() {
        this.activeVideo.currentTime = 0;
        this.bgVideo.currentTime = 0;
        this.audio.currentTime = 0;
        await this._resumeAll();
    }

    // ─── Приватные методы ─────────────────────────────────────────────────────

    /** Переключение через двойной буфер */
    async _switchTo(newIndex) {
        if (!this._isValidIndex(newIndex)) return;

        const newItem = this.playlist[newIndex];
        const incoming = this.nextVideo;
        const outgoing = this.activeVideo;

        outgoing.pause();

        incoming.src = newItem.video;
        this.audio.src = newItem.audio;
        this.bgVideo.src = newItem.video;

        incoming.style.display = "block";
        outgoing.style.display = "none";

        this.activeIdx = 1 - this.activeIdx;
        this.index = newIndex;

        await this._playAll();
        this._notifyChange(newItem);
        this._markViewed(newItem);
    }

    async _playAll() {
        try {
            this.activeVideo.muted = true;
            this.bgVideo.muted = true;
            await this.activeVideo.play();
            this.audio.play().catch(() => {});
            this.bgVideo.play().catch(() => {});
        } catch (err) {
            console.warn("Playback error:", err);
        }
    }

    _pauseAll() {
        this.activeVideo.pause();
        this.bgVideo.pause();
        this.audio.pause();
    }

    async _resumeAll() {
        try {
            this.activeVideo.muted = true;
            this.bgVideo.muted = true;
            await this.activeVideo.play();
            this.bgVideo.play().catch(() => {});
            this.audio.play().catch(() => {});
        } catch (err) {
            console.warn("Resume error:", err);
        }
    }

    _isValidIndex(index) {
        return index >= 0 && index < this.playlist.length;
    }

    _notifyChange(item) {
        if (this.onVideoChange) this.onVideoChange(item);
    }

    async _markViewed(item) {
        if (!this.currentPlaylistName || !item.id) return;
        try {
            await markVideoViewed(this.currentPlaylistName, item.id);
            item.lastViewed = new Date().toISOString();
        } catch (err) {
            console.warn("Не удалось обновить время просмотра:", err);
        }
    }
}
