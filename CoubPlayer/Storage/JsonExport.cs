using Microsoft.Data.Sqlite;
using Newtonsoft.Json;

namespace CoubPlayer.Storage
{
    /// <summary>
    /// Выгрузка базы обратно в JSON-файлы прежнего формата.
    ///
    /// Это не только инструмент миграции. Во-первых, им проверяется сам
    /// перенос: импортировали, выгрузили, сравнили с исходником — совпало,
    /// значит ничего не потеряно. Во-вторых, это резервная копия в понятном
    /// формате и путь назад, если с базой что-то пойдёт не так.
    ///
    /// Данные берутся теми же выборками, которыми пользуется приложение,
    /// и сериализуются теми же настройками — поэтому выгрузка совпадает
    /// с оригиналом, включая пропуск пустых полей.
    /// </summary>
    public class JsonExport
    {
        private readonly CoubDb _db;

        public JsonExport(CoubDb db) => _db = db;

        public void WriteAll(string targetDir)
        {
            Directory.CreateDirectory(targetDir);
            using var connection = _db.Open();

            // Своя копия чтения здесь означала бы, что выгрузка проверяет
            // саму себя, а не то, что плеер увидит в базе
            Write(targetDir, "coub_list.json", CoubRepository.ReadAll(connection));
            Write(targetDir, "playlists.json", PlaylistRepository.ReadAll(connection));
            Write(targetDir, "tag_groups.json", ReadTagGroups(connection));
            Write(targetDir, "fx_presets.json", FxPresetRepository.ReadAll(connection));
            Write(targetDir, "group_order.json", GroupOrderRepository.ReadAll(connection));
        }

        private static void Write(string dir, string name, object data)
        {
            var json = JsonConvert.SerializeObject(data, Formatting.Indented);
            File.WriteAllText(Path.Combine(dir, name), json);
        }

        /// <summary>
        /// Карта «тег → группа». Отдельно от CoubRepository.GetTagGroups лишь
        /// потому, что тот открывает соединение сам, а здесь оно уже есть.
        /// </summary>
        private static Dictionary<string, string> ReadTagGroups(SqliteConnection cn)
        {
            var result = new Dictionary<string, string>();

            using var command = cn.CreateCommand();
            command.CommandText =
                "SELECT name, group_name FROM tags WHERE group_name IS NOT NULL ORDER BY id;";
            using var reader = command.ExecuteReader();

            while (reader.Read()) result[reader.GetString(0)] = reader.GetString(1);
            return result;
        }
    }
}
