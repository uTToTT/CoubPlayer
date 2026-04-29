// loader.js
// Загрузка данных с сервера. Без изменений в логике, добавлена обработка ошибок.

/**
 * @returns {Promise<{
 *   playlists: Record<string, {title: string, videos: Record<string, any>}>,
 *   coubMap: Record<string, {id: string, video: string, audio: string}>
 * }>}
 */
export async function loadData() {
    const [playlistsRes, coubsRes] = await Promise.all([
        fetch(`Data/playlists.json?t=${Date.now()}`),
        fetch(`Data/coub_list.json?t=${Date.now()}`),
    ]);

    if (!playlistsRes.ok) throw new Error("Не удалось загрузить playlists.json");
    if (!coubsRes.ok) throw new Error("Не удалось загрузить coub_list.json");

    const playlists = await playlistsRes.json();
    const coubs = await coubsRes.json();

    const coubMap = Object.fromEntries(coubs.map((c) => [c.id, c]));

    return { playlists, coubMap };
}
