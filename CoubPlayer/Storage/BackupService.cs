using CoubPlayer.Services;
using Microsoft.Data.Sqlite;

namespace CoubPlayer.Storage
{
    /// <summary>Одна резервная копия на диске.</summary>
    public class BackupInfo
    {
        /// <summary>Имя папки — оно же отметка времени, «2026-09-19_11-40-05».</summary>
        public string name { get; set; } = "";
        public string createdAt { get; set; } = "";
        public long bytes { get; set; }
        public bool automatic { get; set; }
    }

    /// <summary>
    /// Резервные копии библиотеки.
    ///
    /// Раньше данные лежали в пяти читаемых JSON, и копия делалась мышкой.
    /// Теперь всё в одном файле базы: 107 плейлистов, тысячи записей, порядок,
    /// группы, баннеры, эффекты, теги. Ролики перекачиваются за вечер —
    /// раскладка не перекачивается ничем.
    ///
    /// В копию кладём и то и другое:
    ///
    /// • coubplayer.db — точный снимок, восстановление за одно копирование.
    ///   Снимается через VACUUM INTO, а не копированием файла: при включённом
    ///   WAL часть данных лежит в отдельном журнале, и копия файла базы была бы
    ///   обрезана по последней контрольной точке.
    ///
    /// • JSON — то же самое в читаемом виде, на случай если с базой или самим
    ///   приложением что-то не так. Формат знает не все колонки (метаданные
    ///   Coub, эмбеддинги), поэтому он дополнение к снимку, а не замена.
    /// </summary>
    public class BackupService
    {
        /// <summary>Сколько копий держим. Каждая — около 5 МБ.</summary>
        private const int KeepCount = 10;

        /// <summary>Не чаще одной автоматической копии в сутки.</summary>
        private static readonly TimeSpan AutoInterval = TimeSpan.FromHours(20);

        private const string AutoMarker = ".auto";

        private readonly CoubDb _db;
        private readonly object _lock = new();

        public BackupService(CoubDb db) => _db = db;

        /// <summary>
        /// Рядом с приложением, а не в wwwroot/Data. Две причины: всё внутри
        /// wwwroot раздаётся по HTTP, а снимку базы там не место; и копия,
        /// лежащая внутри защищаемой папки, разделит её судьбу при любой
        /// неприятности с этой папкой целиком.
        /// </summary>
        public string BackupsDir => Path.Combine(Directory.GetCurrentDirectory(), "backups");

        // ─── Чтение ─────────────────────────────────────────────────────────

        public List<BackupInfo> List()
        {
            if (!Directory.Exists(BackupsDir)) return new();

            var result = new List<BackupInfo>();

            foreach (var dir in Directory.EnumerateDirectories(BackupsDir))
            {
                var info = new DirectoryInfo(dir);
                var size = info.EnumerateFiles("*", SearchOption.AllDirectories)
                    .Sum(f => f.Length);

                result.Add(new BackupInfo
                {
                    name = info.Name,
                    createdAt = info.CreationTimeUtc.ToString("o"),
                    bytes = size,
                    automatic = File.Exists(Path.Combine(dir, AutoMarker)),
                });
            }

            // Новые сверху: именно их и хотят видеть
            return result.OrderByDescending(b => b.createdAt).ToList();
        }

        public BackupInfo? Latest() => List().FirstOrDefault();

        // ─── Создание ───────────────────────────────────────────────────────

        /// <summary>
        /// Делает копию. Пока она не собралась целиком, папка называется
        /// с точкой впереди — незаконченную копию не видно в списке и её
        /// не примут за настоящую.
        /// </summary>
        public BackupInfo Create(bool automatic = false)
        {
            lock (_lock)
            {
                Directory.CreateDirectory(BackupsDir);

                var stamp = DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss");
                var target = Path.Combine(BackupsDir, stamp);
                var staging = Path.Combine(BackupsDir, "." + stamp);

                if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
                Directory.CreateDirectory(staging);

                try
                {
                    SnapshotDatabase(Path.Combine(staging, "coubplayer.db"));
                    new JsonExport(_db).WriteAll(Path.Combine(staging, "json"));

                    if (automatic) File.WriteAllText(Path.Combine(staging, AutoMarker), "");

                    if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                    Directory.Move(staging, target);
                }
                catch
                {
                    try { Directory.Delete(staging, recursive: true); } catch (IOException) { }
                    throw;
                }

                Rotate();

                var info = new DirectoryInfo(target);
                return new BackupInfo
                {
                    name = info.Name,
                    createdAt = info.CreationTimeUtc.ToString("o"),
                    bytes = info.EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length),
                    automatic = automatic,
                };
            }
        }

        /// <summary>
        /// Копия при запуске — до того, как в данных что-то поменяется.
        /// Если свежая уже есть, ничего не делает: перезапуск за перезапуском
        /// не должен вытеснять историю.
        /// </summary>
        public void EnsureRecent()
        {
            try
            {
                var latest = Latest();
                if (latest != null &&
                    DateTime.TryParse(latest.createdAt, null,
                        System.Globalization.DateTimeStyles.RoundtripKind, out var when) &&
                    DateTime.UtcNow - when < AutoInterval)
                {
                    return;
                }

                var made = Create(automatic: true);
                ConsoleLog.Muted($"[Копия] {made.name} — {made.bytes / 1024} КБ");
            }
            catch (Exception ex)
            {
                // Копия не должна мешать запуску: без неё плеер работает,
                // просто без подстраховки
                ConsoleLog.Error($"[Копия] не удалось сделать: {ex.Message}");
            }
        }

        /// <summary>
        /// Снимок базы. VACUUM INTO, а не File.Copy: при WAL свежие изменения
        /// лежат в отдельном журнале, и копия самого файла оказалась бы
        /// обрезанной по последней контрольной точке. Заодно снимок выходит
        /// уплотнённым.
        /// </summary>
        private void SnapshotDatabase(string targetPath)
        {
            using var connection = _db.Open();
            using var command = connection.CreateCommand();

            // Путь подставляем параметром: в нём бывают апострофы
            command.CommandText = "VACUUM INTO $path;";
            command.Parameters.AddWithValue("$path", targetPath);
            command.ExecuteNonQuery();
        }

        /// <summary>Оставляет последние KeepCount копий, остальные убирает.</summary>
        private void Rotate()
        {
            var all = List();
            foreach (var old in all.Skip(KeepCount))
            {
                try
                {
                    Directory.Delete(Path.Combine(BackupsDir, old.name), recursive: true);
                }
                catch (IOException ex)
                {
                    ConsoleLog.Muted($"[Копия] {old.name} не убралась: {ex.Message}");
                }
            }
        }
    }
}
