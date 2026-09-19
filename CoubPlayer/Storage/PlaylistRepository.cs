using System.Globalization;
using CoubPlayer.Meta;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;

namespace CoubPlayer.Storage
{
    /// <summary>Чем кончилась операция. Контроллер переводит это в HTTP-код.</summary>
    public enum PlaylistOutcome
    {
        Ok,
        /// <summary>Плейлиста с таким именем нет.</summary>
        NotFound,
        /// <summary>Записи с таким ключом нет в этом плейлисте.</summary>
        ItemNotFound,
        /// <summary>Такого ролика нет в библиотеке — класть в плейлист нечего.</summary>
        CoubNotFound,
        /// <summary>Имя занято.</summary>
        Conflict,
    }

    /// <summary>
    /// Плейлисты и их содержимое.
    ///
    /// Заменяет прежний цикл «прочитать playlists.json целиком, изменить в
    /// памяти, записать целиком». Разница не в удобстве: на плейлисте в
    /// три тысячи роликов отметка «просмотрено» переписывала весь файл,
    /// а теперь это одна строка. И полтора десятка таких операций больше
    /// не гоняют туда-сюда всю библиотеку.
    ///
    /// Блокировка оставлена своя, поверх SQLite. Она не про целостность —
    /// её обеспечивают транзакции, — а про то, что составные операции
    /// (посчитать позицию, раздвинуть соседей, вставить) должны выполняться
    /// целиком, не перемежаясь друг с другом.
    /// </summary>
    public class PlaylistRepository
    {
        private readonly CoubDb _db;
        private static readonly object _lock = new();

        public PlaylistRepository(CoubDb db) => _db = db;

        // ─── Чтение ─────────────────────────────────────────────────────────

        /// <summary>
        /// Все плейлисты в том же виде, в каком их отдавал playlists.json:
        /// клиент разбирает именно эту форму, и менять её здесь было бы
        /// отдельной задачей со своими рисками.
        /// </summary>
        public Dictionary<string, Playlist> ReadAll()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                return ReadAll(connection);
            }
        }

        /// <summary>Та же выборка для тех, у кого уже есть соединение (см. JsonExport).</summary>
        public static Dictionary<string, Playlist> ReadAll(SqliteConnection cn)
        {
            var result = new Dictionary<string, Playlist>();
            var byId = new Dictionary<long, Playlist>();

            using (var command = cn.CreateCommand())
            {
                command.CommandText = @"
SELECT id, name, title, group_name, sort_order, banner_image, banner_video
FROM playlists ORDER BY id;";
                using var reader = command.ExecuteReader();

                while (reader.Read())
                {
                    var banner = new PlaylistBanner
                    {
                        image = reader.IsDBNull(5) ? null : reader.GetString(5),
                        video = reader.IsDBNull(6) ? null : reader.GetString(6),
                    };

                    var playlist = new Playlist
                    {
                        title = reader.GetString(2),
                        videos = new Dictionary<string, VideoMeta>(),
                        group = reader.IsDBNull(3) ? null : reader.GetString(3),
                        order = reader.IsDBNull(4) ? null : reader.GetInt32(4),
                        // Пустой баннер в JSON не писался вовсе — сохраняем это
                        banner = banner.IsEmpty ? null : banner,
                    };

                    result[reader.GetString(1)] = playlist;
                    byId[reader.GetInt64(0)] = playlist;
                }
            }

            using (var command = cn.CreateCommand())
            {
                command.CommandText = @"
SELECT playlist_id, coub_id, instance, title, sort_order, last_viewed, fx, bg_fx, bg_separate
FROM playlist_items ORDER BY id;";
                using var reader = command.ExecuteReader();

                while (reader.Read())
                {
                    if (!byId.TryGetValue(reader.GetInt64(0), out var playlist)) continue;

                    playlist.videos[MakeKey(reader.GetString(1), reader.GetInt32(2))] = new VideoMeta
                    {
                        title = reader.GetString(3),
                        order = reader.GetInt32(4),
                        lastViewed = ParseDate(reader, 5),
                        fx = DeserializeMap(reader, 6),
                        bgFx = DeserializeMap(reader, 7),
                        bgSeparate = reader.IsDBNull(8) ? null : reader.GetInt32(8) != 0,
                    };
                }
            }

            return result;
        }

        public List<string> ReadNames()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "SELECT name FROM playlists ORDER BY id;";

                var names = new List<string>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) names.Add(reader.GetString(0));
                return names;
            }
        }

        public bool Exists(string name)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                return FindId(connection, null, name) != null;
            }
        }

        /// <summary>Строка меню кнопки на coub.com — без содержимого плейлиста.</summary>
        public record Summary(string Name, int Count, int? Order, string? Group, bool HasCoub);

        /// <summary>
        /// Плейлисты со счётчиками. Содержимое не читаем: меню показывает
        /// только числа, а тянуть ради них десятки тысяч записей незачем.
        /// </summary>
        public List<Summary> ReadSummaries(string? coubId)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText = @"
SELECT p.name,
       (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id),
       p.sort_order,
       p.group_name,
       (SELECT EXISTS(SELECT 1 FROM playlist_items i
                      WHERE i.playlist_id = p.id AND i.coub_id = $coub))
FROM playlists p
ORDER BY p.id;";
                command.Parameters.AddWithValue("$coub", (object?)coubId ?? DBNull.Value);

                var result = new List<Summary>();
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    result.Add(new Summary(
                        reader.GetString(0),
                        reader.GetInt32(1),
                        reader.IsDBNull(2) ? null : reader.GetInt32(2),
                        reader.IsDBNull(3) ? null : reader.GetString(3),
                        !string.IsNullOrEmpty(coubId) && reader.GetInt32(4) != 0));
                }
                return result;
            }
        }

        /// <summary>Id роликов в плейлисте, без копий. Пустое имя — по всей библиотеке.</summary>
        public List<string> ReadCoubIds(string? playlist = null)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();

                if (string.IsNullOrEmpty(playlist))
                {
                    command.CommandText = "SELECT DISTINCT coub_id FROM playlist_items;";
                }
                else
                {
                    command.CommandText = @"
SELECT DISTINCT i.coub_id FROM playlist_items i
JOIN playlists p ON p.id = i.playlist_id
WHERE p.name = $name;";
                    command.Parameters.AddWithValue("$name", playlist);
                }

                var ids = new List<string>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) ids.Add(reader.GetString(0));
                return ids;
            }
        }

        // ─── Сам плейлист ───────────────────────────────────────────────────

        public PlaylistOutcome Create(string name)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                if (FindId(connection, transaction, name) != null) return PlaylistOutcome.Conflict;

                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "INSERT INTO playlists (name, title) VALUES ($name, $name);";
                command.Parameters.AddWithValue("$name", name);
                command.ExecuteNonQuery();

                transaction.Commit();
                return PlaylistOutcome.Ok;
            }
        }

        /// <summary>
        /// Удаляет плейлист вместе с записями (их уносит ON DELETE CASCADE).
        /// Имена файлов баннеров возвращаются, чтобы вызывающий убрал их с диска:
        /// репозиторий про файлы не знает и знать не должен.
        /// </summary>
        public (PlaylistOutcome outcome, string? bannerImage, string? bannerVideo) Delete(string name)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, name);
                if (id == null) return (PlaylistOutcome.NotFound, null, null);

                string? image = null, video = null;
                using (var select = connection.CreateCommand())
                {
                    select.Transaction = transaction;
                    select.CommandText = "SELECT banner_image, banner_video FROM playlists WHERE id = $id;";
                    select.Parameters.AddWithValue("$id", id);
                    using var reader = select.ExecuteReader();
                    if (reader.Read())
                    {
                        image = reader.IsDBNull(0) ? null : reader.GetString(0);
                        video = reader.IsDBNull(1) ? null : reader.GetString(1);
                    }
                }

                Execute(connection, transaction, "DELETE FROM playlists WHERE id = $id;", ("$id", id));

                transaction.Commit();
                return (PlaylistOutcome.Ok, image, video);
            }
        }

        /// <summary>
        /// Переименование. Заголовок идёт следом за именем — так было и в JSON:
        /// контроллер записывал новое имя и в ключ, и в title.
        /// </summary>
        public PlaylistOutcome Rename(string name, string newName)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, name);
                if (id == null) return PlaylistOutcome.NotFound;
                if (FindId(connection, transaction, newName) != null) return PlaylistOutcome.Conflict;

                Execute(connection, transaction,
                    "UPDATE playlists SET name = $new, title = $new WHERE id = $id;",
                    ("$new", newName), ("$id", id));

                transaction.Commit();
                return PlaylistOutcome.Ok;
            }
        }

        public PlaylistOutcome SetGroup(string name, string? group)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                var id = FindId(connection, null, name);
                if (id == null) return PlaylistOutcome.NotFound;

                Execute(connection, null,
                    "UPDATE playlists SET group_name = $group WHERE id = $id;",
                    ("$group", string.IsNullOrEmpty(group) ? DBNull.Value : group), ("$id", id));

                return PlaylistOutcome.Ok;
            }
        }

        /// <summary>Порядок плейлистов в списке. Не названные остаются как были.</summary>
        public void SetOrder(List<string> names)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                for (var i = 0; i < names.Count; i++)
                {
                    Execute(connection, transaction,
                        "UPDATE playlists SET sort_order = $order WHERE name = $name;",
                        ("$order", i), ("$name", names[i]));
                }

                transaction.Commit();
            }
        }

        public PlaylistOutcome SetBanner(string name, string? image, string? video, out string? replaced)
        {
            replaced = null;

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, name);
                if (id == null) return PlaylistOutcome.NotFound;

                var column = image != null ? "banner_image" : "banner_video";
                var value = image ?? video;

                using (var select = connection.CreateCommand())
                {
                    select.Transaction = transaction;
                    select.CommandText = $"SELECT {column} FROM playlists WHERE id = $id;";
                    select.Parameters.AddWithValue("$id", id);
                    var current = select.ExecuteScalar();
                    replaced = current == null || current == DBNull.Value ? null : Convert.ToString(current);
                }

                Execute(connection, transaction,
                    $"UPDATE playlists SET {column} = $value WHERE id = $id;",
                    ("$value", (object?)value ?? DBNull.Value), ("$id", id));

                transaction.Commit();
                return PlaylistOutcome.Ok;
            }
        }

        /// <summary>
        /// Сбрасывает баннер. kind: "image" | "video" | "all".
        /// Возвращает имена файлов, которые теперь некому держать.
        /// </summary>
        public (PlaylistOutcome outcome, List<string> orphaned) ClearBanner(string name, string kind)
        {
            var orphaned = new List<string>();

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, name);
                if (id == null) return (PlaylistOutcome.NotFound, orphaned);

                string? image = null, video = null;
                using (var select = connection.CreateCommand())
                {
                    select.Transaction = transaction;
                    select.CommandText = "SELECT banner_image, banner_video FROM playlists WHERE id = $id;";
                    select.Parameters.AddWithValue("$id", id);
                    using var reader = select.ExecuteReader();
                    if (reader.Read())
                    {
                        image = reader.IsDBNull(0) ? null : reader.GetString(0);
                        video = reader.IsDBNull(1) ? null : reader.GetString(1);
                    }
                }

                if (kind is "image" or "all" && image != null)
                {
                    orphaned.Add(image);
                    Execute(connection, transaction,
                        "UPDATE playlists SET banner_image = NULL WHERE id = $id;", ("$id", id));
                }
                if (kind is "video" or "all" && video != null)
                {
                    orphaned.Add(video);
                    Execute(connection, transaction,
                        "UPDATE playlists SET banner_video = NULL WHERE id = $id;", ("$id", id));
                }

                transaction.Commit();
                return (PlaylistOutcome.Ok, orphaned);
            }
        }

        // ─── Записи плейлиста ───────────────────────────────────────────────

        /// <summary>
        /// Кладёт ролик в начало плейлиста, сдвигая остальные вниз.
        /// Уже лежащий там ролик повторно не добавляется.
        /// </summary>
        public PlaylistOutcome AddVideo(string playlist, string coubId, string? title)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, playlist);
                if (id == null) return PlaylistOutcome.NotFound;

                var (baseId, instance) = SplitKey(coubId);

                // Запись ссылается на ролик внешним ключом, и без этой проверки
                // отсутствующий ролик уронил бы запрос ошибкой SQLite вместо
                // внятного ответа
                if (!CoubExists(connection, transaction, baseId))
                    return PlaylistOutcome.CoubNotFound;

                if (!HasItem(connection, transaction, id.Value, baseId, instance))
                {
                    Execute(connection, transaction,
                        "UPDATE playlist_items SET sort_order = sort_order + 1 WHERE playlist_id = $p;",
                        ("$p", id));

                    InsertItem(connection, transaction, id.Value, baseId, instance,
                        title ?? baseId, 0, null, null, null);
                }

                transaction.Commit();
                return PlaylistOutcome.Ok;
            }
        }

        /// <summary>
        /// Убирает запись и закрывает за ней дыру в нумерации.
        ///
        /// Ключ может прийти точным ("id#2") или просто id ролика — тогда
        /// убираем первую его запись. Искать ключ на клиенте нельзя: его
        /// копия плейлиста могла устареть.
        /// </summary>
        public PlaylistOutcome RemoveVideo(string playlist, string key)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, playlist);
                if (id == null) return PlaylistOutcome.NotFound;

                var (baseId, instance) = SplitKey(key);

                long? itemId = null;
                int removedOrder = 0;

                using (var select = connection.CreateCommand())
                {
                    select.Transaction = transaction;
                    select.CommandText = key.Contains('#')
                        ? @"SELECT id, sort_order FROM playlist_items
                            WHERE playlist_id = $p AND coub_id = $c AND instance = $i;"
                        : @"SELECT id, sort_order FROM playlist_items
                            WHERE playlist_id = $p AND coub_id = $c
                            ORDER BY instance LIMIT 1;";
                    select.Parameters.AddWithValue("$p", id);
                    select.Parameters.AddWithValue("$c", baseId);
                    if (key.Contains('#')) select.Parameters.AddWithValue("$i", instance);

                    using var reader = select.ExecuteReader();
                    if (reader.Read())
                    {
                        itemId = reader.GetInt64(0);
                        removedOrder = reader.GetInt32(1);
                    }
                }

                if (itemId == null) return PlaylistOutcome.ItemNotFound;

                Execute(connection, transaction,
                    "DELETE FROM playlist_items WHERE id = $id;", ("$id", itemId));
                Execute(connection, transaction,
                    @"UPDATE playlist_items SET sort_order = sort_order - 1
                      WHERE playlist_id = $p AND sort_order > $order;",
                    ("$p", id), ("$order", removedOrder));

                transaction.Commit();
                return PlaylistOutcome.Ok;
            }
        }

        /// <summary>
        /// Ещё одна запись того же ролика, сразу за исходной. Файлы не
        /// копируются: обе записи ссылаются на один куб, но имеют свои
        /// позицию и постобработку.
        /// </summary>
        public (PlaylistOutcome outcome, string? key) Duplicate(string playlist, string key)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, playlist);
                if (id == null) return (PlaylistOutcome.NotFound, null);

                var (baseId, instance) = SplitKey(key);

                string title;
                int order;
                string? fx, bgFx;
                object bgSeparate;

                using (var select = connection.CreateCommand())
                {
                    select.Transaction = transaction;
                    select.CommandText = @"
SELECT title, sort_order, fx, bg_fx, bg_separate FROM playlist_items
WHERE playlist_id = $p AND coub_id = $c AND instance = $i;";
                    select.Parameters.AddWithValue("$p", id);
                    select.Parameters.AddWithValue("$c", baseId);
                    select.Parameters.AddWithValue("$i", instance);

                    using var reader = select.ExecuteReader();
                    if (!reader.Read()) return (PlaylistOutcome.ItemNotFound, null);

                    title = reader.GetString(0);
                    order = reader.GetInt32(1);
                    fx = reader.IsDBNull(2) ? null : reader.GetString(2);
                    bgFx = reader.IsDBNull(3) ? null : reader.GetString(3);
                    bgSeparate = reader.IsDBNull(4) ? DBNull.Value : reader.GetInt32(4);
                }

                var nextInstance = NextInstance(connection, transaction, id.Value, baseId);

                Execute(connection, transaction,
                    @"UPDATE playlist_items SET sort_order = sort_order + 1
                      WHERE playlist_id = $p AND sort_order > $order;",
                    ("$p", id), ("$order", order));

                InsertItem(connection, transaction, id.Value, baseId, nextInstance,
                    title, order + 1, fx, bgFx, bgSeparate);

                transaction.Commit();
                return (PlaylistOutcome.Ok, MakeKey(baseId, nextInstance));
            }
        }

        /// <summary>Персональная постобработка одной записи. Пустой fx снимает настройки.</summary>
        public PlaylistOutcome SetFx(
            string playlist, string key,
            Dictionary<string, double>? fx, Dictionary<string, double>? bgFx, bool bgSeparate)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                var id = FindId(connection, null, playlist);
                if (id == null) return PlaylistOutcome.NotFound;

                var (baseId, instance) = SplitKey(key);

                // bgFx имеет смысл только при отдельной настройке фона — иначе
                // не храним, чтобы записи не пухли пустыми объектами
                var changed = Execute(connection, null, @"
UPDATE playlist_items SET fx = $fx, bg_fx = $bgFx, bg_separate = $bgSeparate
WHERE playlist_id = $p AND coub_id = $c AND instance = $i;",
                    ("$fx", SerializeMap(fx)),
                    ("$bgFx", bgSeparate ? SerializeMap(bgFx) : DBNull.Value),
                    ("$bgSeparate", bgSeparate ? 1 : DBNull.Value),
                    ("$p", id), ("$c", baseId), ("$i", instance));

                return changed > 0 ? PlaylistOutcome.Ok : PlaylistOutcome.ItemNotFound;
            }
        }

        public PlaylistOutcome MarkViewed(string playlist, string key)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                var id = FindId(connection, null, playlist);
                if (id == null) return PlaylistOutcome.NotFound;

                var (baseId, instance) = SplitKey(key);

                var changed = Execute(connection, null, @"
UPDATE playlist_items SET last_viewed = $now
WHERE playlist_id = $p AND coub_id = $c AND instance = $i;",
                    ("$now", DateTime.UtcNow.ToString("o")),
                    ("$p", id), ("$c", baseId), ("$i", instance));

                return changed > 0 ? PlaylistOutcome.Ok : PlaylistOutcome.ItemNotFound;
            }
        }

        /// <summary>
        /// Переставляет ролики внутри плейлиста.
        ///
        /// Ключи могут быть подмножеством: в сетке бывают включены поиск или
        /// фильтр по тегам, и пользователь таскает не всё. Поэтому раздаём не
        /// сквозную нумерацию, а те позиции, которые эти записи и занимали, —
        /// остальные остаются на своих местах.
        /// </summary>
        public PlaylistOutcome Reorder(string playlist, List<string> keys, out string? error)
        {
            error = null;

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, playlist);
                if (id == null) return PlaylistOutcome.NotFound;

                if (keys.Distinct().Count() != keys.Count)
                {
                    error = "Duplicate ids";
                    return PlaylistOutcome.ItemNotFound;
                }

                var itemIds = new List<long>();
                var slots = new List<int>();
                var unknown = new List<string>();

                foreach (var key in keys)
                {
                    var (baseId, instance) = SplitKey(key);

                    using var select = connection.CreateCommand();
                    select.Transaction = transaction;
                    select.CommandText = @"
SELECT id, sort_order FROM playlist_items
WHERE playlist_id = $p AND coub_id = $c AND instance = $i;";
                    select.Parameters.AddWithValue("$p", id);
                    select.Parameters.AddWithValue("$c", baseId);
                    select.Parameters.AddWithValue("$i", instance);

                    using var reader = select.ExecuteReader();
                    if (!reader.Read())
                    {
                        unknown.Add(key);
                        continue;
                    }
                    itemIds.Add(reader.GetInt64(0));
                    slots.Add(reader.GetInt32(1));
                }

                if (unknown.Count > 0)
                {
                    error = $"Not in playlist: {string.Join(", ", unknown)}";
                    return PlaylistOutcome.ItemNotFound;
                }

                slots.Sort();
                for (var i = 0; i < itemIds.Count; i++)
                {
                    Execute(connection, transaction,
                        "UPDATE playlist_items SET sort_order = $order WHERE id = $id;",
                        ("$order", slots[i]), ("$id", itemIds[i]));
                }

                transaction.Commit();
                return PlaylistOutcome.Ok;
            }
        }

        /// <summary>
        /// Ставит скачанный ролик на его место в ленте.
        ///
        /// Идём по ленте вверх от нужного ролика и ищем первый, который уже
        /// лежит в плейлисте — встаём сразу за ним. Так D, добавляемый
        /// к A B C E F, попадает между C и E, а не в начало. Если выше ничего
        /// знакомого нет, ролик самый свежий — ему начало плейлиста.
        ///
        /// Ролики, которых в ленте нет вовсе (добавленные вручную), на расчёт
        /// не влияют и остаются там, где лежали.
        /// </summary>
        public PlaylistOutcome AddAtFeedPosition(
            string playlist, string coubId, string? title,
            List<string> feed, Dictionary<string, int> feedIndex)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var id = FindId(connection, transaction, playlist);
                if (id == null) return PlaylistOutcome.NotFound;

                // Уже лежит — второй раз не кладём
                if (HasItem(connection, transaction, id.Value, coubId, 1))
                {
                    transaction.Commit();
                    return PlaylistOutcome.Ok;
                }

                var position = PositionInFeed(connection, transaction, id.Value, feed, feedIndex, coubId);

                Execute(connection, transaction,
                    @"UPDATE playlist_items SET sort_order = sort_order + 1
                      WHERE playlist_id = $p AND sort_order >= $order;",
                    ("$p", id), ("$order", position));

                InsertItem(connection, transaction, id.Value, coubId, 1,
                    title ?? coubId, position, null, null, null);

                transaction.Commit();
                return PlaylistOutcome.Ok;
            }
        }

        private static int PositionInFeed(
            SqliteConnection cn, SqliteTransaction tx, long playlistId,
            List<string> feed, Dictionary<string, int> feedIndex, string coubId)
        {
            if (!feedIndex.TryGetValue(coubId, out var idx)) return 0;

            // Позиции всех роликов плейлиста одним запросом: идти в базу на
            // каждый шаг вверх по ленте было бы тысячами мелких запросов.
            // У ролика может быть несколько копий — берём самую нижнюю,
            // чтобы новый встал за всеми
            var orders = new Dictionary<string, int>();
            using (var command = cn.CreateCommand())
            {
                command.Transaction = tx;
                command.CommandText =
                    "SELECT coub_id, MAX(sort_order) FROM playlist_items " +
                    "WHERE playlist_id = $p GROUP BY coub_id;";
                command.Parameters.AddWithValue("$p", playlistId);

                using var reader = command.ExecuteReader();
                while (reader.Read()) orders[reader.GetString(0)] = reader.GetInt32(1);
            }

            for (var i = idx - 1; i >= 0; i--)
            {
                if (orders.TryGetValue(feed[i], out var order)) return order + 1;
            }

            return 0;
        }

        // ─── Мелочи ─────────────────────────────────────────────────────────

        private static long? FindId(SqliteConnection cn, SqliteTransaction? tx, string name)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = "SELECT id FROM playlists WHERE name = $name;";
            command.Parameters.AddWithValue("$name", name);

            var value = command.ExecuteScalar();
            return value == null || value == DBNull.Value ? null : Convert.ToInt64(value);
        }

        private static bool CoubExists(SqliteConnection cn, SqliteTransaction? tx, string coubId)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = "SELECT EXISTS(SELECT 1 FROM coubs WHERE id = $id);";
            command.Parameters.AddWithValue("$id", coubId);
            return Convert.ToInt32(command.ExecuteScalar()) != 0;
        }

        private static bool HasItem(
            SqliteConnection cn, SqliteTransaction? tx, long playlistId, string coubId, int instance)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText =
                "SELECT EXISTS(SELECT 1 FROM playlist_items " +
                "WHERE playlist_id = $p AND coub_id = $c AND instance = $i);";
            command.Parameters.AddWithValue("$p", playlistId);
            command.Parameters.AddWithValue("$c", coubId);
            command.Parameters.AddWithValue("$i", instance);
            return Convert.ToInt32(command.ExecuteScalar()) != 0;
        }

        private static int NextInstance(
            SqliteConnection cn, SqliteTransaction? tx, long playlistId, string coubId)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText =
                "SELECT COALESCE(MAX(instance), 1) + 1 FROM playlist_items " +
                "WHERE playlist_id = $p AND coub_id = $c;";
            command.Parameters.AddWithValue("$p", playlistId);
            command.Parameters.AddWithValue("$c", coubId);
            return Convert.ToInt32(command.ExecuteScalar());
        }

        private static void InsertItem(
            SqliteConnection cn, SqliteTransaction? tx, long playlistId, string coubId, int instance,
            string title, int order, string? fx, string? bgFx, object? bgSeparate)
        {
            Execute(cn, tx, @"
INSERT INTO playlist_items
    (playlist_id, coub_id, instance, title, sort_order, fx, bg_fx, bg_separate)
VALUES
    ($p, $c, $i, $title, $order, $fx, $bgFx, $bgSeparate);",
                ("$p", playlistId), ("$c", coubId), ("$i", instance),
                ("$title", title), ("$order", order),
                ("$fx", (object?)fx ?? DBNull.Value),
                ("$bgFx", (object?)bgFx ?? DBNull.Value),
                ("$bgSeparate", bgSeparate ?? DBNull.Value));
        }

        private static int Execute(
            SqliteConnection cn, SqliteTransaction? tx, string sql,
            params (string name, object? value)[] parameters)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = sql;
            foreach (var (name, value) in parameters)
                command.Parameters.AddWithValue(name, value ?? DBNull.Value);
            return command.ExecuteNonQuery();
        }

        /// <summary>"abc" → (abc, 1); "abc#3" → (abc, 3).</summary>
        internal static (string coubId, int instance) SplitKey(string key)
        {
            var i = key.IndexOf('#');
            if (i < 0) return (key, 1);

            var tail = key[(i + 1)..];
            return int.TryParse(tail, out var n) && n > 1
                ? (key[..i], n)
                : (key, 1);   // "#" без числа — считаем частью id, чтобы не потерять запись
        }

        internal static string MakeKey(string coubId, int instance) =>
            instance > 1 ? $"{coubId}#{instance}" : coubId;

        private static DateTime? ParseDate(SqliteDataReader reader, int column)
        {
            if (reader.IsDBNull(column)) return null;

            // RoundtripKind сохраняет UTC — иначе дата уехала бы на смещение
            // локального часового пояса
            return DateTime.Parse(
                reader.GetString(column), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        }

        private static Dictionary<string, double>? DeserializeMap(SqliteDataReader reader, int column) =>
            reader.IsDBNull(column)
                ? null
                : JsonConvert.DeserializeObject<Dictionary<string, double>>(reader.GetString(column));

        private static object SerializeMap(Dictionary<string, double>? map) =>
            map == null || map.Count == 0 ? DBNull.Value : JsonConvert.SerializeObject(map);
    }
}
