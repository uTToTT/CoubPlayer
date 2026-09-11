// player.js
import { markVideoViewed } from "./api.js";
import { setLastVideoForPlaylist, getLastVideoForPlaylist } from "./state.js";
import { initVideoFlip, setFlipMode, syncFlipStageSize, flipTransition, resetFlipAngle } from "./video-flip.js";
import { composeSettings, NEUTRAL_SETTINGS } from "./randomizer.js";

export class Player {
    /** Длительность затухания фона при смене источника, мс (см. style.css). */
    static BG_FADE_MS = 190;

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

        // Рандомизатор настроек (см. randomizer.js). null = эффекты выключены.
        this._effects = null;
        // Строка CSS filter, наложенная на каждый буфер эффектами. Хранится
        // отдельно, потому что кроссфейд анимирует filter и должен подмешивать
        // свой blur() к уже наложенному эффекту, а не затирать его.
        this._fxFilter = new WeakMap();

        // Компенсация поворота фона зависит от пропорций окна
        this._bgFx = null;
        // Фон может показывать не активное видео, а плитку под курсором (сетка)
        this._bgSourceEl = null;
        this._bgSwapTimer = null;

        window.addEventListener("resize", () => {
            this._fitVideo(this.activeVideo);
            if (this.transitionMode === "flip") syncFlipStageSize(this.activeVideo);
            if (this._bgFx) {
                this.bgCanvas.style.setProperty("--bg-fx-scale", this._bgCoverScale(this._bgFx));
            }
        });

        this._bgRafId = null;
        this._startBgLoop();
        this.transitionMode = "crossfade"; // "crossfade" | "flip"
        initVideoFlip({ tiltLimit: 15, tiltScale: 1.23, tiltEffect: "repel" });
    }

    _startBgLoop() {
        const draw = () => {
            // Источником фона может быть не активное видео, а превью из сетки
            const v = this._bgSourceEl || this.activeVideo;
            if (v.readyState >= 2 && v.videoWidth > 0) {
                const canvas = this.bgCanvas;
                if (canvas.width !== window.innerWidth) canvas.width = window.innerWidth;
                if (canvas.height !== window.innerHeight) canvas.height = window.innerHeight;
                this._drawCover(v, canvas.width, canvas.height);
            }
            this._bgRafId = requestAnimationFrame(draw);
        };
        draw();
    }

    // Рисует кадр видео в canvas по принципу object-fit: cover —
    // с сохранением пропорций и обрезкой лишнего по краям,
    // вместо растягивания всего кадра в размеры canvas.
    _drawCover(video, dw, dh) {
        const sw = video.videoWidth;
        const sh = video.videoHeight;
        if (!sw || !sh) return;

        const srcRatio = sw / sh;
        const dstRatio = dw / dh;

        let sx, sy, sWidth, sHeight;
        if (srcRatio > dstRatio) {
            // видео шире экрана — обрезаем по бокам
            sHeight = sh;
            sWidth = sh * dstRatio;
            sx = (sw - sWidth) / 2;
            sy = 0;
        } else {
            // видео выше экрана — обрезаем сверху/снизу
            sWidth = sw;
            sHeight = sw / dstRatio;
            sx = 0;
            sy = (sh - sHeight) / 2;
        }

        this.bgCtx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, dw, dh);
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
        const savedKey = getLastVideoForPlaylist(this.currentPlaylistName);
        if (savedKey == null) return 0;
        const idx = this.playlist.findIndex((item) => item.key === savedKey);
        return idx === -1 ? 0 : idx;
    }

    /**
     * Подключает рандомизатор настроек (randomizer.js) или снимает его (null).
     * Эффекты применяются к текущему ролику сразу, к следующим — при переключении.
     * @param {{settingsFor: (id: string) => {speed: number, filter: string, transform: string}} | null} randomizer
     */
    setEffects(randomizer) {
        this._effects = randomizer || null;
        this.refreshEffects();
        // Второй буфер сбрасываем в нейтральное состояние: свои настройки он
        // получит при переключении, а так на нём могли остаться прошлые
        this._applyEffects(this.nextVideo, null);
    }

    /** Пересчитать и применить эффекты текущего ролика (например, после правки fx). */
    refreshEffects() {
        this._applyEffects(this.activeVideo, this.playlist[this.index] || null);
    }

    /**
     * Показывать в фоне не активное видео, а конкретный элемент —
     * плитку под курсором в режиме сетки. Смена источника проходит через
     * затухание, иначе фон дёргано перескакивал бы между роликами.
     * @param {HTMLVideoElement|null} videoEl — null возвращает фон к активному видео
     * @param {object|null} item — запись плейлиста, чью постобработку показать
     */
    setBgPreview(videoEl, item) {
        if (this._bgSourceEl === videoEl) return;

        clearTimeout(this._bgSwapTimer);
        this.bgCanvas.classList.add("bg-fading");

        this._bgSwapTimer = setTimeout(() => {
            this._bgSourceEl = videoEl;
            this._applyBgEffects(item ?? this.playlist[this.index] ?? null);
            this.bgCanvas.classList.remove("bg-fading");
        }, Player.BG_FADE_MS);
    }

    /** Вернуть фон к текущему ролику плеера. */
    clearBgPreview() {
        this.setBgPreview(null, null);
    }

    /**
     * Настройки фона. «Вместе» — те же, что у видео (включая случайные из
     * «Безумия»); «отдельно» — только то, что задано фону вручную.
     */
    _bgSettingsFor(item) {
        if (!item) return NEUTRAL_SETTINGS;
        return item.bgSeparate
            ? composeSettings(item.bgFx || {})
            : this._settingsFor(item);
    }

    /**
     * Накладывает постобработку на фон-канвас.
     * Через CSS-переменные, а не через ctx.filter: фон рисуется каждый кадр
     * на весь экран, и фильтровать его в canvas было бы заметно дороже.
     * Скорость к фону не применяется — канвас просто перерисовывает кадры
     * активного видео и повторяет его темп сам.
     */
    _applyBgEffects(item) {
        const bg = this._bgSettingsFor(item);
        this._bgFx = bg;

        this.bgCanvas.style.setProperty("--bg-fx-filter", bg.filter);
        this.bgCanvas.style.setProperty("--bg-fx-transform", bg.transform);
        this.bgCanvas.style.setProperty("--bg-fx-scale", this._bgCoverScale(bg));
    }

    /**
     * Во сколько раз растянуть фон, чтобы повёрнутый кадр всё ещё накрывал
     * экран целиком и по углам не появлялись пустые треугольники.
     */
    _bgCoverScale(bg) {
        const BASE = 1.05;
        const angle = Number(bg?.values?.rotate) || 0;
        if (!angle) return BASE;

        const rad = (Math.abs(angle) * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;

        return BASE * Math.max(cos + (sin * h) / w, cos + (sin * w) / h);
    }

    /**
     * Итоговые настройки ролика.
     * Случайные (режим «Безумие») служат основой, персональные настройки
     * записи плейлиста накладываются сверху — вручную выставленное всегда
     * важнее выпавшего. Ключ — item.key, а не item.id: у копий одного ролика
     * настройки свои.
     */
    _settingsFor(item) {
        if (!item) return NEUTRAL_SETTINGS;
        const random = this._effects?.valuesFor(item.key) || null;
        if (!random && !item.fx) return NEUTRAL_SETTINGS;
        return composeSettings({ ...random, ...(item.fx || {}) });
    }

    /**
     * Накладывает эффекты на конкретный видео-буфер.
     * transform идёт через CSS-переменную --fx-transform, а не через style.transform:
     * у .video-flip-face уже есть собственный transform (центрирование в кроссфейде,
     * поворот задней грани в flip-режиме), и перетереть его нельзя.
     * Скорость выставляется и видео, и аудио — иначе дорожки разъедутся.
     */
    _applyEffects(videoEl, item) {
        if (!videoEl) return;
        const fx = this._settingsFor(item);

        this._fxFilter.set(videoEl, fx.filter);
        videoEl.style.filter = fx.filter;
        videoEl.style.setProperty("--fx-transform", fx.transform);

        // defaultPlaybackRate тоже — при загрузке нового src браузер сбрасывает
        // playbackRate именно в него, иначе скорость слетала бы на 1
        videoEl.defaultPlaybackRate = fx.speed;
        videoEl.playbackRate = fx.speed;
        if (videoEl === this.activeVideo) {
            this.audio.defaultPlaybackRate = fx.speed;
            this.audio.playbackRate = fx.speed;
            this._applyBgEffects(item);
        }
    }

    /** Возвращает буферу тот filter, который на нём должен быть по эффектам. */
    _restoreFilter(videoEl) {
        videoEl.style.filter = this._fxFilter.get(videoEl) || "";
    }

    /** Строка filter буфера с подмешанным blur для анимации перехода. */
    _filterWithBlur(videoEl, blurPx) {
        const base = this._fxFilter.get(videoEl) || "";
        return `${base} blur(${blurPx}px)`.trim();
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
            this._restoreFilter(v);
            v.style.display = "block";
        });
        if (this.transitionMode !== "flip") {
            this.nextVideo.style.display = "none";
        }

        this.activeVideo.src = item.video;
        this.audio.src = item.audio;
        this._applyEffects(this.activeVideo, item);

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

    async resume() {
        await this._resumeAll();
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
        incoming.style.display = "block";

        this.audio.src = newItem.audio;

        outgoing.pause();
        this.activeIdx = 1 - this.activeIdx;
        this.index = newIndex;

        this._applyEffects(incoming, newItem);
        incoming.style.filter = this._filterWithBlur(incoming, 12);

        await this._playAll();

        if (generation !== this._generation) {
            // Нас обогнало следующее переключение — анимацию не заводим,
            // но blur, выставленный до await, снять обязаны: иначе буфер
            // так и останется размытым
            this._restoreFilter(incoming);
            return;
        }

        const DURATION = 320;
        const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

        // blur подмешивается к фильтру эффектов, иначе анимация затирала бы его
        // на время перехода и ролик «моргал» бы настройками
        const fadeIn = incoming.animate(
            [
                { opacity: 0, filter: this._filterWithBlur(incoming, 12) },
                { opacity: 1, filter: this._filterWithBlur(incoming, 0) },
            ],
            { duration: DURATION, easing: EASING, fill: "forwards" }
        );

        const fadeOut = outgoing.animate(
            [
                { opacity: 1, filter: this._filterWithBlur(outgoing, 0) },
                { opacity: 0, filter: this._filterWithBlur(outgoing, 12) },
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
            this._restoreFilter(incoming);
            outgoing.style.display = "none";
            outgoing.style.opacity = "1";
            this._restoreFilter(outgoing);
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
        incoming.src = newItem.video;
        this.audio.src = newItem.audio;

        outgoing.pause();
        this.activeIdx = 1 - this.activeIdx;
        this.index = newIndex;

        this._applyEffects(incoming, newItem);

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
            this._restoreFilter(this._pendingOutgoing);
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
        setLastVideoForPlaylist(this.currentPlaylistName, item.key);
        if (this.onVideoChange) this.onVideoChange(item);
    }

    async _markViewed(item) {
        if (!this.currentPlaylistName || !item.key) return;
        if (this.isVirtualPlaylist(this.currentPlaylistName)) return;
        try {
            await markVideoViewed(this.currentPlaylistName, item.key);
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
                this._restoreFilter(v);
            });
            syncFlipStageSize(this.activeVideo);
            resetFlipAngle(this.activeIdx);
        } else {
            resetFlipAngle(this.activeIdx);
            this.nextVideo.style.display = "none";
            this.activeVideo.style.display = "block";
            this.activeVideo.style.opacity = "1";
            this._restoreFilter(this.activeVideo);
        }
    }
}