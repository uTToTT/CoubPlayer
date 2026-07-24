// loader.js
// Загрузка данных с сервера.
// Если playlists.json / coub_list.json ещё не существуют (первый запуск,
// пока ничего не скачано и не создано) — это не ошибка, а нормальное пустое
// состояние: возвращаем пустые структуры, чтобы плеер мог продолжить работу
// (создать первый плейлист, докачать видео и т.д.), а не падал целиком.

/**
 * @returns {Promise<{
 *   playlists: Record<string, {title: string, videos: Record<string, any>}>,
 *   coubMap: Record<string, {id: string, video: string, audio: string}>
 * }>}
 */
export async function loadData() {
    const [playlists, coubs] = await Promise.all([
        fetchJsonSafe(`Data/playlists.json?t=${Date.now()}`, {}),
        fetchJsonSafe(`Data/coub_list.json?t=${Date.now()}`, []),
    ]);

    const coubMap = Object.fromEntries(coubs.map((c) => [c.id, c]));

    return { playlists, coubMap };
}

/**
 * Загружает JSON по URL. Если файла нет (404) или он пуст/битый —
 * возвращает fallback вместо исключения. Настоящие сетевые ошибки
 * (сервер недоступен и т.п.) по-прежнему пробрасываются наверх —
 * без сервера плеер работать всё равно не может.
 * @param {string} url
 * @param {any} fallback
 */
async function fetchJsonSafe(url, fallback) {
    let res;
    try {
        res = await fetch(url);
    } catch (err) {
        throw new Error(`Сервер недоступен (${url}): ${err.message}`);
    }

    if (res.status === 404) {
        console.warn(`${url} не найден — используется пустое значение по умолчанию`);
        return fallback;
    }

    if (!res.ok) {
        console.warn(`Не удалось загрузить ${url} (HTTP ${res.status}) — используется пустое значение по умолчанию`);
        return fallback;
    }

    try {
        return await res.json();
    } catch (err) {
        console.warn(`${url} повреждён или пуст — используется пустое значение по умолчанию:`, err.message);
        return fallback;
    }
}