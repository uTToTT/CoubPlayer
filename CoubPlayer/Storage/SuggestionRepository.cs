using Microsoft.Data.Sqlite;

namespace CoubPlayer.Storage
{
    public class PlaylistSuggestion
    {
        public string name { get; set; } = "";
        public double score { get; set; }
        /// <summary>Теги, из-за которых плейлист и предложен — чтобы подсказка не была гаданием.</summary>
        public List<string> matched { get; set; } = new();
    }

    public class TagSuggestion
    {
        public string tag { get; set; } = "";
        public double score { get; set; }
    }

    /// <summary>
    /// Подсказка «куда положить и что повесить».
    ///
    /// Считается по тегам, которые Coub сам повесил на ролик: их приносит
    /// дозагрузка метаданных. Своих тегов у пользователя десятки, коубовских
    /// — десятки тысяч, и именно вторые дают достаточно совпадений, чтобы
    /// что-то предполагать.
    ///
    /// Мера — доля, а не число. Плейлист предлагается не потому, что в нём
    /// много роликов с таким тегом, а потому что такой тег в нём преобладает:
    /// «аниме» у пяти роликов из трёх тысяч не значит ничего, а у восьмидесяти
    /// из ста значит почти всё. Без этого самый большой плейлист побеждал бы
    /// всегда.
    ///
    /// Редкость тега учитывается отдельно: тег, который есть у половины
    /// библиотеки, почти ничего не говорит о принадлежности.
    /// </summary>
    public class SuggestionRepository
    {
        /// <summary>Сколько подсказок отдавать.</summary>
        private const int TopPlaylists = 3;
        private const int TopTags = 5;

        /// <summary>
        /// Ниже этого предлагать не стоит: совпало что-то слишком общее.
        ///
        /// Подобрано на выборке из 116 роликов с двумя тематическими
        /// плейлистами: отложенные ролики своей темы набирали 1,4–8,7, чужие
        /// — 0,2–2,9. Чистой границы между ними нет и быть не может, так что
        /// это отсечка явного шума, а не критерий правоты. На библиотеке
        /// в сотню плейлистов может потребовать правки.
        /// </summary>
        private const double MinScore = 0.25;

        private readonly CoubDb _db;

        public SuggestionRepository(CoubDb db) => _db = db;

        public (List<PlaylistSuggestion> playlists, List<TagSuggestion> tags) Suggest(string coubId)
        {
            using var connection = _db.Open();
            return Suggest(connection, coubId, ReadCoubTagIds(connection, coubId));
        }

        /// <summary>
        /// То же самое, но для ролика, которого в библиотеке ещё нет: теги
        /// приходят снаружи — их приносит расширение прямо со страницы coub.com.
        ///
        /// Незнакомые теги отбрасываются молча: тега, которого нет ни у одного
        /// скачанного ролика, всё равно не с чем сравнивать. Если не осталось
        /// ни одного — подсказок не будет, и это честный ответ, а не ошибка.
        /// </summary>
        public (List<PlaylistSuggestion> playlists, List<TagSuggestion> tags) SuggestByTags(
            string coubId, IEnumerable<string> tagNames)
        {
            using var connection = _db.Open();
            return Suggest(connection, coubId, ResolveTagIds(connection, tagNames));
        }

        /// <summary>
        /// Есть ли у ролика коубовские теги — то единственное, на чём строятся
        /// подсказки. Нет тегов — и считать нечего, сколько ни спрашивай.
        /// </summary>
        public bool HasTags(string coubId)
        {
            using var connection = _db.Open();
            return ReadCoubTagIds(connection, coubId).Count > 0;
        }

        private static (List<PlaylistSuggestion> playlists, List<TagSuggestion> tags) Suggest(
            SqliteConnection connection, string coubId, List<long> tagIds)
        {
            if (tagIds.Count == 0) return (new(), new());

            var library = CountCoubsWithMetadata(connection);
            if (library == 0) return (new(), new());

            var globalCounts = ReadGlobalTagCounts(connection, tagIds);
            var tagNames = ReadTagNames(connection, tagIds);

            // Редкость тега: тег у половины библиотеки почти ничего не говорит,
            // тег у десятка роликов говорит много
            var weight = new Dictionary<long, double>();
            foreach (var id in tagIds)
            {
                var seen = globalCounts.GetValueOrDefault(id, 0);
                weight[id] = Math.Log(1.0 + (double)library / (1 + seen));
            }

            return (
                SuggestPlaylists(connection, coubId, tagIds, weight, tagNames),
                SuggestTags(connection, coubId, tagIds, weight)
            );
        }

        // ─── Плейлисты ──────────────────────────────────────────────────────

        private static List<PlaylistSuggestion> SuggestPlaylists(
            SqliteConnection cn, string coubId, List<long> tagIds,
            Dictionary<long, double> weight, Dictionary<long, string> tagNames)
        {
            // Сколько роликов со сведениями в каждом плейлисте. Ролики без
            // метаданных в знаменатель не берём: они не могли бы совпасть
            // ни по одному тегу и только занижали бы долю
            var sizes = new Dictionary<long, int>();
            using (var command = cn.CreateCommand())
            {
                command.CommandText = @"
SELECT i.playlist_id, COUNT(DISTINCT i.coub_id)
FROM playlist_items i
JOIN coubs c ON c.id = i.coub_id
WHERE c.meta_fetched_at IS NOT NULL AND i.coub_id <> $id
GROUP BY i.playlist_id;";
                command.Parameters.AddWithValue("$id", coubId);

                using var reader = command.ExecuteReader();
                while (reader.Read()) sizes[reader.GetInt64(0)] = reader.GetInt32(1);
            }

            // Сколько роликов в плейлисте несут каждый из тегов кандидата
            var hits = new Dictionary<long, Dictionary<long, int>>();
            using (var command = cn.CreateCommand())
            {
                command.CommandText = $@"
SELECT i.playlist_id, ct.tag_id, COUNT(DISTINCT i.coub_id)
FROM playlist_items i
JOIN coub_tags ct ON ct.coub_id = i.coub_id AND ct.source = 'coub'
WHERE ct.tag_id IN ({Placeholders(tagIds)}) AND i.coub_id <> $id
GROUP BY i.playlist_id, ct.tag_id;";
                command.Parameters.AddWithValue("$id", coubId);
                AddTagParameters(command, tagIds);

                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var playlistId = reader.GetInt64(0);
                    if (!hits.TryGetValue(playlistId, out var perTag))
                        hits[playlistId] = perTag = new Dictionary<long, int>();
                    perTag[reader.GetInt64(1)] = reader.GetInt32(2);
                }
            }

            // Плейлисты, где ролик уже лежит, предлагать незачем
            var already = ReadPlaylistsContaining(cn, coubId);
            var names = ReadPlaylistNames(cn);

            var result = new List<PlaylistSuggestion>();

            foreach (var (playlistId, perTag) in hits)
            {
                if (already.Contains(playlistId)) continue;
                if (!sizes.TryGetValue(playlistId, out var size) || size == 0) continue;
                if (!names.TryGetValue(playlistId, out var name)) continue;

                double score = 0;
                var matched = new List<(string tag, double share)>();

                foreach (var (tagId, count) in perTag)
                {
                    var share = (double)count / size;
                    score += weight.GetValueOrDefault(tagId, 0) * share;

                    if (tagNames.TryGetValue(tagId, out var tagName))
                        matched.Add((tagName, share));
                }

                if (score < MinScore) continue;

                result.Add(new PlaylistSuggestion
                {
                    name = name,
                    score = Math.Round(score, 4),
                    // Показываем те теги, что дали больше всего: по ним видно,
                    // почему плейлист предложен
                    matched = matched.OrderByDescending(m => m.share)
                        .Take(4).Select(m => m.tag).ToList(),
                });
            }

            return result.OrderByDescending(r => r.score).Take(TopPlaylists).ToList();
        }

        // ─── Теги пользователя ──────────────────────────────────────────────

        /// <summary>
        /// Какие свои теги стоит повесить. Считаем по тому же принципу: тег
        /// предлагается, если ролики, на которых он уже висит, несут те же
        /// коубовские теги, что и кандидат.
        /// </summary>
        private static List<TagSuggestion> SuggestTags(
            SqliteConnection cn, string coubId, List<long> tagIds, Dictionary<long, double> weight)
        {
            var sizes = new Dictionary<long, int>();
            using (var command = cn.CreateCommand())
            {
                command.CommandText = @"
SELECT tag_id, COUNT(DISTINCT coub_id) FROM coub_tags
WHERE source = 'user' AND coub_id <> $id
GROUP BY tag_id;";
                command.Parameters.AddWithValue("$id", coubId);

                using var reader = command.ExecuteReader();
                while (reader.Read()) sizes[reader.GetInt64(0)] = reader.GetInt32(1);
            }

            if (sizes.Count == 0) return new();

            var scores = new Dictionary<long, double>();
            using (var command = cn.CreateCommand())
            {
                command.CommandText = $@"
SELECT mine.tag_id, theirs.tag_id, COUNT(DISTINCT mine.coub_id)
FROM coub_tags mine
JOIN coub_tags theirs ON theirs.coub_id = mine.coub_id AND theirs.source = 'coub'
WHERE mine.source = 'user' AND mine.coub_id <> $id
  AND theirs.tag_id IN ({Placeholders(tagIds)})
GROUP BY mine.tag_id, theirs.tag_id;";
                command.Parameters.AddWithValue("$id", coubId);
                AddTagParameters(command, tagIds);

                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var userTagId = reader.GetInt64(0);
                    var coubTagId = reader.GetInt64(1);
                    var count = reader.GetInt32(2);

                    if (!sizes.TryGetValue(userTagId, out var size) || size == 0) continue;

                    scores.TryGetValue(userTagId, out var current);
                    scores[userTagId] = current + weight.GetValueOrDefault(coubTagId, 0) * count / size;
                }
            }

            // Свои теги, уже висящие на ролике, предлагать незачем
            var own = ReadOwnUserTagIds(cn, coubId);
            var names = ReadTagNames(cn, scores.Keys.ToList());

            return scores
                .Where(s => !own.Contains(s.Key) && s.Value >= MinScore)
                .OrderByDescending(s => s.Value)
                .Take(TopTags)
                .Where(s => names.ContainsKey(s.Key))
                .Select(s => new TagSuggestion { tag = names[s.Key], score = Math.Round(s.Value, 4) })
                .ToList();
        }

        // ─── Выборки ────────────────────────────────────────────────────────

        /// <summary>
        /// Имена тегов → их id. Регистр и пробелы приводятся так же, как при
        /// сохранении (CoubRepository.Normalize), иначе «Anime» и «anime»
        /// оказались бы разными тегами.
        /// </summary>
        private static List<long> ResolveTagIds(SqliteConnection cn, IEnumerable<string> tagNames)
        {
            var names = tagNames
                .Select(t => t?.Trim().ToLowerInvariant() ?? "")
                .Where(t => t.Length > 0)
                .Distinct()
                .ToList();

            if (names.Count == 0) return new();

            using var command = cn.CreateCommand();
            command.CommandText =
                $"SELECT id FROM tags WHERE name IN ({Placeholders(names)});";
            for (var i = 0; i < names.Count; i++)
                command.Parameters.AddWithValue($"$t{i}", names[i]);

            var result = new List<long>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result.Add(reader.GetInt64(0));
            return result;
        }

        private static List<long> ReadCoubTagIds(SqliteConnection cn, string coubId)
        {
            using var command = cn.CreateCommand();
            command.CommandText =
                "SELECT tag_id FROM coub_tags WHERE coub_id = $id AND source = 'coub';";
            command.Parameters.AddWithValue("$id", coubId);

            var result = new List<long>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result.Add(reader.GetInt64(0));
            return result;
        }

        private static HashSet<long> ReadOwnUserTagIds(SqliteConnection cn, string coubId)
        {
            using var command = cn.CreateCommand();
            command.CommandText =
                "SELECT tag_id FROM coub_tags WHERE coub_id = $id AND source = 'user';";
            command.Parameters.AddWithValue("$id", coubId);

            var result = new HashSet<long>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result.Add(reader.GetInt64(0));
            return result;
        }

        private static int CountCoubsWithMetadata(SqliteConnection cn)
        {
            using var command = cn.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM coubs WHERE meta_fetched_at IS NOT NULL;";
            return Convert.ToInt32(command.ExecuteScalar());
        }

        private static Dictionary<long, int> ReadGlobalTagCounts(SqliteConnection cn, List<long> tagIds)
        {
            using var command = cn.CreateCommand();
            command.CommandText = $@"
SELECT tag_id, COUNT(DISTINCT coub_id) FROM coub_tags
WHERE source = 'coub' AND tag_id IN ({Placeholders(tagIds)})
GROUP BY tag_id;";
            AddTagParameters(command, tagIds);

            var result = new Dictionary<long, int>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result[reader.GetInt64(0)] = reader.GetInt32(1);
            return result;
        }

        private static Dictionary<long, string> ReadTagNames(SqliteConnection cn, List<long> tagIds)
        {
            var result = new Dictionary<long, string>();
            if (tagIds.Count == 0) return result;

            using var command = cn.CreateCommand();
            command.CommandText = $"SELECT id, name FROM tags WHERE id IN ({Placeholders(tagIds)});";
            AddTagParameters(command, tagIds);

            using var reader = command.ExecuteReader();
            while (reader.Read()) result[reader.GetInt64(0)] = reader.GetString(1);
            return result;
        }

        private static HashSet<long> ReadPlaylistsContaining(SqliteConnection cn, string coubId)
        {
            using var command = cn.CreateCommand();
            command.CommandText = "SELECT DISTINCT playlist_id FROM playlist_items WHERE coub_id = $id;";
            command.Parameters.AddWithValue("$id", coubId);

            var result = new HashSet<long>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result.Add(reader.GetInt64(0));
            return result;
        }

        private static Dictionary<long, string> ReadPlaylistNames(SqliteConnection cn)
        {
            using var command = cn.CreateCommand();
            command.CommandText = "SELECT id, name FROM playlists;";

            var result = new Dictionary<long, string>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) result[reader.GetInt64(0)] = reader.GetString(1);
            return result;
        }

        /// <summary>
        /// «$t0, $t1, …» — теги подставляются параметрами, а не текстом.
        /// Годится и для id, и для имён: важно только их количество.
        /// </summary>
        private static string Placeholders<T>(List<T> items) =>
            string.Join(", ", items.Select((_, i) => $"$t{i}"));

        private static void AddTagParameters(SqliteCommand command, List<long> ids)
        {
            for (var i = 0; i < ids.Count; i++)
                command.Parameters.AddWithValue($"$t{i}", ids[i]);
        }
    }
}
