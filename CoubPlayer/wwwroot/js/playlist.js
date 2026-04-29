// playlist.js
// Вся логика сортировки и построения плейлистов вынесена сюда из Player.
// Player теперь отвечает только за воспроизведение.

/**
 * @typedef {{id: string, title: string, order: number, lastViewed: string | null}} PlaylistItem
 * @typedef {{videos: Record<string, {title: string, order: number, lastViewed?: string}>}} PlaylistObj
 * @typedef {{id: string, title: string, video: string, audio: string, lastViewed?: string | null}} ResolvedItem
 */

/**
 * Преобразует объект videos в массив и обогащает данными из coubMap.
 * @param {PlaylistObj} playlistObj
 * @param {PlaylistItem[]} sorted — уже отсортированный массив
 * @param {Record<string, {video: string, audio: string}>} coubMap
 * @returns {ResolvedItem[]}
 */
export function resolveItems(sorted, coubMap) {
    return sorted.map((item) => {
        const coub = coubMap[item.id] || {};
        return {
            id: item.id,
            title: item.title,
            video: coub.video || "",
            audio: coub.audio || "",
            lastViewed: item.lastViewed || null,
        };
    });
}

/**
 * Сортировка по полю order.
 * @param {PlaylistObj} playlistObj
 * @param {"asc" | "desc"} direction
 * @returns {PlaylistItem[]}
 */
export function sortByOrder(playlistObj, direction = "asc") {
    if (!playlistObj?.videos) return [];

    return Object.entries(playlistObj.videos)
        .map(([id, meta]) => ({
            id,
            title: meta.title,
            order: meta.order,
            lastViewed: meta.lastViewed || null,
        }))
        .sort((a, b) =>
            direction === "asc" ? a.order - b.order : b.order - a.order
        );
}

/**
 * Сортировка по дате последнего просмотра.
 * @param {PlaylistObj} playlistObj
 * @param {"asc" | "desc"} direction
 * @returns {PlaylistItem[]}
 */
export function sortByLastViewed(playlistObj, direction = "desc") {
    if (!playlistObj?.videos) return [];

    return Object.entries(playlistObj.videos)
        .map(([id, meta]) => ({
            id,
            title: meta.title,
            order: meta.order,
            lastViewed: meta.lastViewed ? new Date(meta.lastViewed) : null,
        }))
        .sort((a, b) => {
            if (!a.lastViewed && !b.lastViewed) return 0;
            if (!a.lastViewed) return direction === "asc" ? -1 : 1;
            if (!b.lastViewed) return direction === "asc" ? 1 : -1;
            return direction === "asc"
                ? a.lastViewed - b.lastViewed
                : b.lastViewed - a.lastViewed;
        });
}

/**
 * Случайная сортировка с детерминированным seed (алгоритм Fisher-Yates).
 * @param {PlaylistObj} playlistObj
 * @param {number} seed
 * @returns {PlaylistItem[]}
 */
export function sortRandom(playlistObj, seed = 1) {
    if (!playlistObj?.videos) return [];

    const arr = Object.entries(playlistObj.videos).map(([id, meta]) => ({
        id,
        title: meta.title,
        order: meta.order,
        lastViewed: meta.lastViewed || null,
    }));

    const rng = createSeededRNG(seed);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    return arr;
}

/**
 * @param {number} seed
 * @returns {() => number}
 */
function createSeededRNG(seed) {
    let s = seed;
    return () => {
        s += 1;
        return (Math.sin(s) * 10000) % 1;
    };
}

/**
 * Единая точка входа: выбрать стратегию сортировки и вернуть resolved items.
 * @param {PlaylistObj} playlistObj
 * @param {Record<string, any>} coubMap
 * @param {{ type: "order" | "lastViewed" | "random", direction: "asc" | "desc", seed?: number }} options
 * @returns {ResolvedItem[]}
 */
export function buildPlaylist(playlistObj, coubMap, { type, direction, seed = 1 }) {
    let sorted;

    if (type === "order") {
        sorted = sortByOrder(playlistObj, direction);
    } else if (type === "lastViewed") {
        sorted = sortByLastViewed(playlistObj, direction);
    } else {
        sorted = sortRandom(playlistObj, seed);
    }

    return resolveItems(sorted, coubMap);
}
