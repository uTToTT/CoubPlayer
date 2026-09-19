namespace CoubPlayer.Storage
{
    /// <summary>
    /// Схема базы. Держим её текстом, а не через миграции EF: таблиц немного,
    /// приложение однопользовательское, и так виднее, что именно лежит на диске.
    ///
    /// Решения, которые стоит знать, читая схему:
    ///
    /// • Ключ записи плейлиста "id#2" раскладывается на coub_id + instance.
    ///   instance = 1 означает голый "id" — при выгрузке обратно в JSON ключ
    ///   собирается ровно таким, каким был.
    ///
    /// • Теги пользователя и теги, пришедшие от Coub, лежат в одной таблице,
    ///   но различаются полем source. Смешать их легко, разделить потом больно:
    ///   своих тегов десятки, коубовских будут десятки тысяч.
    ///
    /// • coubs.embedding зарезервирована под вектор CLIP. Сейчас пустая —
    ///   но добавить колонку сразу дешевле, чем мигрировать схему потом.
    ///
    /// • Названия у ролика два: coubs.title приходит из метаданных Coub,
    ///   playlist_items.title — то, что видно в конкретном плейлисте. Они могут
    ///   расходиться, и JSON хранит именно второе, поэтому оба нужны.
    /// </summary>
    public static class Schema
    {
        /// <summary>
        /// Версия схемы — формы таблиц. Растёт при изменениях, см. CoubDb.Migrate.
        ///
        /// Не путать с версией плеера (<see cref="AppVersion"/>): та про
        /// приложение и хранится в таблице meta. Оси разные — схема может
        /// не меняться годами, пока версия плеера растёт, и наоборот.
        /// </summary>
        public const int Version = 2;

        // PRAGMA journal_mode и foreign_keys здесь намеренно нет: первый нельзя
        // выполнить внутри транзакции, второй действует на соединение, а не на
        // базу. Оба выставляются в CoubDb.
        public const string CreateSql = @"
CREATE TABLE IF NOT EXISTS coubs (
    id              TEXT PRIMARY KEY,
    video           TEXT NOT NULL DEFAULT '',
    audio           TEXT NOT NULL DEFAULT '',

    -- Метаданные Coub. NULL означает 'ещё не забирали', а не 'их нет'
    title           TEXT,
    channel_id      INTEGER,
    channel_title   TEXT,
    duration        REAL,
    width           INTEGER,
    height          INTEGER,
    nsfw            INTEGER,
    meta_fetched_at TEXT,

    -- Под вектор CLIP: заполнится, когда дойдут руки до предсказаний по кадру
    embedding       BLOB
);

CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    group_name TEXT
);

CREATE TABLE IF NOT EXISTS coub_tags (
    coub_id TEXT    NOT NULL REFERENCES coubs(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    source  TEXT    NOT NULL CHECK (source IN ('user', 'coub')),
    PRIMARY KEY (coub_id, tag_id, source)
);

CREATE INDEX IF NOT EXISTS ix_coub_tags_tag ON coub_tags(tag_id, source);

CREATE TABLE IF NOT EXISTS playlists (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    group_name   TEXT,
    sort_order   INTEGER,          -- NULL = порядок не задавали перетаскиванием
    banner_image TEXT,
    banner_video TEXT
);

CREATE TABLE IF NOT EXISTS playlist_items (
    id          INTEGER PRIMARY KEY,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    coub_id     TEXT    NOT NULL REFERENCES coubs(id),
    instance    INTEGER NOT NULL DEFAULT 1,   -- 1 = 'id', 2 = 'id#2', ...
    title       TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL,
    last_viewed TEXT,                          -- ISO-8601 как в JSON, либо NULL
    fx          TEXT,                          -- JSON-объект, либо NULL
    bg_fx       TEXT,
    bg_separate INTEGER,
    UNIQUE (playlist_id, coub_id, instance)
);

CREATE INDEX IF NOT EXISTS ix_items_playlist ON playlist_items(playlist_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_items_coub     ON playlist_items(coub_id);

CREATE TABLE IF NOT EXISTS fx_presets (
    name        TEXT PRIMARY KEY,
    fx          TEXT,
    bg_fx       TEXT,
    bg_separate INTEGER NOT NULL DEFAULT 0
);

-- Порядок групп, заданный перетаскиванием. kind: 'playlists' | 'tags'
CREATE TABLE IF NOT EXISTS group_order (
    kind       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (kind, name)
);

-- Сведения о самих данных: чем и когда записаны. Ключи см. в MetaKeys
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

        /// <summary>Шаг 1 → 2: таблица meta, в которой живёт версия плеера.</summary>
        public const string MigrateTo2Sql = @"
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";
    }

    /// <summary>Ключи таблицы meta — строками их легко перепутать.</summary>
    public static class MetaKeys
    {
        /// <summary>Версия плеера, которой данные записаны в последний раз.</summary>
        public const string AppVersion = "app_version";

        /// <summary>Когда JSON-файлы перенесли в базу, ISO-8601.</summary>
        public const string ImportedAt = "imported_at";
    }
}
