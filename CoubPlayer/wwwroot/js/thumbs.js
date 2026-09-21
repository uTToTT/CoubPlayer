// thumbs.js — кадры-превью роликов.
//
// Чтобы показать ролик неподвижным, раньше приходилось грузить само видео —
// по несколько мегабайт на каждую плитку. Кадр снимается один раз и дальше
// берётся картинкой в 10 КБ; видео нужно только под курсором, когда его
// и правда просят.
//
// Снимает кадр браузер, а не сервер: декодировать mp4 серверу нечем, ffmpeg
// в зависимостях нет. Зато браузер всё равно грузит видео — для баннера или
// для плитки под курсором, — и кадр достаётся почти даром.
//
// Отсюда и порядок заполнения: библиотека обрастает кадрами сама, по мере
// того как ролики попадаются на глаза. Ничего запускать отдельно не надо.
//
// Кадр 16:9 и одинаковый для всех мест, где нужен: и баннер, и плитка режут
// его по центру через object-fit: cover — ровно так же, как резали бы само
// видео.

import { getCoubThumbs, saveCoubThumb } from "./api.js";

// Баннер на экране около 215×121, плитка — до 340×340. 480 в ширину хватает
// обоим и с запасом под экраны с высокой плотностью
export const THUMB_W = 480;
export const THUMB_H = 270;

/** @type {Set<string>|null} id роликов, для которых кадр уже есть */
let _thumbs = null;
/** @type {Promise<void>|null} */
let _thumbsLoading = null;

/** Уже отправленные в этом сеансе — чтобы не слать один кадр дважды. */
const _thumbsSent = new Set();

export function thumbUrl(coubId) {
    return `/Data/thumbs/${encodeURIComponent(coubId)}.webp`;
}

/** Есть ли готовый кадр. До primeThumbs() всегда false. */
export function hasThumb(coubId) {
    return !!coubId && !!_thumbs?.has(coubId);
}

/** Загружен ли уже список готовых кадров. */
export function thumbsReady() {
    return _thumbs !== null;
}

/** Загружает список готовых кадров. Звать перед отрисовкой списка. */
export function primeThumbs() {
    if (_thumbs) return Promise.resolve();
    if (!_thumbsLoading) {
        _thumbsLoading = getCoubThumbs()
            .then((ids) => { _thumbs = new Set(ids); })
            // Не получилось — считаем, что кадров нет: покажем видео, как
            // и раньше. Список из-за этого ждать не должен
            .catch(() => { _thumbs = new Set(); })
            .finally(() => { _thumbsLoading = null; });
    }
    return _thumbsLoading;
}

/**
 * Снимает кадр с загруженного видео и отправляет на сервер.
 * Тихо сдаётся при любой заминке: превью — ускорение, а не обязанность.
 */
export async function captureThumb(video, coubId) {
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
        // Повторим при следующей встрече с этим роликом
        _thumbsSent.delete(coubId);
    }
}
