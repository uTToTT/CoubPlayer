using Microsoft.Data.Sqlite;

namespace CoubPlayer.Storage
{
    /// <summary>
    /// Порядок групп в списках плейлистов и тегов. Заменяет group_order.json.
    ///
    /// Самих групп как сущности нет — они существуют, пока на них кто-то
    /// ссылается. Здесь хранится только их последовательность.
    /// </summary>
    public class GroupOrderRepository
    {
        private readonly CoubDb _db;
        private static readonly object _lock = new();

        public GroupOrderRepository(CoubDb db) => _db = db;

        public Dictionary<string, List<string>> ReadAll()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                return ReadAll(connection);
            }
        }

        public static Dictionary<string, List<string>> ReadAll(SqliteConnection cn)
        {
            using var command = cn.CreateCommand();
            command.CommandText = "SELECT kind, name FROM group_order ORDER BY kind, sort_order;";

            var result = new Dictionary<string, List<string>>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var kind = reader.GetString(0);
                if (!result.TryGetValue(kind, out var list))
                {
                    list = new List<string>();
                    result[kind] = list;
                }
                list.Add(reader.GetString(1));
            }
            return result;
        }

        /// <summary>Порядок групп одного вида. Приходит полный список.</summary>
        public Dictionary<string, List<string>> SetOrder(string kind, List<string> groups)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                // Полная замена: пропавшие из списка группы должны исчезнуть,
                // иначе они остались бы висеть со старыми позициями
                using (var clear = connection.CreateCommand())
                {
                    clear.Transaction = transaction;
                    clear.CommandText = "DELETE FROM group_order WHERE kind = $kind;";
                    clear.Parameters.AddWithValue("$kind", kind);
                    clear.ExecuteNonQuery();
                }

                for (var i = 0; i < groups.Count; i++)
                {
                    using var insert = connection.CreateCommand();
                    insert.Transaction = transaction;
                    insert.CommandText =
                        "INSERT INTO group_order (kind, name, sort_order) VALUES ($kind, $name, $order);";
                    insert.Parameters.AddWithValue("$kind", kind);
                    insert.Parameters.AddWithValue("$name", groups[i]);
                    insert.Parameters.AddWithValue("$order", i);
                    insert.ExecuteNonQuery();
                }

                var all = ReadAll(connection);
                transaction.Commit();
                return all;
            }
        }

        /// <summary>Порядок групп плейлистов — то, что нужно расширению.</summary>
        public List<string> ReadPlaylistGroups() =>
            ReadAll().TryGetValue("playlists", out var order) ? order : new List<string>();
    }
}
