namespace CoubPlayer.Services
{
    /// <summary>
    /// Общая логика ретраев при 429 (Too Many Requests), вынесенная из
    /// CoubDownloadService, чтобы её же использовал CoubTimelineService
    /// при постраничном обходе ленты liked/bookmarks.
    /// </summary>
    public static class HttpRetryHelper
    {
        /// <summary>
        /// requestFactory вызывается заново на каждой попытке — HttpRequestMessage
        /// одноразовый и не может быть переиспользован после отправки.
        /// </summary>
        public static async Task<HttpResponseMessage> SendWithRetryAsync(
            HttpClient client, Func<HttpRequestMessage> requestFactory, int maxRetries = 3)
        {
            for (var attempt = 0; ; attempt++)
            {
                using var req = requestFactory();
                var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);

                if (res.StatusCode != System.Net.HttpStatusCode.TooManyRequests || attempt >= maxRetries)
                    return res;

                var wait = res.Headers.RetryAfter?.Delta
                    ?? TimeSpan.FromSeconds(5 * (attempt + 1));

                res.Dispose();
                await Task.Delay(wait);
            }
        }
    }
}