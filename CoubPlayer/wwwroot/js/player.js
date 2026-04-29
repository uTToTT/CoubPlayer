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

        this._generation = 0;

        this._activeAnimations = null;
        this._pendingOutgoing = null;

        window.addEventListener("resize", () => {
            this._fitVideo(this.activeVideo);
        });
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

    getVolume() {
        return Math.round(this.audio.volume * 100);
    }

    /** Запустить видео по индексу (первый запуск или после setPlaylist) */
    async play(index) {
        if (!this._isValidIndex(index)) return;

        this._cancelTransition();
        this._generation++;

        this.index = index;
        const item = this.playlist[index];

        // Сбрасываем оба буфера в видимое состояние
        this.videoEls.forEach((v) => {
            v.style.opacity = "1";
            v.style.filter = "";
            v.style.display = "block";
        });
        // Прячем неактивный буфер
        this.nextVideo.style.display = "none";

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

        // Отменяем предыдущую анимацию и инкрементируем поколение.
        // Все колбэки предыдущего вызова увидят устаревший токен и выйдут.
        this._cancelTransition();
        const generation = ++this._generation;

        const newItem = this.playlist[newIndex];
        const incoming = this.nextVideo;
        const outgoing = this.activeVideo;

        // ── 1. Подготовка incoming: в DOM, но полностью прозрачный ───────────
        incoming.src = newItem.video;
        incoming.style.opacity = "0";
        incoming.style.filter = "blur(12px)";
        incoming.style.display = "block";

        this.audio.src = newItem.audio;
        this._animateBg(newItem.video);

        // ── 2. Swap буфера ────────────────────────────────────────────────────
        outgoing.pause();
        this.activeIdx = 1 - this.activeIdx;
        this.index = newIndex;

        // ── 3. Запуск воспроизведения — await может занять время, за которое
        //       придёт следующий _switchTo. После await проверяем токен.
        await this._playAll();

        if (generation !== this._generation) return; // устарели — выходим

        // ── 4. Параллельный crossfade ─────────────────────────────────────────
        const DURATION = 320;
        const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

        const fadeIn = incoming.animate(
            [
                { opacity: 0, filter: "blur(12px)" },
                { opacity: 1, filter: "blur(0px)" },
            ],
            { duration: DURATION, easing: EASING, fill: "forwards" }
        );

        const fadeOut = outgoing.animate(
            [
                { opacity: 1, filter: "blur(0px)" },
                { opacity: 0, filter: "blur(12px)" },
            ],
            { duration: DURATION, easing: EASING, fill: "forwards" }
        );

        this._activeAnimations = [fadeIn, fadeOut];
        this._pendingOutgoing = outgoing;

        fadeIn.finished.then(() => {
            // Проверяем токен — если устарел, DOM уже привёл в порядок
            // следующий _switchTo через _cancelTransition(). Не трогаем ничего.
            if (generation !== this._generation) return;

            incoming.style.opacity = "1";
            incoming.style.filter = "";
            outgoing.style.display = "none";
            outgoing.style.opacity = "1";
            outgoing.style.filter = "";
            this._activeAnimations = null;
            this._pendingOutgoing = null;
        }).catch(() => { });

        this._notifyChange(newItem);
        this._markViewed(newItem);
    }

    _animateBg(src) {
        const bg = this.bgVideo;

        // Прерываем предыдущую bg-анимацию если есть
        if (this._bgAnimation) {
            this._bgAnimation.cancel();
            this._bgAnimation = null;
        }

        const fadeOut = bg.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: 200, easing: "ease", fill: "forwards" }
        );

        this._bgAnimation = fadeOut;

        fadeOut.finished.then(() => {
            bg.src = src;
            bg.play().catch(() => { });

            const fadeIn = bg.animate(
                [{ opacity: 0 }, { opacity: 1 }],
                { duration: 300, easing: "ease", fill: "forwards" }
            );

            this._bgAnimation = fadeIn;

            fadeIn.finished.then(() => {
                bg.style.opacity = "1";
                this._bgAnimation = null;
            }).catch(() => { });
        }).catch(() => { });
    }

    _cancelTransition() {
        if (this._activeAnimations) {
            this._activeAnimations.forEach((a) => a.cancel());
            this._activeAnimations = null;
        }

        if (this._pendingOutgoing) {
            // Мгновенно скрываем outgoing — он больше не нужен
            this._pendingOutgoing.style.display = "none";
            this._pendingOutgoing.style.opacity = "1";
            this._pendingOutgoing.style.filter = "";
            this._pendingOutgoing = null;
        }
    }

    _fitVideo(video) {
        const onMeta = () => {
            const ratio = video.videoWidth / video.videoHeight;
            const maxW = window.innerWidth * 0.8;
            const maxH = window.innerHeight * 0.7;

            let w, h;
            if (ratio > maxW / maxH) {
                w = maxW; h = maxW / ratio;
            } else {
                h = maxH; w = maxH * ratio;
            }

            video.style.width = w + "px";
            video.style.height = h + "px";
        };

        if (video.readyState >= 1) {
            onMeta();
        } else {
            video.addEventListener("loadedmetadata", onMeta, { once: true });
        }
    }

    async _playAll() {
        try {
            this.activeVideo.muted = true;
            this.bgVideo.muted = true;
            this._fitVideo(this.activeVideo);
            await this.activeVideo.play();
            this.audio.play().catch(() => { });
            this.bgVideo.play().catch(() => { });
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
            this.bgVideo.play().catch(() => { });
            this.audio.play().catch(() => { });
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
