using CoubPlayer.Meta;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;

namespace CoubPlayer.Storage
{
    /// <summary>
    /// Пресеты постобработки — именованные наборы настроек. Заменяет
    /// fx_presets.json. Имя и есть ключ, регистр при сравнении не важен.
    /// </summary>
    public class FxPresetRepository
    {
        private readonly CoubDb _db;
        private static readonly object _lock = new();

        public FxPresetRepository(CoubDb db) => _db = db;

        public List<FxPreset> ReadAll()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                return ReadAll(connection);
            }
        }

        public static List<FxPreset> ReadAll(SqliteConnection cn)
        {
            using var command = cn.CreateCommand();
            command.CommandText = "SELECT name, fx, bg_fx, bg_separate FROM fx_presets ORDER BY rowid;";

            var result = new List<FxPreset>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                result.Add(new FxPreset
                {
                    name = reader.GetString(0),
                    fx = DeserializeMap(reader, 1),
                    bgFx = DeserializeMap(reader, 2),
                    bgSeparate = reader.GetInt32(3) != 0,
                });
            }
            return result;
        }

        /// <summary>Создаёт пресет или перезаписывает существующий с тем же именем.</summary>
        public List<FxPreset> Save(FxPreset preset)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                // Имя в базе — PRIMARY KEY с учётом регистра, а прежний контроллер
                // сравнивал без него. Убираем разнописанного двойника заранее,
                // иначе рядом появился бы второй пресет с тем же именем
                Execute(connection, transaction,
                    "DELETE FROM fx_presets WHERE name = $name COLLATE NOCASE;",
                    ("$name", preset.name));

                Execute(connection, transaction, @"
INSERT INTO fx_presets (name, fx, bg_fx, bg_separate)
VALUES ($name, $fx, $bgFx, $bgSeparate);",
                    ("$name", preset.name),
                    ("$fx", SerializeMap(preset.fx)),
                    ("$bgFx", SerializeMap(preset.bgFx)),
                    ("$bgSeparate", preset.bgSeparate ? 1 : 0));

                var all = ReadAll(connection);
                transaction.Commit();
                return all;
            }
        }

        /// <summary>null — пресета с таким именем не было.</summary>
        public List<FxPreset>? Delete(string name)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var removed = Execute(connection, transaction,
                    "DELETE FROM fx_presets WHERE name = $name COLLATE NOCASE;", ("$name", name));

                if (removed == 0) return null;

                var all = ReadAll(connection);
                transaction.Commit();
                return all;
            }
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

        private static Dictionary<string, double>? DeserializeMap(SqliteDataReader reader, int column) =>
            reader.IsDBNull(column)
                ? null
                : JsonConvert.DeserializeObject<Dictionary<string, double>>(reader.GetString(column));

        private static object SerializeMap(Dictionary<string, double>? map) =>
            map == null || map.Count == 0 ? DBNull.Value : JsonConvert.SerializeObject(map);
    }
}
