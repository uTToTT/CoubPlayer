// banner.js — баннеры плейлистов: отрисовка и редактор кадрирования.
//
// Что показывается на плитке плейлиста:
//   • неподвижный кадр — своя картинка, если её загрузили; иначе первый кадр
//     первого ролика плейлиста; если и роликов нет — буква/эмодзи;
//   • анимация при наведении — свой ролик, если его загрузили, иначе тот же
//     первый ролик плейлиста. Всегда без звука.
//
// Своя картинка кадрируется прямо в браузере (перетаскивание + масштаб, как
// при смене аватарки), на сервер уходит уже готовый кадр 16:9 — серверу не
// нужно знать ничего про рамку и зум.

import { coubIdFromKey } from "./playlist.js";

const BANNER_W = 960;
const BANNER_H = 540;
const MAX_ZOOM = 4;

// ─── Источники баннера ────────────────────────────────────────────────────

/** Первый по порядку ролик плейлиста — он же баннер по умолчанию. */
function firstCoubOf(playlistData, coubMap) {
    const entries = Object.entries(playlistData?.videos || {});
    if (!entries.length) return null;

    let best = null;
    for (const [key, meta] of entries) {
        if (!best || (meta.order ?? 0) < (best.order ?? 0)) {
            best = { key, order: meta.order ?? 0 };
        }
    }
    return coubMap?.[coubIdFromKey(best.key)] || null;
}

function emojiForPlaylist(name) {
    const map = {
        bookmarks: "🔖", liked: "❤️", favorites: "⭐", watch: "👁",
        music: "🎵", anime: "✨", funny: "😂", art: "🎨",
        nature: "🌿", games: "🎮", sport: "⚡",
    };
    const lower = String(name).toLowerCase();
    for (const [key, emoji] of Object.entries(map)) {
        if (lower.includes(key)) return emoji;
    }
    return [...String(name)][0] || "📋";
}

// Старые иконки (Data/icons/<имя>.webp) никуда не делись — если у плейлиста
// нет своего баннера, но иконка была поставлена раньше, показываем её.
const _legacyIconCache = new Map();

function legacyIconUrl(name) {
    return `/Data/icons/${encodeURIComponent(name)}.webp`;
}

function legacyIconExists(name) {
    if (!_legacyIconCache.has(name)) {
        _legacyIconCache.set(name, new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = legacyIconUrl(name);
        }));
    }
    return _legacyIconCache.get(name);
}

/** Сбросить кэш проверки старой иконки (после переименования плейлиста). */
export function forgetLegacyIcon(name) {
    _legacyIconCache.delete(name);
}

function bannerFileUrl(fileName) {
    return `/Data/banners/${encodeURIComponent(fileName)}`;
}

// ─── Отрисовка ────────────────────────────────────────────────────────────

/**
 * Собирает элемент баннера плейлиста.
 * @param {string} name
 * @param {object} data — запись плейлиста (videos, banner)
 * @param {{coubMap?: object, animate?: boolean, cacheBust?: number}} options
 * @returns {Promise<HTMLElement>}
 */
export async function buildBannerEl(name, data, { coubMap, animate = true, cacheBust } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "pl-banner";

    const bust = cacheBust ? `?t=${cacheBust}` : "";
    const coub = firstCoubOf(data, coubMap);

    const stillSrc = data?.banner?.image
        ? bannerFileUrl(data.banner.image) + bust
        : (await legacyIconExists(name)) ? legacyIconUrl(name) + bust : null;

    const animSrc = data?.banner?.video
        ? bannerFileUrl(data.banner.video) + bust
        : coub?.video || null;

    if (stillSrc) {
        const img = document.createElement("img");
        img.className = "pl-banner-still";
        img.src = stillSrc;
        img.alt = "";
        img.draggable = false;
        wrap.appendChild(img);
        wrap.classList.add("pl-banner--has-still");
    }

    if (animSrc && animate) {
        const video = document.createElement("video");
        video.className = "pl-banner-video";
        video.muted = true;          // анимация баннера всегда без звука
        video.loop = true;
        video.playsInline = true;
        video.draggable = false;
        video.preload = "metadata";
        // #t=0.1 — чтобы браузер отрисовал кадр, не дожидаясь воспроизведения:
        // без своей картинки именно он и служит неподвижным баннером
        video.src = animSrc + (animSrc.includes("#") ? "" : "#t=0.1");
        video.addEventListener("loadeddata", () => video.classList.add("is-ready"));
        wrap.appendChild(video);
    }

    if (!stillSrc && !animSrc) {
        const fallback = document.createElement("span");
        fallback.className = "pl-banner-fallback";
        fallback.textContent = emojiForPlaylist(name);
        wrap.appendChild(fallback);
    }

    return wrap;
}

/**
 * Вешает запуск анимации при наведении. Отдельно от сборки, чтобы вызывающий
 * сам решал, на каком элементе ловить курсор (плитка целиком, а не баннер).
 * @param {HTMLElement} hoverTarget
 * @param {HTMLElement} bannerEl
 */
export function bindBannerHover(hoverTarget, bannerEl) {
    const video = bannerEl.querySelector(".pl-banner-video");
    if (!video) return;

    hoverTarget.addEventListener("mouseenter", () => {
        video.play().catch(() => { });
    });
    hoverTarget.addEventListener("mouseleave", () => {
        video.pause();
        try { video.currentTime = 0.1; } catch { /* метаданные ещё не готовы */ }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Редактор кадрирования
// ═══════════════════════════════════════════════════════════════════════════

const overlay = document.getElementById("bannerCropOverlay");
const panel = document.getElementById("bannerCropPanel");
const subtitle = document.getElementById("bannerCropSubtitle");
const frame = document.getElementById("bannerCropFrame");
const image = document.getElementById("bannerCropImage");
const zoomInput = document.getElementById("bannerCropZoom");
const closeBtn = document.getElementById("bannerCropClose");
const cancelBtn = document.getElementById("bannerCropCancel");
const saveBtn = document.getElementById("bannerCropSave");

let _state = null;   // { natW, natH, baseScale, zoom, x, y }
let _resolve = null;
let _objectUrl = null;

/**
 * Открывает редактор кадрирования и возвращает готовый кадр 16:9.
 * @param {File} file
 * @param {string} playlistName
 * @returns {Promise<Blob|null>} null — пользователь отменил
 */
export function cropBannerImage(file, playlistName) {
    return new Promise((resolve) => {
        _resolve = resolve;
        subtitle.textContent = playlistName;

        if (_objectUrl) URL.revokeObjectURL(_objectUrl);
        _objectUrl = URL.createObjectURL(file);

        image.onload = () => {
            const rect = frame.getBoundingClientRect();
            const baseScale = Math.max(
                rect.width / image.naturalWidth,
                rect.height / image.naturalHeight
            );
            _state = {
                natW: image.naturalWidth,
                natH: image.naturalHeight,
                baseScale,
                zoom: 1,
                x: 0,
                y: 0,
            };
            zoomInput.value = 1;
            applyTransform();
        };
        image.src = _objectUrl;

        overlay.classList.add("show");
    });
}

function frameSize() {
    const rect = frame.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
}

/** Держит картинку так, чтобы она всегда полностью накрывала рамку. */
function clampOffsets() {
    const { w, h } = frameSize();
    const eff = _state.baseScale * _state.zoom;
    const maxX = Math.max(0, (_state.natW * eff - w) / 2);
    const maxY = Math.max(0, (_state.natH * eff - h) / 2);

    _state.x = Math.max(-maxX, Math.min(maxX, _state.x));
    _state.y = Math.max(-maxY, Math.min(maxY, _state.y));
}

function applyTransform() {
    if (!_state) return;
    clampOffsets();
    const eff = _state.baseScale * _state.zoom;
    image.style.width = `${_state.natW * eff}px`;
    image.style.height = `${_state.natH * eff}px`;
    image.style.transform = `translate(calc(-50% + ${_state.x}px), calc(-50% + ${_state.y}px))`;
}

function closeCropper(result) {
    overlay.classList.remove("show");
    _state = null;
    if (_objectUrl) {
        URL.revokeObjectURL(_objectUrl);
        _objectUrl = null;
    }
    image.removeAttribute("src");

    const resolve = _resolve;
    _resolve = null;
    resolve?.(result);
}

/** Переводит видимую в рамке область обратно в координаты картинки. */
function exportCrop() {
    return new Promise((resolve) => {
        const { w, h } = frameSize();
        const eff = _state.baseScale * _state.zoom;

        const sw = w / eff;
        const sh = h / eff;
        const sx = _state.natW / 2 - (w / 2 + _state.x) / eff;
        const sy = _state.natH / 2 - (h / 2 + _state.y) / eff;

        const canvas = document.createElement("canvas");
        canvas.width = BANNER_W;
        canvas.height = BANNER_H;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, BANNER_W, BANNER_H);

        canvas.toBlob((blob) => resolve(blob), "image/webp", 0.9);
    });
}

// ─── Взаимодействие ───────────────────────────────────────────────────────

export function initBannerCropper() {
    let dragging = false;
    let startX = 0;
    let startY = 0;

    frame.addEventListener("pointerdown", (e) => {
        if (!_state) return;
        dragging = true;
        startX = e.clientX - _state.x;
        startY = e.clientY - _state.y;
        frame.setPointerCapture(e.pointerId);
        frame.classList.add("is-dragging");
    });

    frame.addEventListener("pointermove", (e) => {
        if (!dragging || !_state) return;
        _state.x = e.clientX - startX;
        _state.y = e.clientY - startY;
        applyTransform();
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        frame.classList.remove("is-dragging");
        try { frame.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ }
    };
    frame.addEventListener("pointerup", endDrag);
    frame.addEventListener("pointercancel", endDrag);

    frame.addEventListener("wheel", (e) => {
        if (!_state) return;
        e.preventDefault();
        const next = _state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
        _state.zoom = Math.max(1, Math.min(MAX_ZOOM, next));
        zoomInput.value = _state.zoom;
        applyTransform();
    }, { passive: false });

    zoomInput.addEventListener("input", () => {
        if (!_state) return;
        _state.zoom = Number(zoomInput.value);
        applyTransform();
    });

    saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!_state) return;
        saveBtn.disabled = true;
        try {
            const blob = await exportCrop();
            closeCropper(blob);
        } finally {
            saveBtn.disabled = false;
        }
    });

    const cancel = (e) => {
        e?.stopPropagation();
        closeCropper(null);
    };
    cancelBtn.addEventListener("click", cancel);
    closeBtn.addEventListener("click", cancel);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && overlay.classList.contains("show")) {
            e.preventDefault();
            e.stopPropagation();
            closeCropper(null);
        }
    }, true);

    // Клик мимо панели — отмена
    overlay.addEventListener("click", (e) => {
        if (!panel.contains(e.target)) closeCropper(null);
    });

    window.addEventListener("resize", applyTransform);
}
