/**
 * icons.js — подстановка нарисованных иконок вместо эмодзи-заглушек.
 *
 * Как этим пользоваться:
 *   1. Нарисуйте иконку (лучше — SVG в один цвет, currentColor,
 *      или PNG на прозрачном фоне, квадратная, 64–128px).
 *   2. Сохраните файл в папку /icons рядом с index.html под именем
 *      из списка ниже, например icons/restart.svg.
 *   3. Обновите страницу. Файл найдётся автоматически и заменит
 *      эмодзи. Ничего в HTML/CSS менять не нужно.
 *
 * Если файла нет — остаётся эмодзи-заглушка, ошибок в консоли не будет.
 * Порядок проверки форматов для каждого имени: .svg → .png → .webp.
 */

(function () {
    const ICON_DIR = "Data/icons/";
    const EXTENSIONS = ["svg", "png", "webp"];

    // Полный список имён, которые понимает плеер "из коробки".
    // Достаточно положить файл с таким именем — подключать его
    // отдельно не нужно.
    const KNOWN_ICONS = [
        "prev",
        "next",
        "fullscreen",
        "restart",
        "copy-link",
        "tags",
        "playlist-add",
        "folder",
        "playlist",
        "download",
        "link",
        "sync-liked",
        "sync-bookmarks",
        "add",
        "start",
        "rename",
        "delete",
    ];

    function tryLoad(name) {
        return new Promise((resolve) => {
            let i = 0;
            const attempt = () => {
                if (i >= EXTENSIONS.length) {
                    resolve(null);
                    return;
                }
                const ext = EXTENSIONS[i++];
                const src = `${ICON_DIR}${name}.${ext}`;
                const img = new Image();
                img.onload = () => resolve(src);
                img.onerror = attempt;
                img.src = src;
            };
            attempt();
        });
    }

    async function applyIcons() {
        const slots = document.querySelectorAll(".icon-slot[data-icon-name]");
        // Кэшируем результат на имя иконки, чтобы не проверять сеть повторно,
        // если один и тот же значок используется в нескольких местах
        // (например "playlist" в шапке и в панели сортировки).
        const cache = new Map();

        await Promise.all(
            Array.from(slots).map(async (slot) => {
                const name = slot.dataset.iconName;
                if (!name) return;

                if (!cache.has(name)) {
                    cache.set(name, tryLoad(name));
                }
                const src = await cache.get(name);
                if (!src) return;

                const img = slot.querySelector(".icon-custom");
                if (!img) return;
                img.src = src;
                slot.classList.add("icon-slot--loaded");
            })
        );
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyIcons);
    } else {
        applyIcons();
    }

    // На случай если main.js динамически дорисовывает часть UI после
    // загрузки (например строки плейлистов) — можно вызвать повторно:
    window.refreshCustomIcons = applyIcons;
})();