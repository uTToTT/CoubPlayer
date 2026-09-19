using Newtonsoft.Json.Linq;

namespace CoubPlayer.Storage
{
    public class RoundTripResult
    {
        public bool Ok => Differences.Count == 0;
        public List<string> Differences { get; } = new();
        public Dictionary<string, bool> Files { get; } = new();

        public override string ToString()
        {
            var lines = Files.Select(f => $"  {(f.Value ? "совпал" : "РАЗОШЁЛСЯ")}  {f.Key}");
            var head = Ok ? "перенос точный" : $"расхождений: {Differences.Count}";
            return head + Environment.NewLine + string.Join(Environment.NewLine, lines);
        }
    }

    /// <summary>
    /// Критерий приёмки переноса: выгрузить базу обратно в JSON и сверить
    /// с исходными файлами.
    ///
    /// Сравниваем не текст, а разобранные деревья: форматирование и порядок
    /// ключей в объектах — не данные, а вот пропавшее поле или изменившееся
    /// число — данные. Зато порядок элементов в массивах значим и проверяется:
    /// в coub_list.json он задаёт очерёдность.
    /// </summary>
    public static class RoundTripCheck
    {
        private static readonly string[] Files =
        {
            "coub_list.json", "playlists.json", "tag_groups.json",
            "fx_presets.json", "group_order.json",
        };

        public static RoundTripResult Compare(string originalDir, string exportedDir)
        {
            var result = new RoundTripResult();

            foreach (var name in Files)
            {
                var before = Path.Combine(originalDir, name);
                var after = Path.Combine(exportedDir, name);

                // Файла не было и не появилось — нечего сравнивать
                if (!File.Exists(before) && !File.Exists(after)) continue;

                if (!File.Exists(before))
                {
                    // Файла не было, потому что нечего было хранить — приложение
                    // создаёт их по требованию. Пустая выгрузка это не потеря
                    var empty = IsEmptyJson(after);
                    result.Files[name] = empty;
                    if (!empty)
                        result.Differences.Add($"{name}: не было в исходнике, но выгрузился непустым");
                    continue;
                }

                if (!File.Exists(after))
                {
                    result.Files[name] = false;
                    result.Differences.Add($"{name}: был в исходнике, но не выгрузился");
                    continue;
                }

                var diffs = new List<string>();
                CompareTokens(
                    JToken.Parse(File.ReadAllText(before)),
                    JToken.Parse(File.ReadAllText(after)),
                    name, diffs);

                result.Files[name] = diffs.Count == 0;
                result.Differences.AddRange(diffs.Take(20));
            }

            return result;
        }

        /// <summary>Пустой список или объект — то же самое, что отсутствие ключа.</summary>
        private static bool IsEmpty(JToken token) => token switch
        {
            JObject obj => obj.Count == 0,
            JArray arr => arr.Count == 0,
            JValue { Value: null } => true,
            _ => false,
        };

        /// <summary>Пустой объект, пустой массив или отсутствие содержимого.</summary>
        private static bool IsEmptyJson(string path)
        {
            try
            {
                var token = JToken.Parse(File.ReadAllText(path));
                return token switch
                {
                    JObject obj => obj.Count == 0,
                    JArray arr => arr.Count == 0,
                    _ => false,
                };
            }
            catch
            {
                return false;
            }
        }

        private static void CompareTokens(JToken before, JToken after, string path, List<string> diffs)
        {
            // Больше двадцати расхождений читать бессмысленно — картина ясна
            if (diffs.Count >= 20) return;

            if (before.Type != after.Type)
            {
                diffs.Add($"{path}: было {before.Type}, стало {after.Type}");
                return;
            }

            switch (before)
            {
                case JObject beforeObj:
                    var afterObj = (JObject)after;

                    foreach (var property in beforeObj.Properties())
                    {
                        var other = afterObj.Property(property.Name);
                        if (other == null)
                        {
                            // Пустой список — это не данные, а их отсутствие.
                            // База хранит строки, а не факт «ключ был»: пустая
                            // группа не оставляет ни одной строки, и выгрузка
                            // ключа не пишет. Потерять тут нечего
                            if (!IsEmpty(property.Value))
                                diffs.Add($"{path}.{property.Name}: пропало при выгрузке");
                            continue;
                        }
                        CompareTokens(property.Value, other.Value, $"{path}.{property.Name}", diffs);
                    }

                    foreach (var property in afterObj.Properties())
                    {
                        if (beforeObj.Property(property.Name) == null && !IsEmpty(property.Value))
                            diffs.Add($"{path}.{property.Name}: появилось из ниоткуда");
                    }
                    break;

                case JArray beforeArr:
                    var afterArr = (JArray)after;
                    if (beforeArr.Count != afterArr.Count)
                    {
                        diffs.Add($"{path}: было элементов {beforeArr.Count}, стало {afterArr.Count}");
                        return;
                    }
                    for (var i = 0; i < beforeArr.Count; i++)
                        CompareTokens(beforeArr[i], afterArr[i], $"{path}[{i}]", diffs);
                    break;

                default:
                    if (!JToken.DeepEquals(before, after))
                        diffs.Add($"{path}: было «{before}», стало «{after}»");
                    break;
            }
        }
    }
}
