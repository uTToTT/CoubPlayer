using System.Reflection;

namespace CoubPlayer.Storage
{
    /// <summary>
    /// Версия плеера.
    ///
    /// Своей константы здесь нет намеренно: число задаётся один раз в csproj
    /// (&lt;Version&gt;) и читается отсюда из атрибута сборки. Константа рядом
    /// с ним стала бы вторым источником правды и разошлась бы на первом же
    /// выпуске, когда о ней забудут.
    ///
    /// Зачем она нужна. Версия, которой данные были записаны, хранится в самой
    /// базе. При запуске <see cref="DataMigrations"/> сравнивает её с текущей
    /// и знает, откуда и куда переносить, — без этого пришлось бы угадывать
    /// возраст данных по их содержимому.
    /// </summary>
    public static class AppVersion
    {
        /// <summary>Например, «1.0.0».</summary>
        public static string Current { get; } = Read();

        /// <summary>
        /// Версия как три числа — для сравнений «старее / новее».
        /// Непонятная строка даёт 0.0.0: так данные неизвестного происхождения
        /// считаются самыми старыми, и миграции пройдут по ним целиком.
        /// </summary>
        public static Version Parse(string? value) =>
            System.Version.TryParse(Trim(value), out var parsed) ? parsed : new Version(0, 0, 0);

        public static Version CurrentParsed { get; } = Parse(Current);

        private static string Read()
        {
            var assembly = Assembly.GetExecutingAssembly();

            // InformationalVersion — то, что положил сюда <Version> из csproj.
            // У сборок с SourceLink к нему приписан хэш коммита через «+»
            var informational = assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

            var value = Trim(informational)
                ?? assembly.GetName().Version?.ToString(3);

            return string.IsNullOrEmpty(value) ? "0.0.0" : value;
        }

        private static string? Trim(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;

            var plus = value.IndexOf('+');
            return plus >= 0 ? value[..plus] : value;
        }
    }
}
