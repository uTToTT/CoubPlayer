using Newtonsoft.Json.Linq;

namespace CoubPlayer.Services
{
    /// <summary>
    /// Получает permalink'и роликов из личной ленты liked/bookmarks пользователя
    /// Coub — порт логики Crawler.GetLinks/DownloadLinks из старого консольного
    /// загрузчика, но без записи url_list.txt/metadata на диск: нам нужны только
    /// сами id, дальше их скачивает CoubDownloadService.
    /// </summary>
    public class CoubTimelineService
    {
        private readonly IHttpClientFactory _httpClientFactory;

        private const int PageSize = 25;      // как PageLimit в оригинальном Crawler
        private const int MaxApiPage = 999;   // Coub API не отдаёт страницы дальше 999

        public CoubTimelineService(IHttpClientFactory httpClientFactory)
        {
            _httpClientFactory = httpClientFactory;
        }

        /// <summary>
        /// Возвращает до <paramref name="limit"/> permalink'ов, от новых к старым.
        /// Репосты пропускаются — как и в оригинальном Crawler
        /// (там тоже был фильтр links.Where(x => !x.IsRepost)).
        /// </summary>
        /// <exception cref="InvalidOperationException">Неверный/просроченный токен или категория</exception>
        public async Task<List<string>> GetPermalinksAsync(string category, string token, int limit)
        {
            if (string.IsNullOrWhiteSpace(token))
                throw new InvalidOperationException("Не указан access token (remember_token)");

            var template = category switch
            {
                "liked" => "https://coub.com/api/v2/timeline/likes?order_by=date&per_page={0}&page={1}",
                "bookmarks" => "https://coub.com/api/v2/timeline/favourites?order_by=date&per_page={0}&page={1}",
                _ => throw new InvalidOperationException($"Неизвестная категория: {category}")
            };

            var client = _httpClientFactory.CreateClient();
            var userAgent = CoubUserAgents.GetRandomAgent();
            var jitter = new Random();

            var result = new List<string>();
            var page = 1;
            int? totalPages = null;

            while (result.Count < limit)
            {
                var url = string.Format(template, PageSize, page);

                using var res = await HttpRetryHelper.SendWithRetryAsync(client, () =>
                {
                    var req = new HttpRequestMessage(HttpMethod.Get, url);
                    req.Headers.UserAgent.ParseAdd(userAgent);
                    // Личная лента требует cookie с access token'ом (как в Crawler.DownloadJson)
                    req.Headers.TryAddWithoutValidation("Cookie", $"remember_token={token}");
                    return req;
                });

                if (res.StatusCode == System.Net.HttpStatusCode.Forbidden)
                    throw new InvalidOperationException("Неверный или просроченный access token");

                res.EnsureSuccessStatusCode();

                var json = await res.Content.ReadAsStringAsync();
                var data = JObject.Parse(json);

                totalPages ??= data["total_pages"]?.Value<int>();

                if (data["coubs"] is not JArray coubs || coubs.Count == 0)
                    break;

                foreach (var coub in coubs)
                {
                    if (result.Count >= limit) break;

                    var recoubTo = coub["recoub_to"];
                    var isRepost = recoubTo != null && recoubTo.Type != JTokenType.Null;
                    if (isRepost) continue;

                    var permalink = coub["permalink"]?.ToString();
                    if (!string.IsNullOrEmpty(permalink))
                        result.Add(permalink);
                }

                if (result.Count >= limit) break;
                if (page >= (totalPages ?? page) || page >= MaxApiPage) break;

                page++;
                // Пауза между страницами ленты — та же логика, что и между скачиваниями роликов
                await Task.Delay(2500 + jitter.Next(0, 800));
            }

            return result;
        }
    }
}