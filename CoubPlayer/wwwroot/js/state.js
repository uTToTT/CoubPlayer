// state.js
// Централизованное хранилище состояния приложения.
// Единственное место, где живут данные о плейлистах и coubMap.

export const state = {
    /** @type {Record<string, {title: string, videos: Record<string, {title: string, order: number, lastViewed?: string}>}>} */
    playlists: {},

    /** @type {Record<string, {id: string, video: string, audio: string}>} */
    coubMap: {},

    /** @type {string | null} Имя выбранного плейлиста */
    selectedPlaylist: null,

    /** @type {"order" | "lastViewed" | "random"} */
    sortType: "order",

    /** @type {"asc" | "desc"} */
    sortDirection: "asc",

    /** @type {number} Seed для рандомной сортировки */
    randomSeed: 1,
};
