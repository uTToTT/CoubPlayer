using CoubPlayer.Meta;
using Newtonsoft.Json;

namespace CoubPlayer.Services
{
    /// <summary>
    /// Мигрирует старую раскладку файлов ("Coubs/{id}/video.mp4", физически в
    /// wwwroot/Coubs/{id}) на новую ("/Data/Coubs/{id}/video.mp4", физически в
    /// wwwroot/Data/Coubs/{id}), которую использует CoubDownloadService.
    ///
    /// Без этого шага в двух разных папках оказывались бы копии одного и того же
    /// ролика: старые (из консольного CoubDownloader) — в wwwroot/Coubs, новые
    /// (докачанные через плеер) — в wwwroot/Data/Coubs. Заодно после переноса
    /// проверка "уже скачано" в CoubDownloadService (она смотрит только в новую
    /// папку) начинает видеть и старые ролики — повторных скачиваний не будет.
    ///
    /// Идемпотентна: при повторном запуске уже мигрированные записи (video
    /// начинается с "/") просто пропускаются, так что вызывать можно на каждом
    /// старте приложения без последствий.
    /// </summary>
    public static class CoubLibraryMigrator
    {
        public static void MigrateOldPaths()
        {
            var wwwroot = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
            var coubListPath = Path.Combine(wwwroot, "Data", "coub_list.json");

            if (!File.Exists(coubListPath))
                return; // ещё нет ни одного скачанного ролика — мигрировать нечего

            List<CoubListEntry>? list;
            try
            {
                var json = File.ReadAllText(coubListPath);
                list = JsonConvert.DeserializeObject<List<CoubListEntry>>(json);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[Migration] Не удалось прочитать coub_list.json: {ex.Message}");
                return;
            }

            if (list == null || list.Count == 0) return;

            var moved = 0;
            var pathsRewritten = 0;
            var missingOnDisk = 0;
            var changed = false;

            foreach (var entry in list)
            {
                if (string.IsNullOrEmpty(entry.video)) continue;

                // Новый формат уже абсолютный веб-путь (начинается с "/") — уже мигрировано
                if (entry.video.StartsWith('/')) continue;

                var videoFileName = Path.GetFileName(entry.video);
                var audioFileName = string.IsNullOrEmpty(entry.audio) ? null : Path.GetFileName(entry.audio);

                // Старый путь в JSON относительный (например "Coubs/4aoaqe/video.mp4") —
                // берём его буквально, а не реконструируем по конвенции, чтобы не промахнуться,
                // если реальная раскладка на диске у кого-то немного отличается
                var oldVideoOnDisk = Path.Combine(wwwroot, entry.video.Replace('/', Path.DirectorySeparatorChar));
                var oldFolder = Path.GetDirectoryName(oldVideoOnDisk);

                var newFolder = Path.Combine(wwwroot, "Data", "Coubs", entry.id);

                if (!string.IsNullOrEmpty(oldFolder) && Directory.Exists(oldFolder))
                {
                    if (!Directory.Exists(newFolder))
                    {
                        Directory.CreateDirectory(Path.Combine(wwwroot, "Data", "Coubs"));
                        Directory.Move(oldFolder, newFolder);
                    }
                    else
                    {
                        // Новая папка уже существует (ролик перескачали через плеер заново) —
                        // переносим только недостающие файлы, а старую папку убираем целиком,
                        // чтобы не оставалось двух копий
                        foreach (var file in Directory.GetFiles(oldFolder))
                        {
                            var destFile = Path.Combine(newFolder, Path.GetFileName(file));
                            if (!File.Exists(destFile))
                                File.Move(file, destFile);
                        }
                        Directory.Delete(oldFolder, recursive: true);
                    }
                    moved++;
                }
                else if (!Directory.Exists(newFolder))
                {
                    // Ни старой, ни новой папки физически нет — файлы утеряны.
                    // Путь в JSON всё равно переводим в новый формат: если ролик
                    // когда-нибудь перескачают через /download или /sync, он ляжет
                    // именно туда и запись сама "оживёт"
                    missingOnDisk++;
                }

                entry.video = $"/Data/Coubs/{entry.id}/{videoFileName}";
                if (audioFileName != null)
                    entry.audio = $"/Data/Coubs/{entry.id}/{audioFileName}";

                pathsRewritten++;
                changed = true;
            }

            if (!changed) return;

            // Бэкап делаем один раз — если он уже есть, значит миграция когда-то
            // уже запускалась, повторно исходный (до-миграционный) файл не трогаем
            var backupPath = coubListPath + ".bak";
            if (!File.Exists(backupPath))
                File.Copy(coubListPath, backupPath);

            var newJson = JsonConvert.SerializeObject(list, Formatting.Indented);
            var tempPath = coubListPath + ".tmp";
            File.WriteAllText(tempPath, newJson);
            File.Replace(tempPath, coubListPath, null);

            Console.WriteLine(
                $"[Migration] coub_list.json: путей обновлено — {pathsRewritten}, " +
                $"папок перенесено — {moved}, файлов не найдено на диске — {missingOnDisk}.");
        }
    }
}