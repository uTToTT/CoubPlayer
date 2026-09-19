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
import { getPlaylistIcons, getCoubThumbs, saveCoubThumb } from "./api.js";

const BANNER_W = 960;
const BANNER_H = 540;
const MAX_ZOOM = 4;

// Насколько заранее готовить баннер — примерно на экран вперёд, чтобы при
// обычной прокрутке он успевал появиться до того, как окажется на виду
const PRELOAD_MARGIN = "300px";

// Потолок на число одновременно живых <video>. Браузер держит на каждый
// декодер и соединение, и после нескольких десятков начинает захлёбываться
// даже без нашей помощи. Видно одновременно заметно меньше
const MAX_LIVE_VIDEOS = 24;

// Сколько видео грузится одновременно. Запускать все разом — значит делить
// канал на всех: готовы они окажутся примерно тогда же, но все сразу и в
// конце. По очереди первые появляются почти мгновенно, а остальные дотекают
const MAX_CONCURRENT_LOADS = 4;

// Кадр для превью. Баннер на экране около 215×121, так что 480 в ширину —
// с запасом и под экраны с высокой плотностью
const THUMB_W = 480;
const THUMB_H = 270;

// ─── Источники баннера ────────────────────────────────────────────────────

/**
 * Ролик в самом низу плейлиста — он же баннер по умолчанию.
 *
 * Низ, а не верх: новые ролики кладутся в начало, поэтому внизу лежит тот,
 * с которого плейлист начинался. Он и задаёт его лицо — а верхний менялся бы
 * после каждой догрузки, и плейлист было бы не узнать.
 *
 * Своя картинка или свой ролик, выбранные пользователем, всё это перебивают —
 * см. buildBannerEl.
 */
function defaultCoubOf(playlistData, coubMap) {
    const entries = Object.entries(playlistData?.videos || {});
    if (!entries.length) return null;

    let best = null;
    for (const [key, meta] of entries) {
        if (!best || (meta.order ?? 0) > (best.order ?? 0)) {
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
//
// Раньше наличие иконки выяснялось подбором: на каждый плейлист заводился
// Image и ждали, загрузится он или отвалится 404. При сотне плейлистов это
// сотня запросов, и список строился по одной строке за раз, дожидаясь
// каждого. Теперь сервер отвечает одним списком, а проверка становится
// обычным поиском в множестве — без сети и без ожидания.

/** @type {Set<string>|null} */
let _legacyIcons = null;
/** @type {Promise<void>|null} */
let _legacyIconsLoading = null;

function legacyIconUrl(name) {
    return `/Data/icons/${encodeURIComponent(name)}.webp`;
}

/**
 * Загружает список имеющихся значков. Звать перед отрисовкой списка;
 * повторные вызовы бесплатны.
 */
export function primeLegacyIcons() {
    if (_legacyIcons) return Promise.resolve();
    if (!_legacyIconsLoading) {
        _legacyIconsLoading = getPlaylistIcons()
            .then((names) => { _legacyIcons = new Set(names); })
            // Не получилось — считаем, что значков нет: баннер отрисуется
            // из ролика, а весь список из-за этого ждать не должен
            .catch(() => { _legacyIcons = new Set(); })
            .finally(() => { _legacyIconsLoading = null; });
    }
    return _legacyIconsLoading;
}

function legacyIconExists(name) {
    return _legacyIcons?.has(name) ?? false;
}

/** Сбросить список значков — после переименования, загрузки или удаления. */
export function forgetLegacyIcon() {
    _legacyIcons = null;
}

// ─── Кадры-превью ─────────────────────────────────────────────────────────
// Баннер без своей картинки показывает кадр первого ролика, а чтобы получить
// кадр, раньше приходилось грузить само видео — на каждую плитку по несколько
// мегабайт. Теперь кадр снимается один раз и дальше берётся картинкой: видео
// нужно только под курсором, когда его и правда просят.

/** @type {Set<string>|null} */
let _thumbs = null;
/** @type {Promise<void>|null} */
let _thumbsLoading = null;

/** Уже отправленные в этом сеансе — чтобы не слать один кадр дважды. */
const _thumbsSent = new Set();

function thumbUrl(coubId) {
    return `/Data/thumbs/${encodeURIComponent(coubId)}.webp`;
}

/** Загружает список готовых кадров. Звать перед отрисовкой списка. */
export function primeThumbs() {
    if (_thumbs) return Promise.resolve();
    if (!_thumbsLoading) {
        _thumbsLoading = getCoubThumbs()
            .then((ids) => { _thumbs = new Set(ids); })
            // Не получилось — считаем, что кадров нет: баннер возьмёт видео,
            // как и раньше. Список из-за этого ждать не должен
            .catch(() => { _thumbs = new Set(); })
            .finally(() => { _thumbsLoading = null; });
    }
    return _thumbsLoading;
}

/**
 * Снимает кадр с загруженного видео и отправляет на сервер.
 * Тихо сдаётся при любой заминке: превью — ускорение, а не обязанность.
 */
async function captureThumb(video, coubId) {
    if (!coubId || _thumbs?.has(coubId) || _thumbsSent.has(coubId)) return;
    if (!video.videoWidth) return;

    _thumbsSent.add(coubId);

    try {
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_W;
        canvas.height = THUMB_H;

        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";

        // Обрезаем, а не сплющиваем. Ролики бывают квадратными (960×960) и
        // вертикальными (538×960), и вписанный в 16:9 без обрезки квадрат
        // выглядит раздавленным — именно это и было видно на баннерах.
        // Берём середину кадра, как это делает object-fit: cover.
        const srcRatio = video.videoWidth / video.videoHeight;
        const dstRatio = THUMB_W / THUMB_H;

        let sw = video.videoWidth;
        let sh = video.videoHeight;
        let sx = 0;
        let sy = 0;

        if (srcRatio > dstRatio) {
            sw = sh * dstRatio;
            sx = (video.videoWidth - sw) / 2;
        } else {
            sh = sw / dstRatio;
            sy = (video.videoHeight - sh) / 2;
        }

        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, THUMB_W, THUMB_H);

        const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/webp", 0.8)
        );
        if (!blob) return;

        await saveCoubThumb(coubId, blob);
        _thumbs?.add(coubId);
    } catch {
        // Сеть, переполненный диск, кадр ещё не готов — не наша забота.
        // Повторим при следующем открытии списка
        _thumbsSent.delete(coubId);
    }
}

function bannerFileUrl(fileName) {
    return `/Data/banners/${encodeURIComponent(fileName)}`;
}

// ─── Отрисовка ────────────────────────────────────────────────────────────

/**
 * Собирает элемент баннера плейлиста.
 *
 * Видео здесь не создаётся: элемент лишь запоминает, что показывать, и встаёт
 * под наблюдение. Само <video> появится, когда баннер подойдёт к экрану, и
 * исчезнет, когда уедет. Иначе сотня плейлистов означала бы сотню видео —
 * каждое со своим соединением и декодером, и всё это ради кадра, который
 * почти всегда за пределами видимой области.
 *
 * @param {string} name
 * @param {object} data — запись плейлиста (videos, banner)
 * @param {{coubMap?: object, animate?: boolean, cacheBust?: number}} options
 * @returns {HTMLElement}
 */
export function buildBannerEl(name, data, { coubMap, animate = true, cacheBust } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "pl-banner";

    const bust = cacheBust ? `?t=${cacheBust}` : "";
    const coub = defaultCoubOf(data, coubMap);
    const coubId = coub?.id || null;

    // Порядок важен: своя картинка, затем старый значок, и только потом
    // снятый кадр — он подмена видео, а не выбор пользователя
    const stillSrc = data?.banner?.image
        ? bannerFileUrl(data.banner.image) + bust
        : legacyIconExists(name) ? legacyIconUrl(name) + bust
            : (coubId && _thumbs?.has(coubId)) ? thumbUrl(coubId)
                : null;

    const animSrc = data?.banner?.video
        ? bannerFileUrl(data.banner.video) + bust
        : coub?.video || null;

    if (stillSrc) {
        const img = document.createElement("img");
        img.className = "pl-banner-still";
        img.src = stillSrc;
        img.alt = "";
        img.draggable = false;
        // Браузер сам решит, когда грузить уехавшие за экран
        img.loading = "lazy";
        img.decoding = "async";
        wrap.appendChild(img);
        wrap.classList.add("pl-banner--has-still");
    }

    if (animSrc && animate) {
        wrap._animSrc = animSrc;

        // Кадр снимаем только со своего ролика: превью ключуется его id,
        // а собственный анимированный баннер плейлиста — это не он
        wrap._thumbCoubId = data?.banner?.video ? null : coubId;

        if (stillSrc) {
            // Картинка уже есть, и в покое видно именно её. Видео понадобится
            // только под курсором — ради него сеть трогать незачем
            wrap._hoverOnly = true;
        } else {
            const io = observer();
            if (io) io.observe(wrap);
            // Без IntersectionObserver ленивость невозможна, но и остаться
            // совсем без баннера нельзя: без картинки именно видео служит
            // кадром. Тогда показываем сразу, спасает только потолок
            else { _wanted.add(wrap); mountVideo(wrap); }
        }
    }

    if (!stillSrc && !animSrc) {
        const fallback = document.createElement("span");
        fallback.className = "pl-banner-fallback";
        fallback.textContent = emojiForPlaylist(name);
        wrap.appendChild(fallback);
    }

    return wrap;
}

// ─── Ленивое видео ────────────────────────────────────────────────────────

let _observer = null;
const _live = new Set();     // баннеры с созданным <video>
const _wanted = new Set();   // баннеры у экрана: ждут очереди, если упёрлись в потолок

function observer() {
    if (typeof IntersectionObserver !== "function") return null;

    if (!_observer) {
        _observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    _wanted.add(entry.target);
                    mountVideo(entry.target);
                } else {
                    _wanted.delete(entry.target);
                    unmountVideo(entry.target);
                }
            }
            drain();
        }, { rootMargin: PRELOAD_MARGIN });
    }
    return _observer;
}

/**
 * Занимает освободившиеся места теми, кто у экрана, но не поместился.
 * Без этого баннер, которому не хватило места при прокрутке, так и остался бы
 * пустым: наблюдатель сообщает только о смене состояния, а оно не менялось.
 */
function drain() {
    for (const wrap of _wanted) {
        if (_live.size >= MAX_LIVE_VIDEOS) return;
        if (!wrap._video) mountVideo(wrap);
    }
}

/**
 * @param {HTMLElement} wrap
 * @param {boolean} [force] — наведение: показать, даже если потолок исчерпан
 */
function mountVideo(wrap, force = false) {
    if (!wrap._animSrc || wrap._video) return;

    if (_live.size >= MAX_LIVE_VIDEOS) {
        // Курсор — точный признак того, что баннер нужен прямо сейчас,
        // поэтому ему уступает место любой другой
        if (!force) return;
        const victim = [..._live].find((w) => w !== wrap && !w._hovered);
        if (!victim) return;
        unmountVideo(victim);
    }

    // Под курсором ждать очереди неуместно — это единственный баннер,
    // которого пользователь прямо сейчас ждёт
    if (!force && _loading >= MAX_CONCURRENT_LOADS) {
        if (!_queue.includes(wrap)) _queue.push(wrap);
        return;
    }

    createVideo(wrap);
}

// Сколько видео сейчас грузится и кто ждёт своей очереди
let _loading = 0;
const _queue = [];

function createVideo(wrap) {
    const video = document.createElement("video");
    video.className = "pl-banner-video";
    video.muted = true;          // анимация баннера всегда без звука
    video.loop = true;
    video.playsInline = true;
    video.draggable = false;
    video.preload = "metadata";
    // #t=0.1 — чтобы браузер отрисовал кадр, не дожидаясь воспроизведения:
    // без своей картинки именно он и служит неподвижным баннером
    video.src = wrap._animSrc + (wrap._animSrc.includes("#") ? "" : "#t=0.1");

    _loading++;
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        _loading--;
        pumpQueue();
    };
    // Место в очереди освобождается и когда видео не пошло: иначе одна
    // битая ссылка застопорила бы весь список
    wrap._settle = settle;

    video.addEventListener("loadeddata", () => {
        video.classList.add("is-ready");
        settle();
        // Сняли кадр — в следующий раз этот баннер обойдётся картинкой
        captureThumb(video, wrap._thumbCoubId);
    });
    video.addEventListener("error", settle);

    wrap.appendChild(video);
    wrap._video = video;
    _live.add(wrap);

    // Курсор мог уже стоять на плитке, когда баннер догрузился
    if (wrap._hovered) video.play().catch(() => { });
}

function pumpQueue() {
    while (_queue.length && _loading < MAX_CONCURRENT_LOADS && _live.size < MAX_LIVE_VIDEOS) {
        const next = _queue.shift();
        // Пока стоял в очереди, баннер мог уехать за экран или быть выброшен
        if (!next._animSrc || next._video || !_wanted.has(next)) continue;
        createVideo(next);
    }
}

function unmountVideo(wrap) {
    const queued = _queue.indexOf(wrap);
    if (queued >= 0) _queue.splice(queued, 1);

    const video = wrap._video;
    if (!video) return;

    video.pause();
    // Пустой src и load() заставляют браузер отпустить соединение и декодер;
    // одного remove() для этого мало
    video.removeAttribute("src");
    video.load();
    video.remove();

    wrap._video = null;
    _live.delete(wrap);

    // Только теперь: видео могло не успеть догрузиться, и освобождённое место
    // в очереди сразу займёт следующий — а тому нужно уже свободное место
    const settle = wrap._settle;
    wrap._settle = null;
    settle?.();
}

/** @param {HTMLElement} wrap */
function releaseBanner(wrap) {
    _wanted.delete(wrap);
    unmountVideo(wrap);
    _observer?.unobserve(wrap);
}

/**
 * Снимает наблюдение с баннеров внутри узла. Звать перед тем, как выбросить
 * их разметку: наблюдатель держит ссылку на элемент, и без этого каждая
 * перерисовка списка оставляла бы за собой мёртвые баннеры.
 * @param {HTMLElement} root
 */
export function releaseBanners(root) {
    if (!root) return;
    for (const wrap of root.querySelectorAll(".pl-banner")) releaseBanner(wrap);
    drain();
}

/**
 * Вешает запуск анимации при наведении. Отдельно от сборки, чтобы вызывающий
 * сам решал, на каком элементе ловить курсор (плитка целиком, а не баннер).
 *
 * Видео к этому моменту может ещё не существовать, поэтому наведение только
 * помечает баннер, а играть начинает то, что найдётся.
 *
 * @param {HTMLElement} hoverTarget
 * @param {HTMLElement} bannerEl
 */
export function bindBannerHover(hoverTarget, bannerEl) {
    hoverTarget.addEventListener("mouseenter", () => {
        bannerEl._hovered = true;
        if (!bannerEl._video) mountVideo(bannerEl, true);
        bannerEl._video?.play().catch(() => { });
    });

    hoverTarget.addEventListener("mouseleave", () => {
        bannerEl._hovered = false;
        const video = bannerEl._video;
        if (!video) return;
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
