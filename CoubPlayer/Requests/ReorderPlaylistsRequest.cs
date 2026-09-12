namespace CoubPlayer.Requests
{
    /// <summary>Имена плейлистов в новом порядке.</summary>
    public class ReorderPlaylistsRequest
    {
        public List<string> Names { get; set; } = new();
    }
}
