// player.js
import { markVideoViewed } from "./api.js";
import { setLastVideoForPlaylist, getLastVideoForPlaylist } from "./state.js";
import { initVideoFlip, setFlipMode, syncFlipStageSize, flipTransition, resetFlipAngle } from "./video-flip.js";

export class Player {
    constructor(videoEls, audioEl, bgVideoEl) {
        this.videoEls = videoEls;
        this.audio = audioEl;
        this.bgCanvas = bgVideoEl;
        this.bgCtx = this.bgCanvas.getContext("2d");

        this.activeIdx = 0;
        this.index = 0;
        this.playlist = [];
        this.currentPlaylistName = null;

        this.onVideoChange = null;
        this.onPlayStateChange = null;
        this._generation = 0;

        this.isVirtualPlaylist = () => false;

        this._activeAnimations = null;
        this._pendingOutgoing = null;

        window.addEventListener("resize", () => {
            this._fitVideo(this.activeVideo);
            if (this.transitionMode === "flip") syncFlipStageSize(this.activeVideo);
        });

        this._bgRafId = null;
        this._startBgLoop();
        this.transitionMode = "crossfade"; // "crossfade" | "flip"
        initVideoFlip({ tiltLimit: 15, tiltScale: 1.23, tiltEffect: "repel" });
    }

    _startBgLoop() {
        const draw = () => {
            const v = this.activeVideo;
            if (v.readyState >= 2 && v.videoWidth > 0) {
                const canvas = this.bgCanvas;
                if (canvas.width !== window.innerWidth) canvas.width = window.innerWidth;
                if (canvas.height !== window.innerHeight) canvas.height = window.innerHeight;
                this.bgCtx.drawImage(v, 0, 0, canvas.width, canvas.height);
            }
            this._bgRafId = requestAnimationFrame(draw);
        };
        draw();
    }

    getCurrentTime() {
        return this.audio.currentTime || 0;
    }

    getDuration() {
        const d = this.audio.duration;
        return isFinite(d) ? d : 0;
    }



    /**
     * Перемотка. Ведущий трек — audio. Основной видео-буфер зациклен и короче
     * аудио, синкаем его по модулю своей длительности. Canvas-фон синхронизировать
     * не нужно — он каждый rAF рисует актуальный кадр activeVideo сам по себе.
     */
    seek(time) {
        const duration = this.getDuration();
        if (!duration) return;

        const clamped = Math.max(0, Math.min(duration, time));
        this.audio.currentTime = clamped;

        const videoDur = this.activeVideo.duration;
        if (videoDur && isFinite(videoDur) && videoDur > 0) {
            this.activeVideo.currentTime = clamped % videoDur;
        }
    }

    get activeVideo() {
        return this.videoEls[this.activeIdx];
    }

    get nextVideo() {
        return this.videoEls[1 - this.activeIdx];
    }

    setPlaylist(list, playlistName = null) {
        this.playlist = list;
        if (playlistName !== null) this.currentPlaylistName = playlistName;
    }

    setVirtualPlaylistPredicate(predicate) {
        this.isVirtualPlaylist = predicate;
    }

    getStartIndex() {
        const savedId = getLastVideoForPlaylist(this.currentPlaylistName);
        if (savedId == null) return 0;
        const idx = this.playlist.findIndex((item) => item.id === savedId);
        return idx === -1 ? 0 : idx;
    }

    setVolume(value) {
        const vol = Math.max(0, Math.min(1, value / 100));
        this.audio.volume = vol;
        this.videoEls.forEach((v) => (v.volume = vol));
        // bgCanvas беззвучен по определению — трогать нечего
    }

    getVolume() {
        return Math.round(this.audio.volume * 100);
    }

    async play(index) {
        if (!this._isValidIndex(index)) return;
        if (this._switching) return;
        this._cancelTransition();
        this._generation++;

        this.index = index;
        const item = this.playlist[index];

        this.videoEls.forEach((v) => {
            v.style.opacity = "1";
            v.style.filter = "";
            v.style.display = "block";
        });
        if (this.transitionMode !== "flip") {
            this.nextVideo.style.display = "none";
        }

        this.activeVideo.src = item.video;
        this.audio.src = item.audio;

        if (this.transitionMode === "flip") {
            syncFlipStageSize(this.activeVideo);
            resetFlipAngle(this.activeIdx);
        }

        await this._playAll();
        this._notifyChange(item);
        this._markViewed(item);
    }

    async playPaused(index) {
        await this.play(index);
        this._pauseAll();
    }

    async goToNext() {
        await this._switchTo(this.index + 1);
    }

    async goToPrev() {
        await this._switchTo(this.index - 1);
    }

    async goToIndex(userIndex) {
        const index = Number(userIndex) - 1;
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

    get isPaused() {
        return this.activeVideo.paused;
    }

    async restart() {
        this.activeVideo.currentTime = 0;
        this.audio.currentTime = 0;
        await this._resumeAll();
    }

    async _switchTo(newIndex) {
        if (!this._isValidIndex(newIndex)) return;
        if (this._switching) return;           // ← игнорируем клики во время перехода
        this._switching = true;
        try {
            const dir = newIndex > this.index ? 1 : -1;
            if (this.transitionMode === "flip") {
                await this._switchFlip(newIndex, dir);
            } else {
                await this._switchCrossfade(newIndex);
            }
        } finally {
            this._switching = false;
        }
    }

    // ─── Кроссфейд (оригинальная логика, без изменений) ───────────────────
    async _switchCrossfade(newIndex) {
        this._cancelTransition();
        const generation = ++this._generation;

        const newItem = this.playlist[newIndex];
        const incoming = this.nextVideo;
        const outgoing = this.activeVideo;

        incoming.src = newItem.video;
        incoming.style.opacity = "0";
        incoming.style.filter = "blur(12px)";
        incoming.style.display = "block";

        this.audio.src = newItem.audio;

        outgoing.pause();
        this.activeIdx = 1 - this.activeIdx;
        this.index = newIndex;

        await this._playAll();

        if (generation !== this._generation) return;

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
            if (generation !== this._generation) return;

            fadeIn.cancel();
            fadeOut.cancel();

            incoming.style.opacity = "1";
            incoming.style.filter = "";
            outgoing.style.display = "none";
            outgoing.style.opacity = "1";
            outgoing.style.filter = "";
            this._activeAnimations = null;
            this._pendingOutgoing = null;
        }).catch(() => {
            // На случай если finished реджектится (например, из-за _cancelTransition извне) —
            // всё равно подчищаем, чтобы не оставлять зависший fill:forwards эффект.
            fadeIn.cancel();
            fadeOut.cancel();
        });
        this._notifyChange(newItem);
        this._markViewed(newItem);
    }

    // ─── Flip — 3D-переворот ────────────────────────────────────────────────
    async _switchFlip(newIndex, dir) {
        this._cancelTransition();
        const generation = ++this._generation;

        const newItem = this.playlist[newIndex];
        const incoming = this.nextVideo;
        const outgoing = this.activeVideo;

        incoming.style.display = "block";
        incoming.style.opacity = "1";
        incoming.style.filter = "";
        incoming.src = newItem.video;
        this.audio.src = newItem.audio;

        outgoing.pause();
        this.activeIdx = 1 - this.activeIdx;
        this.index = newIndex;

        syncFlipStageSize(incoming);

        // Поворот — сразу, синхронно с toggle activeIdx, а не после await.
        // Так angle и activeIdx физически не могут разойтись по чётности.
        flipTransition(dir, 600).catch(() => { });

        await this._playAll();
        if (generation !== this._generation) return; // теперь эта проверка нужна
        // только для notify/markViewed —
        // визуальное состояние уже консистентно
        this._notifyChange(newItem);
        this._markViewed(newItem);
    }

    _cancelTransition() {
        if (this._activeAnimations) {
            this._activeAnimations.forEach((a) => a.cancel());
            this._activeAnimations = null;
        }

        if (this._pendingOutgoing) {
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
        const video = this.activeVideo;   // ← зафиксировать один раз
        try {
            video.muted = true;
            this._fitVideo(video);
            await video.play();
            video.addEventListener("play", () => this.onPlayStateChange?.(false), { once: false });
            video.addEventListener("pause", () => this.onPlayStateChange?.(true), { once: false });
            this.audio.play().catch(() => { });
            this.onPlayStateChange?.(false);
        } catch (err) {
            console.warn("Playback error:", err);
        }
    }

    _pauseAll() {
        this.activeVideo.pause();
        this.audio.pause();
        this.onPlayStateChange?.(true);
    }

    async _resumeAll() {
        try {
            this.activeVideo.muted = true;
            await this.activeVideo.play();
            this.activeVideo.addEventListener("play", () => this.onPlayStateChange?.(false), { once: false });
            this.activeVideo.addEventListener("pause", () => this.onPlayStateChange?.(true), { once: false });
            this.audio.play().catch(() => { });
            this.onPlayStateChange?.(false);
        } catch (err) {
            console.warn("Resume error:", err);
        }
    }

    _isValidIndex(index) {
        return index >= 0 && index < this.playlist.length;
    }

    _notifyChange(item) {
        setLastVideoForPlaylist(this.currentPlaylistName, item.id);
        if (this.onVideoChange) this.onVideoChange(item);
    }

    async _markViewed(item) {
        if (!this.currentPlaylistName || !item.id) return;
        if (this.isVirtualPlaylist(this.currentPlaylistName)) return;
        try {
            await markVideoViewed(this.currentPlaylistName, item.id);
            item.lastViewed = new Date().toISOString();
        } catch (err) {
            console.warn("Не удалось обновить время просмотра:", err);
        }
    }

    setTransitionMode(mode) {
        this._cancelTransition();
        // Дополнительная страховка: снять вообще все WAAPI-анимации с обоих буферов,
        // даже если _activeAnimations уже null (например, они успели дозавершиться).
        this.videoEls.forEach((v) => {
            v.getAnimations().forEach((a) => a.cancel());
        });

        this.transitionMode = mode === "flip" ? "flip" : "crossfade";
        setFlipMode(this.transitionMode === "flip");

        if (this.transitionMode === "flip") {
            this.videoEls.forEach((v) => {
                v.style.display = "block";
                v.style.opacity = "1";
                v.style.filter = "";
            });
            syncFlipStageSize(this.activeVideo);
            resetFlipAngle(this.activeIdx);
        } else {
            resetFlipAngle(this.activeIdx);
            this.nextVideo.style.display = "none";
            this.activeVideo.style.display = "block";
            this.activeVideo.style.opacity = "1";
            this.activeVideo.style.filter = "";
        }
    }
}