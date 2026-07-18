using System.Collections.Generic;

namespace CoubPlayer.Requests
{
    public class DownloadCoubsRequest
    {
        public List<string> Urls { get; set; } = new();
    }
}