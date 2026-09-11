using Newtonsoft.Json;

namespace CoubPlayer.Meta
{
    public class VideoMeta
    {
        public string title { get; set; }
        public int order { get; set; }
        public DateTime? lastViewed { get; set; } = null;

        /// <summary>
        /// Персональная постобработка ролика: ключи — имена настроек из
        /// randomizer.js (saturate, contrast, speed, mirror и т.д.), значения —
        /// числа (mirror хранится как 0/1). null = у ролика своих настроек нет.
        /// Лежит именно в плейлисте, а не в coub_list.json, чтобы копии одного
        /// и того же ролика могли выглядеть по-разному.
        /// </summary>
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public Dictionary<string, double>? fx { get; set; }

        /// <summary>
        /// Постобработка заднего фона. Работает только когда bgSeparate = true;
        /// иначе фон повторяет настройки самого ролика.
        /// </summary>
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public Dictionary<string, double>? bgFx { get; set; }

        /// <summary>
        /// true — у фона свои настройки (bgFx), null/false — фон идёт вместе с видео.
        /// </summary>
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public bool? bgSeparate { get; set; }
    }
}
