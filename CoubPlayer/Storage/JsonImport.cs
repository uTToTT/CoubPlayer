using CoubPlayer.Meta;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;

namespace CoubPlayer.Storage
{
    public class ImportReport
    {
        public int Coubs { get; set; }
        public int Tags { get; set; }
        public int CoubTags { get; set; }
        public int Playlists { get; set; }
        public int Items { get; set; }
        public int FxPresets { get; set; }
        public int GroupOrder { get; set; }
        public List<string> Warnings { get; } = new();

        public override string ToString() =>
            $"ролики {Coubs}, теги {Tags} ({CoubTags} связок), плейлисты {Playlists} " +
            $"({Items} записей), пресеты {FxPresets}, порядок групп {GroupOrder}";
    }

    /// <summary>
    /// Перенос данных из JSON-файлов в базу. Одноразовая операция при переходе,
    /// но написана так, чтобы её можно было повторить на копии данных сколько
    /// угодно раз — этим и проверяется, что ничего не потерялось.
    ///
    /// Всё идёт одной транзакцией: либо переносится целиком, либо база остаётся
    /// пустой. Полупустая база хуже отсутствующей.
    /// </summary>
    public class JsonImport
    {
        private readonly string _dataDir;

        public JsonImport(string dataDir) => _dataDir = dataDir;

        public ImportReport Run(CoubDb db)
        {
            var report = new ImportReport();

            using var connection = db.Open();
            using var transaction = connection.BeginTransaction();

            ImportCoubs(connection, transaction, report);
            ImportTagGroups(connection, transaction, report);
            ImportPlaylists(connection, transaction, report);
            ImportFxPresets(connection, transaction, report);
            ImportGroupOrder(connection, transaction, report);

            transaction.Commit();
            return report;
        }

        // ─── Ролики и теги ──────────────────────────────────────────────────

        private void ImportCoubs(SqliteConnection cn, SqliteTransaction tx, ImportReport report)
        {
            var entries = ReadJson<List<CoubListEntry>>("coub_list.json");
            if (entries == null) return;

            using var insertCoub = cn.CreateCommand();
            insertCoub.Transaction = tx;
            insertCoub.CommandText =
                "INSERT OR IGNORE INTO coubs (id, video, audio) VALUES ($id, $video, $audio);";
            insertCoub.Parameters.Add("$id", SqliteType.Text);
            insertCoub.Parameters.Add("$video", SqliteType.Text);
            insertCoub.Parameters.Add("$audio", SqliteType.Text);

            foreach (var entry in entries)
            {
                if (string.IsNullOrEmpty(entry.id))
                {
                    report.Warnings.Add("в coub_list.json запись без id — пропущена");
                    continue;
                }

                insertCoub.Parameters["$id"].Value = entry.id;
                insertCoub.Parameters["$video"].Value = entry.video ?? "";
                insertCoub.Parameters["$audio"].Value = entry.audio ?? "";
                if (insertCoub.ExecuteNonQuery() > 0) report.Coubs++;

                foreach (var tag in entry.tags ?? new List<string>())
                {
                    if (string.IsNullOrWhiteSpace(tag)) continue;
                    var tagId = EnsureTag(cn, tx, tag, report);
                    LinkTag(cn, tx, entry.id, tagId, "user", report);
                }
            }
        }

        private static long EnsureTag(SqliteConnection cn, SqliteTransaction tx, string name, ImportReport report)
        {
            using var select = cn.CreateCommand();
            select.Transaction = tx;
            select.CommandText = "SELECT id FROM tags WHERE name = $name;";
            select.Parameters.AddWithValue("$name", name);

            var existing = select.ExecuteScalar();
            if (existing != null && existing != DBNull.Value) return Convert.ToInt64(existing);

            using var insert = cn.CreateCommand();
            insert.Transaction = tx;
            insert.CommandText = "INSERT INTO tags (name) VALUES ($name); SELECT last_insert_rowid();";
            insert.Parameters.AddWithValue("$name", name);

            report.Tags++;
            return Convert.ToInt64(insert.ExecuteScalar());
        }

        private static void LinkTag(
            SqliteConnection cn, SqliteTransaction tx, string coubId, long tagId, string source, ImportReport report)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText =
                "INSERT OR IGNORE INTO coub_tags (coub_id, tag_id, source) VALUES ($coub, $tag, $src);";
            command.Parameters.AddWithValue("$coub", coubId);
            command.Parameters.AddWithValue("$tag", tagId);
            command.Parameters.AddWithValue("$src", source);
            if (command.ExecuteNonQuery() > 0) report.CoubTags++;
        }

        /// <summary>
        /// tag_groups.json — карта «тег → группа». Тег оттуда мог ни разу не
        /// встретиться у роликов, но группу за ним сохранить всё равно надо.
        /// </summary>
        private void ImportTagGroups(SqliteConnection cn, SqliteTransaction tx, ImportReport report)
        {
            var groups = ReadJson<Dictionary<string, string>>("tag_groups.json");
            if (groups == null) return;

            foreach (var (tag, group) in groups)
            {
                if (string.IsNullOrWhiteSpace(tag)) continue;
                var tagId = EnsureTag(cn, tx, tag, report);

                using var command = cn.CreateCommand();
                command.Transaction = tx;
                command.CommandText = "UPDATE tags SET group_name = $group WHERE id = $id;";
                command.Parameters.AddWithValue("$group", string.IsNullOrEmpty(group) ? DBNull.Value : group);
                command.Parameters.AddWithValue("$id", tagId);
                command.ExecuteNonQuery();
            }
        }

        // ─── Плейлисты ──────────────────────────────────────────────────────

        private void ImportPlaylists(SqliteConnection cn, SqliteTransaction tx, ImportReport report)
        {
            var playlists = ReadJson<Dictionary<string, Playlist>>("playlists.json");
            if (playlists == null) return;

            foreach (var (name, playlist) in playlists)
            {
                using var insert = cn.CreateCommand();
                insert.Transaction = tx;
                insert.CommandText = @"
INSERT INTO playlists (name, title, group_name, sort_order, banner_image, banner_video)
VALUES ($name, $title, $group, $order, $image, $video);
SELECT last_insert_rowid();";
                insert.Parameters.AddWithValue("$name", name);
                insert.Parameters.AddWithValue("$title", playlist.title ?? name);
                insert.Parameters.AddWithValue("$group", (object?)playlist.group ?? DBNull.Value);
                insert.Parameters.AddWithValue("$order", (object?)playlist.order ?? DBNull.Value);
                insert.Parameters.AddWithValue("$image", (object?)playlist.banner?.image ?? DBNull.Value);
                insert.Parameters.AddWithValue("$video", (object?)playlist.banner?.video ?? DBNull.Value);

                var playlistId = Convert.ToInt64(insert.ExecuteScalar());
                report.Playlists++;

                foreach (var (key, meta) in playlist.videos ?? new Dictionary<string, VideoMeta>())
                {
                    // Разбор ключа общий с PlaylistRepository: если эти двое
                    // разойдутся, перенос и работа поймут "id#2" по-разному
                    var (coubId, instance) = PlaylistRepository.SplitKey(key);
                    ImportItem(cn, tx, playlistId, name, coubId, instance, meta, report);
                }
            }
        }

        private static void ImportItem(
            SqliteConnection cn, SqliteTransaction tx, long playlistId, string playlistName,
            string coubId, int instance, VideoMeta meta, ImportReport report)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText = @"
INSERT INTO playlist_items
    (playlist_id, coub_id, instance, title, sort_order, last_viewed, fx, bg_fx, bg_separate)
VALUES
    ($playlist, $coub, $instance, $title, $order, $viewed, $fx, $bgFx, $bgSeparate);";
            command.Parameters.AddWithValue("$playlist", playlistId);
            command.Parameters.AddWithValue("$coub", coubId);
            command.Parameters.AddWithValue("$instance", instance);
            command.Parameters.AddWithValue("$title", meta.title ?? coubId);
            command.Parameters.AddWithValue("$order", meta.order);
            command.Parameters.AddWithValue("$viewed", FormatDate(meta.lastViewed));
            command.Parameters.AddWithValue("$fx", SerializeMap(meta.fx));
            command.Parameters.AddWithValue("$bgFx", SerializeMap(meta.bgFx));
            command.Parameters.AddWithValue("$bgSeparate",
                meta.bgSeparate.HasValue ? (meta.bgSeparate.Value ? 1 : 0) : (object)DBNull.Value);

            try
            {
                command.ExecuteNonQuery();
                report.Items++;
            }
            catch (SqliteException ex)
            {
                // Чаще всего это ссылка на ролик, которого нет в coub_list.json.
                // Не роняем перенос целиком — записываем и идём дальше
                report.Warnings.Add($"«{playlistName}» / {coubId}: {ex.Message}");
            }
        }

        // ─── Пресеты и порядок групп ────────────────────────────────────────

        private void ImportFxPresets(SqliteConnection cn, SqliteTransaction tx, ImportReport report)
        {
            var presets = ReadJson<List<FxPreset>>("fx_presets.json");
            if (presets == null) return;

            foreach (var preset in presets)
            {
                if (string.IsNullOrWhiteSpace(preset.name)) continue;

                using var command = cn.CreateCommand();
                command.Transaction = tx;
                command.CommandText = @"
INSERT OR REPLACE INTO fx_presets (name, fx, bg_fx, bg_separate)
VALUES ($name, $fx, $bgFx, $bgSeparate);";
                command.Parameters.AddWithValue("$name", preset.name);
                command.Parameters.AddWithValue("$fx", SerializeMap(preset.fx));
                command.Parameters.AddWithValue("$bgFx", SerializeMap(preset.bgFx));
                command.Parameters.AddWithValue("$bgSeparate", preset.bgSeparate ? 1 : 0);
                command.ExecuteNonQuery();
                report.FxPresets++;
            }
        }

        private void ImportGroupOrder(SqliteConnection cn, SqliteTransaction tx, ImportReport report)
        {
            var order = ReadJson<Dictionary<string, List<string>>>("group_order.json");
            if (order == null) return;

            foreach (var (kind, names) in order)
            {
                for (var i = 0; i < names.Count; i++)
                {
                    using var command = cn.CreateCommand();
                    command.Transaction = tx;
                    command.CommandText =
                        "INSERT OR REPLACE INTO group_order (kind, name, sort_order) VALUES ($kind, $name, $order);";
                    command.Parameters.AddWithValue("$kind", kind);
                    command.Parameters.AddWithValue("$name", names[i]);
                    command.Parameters.AddWithValue("$order", i);
                    command.ExecuteNonQuery();
                    report.GroupOrder++;
                }
            }
        }

        // ─── Мелочи ─────────────────────────────────────────────────────────

        /// <summary>
        /// Дату храним строкой ровно в том виде, в каком её пишет Newtonsoft
        /// ("o" для UTC) — тогда выгрузка обратно даёт побайтно тот же JSON.
        /// </summary>
        private static object FormatDate(DateTime? value) =>
            value.HasValue ? value.Value.ToString("o") : DBNull.Value;

        private static object SerializeMap(Dictionary<string, double>? map) =>
            map == null || map.Count == 0
                ? DBNull.Value
                : JsonConvert.SerializeObject(map);

        private T? ReadJson<T>(string fileName) where T : class
        {
            var path = System.IO.Path.Combine(_dataDir, fileName);
            if (!File.Exists(path)) return null;

            var json = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(json)) return null;

            try
            {
                return JsonConvert.DeserializeObject<T>(json);
            }
            catch (JsonException ex)
            {
                throw new InvalidOperationException($"{fileName} не разобрался: {ex.Message}", ex);
            }
        }
    }
}
