namespace CoubPlayer.Requests
{
    /// <summary>Порядок групп для одного из списков.</summary>
    public class SetGroupOrderRequest
    {
        /// <summary>"playlists" или "tags".</summary>
        public string Kind { get; set; } = "playlists";

        public List<string> Groups { get; set; } = new();
    }
}
