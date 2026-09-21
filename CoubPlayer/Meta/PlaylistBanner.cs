using Newtonsoft.Json;

namespace CoubPlayer.Meta
{
    /// <summary>
    /// Баннер плейлиста. Хранит только имена файлов в wwwroot/Data/banners —
    /// имена случайные, а не производные от названия плейлиста, чтобы
    /// переименование не требовало возиться с файлами на диске.
    /// Пустые поля означают «по умолчанию»: превью первого ролика плейлиста.
    /// </summary>
    public class PlaylistBanner
    {
        /// <summary>Своя картинка (уже обрезанная под 16:9 на клиенте).</summary>
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public string? image { get; set; }

        /// <summary>Свой анимированный баннер (видеофайл).</summary>
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public string? video { get; set; }

        /// <summary>
        /// Ролик библиотеки, выбранный баннером. Альтернатива video: там свой
        /// загруженный файл, здесь — id уже скачанного ролика. Копировать
        /// ради баннера нечего, и кадр для покоя тоже берётся его.
        /// </summary>
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public string? coub { get; set; }

        [JsonIgnore]
        public bool IsEmpty =>
            string.IsNullOrEmpty(image) && string.IsNullOrEmpty(video) && string.IsNullOrEmpty(coub);
    }
}
