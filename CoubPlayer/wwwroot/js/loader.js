//loader.js
export async function loadData() {
    const p = await fetch(`Data/playlists.json?t=${Date.now()}`);
    const playlists = await p.json();

    const c = await fetch(`Data/coub_list.json?t=${Date.now()}`);
    const coubs = await c.json();

    const coubMap = Object.fromEntries(
        coubs.map(c => [c.id, c])
    );

    return { playlists, coubMap };
}