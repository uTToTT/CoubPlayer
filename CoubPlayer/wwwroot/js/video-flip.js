// video-flip.js — 3D flip-переход + tilt для видео-буферов (без React/gsap/framer-motion).

const stage = document.getElementById("videoFlipStage");
const tiltLayer = document.getElementById("videoFlipTilt");
const inner = document.getElementById("videoFlipInner");

let angle = 0;           // накопительный угол поворота .video-flip-inner (кратно 180)
let mode = "crossfade";  // "crossfade" | "flip"

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * Наклон карточки вслед за курсором.
 *
 * Курсор отслеживается на уровне окна, а не на самой сцене: иначе наклон
 * замирал, стоило увести мышь на панель или за пределы кадра — события туда
 * попросту не доходили.
 *
 * Вместо «мёртвой зоны» у краёв (она скачком сбрасывала наклон и масштаб)
 * действует плавное затухание по расстоянию: на карточке эффект полный, дальше
 * сходит на нет. Само значение догоняется покадрово, поэтому движение остаётся
 * мягким даже при рывках мыши.
 *
 * @param {{tiltLimit?: number, tiltScale?: number, tiltEffect?: "attract"|"repel",
 *          falloff?: number, ease?: number}} options
 *        falloff — за сколько «радиусов карточки» эффект гаснет
 *        ease    — доля пути за кадр (меньше — тяжелее и плавнее)
 */
export function initVideoFlip({
    tiltLimit = 10,
    tiltScale = 1.04,
    tiltEffect = "attract",
    falloff = 2.2,
    ease = 0.14,
} = {}) {
    const dir = tiltEffect === "repel" ? -1 : 1;

    const target = { x: 0, y: 0, scale: 1 };
    const current = { x: 0, y: 0, scale: 1 };
    let rafId = null;

    const setTarget = (clientX, clientY) => {
        const rect = inner.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        // Смещение от центра карточки в её же «радиусах»: ±1 на краю кадра
        const dx = (clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
        const dy = (clientY - (rect.top + rect.height / 2)) / (rect.height / 2);

        // За пределами карточки эффект плавно гаснет, а не обрывается
        const distance = Math.hypot(dx, dy);
        const strength = clamp(1 - Math.max(0, distance - 1) / falloff, 0, 1);

        // Угол считаем по позиции внутри карточки, дальше края он не растёт
        const nx = clamp(dx, -1, 1);
        const ny = clamp(dy, -1, 1);

        target.x = -ny * tiltLimit * strength * dir;
        target.y = nx * tiltLimit * strength * dir;
        target.scale = 1 + (tiltScale - 1) * strength;
    };

    const resetTarget = () => {
        target.x = 0;
        target.y = 0;
        target.scale = 1;
    };

    const tick = () => {
        rafId = null;

        current.x += (target.x - current.x) * ease;
        current.y += (target.y - current.y) * ease;
        current.scale += (target.scale - current.scale) * ease;

        tiltLayer.style.setProperty("--tilt-x", `${current.x.toFixed(3)}deg`);
        tiltLayer.style.setProperty("--tilt-y", `${current.y.toFixed(3)}deg`);
        tiltLayer.style.setProperty("--tilt-scale", current.scale.toFixed(4));

        // Досчитали до цели и стоим в покое — останавливаемся до следующего движения
        const settled =
            Math.abs(target.x - current.x) < 0.01 &&
            Math.abs(target.y - current.y) < 0.01 &&
            Math.abs(target.scale - current.scale) < 0.0005;

        if (!settled) schedule();
    };

    const schedule = () => {
        if (rafId === null) rafId = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", (e) => {
        if (mode !== "flip") return;
        setTarget(e.clientX, e.clientY);
        schedule();
    });

    // Курсор ушёл из окна — возвращаем карточку в исходное положение
    document.addEventListener("pointerleave", () => {
        resetTarget();
        schedule();
    });

    window.addEventListener("blur", () => {
        resetTarget();
        schedule();
    });

    /** Сброс при выходе из flip-режима (см. setFlipMode). */
    initVideoFlip._reset = () => {
        resetTarget();
        schedule();
    };
}

export function setFlipMode(enabled) {
    mode = enabled ? "flip" : "crossfade";
    stage.classList.toggle("video-flip-mode", enabled);
    if (!enabled) initVideoFlip._reset?.();
}

export function isFlipMode() {
    return mode === "flip";
}

/**
 * Подгоняет размер .video-flip-inner под пропорции видео (аналог
 * player.js:_fitVideo, но применяется к обёртке, а не к самому video,
 * т.к. в flip-режиме оба <video> заполняют обёртку на 100%).
 */
export function syncFlipStageSize(video) {
    const onMeta = () => {
        if (!video.videoWidth || !video.videoHeight) return;
        const ratio = video.videoWidth / video.videoHeight;
        const maxW = window.innerWidth * 0.75;
        const maxH = window.innerHeight * 0.7;
        let w, h;
        if (ratio > maxW / maxH) { w = maxW; h = maxW / ratio; }
        else { h = maxH; w = maxH * ratio; }
        inner.style.width = `${w}px`;
        inner.style.height = `${h}px`;
    };
    if (video.readyState >= 1) onMeta();
    else video.addEventListener("loadedmetadata", onMeta, { once: true });
}

/**
 * Мгновенно (без анимации) выставляет угол так, чтобы лицевой стороной
 * оказался элемент, соответствующий activeIdx (0 = playerA, 1 = playerB).
 * Нужно при первом входе в flip-режим и при "жёстких" переходах (play()).
 */
export function resetFlipAngle(activeIdx) {
    angle = activeIdx === 0 ? 0 : 180;
    inner.style.transitionDuration = "0ms";
    inner.style.setProperty("--flip-angle", `${angle}deg`);
    void inner.offsetHeight; // форсируем reflow
    inner.style.transitionDuration = "";
}

/**
 * Поворачивает .video-flip-inner ещё на 180° в указанном направлении.
 * direction: 1 = вперёд (next), -1 = назад (prev).
 * Возвращает Promise, резолвится по завершении CSS-перехода.
 */
export function flipTransition(direction = 1, duration = 600) {
    angle += 180 * direction;
    inner.style.transitionDuration = `${duration}ms`;
    inner.style.setProperty("--flip-angle", `${angle}deg`);

    return new Promise((resolve) => {
        const onEnd = (e) => {
            if (e.target !== inner || e.propertyName !== "transform") return;
            inner.removeEventListener("transitionend", onEnd);
            resolve();
        };
        inner.addEventListener("transitionend", onEnd);
    });
}