using CoubPlayer.Meta;
using Newtonsoft.Json;

namespace CoubPlayer.Services
{
    public class CoubListService
    {
        private readonly string _path = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "coub_list.json");
        private readonly object _lock = new();

        public List<CoubListEntry> ReadAll()
        {
            lock (_lock)
            {
                if (!System.IO.File.Exists(_path)) return new();
                var json = System.IO.File.ReadAllText(_path);
                return JsonConvert.DeserializeObject<List<CoubListEntry>>(json) ?? new();
            }
        }

        private void WriteAll(List<CoubListEntry> list)
        {
            var json = JsonConvert.SerializeObject(list, Formatting.Indented);
            var tmp = _path + ".tmp";
            System.IO.File.WriteAllText(tmp, json);
            if (System.IO.File.Exists(_path))
                System.IO.File.Replace(tmp, _path, null);
            else
                System.IO.File.Move(tmp, _path);
        }

        public void Upsert(CoubDownloadResult result)
        {
            if (string.IsNullOrEmpty(result.Video)) return;

            lock (_lock)
            {
                var list = ReadAllUnsafe();
                var existing = list.FirstOrDefault(c => c.id == result.Id);
                if (existing != null)
                {
                    existing.video = result.Video;
                    existing.audio = result.Audio ?? existing.audio;
                }
                else
                {
                    list.Add(new CoubListEntry
                    {
                        id = result.Id,
                        video = result.Video,
                        audio = result.Audio ?? "",
                        tags = new List<string>()
                    });
                }
                WriteAllUnsafe(list);
            }
        }

        public List<string>? AddTag(string id, string rawTag)
        {
            var tag = Normalize(rawTag);
            if (string.IsNullOrEmpty(tag)) return null;

            lock (_lock)
            {
                var list = ReadAllUnsafe();
                var entry = list.FirstOrDefault(c => c.id == id);
                if (entry == null) return null;

                entry.tags ??= new();
                if (!entry.tags.Contains(tag, StringComparer.OrdinalIgnoreCase))
                    entry.tags.Add(tag);

                WriteAllUnsafe(list);
                return entry.tags;
            }
        }

        public List<string>? RemoveTag(string id, string rawTag)
        {
            var tag = Normalize(rawTag);

            lock (_lock)
            {
                var list = ReadAllUnsafe();
                var entry = list.FirstOrDefault(c => c.id == id);
                if (entry == null) return null;

                entry.tags?.RemoveAll(t => string.Equals(t, tag, StringComparison.OrdinalIgnoreCase));
                WriteAllUnsafe(list);
                return entry.tags ?? new();
            }
        }

        public List<string>? GetTags(string id) =>
            ReadAll().FirstOrDefault(c => c.id == id)?.tags ?? null;

        public IEnumerable<(string Tag, int Count)> GetAllTags() =>
            ReadAll()
                .SelectMany(c => c.tags ?? new())
                .GroupBy(t => t, StringComparer.OrdinalIgnoreCase)
                .Select(g => (Tag: g.Key, Count: g.Count()))
                .OrderByDescending(x => x.Count);

        public List<CoubListEntry> Search(string[] tags, string mode)
        {
            var list = ReadAll();
            return list.Where(c =>
            {
                var t = c.tags ?? new();
                return mode == "all"
                    ? tags.All(w => t.Contains(w, StringComparer.OrdinalIgnoreCase))
                    : tags.Any(w => t.Contains(w, StringComparer.OrdinalIgnoreCase));
            }).ToList();
        }

        private static string Normalize(string tag) => tag?.Trim().ToLowerInvariant() ?? "";

        // *Unsafe = вызывать только уже под lock, чтобы не дублировать блокировку
        private List<CoubListEntry> ReadAllUnsafe()
        {
            if (!System.IO.File.Exists(_path)) return new();
            var json = System.IO.File.ReadAllText(_path);
            return JsonConvert.DeserializeObject<List<CoubListEntry>>(json) ?? new();
        }
        private void WriteAllUnsafe(List<CoubListEntry> list) => WriteAll(list);

        /// <summary>
        /// Переименовывает тег во всех роликах библиотеки.
        /// Если у ролика уже есть тег с новым именем — старый просто убирается
        /// (не плодим дубликаты после normalize).
        /// </summary>
        /// <returns>Число роликов, у которых тег был переименован</returns>
        public int RenameTagGlobally(string rawOldTag, string rawNewTag)
        {
            var oldTag = Normalize(rawOldTag);
            var newTag = Normalize(rawNewTag);
            if (string.IsNullOrEmpty(oldTag) || string.IsNullOrEmpty(newTag)) return 0;

            lock (_lock)
            {
                var list = ReadAllUnsafe();
                var affected = 0;

                foreach (var entry in list)
                {
                    if (entry.tags == null) continue;
                    var hasOld = entry.tags.Any(t => string.Equals(t, oldTag, StringComparison.OrdinalIgnoreCase));
                    if (!hasOld) continue;

                    entry.tags.RemoveAll(t => string.Equals(t, oldTag, StringComparison.OrdinalIgnoreCase));
                    if (!entry.tags.Contains(newTag, StringComparer.OrdinalIgnoreCase))
                        entry.tags.Add(newTag);

                    affected++;
                }

                if (affected > 0) WriteAllUnsafe(list);
                return affected;
            }
        }

        /// <summary>Удаляет тег со всех роликов библиотеки.</summary>
        /// <returns>Число роликов, с которых тег был удалён</returns>
        public int DeleteTagGlobally(string rawTag)
        {
            var tag = Normalize(rawTag);
            if (string.IsNullOrEmpty(tag)) return 0;

            lock (_lock)
            {
                var list = ReadAllUnsafe();
                var affected = 0;

                foreach (var entry in list)
                {
                    if (entry.tags == null) continue;
                    var removed = entry.tags.RemoveAll(t => string.Equals(t, tag, StringComparison.OrdinalIgnoreCase));
                    if (removed > 0) affected++;
                }

                if (affected > 0) WriteAllUnsafe(list);
                return affected;
            }
        }

        /// <summary>Удаляет вообще все теги со всех роликов библиотеки.</summary>
        /// <returns>Число роликов, у которых были удалены теги</returns>
        public int DeleteAllTags()
        {
            lock (_lock)
            {
                var list = ReadAllUnsafe();
                var affected = 0;

                foreach (var entry in list)
                {
                    if (entry.tags == null || entry.tags.Count == 0) continue;
                    entry.tags.Clear();
                    affected++;
                }

                if (affected > 0) WriteAllUnsafe(list);
                return affected;
            }
        }
    }
}