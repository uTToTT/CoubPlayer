using CoubPlayer.Services;

namespace CoubPlayer.Storage
{
    /// <summary>
    /// Что происходит с данными при запуске.
    ///
    /// Три разных дела, которые легко перепутать:
    ///
    /// • схема — форма таблиц, версия в PRAGMA user_version (см. CoubDb.Migrate);
    /// • перенос из JSON — одноразовый, при первом запуске после перехода;
    /// • миграции данных между версиями плеера — то, ради чего у плеера
    ///   вообще появилась версия (см. AppVersion).
    ///
    /// Порядок важен: сперва схема, потом перенос, потом миграции. Переносить
    /// некуда, пока нет таблиц, а мигрировать нечего, пока нет данных.
    /// </summary>
    public static class DataMigrations
    {
        private static readonly string[] LegacyFiles =
        {
            "coub_list.json", "playlists.json", "tag_groups.json",
            "fx_presets.json", "group_order.json",
        };

        public static void Run(CoubDb db, string dataDir)
        {
            db.Migrate();

            ImportLegacyJson(db, dataDir);
            MigrateBetweenVersions(db, dataDir);
        }

        // ─── Переход с JSON ─────────────────────────────────────────────────

        /// <summary>
        /// Переносит JSON-файлы в базу — один раз, при первом запуске после
        /// перехода. Дальше файлов уже нет, и эта проверка ничего не стоит.
        /// </summary>
        private static void ImportLegacyJson(CoubDb db, string dataDir)
        {
            if (!db.IsEmpty()) return;

            var present = LegacyFiles.Where(f => File.Exists(Path.Combine(dataDir, f))).ToList();
            if (present.Count == 0) return;   // чистая установка, переносить нечего

            ConsoleLog.Section("ПЕРЕХОД НА БАЗУ ДАННЫХ");
            ConsoleLog.Info($"  найдено файлов: {present.Count}");

            var report = new JsonImport(dataDir).Run(db);
            ConsoleLog.Info("  перенесено: " + report);

            foreach (var warning in report.Warnings.Take(20))
                ConsoleLog.Muted("  " + warning);
            if (report.Warnings.Count > 20)
                ConsoleLog.Muted($"  …и ещё замечаний: {report.Warnings.Count - 20}");

            Verify(db, dataDir);
            Archive(dataDir, present);

            db.SetMeta(MetaKeys.ImportedAt, DateTime.UtcNow.ToString("o"));

            ConsoleLog.Success("  переход завершён, дальше плеер работает с базой");
            ConsoleLog.Divider();
        }

        /// <summary>
        /// Критерий приёмки: выгружаем базу обратно в JSON и сверяем
        /// с исходниками. Разошлось — останавливаемся, не тронув ни файла.
        ///
        /// Продолжать в этом случае нельзя. Молча работать поверх данных,
        /// про которые известно, что они переехали неправильно, — худшее
        /// из возможного: ошибка обнаружится через месяц, когда исходников
        /// уже не будет.
        /// </summary>
        private static void Verify(CoubDb db, string dataDir)
        {
            var verifyDir = Path.Combine(dataDir, "json-backup", "verify");

            new JsonExport(db).WriteAll(verifyDir);
            var result = RoundTripCheck.Compare(dataDir, verifyDir);

            if (result.Ok)
            {
                ConsoleLog.Success("  сверка: перенос точный");
                try { Directory.Delete(verifyDir, recursive: true); } catch (IOException) { }
                return;
            }

            // Файл базы убираем: иначе следующий запуск решит, что переносить
            // уже нечего, и пойдёт работать с неполными данными
            ConsoleLog.Error("  сверка не сошлась:");
            foreach (var difference in result.Differences.Take(20))
                ConsoleLog.Error("    " + difference);

            try { File.Delete(db.FilePath); } catch (IOException) { }

            throw new InvalidOperationException(
                "Перенос данных в базу дал расхождения — плеер остановлен, чтобы не работать " +
                $"с неверными данными. Исходные JSON-файлы не тронуты, выгрузка для сравнения " +
                $"лежит в {verifyDir}.");
        }

        /// <summary>
        /// Убирает перенесённые файлы в сторону.
        ///
        /// Именно убирает, а не удаляет: это единственная копия библиотеки
        /// в читаемом виде, и она же — путь назад, если с базой что-то
        /// окажется не так.
        /// </summary>
        private static void Archive(string dataDir, List<string> files)
        {
            var backupDir = Path.Combine(dataDir, "json-backup");
            Directory.CreateDirectory(backupDir);

            foreach (var file in files)
            {
                var source = Path.Combine(dataDir, file);
                var target = Path.Combine(backupDir, file);

                try
                {
                    File.Move(source, target, overwrite: true);
                }
                catch (IOException ex)
                {
                    ConsoleLog.Muted($"  {file} остался на месте: {ex.Message}");
                }
            }

            ConsoleLog.Info($"  исходные файлы убраны в {backupDir}");
        }

        // ─── Между версиями плеера ──────────────────────────────────────────

        /// <summary>
        /// Доводит данные до текущей версии плеера.
        ///
        /// Пока шагов нет — и это нормально: механизм заводится заранее, до
        /// того как понадобится. Первая же миграция, придуманная задним
        /// числом, не сможет узнать, с какой версии пришли данные.
        /// </summary>
        private static void MigrateBetweenVersions(CoubDb db, string dataDir)
        {
            var stored = db.GetMeta(MetaKeys.AppVersion);
            var from = AppVersion.Parse(stored);

            if (stored == AppVersion.Current) return;

            if (stored != null && from > AppVersion.CurrentParsed)
            {
                // Данные писала более свежая сборка. Схему такой случай уже
                // отсёк бы, но версия плеера меняется и без изменений схемы
                ConsoleLog.Error(
                    $"[Версия] Данные записаны плеером {stored}, этот — {AppVersion.Current}. " +
                    "Работаем дальше, но лучше обновиться.");
                return;
            }

            // До 1.1.1 кадры-превью снимались вписыванием всего кадра в 16:9,
            // без обрезки: квадратные и вертикальные ролики выходили
            // раздавленными. Снятые тогда картинки лежат на диске и сами себя
            // не перепишут — сбрасываем, следующий показ снимет их заново
            if (from < new Version(1, 1, 1)) DropThumbs(dataDir);

            if (stored != null)
                ConsoleLog.Info($"[Версия] Данные обновлены с {stored} до {AppVersion.Current}");

            db.SetMeta(MetaKeys.AppVersion, AppVersion.Current);
        }

        /// <summary>
        /// Убирает снятые кадры-превью. Это чистый кэш: плеер снимет их заново
        /// при следующем показе списка, потеряется только время на одну
        /// загрузку. Неудача здесь запуск не задерживает.
        /// </summary>
        private static void DropThumbs(string dataDir)
        {
            var thumbs = Path.Combine(dataDir, "thumbs");
            if (!Directory.Exists(thumbs)) return;

            var removed = 0;
            foreach (var file in Directory.EnumerateFiles(thumbs, "*.webp"))
            {
                try { File.Delete(file); removed++; }
                catch (IOException) { /* занят — переживём, кадр просто останется старым */ }
            }

            if (removed > 0)
                ConsoleLog.Muted($"[Версия] кадры-превью сброшены: {removed}");
        }
    }
}
