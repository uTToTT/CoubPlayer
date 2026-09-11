using Newtonsoft.Json;

namespace CoubPlayer.Meta
{
    public class Playlist
    {
        public string title { get; set; }
        public Dictionary<string, VideoMeta> videos { get; set; }

        /// <summary>
        /// Свой баннер плейлиста. null — берём превью первого ролика.
        /// </summary>
        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public PlaylistBanner? banner { get; set; }
    }
}
