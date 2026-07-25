// video-flip.js — 3D flip-переход + tilt для видео-буферов (без React/gsap/framer-motion).

const stage = document.getElementById("videoFlipStage");
const tiltLayer = document.getElementById("videoFlipTilt");
const inner = document.getElementById("videoFlipInner");

let angle = 0;           // накопительный угол поворота .video-flip-inner (кратно 180)
let mode = "crossfade";  // "crossfade" | "flip"

/**
 * Включает обработку mousemove/mouseleave на сцене для tilt-эффекта.
 * Работает только когда активен режим "flip" (см. setFlipMode).
 */
export function initVideoFlip({ tiltLimit = 15, tiltScale = 1.23, tiltEffect = "repel" } = {}) {
    const mult = tiltEffect === "repel" ? -1 : 1;

    stage.addEventListener("mousemove", (e) => {
        if (mode !== "flip") return;
        const rect = stage.getBoundingClientRect();
        const tiltX = ((e.clientY - rect.top) / rect.height - 0.5) * (tiltLimit * 2) * mult;
        const tiltY = ((e.clientX - rect.left) / rect.width - 0.5) * -(tiltLimit * 2) * mult;
        tiltLayer.style.setProperty("--tilt-x", `${tiltX}deg`);
        tiltLayer.style.setProperty("--tilt-y", `${tiltY}deg`);
        tiltLayer.style.setProperty("--tilt-scale", tiltScale);
    });

    stage.addEventListener("mouseleave", () => {
        tiltLayer.style.setProperty("--tilt-x", "0deg");
        tiltLayer.style.setProperty("--tilt-y", "0deg");
        tiltLayer.style.setProperty("--tilt-scale", "1");
    });
}

export function setFlipMode(enabled) {
    mode = enabled ? "flip" : "crossfade";
    stage.classList.toggle("video-flip-mode", enabled);
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