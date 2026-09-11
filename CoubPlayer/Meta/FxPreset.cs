using Newtonsoft.Json;

namespace CoubPlayer.Meta
{
    /// <summary>
    /// Именованный набор настроек постобработки — чтобы применять один и тот же
    /// вид сразу к нескольким роликам. Хранит и настройки видео, и настройки фона.
    /// </summary>
    public class FxPreset
    {
        public string name { get; set; } = "";

        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public Dictionary<string, double>? fx { get; set; }

        [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
        public Dictionary<string, double>? bgFx { get; set; }

        public bool bgSeparate { get; set; }
    }
}
