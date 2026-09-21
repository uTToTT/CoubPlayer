using CoubPlayer.Meta;
using CoubPlayer.Services;
using Microsoft.Data.Sqlite;

namespace CoubPlayer.Storage
{
    /// <summary>
    /// Библиотека роликов и теги. Заменяет coub_list.json и tag_groups.json.
    ///
    /// Теги пользователя и теги, пришедшие от Coub, лежат в одной таблице
    /// и различаются полем source. Наружу отдаются только свои: чужих тегов
    /// будут десятки тысяч, и в списке «мои теги» им не место.
    /// </summary>
    public class CoubRepository
    {
        private const string UserSource = "user";

        private readonly CoubDb _db;
        private static readonly object _lock = new();

        public CoubRepository(CoubDb db) => _db = db;

        // ─── Ролики ─────────────────────────────────────────────────────────

        /// <summary>
        /// Вся библиотека в том же виде, в каком её отдавал coub_list.json:
        /// по ней плеер находит файлы ролика.
        /// </summary>
        public List<CoubListEntry> ReadAll()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                return ReadAll(connection);
            }
        }

        public static List<CoubListEntry> ReadAll(SqliteConnection cn)
        {
            var tags = ReadUserTags(cn);
            var result = new List<CoubListEntry>();

            using var command = cn.CreateCommand();
            command.CommandText = "SELECT id, video, audio FROM coubs ORDER BY rowid;";
            using var reader = command.ExecuteReader();

            while (reader.Read())
            {
                var id = reader.GetString(0);
                result.Add(new CoubListEntry
                {
                    id = id,
                    video = reader.GetString(1),
                    audio = reader.GetString(2),
                    tags = tags.TryGetValue(id, out var list) ? list : new List<string>(),
                });
            }

            return result;
        }

        /// <summary>
        /// Каналы и ролики каждого из них — чтобы плеер мог искать по автору.
        ///
        /// Сгруппировано по каналу, а не выдано парами «ролик → автор»:
        /// у канала обычно не один ролик, а десятки, и его название в ответе
        /// встречается один раз вместо каждого раза. На восьми тысячах роликов
        /// это разница в несколько раз по весу ответа.
        ///
        /// Ролики без сведений сюда не попадают: автор у них не «пустой»,
        /// а неизвестный, и искать по нему нечего.
        /// </summary>
        public Dictionary<string, List<string>> ReadChannels()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText = @"
SELECT channel_title, id FROM coubs
WHERE channel_title IS NOT NULL AND TRIM(channel_title) <> ''
ORDER BY rowid;";

                var result = new Dictionary<string, List<string>>();
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var channel = reader.GetString(0);
                    if (!result.TryGetValue(channel, out var ids))
                        result[channel] = ids = new List<string>();
                    ids.Add(reader.GetString(1));
                }
                return result;
            }
        }

        public List<string> ReadIds()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "SELECT id FROM coubs ORDER BY rowid;";

                var ids = new List<string>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) ids.Add(reader.GetString(0));
                return ids;
            }
        }

        /// <summary>
        /// Заводит или обновляет запись ролика — без неё файлы лежат на диске,
        /// но плеер их не найдёт.
        /// </summary>
        public void Upsert(CoubDownloadResult result)
        {
            if (string.IsNullOrEmpty(result.Video)) return;

            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();

                // Аудио не затираем пустым: у уже скачанного ролика оно могло
                // быть, а в этом результате его просто не заполнили
                command.CommandText = @"
INSERT INTO coubs (id, video, audio) VALUES ($id, $video, $audio)
ON CONFLICT(id) DO UPDATE SET
    video = excluded.video,
    audio = CASE WHEN excluded.audio <> '' THEN excluded.audio ELSE coubs.audio END;";
                command.Parameters.AddWithValue("$id", result.Id);
                command.Parameters.AddWithValue("$video", result.Video);
                command.Parameters.AddWithValue("$audio", (object?)result.Audio ?? "");
                command.ExecuteNonQuery();
            }

            // Если загрузчик уже спрашивал Coub о ролике, сведения пришли вместе
            // со ссылками на потоки. Сохраняем их здесь, а не оставляем отдельному
            // проходу: иначе каждый свежескачанный ролик оказывался бы без тегов,
            // и подсказки про него молчали бы до следующего обхода библиотеки
            if (result.Metadata != null) SaveMetadata(result.Metadata);
        }

        // ─── Метаданные Coub ────────────────────────────────────────────────

        /// <summary>Сколько роликов в библиотеке и у скольких уже есть метаданные.</summary>
        public (int total, int fetched) MetadataStats()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT COUNT(*), COUNT(meta_fetched_at) FROM coubs;";

                using var reader = command.ExecuteReader();
                return reader.Read() ? (reader.GetInt32(0), reader.GetInt32(1)) : (0, 0);
            }
        }

        /// <summary>
        /// Ролики, о которых ещё не спрашивали. Однажды спрошенные сюда не
        /// возвращаются, даже если ответ был пустым, — иначе удалённые с сайта
        /// ролики перезапрашивались бы при каждом проходе бесконечно.
        /// </summary>
        public List<string> FindWithoutMetadata()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT id FROM coubs WHERE meta_fetched_at IS NULL ORDER BY rowid;";

                var ids = new List<string>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) ids.Add(reader.GetString(0));
                return ids;
            }
        }

        /// <summary>
        /// Записывает полученные сведения и теги Coub. Теги пользователя не
        /// трогаются вовсе: у них своё значение source, и смешивать их нельзя.
        /// </summary>
        public void SaveMetadata(CoubMetadata meta)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                Execute(connection, transaction, @"
UPDATE coubs SET
    title = $title, channel_id = $channelId, channel_title = $channelTitle,
    duration = $duration, width = $width, height = $height, nsfw = $nsfw,
    meta_fetched_at = $now
WHERE id = $id;",
                    ("$title", (object?)meta.Title ?? DBNull.Value),
                    ("$channelId", (object?)meta.ChannelId ?? DBNull.Value),
                    ("$channelTitle", (object?)meta.ChannelTitle ?? DBNull.Value),
                    ("$duration", (object?)meta.Duration ?? DBNull.Value),
                    ("$width", (object?)meta.Width ?? DBNull.Value),
                    ("$height", (object?)meta.Height ?? DBNull.Value),
                    ("$nsfw", meta.Nsfw.HasValue ? (meta.Nsfw.Value ? 1 : 0) : (object)DBNull.Value),
                    ("$now", DateTime.UtcNow.ToString("o")),
                    ("$id", meta.Id));

                // Полная замена коубовских тегов: при повторном проходе список
                // на сайте мог измениться, а дописывание оставило бы старые
                Execute(connection, transaction,
                    "DELETE FROM coub_tags WHERE coub_id = $id AND source = 'coub';",
                    ("$id", meta.Id));

                foreach (var tag in meta.Tags)
                {
                    var normalized = Normalize(tag);
                    if (normalized.Length == 0) continue;

                    var tagId = EnsureTag(connection, transaction, normalized);
                    Execute(connection, transaction,
                        "INSERT OR IGNORE INTO coub_tags (coub_id, tag_id, source) VALUES ($c, $t, 'coub');",
                        ("$c", meta.Id), ("$t", tagId));
                }

                transaction.Commit();
            }
        }

        /// <summary>
        /// Что известно о ролике. null — такого ролика в библиотеке нет.
        /// Пустые поля при заполненном fetchedAt означают, что спрашивали,
        /// но сайт ничего не отдал: ролик удалён.
        /// </summary>
        public object? ReadMetadata(string id)
        {
            lock (_lock)
            {
                using var connection = _db.Open();

                using var command = connection.CreateCommand();
                command.CommandText = @"
SELECT title, channel_id, channel_title, duration, width, height, nsfw, meta_fetched_at
FROM coubs WHERE id = $id;";
                command.Parameters.AddWithValue("$id", id);

                using var reader = command.ExecuteReader();
                if (!reader.Read()) return null;

                var result = new
                {
                    id,
                    title = reader.IsDBNull(0) ? null : reader.GetString(0),
                    channelId = reader.IsDBNull(1) ? (long?)null : reader.GetInt64(1),
                    channelTitle = reader.IsDBNull(2) ? null : reader.GetString(2),
                    duration = reader.IsDBNull(3) ? (double?)null : reader.GetDouble(3),
                    width = reader.IsDBNull(4) ? (int?)null : reader.GetInt32(4),
                    height = reader.IsDBNull(5) ? (int?)null : reader.GetInt32(5),
                    nsfw = reader.IsDBNull(6) ? (bool?)null : reader.GetInt32(6) != 0,
                    fetchedAt = reader.IsDBNull(7) ? null : reader.GetString(7),
                    coubTags = ReadTagsBySource(connection, id, "coub"),
                    userTags = ReadTagsBySource(connection, id, UserSource),
                };

                return result;
            }
        }

        private static List<string> ReadTagsBySource(SqliteConnection cn, string coubId, string source)
        {
            using var command = cn.CreateCommand();
            command.CommandText = @"
SELECT t.name FROM coub_tags ct JOIN tags t ON t.id = ct.tag_id
WHERE ct.coub_id = $c AND ct.source = $s ORDER BY ct.rowid;";
            command.Parameters.AddWithValue("$c", coubId);
            command.Parameters.AddWithValue("$s", source);

            var result = new List<string>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result.Add(reader.GetString(0));
            return result;
        }

        /// <summary>
        /// Отмечает, что о ролике спрашивали, но сведений не получили — он
        /// удалён с сайта. Без этой отметки он попадал бы в каждый проход.
        /// </summary>
        public void MarkMetadataChecked(string id)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                Execute(connection, null,
                    "UPDATE coubs SET meta_fetched_at = $now WHERE id = $id;",
                    ("$now", DateTime.UtcNow.ToString("o")), ("$id", id));
            }
        }

        // ─── Теги ролика ────────────────────────────────────────────────────

        public List<string>? GetTags(string id)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                return CoubExists(connection, null, id) ? ReadTagsOf(connection, null, id) : null;
            }
        }

        public List<string>? AddTag(string id, string rawTag)
        {
            var tag = Normalize(rawTag);
            if (string.IsNullOrEmpty(tag)) return null;

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                if (!CoubExists(connection, transaction, id)) return null;

                var tagId = EnsureTag(connection, transaction, tag);
                Execute(connection, transaction,
                    "INSERT OR IGNORE INTO coub_tags (coub_id, tag_id, source) VALUES ($c, $t, $s);",
                    ("$c", id), ("$t", tagId), ("$s", UserSource));

                var tags = ReadTagsOf(connection, transaction, id);
                transaction.Commit();
                return tags;
            }
        }

        public List<string>? RemoveTag(string id, string rawTag)
        {
            var tag = Normalize(rawTag);

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                if (!CoubExists(connection, transaction, id)) return null;

                Execute(connection, transaction, @"
DELETE FROM coub_tags
WHERE coub_id = $c AND source = $s
  AND tag_id IN (SELECT id FROM tags WHERE name = $tag);",
                    ("$c", id), ("$s", UserSource), ("$tag", tag));

                DropOrphanTags(connection, transaction);

                var tags = ReadTagsOf(connection, transaction, id);
                transaction.Commit();
                return tags;
            }
        }

        // ─── Теги библиотеки ────────────────────────────────────────────────

        public List<(string Tag, int Count)> GetAllTags()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText = @"
SELECT t.name, COUNT(*) AS n
FROM coub_tags ct JOIN tags t ON t.id = ct.tag_id
WHERE ct.source = $s
GROUP BY t.id
ORDER BY n DESC;";
                command.Parameters.AddWithValue("$s", UserSource);

                var result = new List<(string, int)>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) result.Add((reader.GetString(0), reader.GetInt32(1)));
                return result;
            }
        }

        public List<CoubListEntry> Search(string[] tags, string mode)
        {
            var wanted = tags.Select(Normalize).Where(t => t.Length > 0).Distinct().ToList();
            if (wanted.Count == 0) return new List<CoubListEntry>();

            lock (_lock)
            {
                using var connection = _db.Open();

                var placeholders = string.Join(", ", wanted.Select((_, i) => $"$t{i}"));
                using var command = connection.CreateCommand();

                // «all» — у ролика должны быть все названные теги, поэтому
                // сверяем число совпавших с числом запрошенных
                command.CommandText = mode == "all"
                    ? $@"
SELECT ct.coub_id FROM coub_tags ct JOIN tags t ON t.id = ct.tag_id
WHERE ct.source = $s AND t.name IN ({placeholders})
GROUP BY ct.coub_id HAVING COUNT(DISTINCT t.id) = {wanted.Count};"
                    : $@"
SELECT DISTINCT ct.coub_id FROM coub_tags ct JOIN tags t ON t.id = ct.tag_id
WHERE ct.source = $s AND t.name IN ({placeholders});";

                command.Parameters.AddWithValue("$s", UserSource);
                for (var i = 0; i < wanted.Count; i++)
                    command.Parameters.AddWithValue($"$t{i}", wanted[i]);

                var ids = new HashSet<string>();
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) ids.Add(reader.GetString(0));

                return ReadAll(connection).Where(c => ids.Contains(c.id)).ToList();
            }
        }

        /// <summary>
        /// Переименовывает тег во всех роликах. Работаем по связям, а не по
        /// самой строке тега: строка общая с тегами от Coub, и переименование
        /// своего тега не должно задевать их.
        /// </summary>
        /// <returns>Сколько роликов это затронуло</returns>
        public int RenameTagGlobally(string rawOldTag, string rawNewTag)
        {
            var oldTag = Normalize(rawOldTag);
            var newTag = Normalize(rawNewTag);
            if (oldTag.Length == 0 || newTag.Length == 0 || oldTag == newTag) return 0;

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var oldId = FindTag(connection, transaction, oldTag);
                if (oldId == null) return 0;

                var affected = CountCoubsWithTag(connection, transaction, oldId.Value);
                if (affected == 0) return 0;

                var newId = EnsureTag(connection, transaction, newTag);

                // Группу переносим за тегом — карта групп ключуется именем
                Execute(connection, transaction, @"
UPDATE tags SET group_name = (SELECT group_name FROM tags WHERE id = $old)
WHERE id = $new AND group_name IS NULL;",
                    ("$old", oldId), ("$new", newId));

                // OR IGNORE: у ролика мог уже быть тег с новым именем
                Execute(connection, transaction, @"
INSERT OR IGNORE INTO coub_tags (coub_id, tag_id, source)
SELECT coub_id, $new, $s FROM coub_tags WHERE tag_id = $old AND source = $s;",
                    ("$new", newId), ("$old", oldId), ("$s", UserSource));

                Execute(connection, transaction,
                    "DELETE FROM coub_tags WHERE tag_id = $old AND source = $s;",
                    ("$old", oldId), ("$s", UserSource));

                DropOrphanTags(connection, transaction);

                transaction.Commit();
                return affected;
            }
        }

        public int DeleteTagGlobally(string rawTag)
        {
            var tag = Normalize(rawTag);
            if (tag.Length == 0) return 0;

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var tagId = FindTag(connection, transaction, tag);
                if (tagId == null) return 0;

                var affected = CountCoubsWithTag(connection, transaction, tagId.Value);
                if (affected == 0) return 0;

                Execute(connection, transaction,
                    "DELETE FROM coub_tags WHERE tag_id = $t AND source = $s;",
                    ("$t", tagId), ("$s", UserSource));

                // Группу за удалённым тегом не держим: в прежнем формате
                // запись из карты групп тоже убиралась
                Execute(connection, transaction,
                    "UPDATE tags SET group_name = NULL WHERE id = $t;", ("$t", tagId));

                DropOrphanTags(connection, transaction);

                transaction.Commit();
                return affected;
            }
        }

        public int DeleteAllTags()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                int affected;
                using (var count = connection.CreateCommand())
                {
                    count.Transaction = transaction;
                    count.CommandText =
                        "SELECT COUNT(DISTINCT coub_id) FROM coub_tags WHERE source = $s;";
                    count.Parameters.AddWithValue("$s", UserSource);
                    affected = Convert.ToInt32(count.ExecuteScalar());
                }

                Execute(connection, transaction,
                    "DELETE FROM coub_tags WHERE source = $s;", ("$s", UserSource));
                Execute(connection, transaction, "UPDATE tags SET group_name = NULL;");
                DropOrphanTags(connection, transaction);

                transaction.Commit();
                return affected;
            }
        }

        // ─── Группы тегов ───────────────────────────────────────────────────

        public Dictionary<string, string> GetTagGroups()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT name, group_name FROM tags WHERE group_name IS NOT NULL ORDER BY id;";

                var result = new Dictionary<string, string>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) result[reader.GetString(0)] = reader.GetString(1);
                return result;
            }
        }

        /// <summary>Собирает тег в группу. Пустое имя группы — убрать из группы.</summary>
        public Dictionary<string, string> SetTagGroup(string rawTag, string? group)
        {
            var tag = Normalize(rawTag);

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                // Тег могли собрать в группу, ещё не повесив ни на один ролик
                var tagId = EnsureTag(connection, transaction, tag);

                Execute(connection, transaction,
                    "UPDATE tags SET group_name = $group WHERE id = $id;",
                    ("$group", string.IsNullOrEmpty(group) ? DBNull.Value : group), ("$id", tagId));

                DropOrphanTags(connection, transaction);
                transaction.Commit();
            }

            return GetTagGroups();
        }

        // ─── Мелочи ─────────────────────────────────────────────────────────

        private static Dictionary<string, List<string>> ReadUserTags(SqliteConnection cn)
        {
            var result = new Dictionary<string, List<string>>();

            using var command = cn.CreateCommand();
            command.CommandText = @"
SELECT ct.coub_id, t.name
FROM coub_tags ct JOIN tags t ON t.id = ct.tag_id
WHERE ct.source = 'user'
ORDER BY ct.rowid;";

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var coubId = reader.GetString(0);
                if (!result.TryGetValue(coubId, out var list))
                {
                    list = new List<string>();
                    result[coubId] = list;
                }
                list.Add(reader.GetString(1));
            }

            return result;
        }

        private static List<string> ReadTagsOf(SqliteConnection cn, SqliteTransaction? tx, string coubId)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = @"
SELECT t.name FROM coub_tags ct JOIN tags t ON t.id = ct.tag_id
WHERE ct.coub_id = $c AND ct.source = $s
ORDER BY ct.rowid;";
            command.Parameters.AddWithValue("$c", coubId);
            command.Parameters.AddWithValue("$s", UserSource);

            var result = new List<string>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result.Add(reader.GetString(0));
            return result;
        }

        private static bool CoubExists(SqliteConnection cn, SqliteTransaction? tx, string id)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = "SELECT EXISTS(SELECT 1 FROM coubs WHERE id = $id);";
            command.Parameters.AddWithValue("$id", id);
            return Convert.ToInt32(command.ExecuteScalar()) != 0;
        }

        private static long? FindTag(SqliteConnection cn, SqliteTransaction? tx, string name)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = "SELECT id FROM tags WHERE name = $name;";
            command.Parameters.AddWithValue("$name", name);

            var value = command.ExecuteScalar();
            return value == null || value == DBNull.Value ? null : Convert.ToInt64(value);
        }

        private static long EnsureTag(SqliteConnection cn, SqliteTransaction? tx, string name)
        {
            var existing = FindTag(cn, tx, name);
            if (existing != null) return existing.Value;

            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = "INSERT INTO tags (name) VALUES ($name); SELECT last_insert_rowid();";
            command.Parameters.AddWithValue("$name", name);
            return Convert.ToInt64(command.ExecuteScalar());
        }

        private static int CountCoubsWithTag(SqliteConnection cn, SqliteTransaction? tx, long tagId)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText =
                "SELECT COUNT(DISTINCT coub_id) FROM coub_tags WHERE tag_id = $t AND source = $s;";
            command.Parameters.AddWithValue("$t", tagId);
            command.Parameters.AddWithValue("$s", UserSource);
            return Convert.ToInt32(command.ExecuteScalar());
        }

        /// <summary>
        /// Убирает теги, за которые больше никто не держится. Без этого список
        /// тегов копил бы призраков: строка осталась, роликов с ней нет.
        /// Теги с группой оставляем — их завели осознанно.
        /// </summary>
        private static void DropOrphanTags(SqliteConnection cn, SqliteTransaction? tx)
        {
            Execute(cn, tx, @"
DELETE FROM tags
WHERE group_name IS NULL
  AND id NOT IN (SELECT tag_id FROM coub_tags);");
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

        private static string Normalize(string? tag) => tag?.Trim().ToLowerInvariant() ?? "";
    }
}
