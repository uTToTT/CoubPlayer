namespace CoubPlayer.Meta
{
    public class Playlist
    {
        public string title { get; set; }
        public Dictionary<string, VideoMeta> videos { get; set; }
    }
}
