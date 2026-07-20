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

        // Сколько раз подряд повторяем одну и ту же страницу при 403, прежде чем сдаться.
        // 403 после первой успешной страницы почти всегда значит не "токен плохой",
        // а временную антибот-блокировку по частоте запросов (Cloudflare и т.п.) —
        // так что это не фатально, просто нужно подождать и повторить.
        private const int MaxConsecutiveForbidden = 5;

        public CoubTimelineService(IHttpClientFactory httpClientFactory)
        {
            _httpClientFactory = httpClientFactory;
        }

        /// <summary>
        /// Возвращает до <paramref name="limit"/> permalink'ов, от новых к старым.
        /// Репосты пропускаются — как и в оригинальном Crawler
        /// (там тоже был фильтр links.Where(x => !x.IsRepost)).
        /// </summary>
        /// <exception cref="InvalidOperationException">Неверный/просроченный токен, неизвестная категория
        /// или устойчивая антибот-блокировка (много 403 подряд).</exception>
        public async Task<List<string>> GetPermalinksAsync(string category, string token, int limit)
        {
            if (string.IsNullOrWhiteSpace(token))
                throw new InvalidOperationException("Не указан access token (remember_token)");

            var isUnlimited = limit < 0;
            var effectiveLimit = isUnlimited ? int.MaxValue : limit;

            var template = category switch
            {
                "liked" => "https://coub.com/api/v2/timeline/likes?order_by=date&per_page={0}&page={1}",
                "bookmarks" => "https://coub.com/api/v2/timeline/favourites?order_by=date&per_page={0}&page={1}",
                _ => throw new InvalidOperationException($"Неизвестная категория: {category}")
            };

            Console.WriteLine($"[timeline:{category}] Начало выгрузки ленты (лимит: {(isUnlimited ? "без ограничений" : limit.ToString())})");

            var client = _httpClientFactory.CreateClient("Coub");
            var jitter = new Random();

            var result = new List<string>();
            var page = 1;
            int? totalPages = null;
            var consecutiveForbidden = 0;

            while (result.Count < effectiveLimit)
            {
                var userAgent = CoubUserAgents.GetRandomAgent();
                var url = string.Format(template, PageSize, page);

                Console.WriteLine($"[timeline:{category}] Страница {page}{(totalPages != null ? $"/{totalPages}" : "")}, получено ссылок: {result.Count}");

                using var res = await HttpRetryHelper.SendWithRetryAsync(client, () =>
                {var client = _httpClientFactory.CreateClient("Coub");
                    var req = new HttpRequestMessage(HttpMethod.Get, url);
                    req.Headers.UserAgent.ParseAdd(userAgent);
                    req.Headers.TryAddWithoutValidation("Cookie", $"remember_token={token}");
                    // Заголовки, приближающие запрос к обычному браузерному —
                    // без них antibot-защита Coub чаще отбивает 403
                    req.Headers.TryAddWithoutValidation("Accept", "application/json");
                    req.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9,ru;q=0.8");
                    req.Headers.TryAddWithoutValidation("Referer", "https://coub.com/");
                    req.Headers.TryAddWithoutValidation("X-Requested-With", "XMLHttpRequest");
                    return req;
                });

                if (res.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    consecutiveForbidden++;

                    // 403 на самой первой странице — это ещё до того, как токен
                    // хоть раз подтвердился успешным ответом, так что тут действительно
                    // похоже на битый/просроченный токен, а не на антибот. Ретраить бессмысленно.
                    if (page == 1)
                    {
                        Console.WriteLine($"[timeline:{category}] ОШИБКА: неверный или просроченный токен (403 на первой странице)");
                        throw new InvalidOperationException("Неверный или просроченный access token");
                    }

                    if (consecutiveForbidden > MaxConsecutiveForbidden)
                    {
                        Console.WriteLine($"[timeline:{category}] ОШИБКА: {consecutiveForbidden} подряд 403 на странице {page} — похоже на устойчивую блокировку, прерываем");
                        throw new InvalidOperationException(
                            "Coub стабильно отдаёт 403 (похоже на антибот-блокировку по частоте запросов, " +
                            "а не на проблему с токеном). Попробуйте повторить синхронизацию позже.");
                    }

                    var backoff = 5000 * consecutiveForbidden + jitter.Next(0, 1500);
                    Console.WriteLine($"[timeline:{category}] 403 на странице {page} (попытка {consecutiveForbidden}/{MaxConsecutiveForbidden}), похоже на временную антибот-блокировку — жду {backoff / 1000}с и повторяю");
                    await Task.Delay(backoff);
                    continue; // page не увеличиваем — повторяем эту же страницу
                }

                consecutiveForbidden = 0; // сбрасываем счётчик после любого не-403 ответа
                res.EnsureSuccessStatusCode();

                var json = await res.Content.ReadAsStringAsync();
                var data = JObject.Parse(json);

                totalPages ??= data["total_pages"]?.Value<int>();

                if (data["coubs"] is not JArray coubs || coubs.Count == 0)
                {
                    Console.WriteLine($"[timeline:{category}] Страница {page} пуста, останавливаемся");
                    break;
                }

                var addedOnPage = 0;
                foreach (var coub in coubs)
                {
                    if (result.Count >= effectiveLimit) break;

                    var recoubTo = coub["recoub_to"];
                    var isRepost = recoubTo != null && recoubTo.Type != JTokenType.Null;
                    if (isRepost) continue;

                    var permalink = coub["permalink"]?.ToString();
                    if (!string.IsNullOrEmpty(permalink))
                    {
                        result.Add(permalink);
                        addedOnPage++;
                    }
                }

                Console.WriteLine($"[timeline:{category}] Страница {page}: добавлено {addedOnPage} (репосты пропущены)");

                if (result.Count >= effectiveLimit) break;
                if (page >= (totalPages ?? page) || page >= MaxApiPage) break;

                page++;
                await Task.Delay(2000 + jitter.Next(0, 800));
            }

            Console.WriteLine($"[timeline:{category}] Выгрузка завершена: собрано {result.Count} ссылок");

            return result;
        }
    }
}