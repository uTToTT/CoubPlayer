using Microsoft.Data.Sqlite;

namespace CoubPlayer.Storage
{
    /// <summary>
    /// Доступ к базе. Единственное место, которое знает, где лежит файл и как
    /// открывается соединение — контроллеры работают через репозитории поверх.
    ///
    /// База живёт рядом с остальными данными, в wwwroot/Data: так она попадает
    /// в резервную копию вместе с роликами и переезжает с портативной сборкой.
    /// </summary>
    public class CoubDb
    {
        private readonly string _path;

        public CoubDb(string? dataDir = null)
        {
            var dir = dataDir ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "Data");
            Directory.CreateDirectory(dir);
            _path = Path.Combine(dir, "coubplayer.db");
        }

        /// <summary>Не Path — иначе имя перекрывает System.IO.Path внутри класса.</summary>
        public string FilePath => _path;

        public SqliteConnection Open()
        {
            var connection = new SqliteConnection($"Data Source={_path}");
            connection.Open();

            // Внешние ключи в SQLite выключены по умолчанию и включаются
            // для каждого соединения отдельно
            using var pragma = connection.CreateCommand();
            pragma.CommandText = "PRAGMA foreign_keys = ON;";
            pragma.ExecuteNonQuery();

            return connection;
        }

        /// <summary>
        /// Создаёт схему, если её нет, и доводит до текущей версии.
        /// Вызывать при старте приложения — операция идемпотентна.
        /// </summary>
        public void Migrate()
        {
            using var connection = Open();

            // WAL переживает перезапуски и заметно спокойнее относится к тому,
            // что читатель и писатель работают одновременно. Внутри транзакции
            // этот PRAGMA выполнить нельзя, поэтому он идёт до неё.
            using (var wal = connection.CreateCommand())
            {
                wal.CommandText = "PRAGMA journal_mode = WAL;";
                wal.ExecuteScalar();
            }

            using var transaction = connection.BeginTransaction();

            var current = GetUserVersion(connection, transaction);

            if (current == 0)
            {
                Execute(connection, transaction, Schema.CreateSql);
                SetUserVersion(connection, transaction, Schema.Version);
                transaction.Commit();
                return;
            }

            // Шаги вперёд, по одному на версию. Каждый доводит базу с
            // предыдущей до своей и не знает о следующих
            if (current < 2)
            {
                Execute(connection, transaction, Schema.MigrateTo2Sql);
                current = 2;
            }

            if (current < 3)
            {
                Execute(connection, transaction, Schema.MigrateTo3Sql);
                current = 3;
            }

            if (current > Schema.Version)
            {
                // База новее приложения: её писала более свежая сборка, и что
                // там появилось, эта не знает. Чинить нечем — но и молча
                // работать поверх нельзя, испортим
                throw new InvalidOperationException(
                    $"База версии {current} новее приложения ({Schema.Version}). " +
                    "Обновите плеер.");
            }

            if (current != Schema.Version)
            {
                throw new InvalidOperationException(
                    $"База версии {current}, приложение ожидает {Schema.Version}. " +
                    "Шаг миграции не описан.");
            }

            SetUserVersion(connection, transaction, Schema.Version);
            transaction.Commit();
        }

        // ─── Таблица meta ───────────────────────────────────────────────────

        public string? GetMeta(string key)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $key;";
            command.Parameters.AddWithValue("$key", key);

            var value = command.ExecuteScalar();
            return value == null || value == DBNull.Value ? null : Convert.ToString(value);
        }

        public void SetMeta(string key, string value)
        {
            using var connection = Open();
            SetMeta(connection, null, key, value);
        }

        public static void SetMeta(
            SqliteConnection connection, SqliteTransaction? transaction, string key, string value)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "INSERT INTO meta (key, value) VALUES ($key, $value) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value;";
            command.Parameters.AddWithValue("$key", key);
            command.Parameters.AddWithValue("$value", value);
            command.ExecuteNonQuery();
        }

        /// <summary>Есть ли в базе хоть что-то — чтобы не импортировать поверх.</summary>
        public bool IsEmpty()
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT EXISTS(SELECT 1 FROM coubs) + EXISTS(SELECT 1 FROM playlists);";
            return Convert.ToInt64(command.ExecuteScalar()) == 0;
        }

        private static int GetUserVersion(SqliteConnection connection, SqliteTransaction transaction)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "PRAGMA user_version;";
            return Convert.ToInt32(command.ExecuteScalar());
        }

        private static void SetUserVersion(SqliteConnection connection, SqliteTransaction transaction, int version)
        {
            // PRAGMA не принимает параметры, поэтому число подставляем в текст.
            // Значение своё, из константы — подстановки извне здесь нет.
            Execute(connection, transaction, $"PRAGMA user_version = {version};");
        }

        private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            command.ExecuteNonQuery();
        }
    }
}
