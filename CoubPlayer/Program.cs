using System.Diagnostics;
using CoubPlayer.Services;
using CoubPlayer.Storage;
using Microsoft.AspNetCore.StaticFiles;
namespace CoubPlayer
{
    public class Program
    {
        /// <summary>
        /// Политика для браузерного расширения. Пускаем только origin'ы вида
        /// chrome-extension://… — обычная веб-страница такой origin подделать
        /// не может, так что локальный API остаётся закрыт от посторонних сайтов.
        /// </summary>
        private const string ExtensionCorsPolicy = "extension";

        /// <summary>
        /// Все пути к данным считаются от текущего каталога. При запуске из
        /// Visual Studio это папка проекта — там и лежит wwwroot с роликами,
        /// всё сходится. А вот у собранного приложения текущий каталог — тот,
        /// откуда его запустили: ярлык с другой рабочей папкой, командная
        /// строка, автозагрузка — и приложение искало бы данные не там.
        ///
        /// Поэтому: если рядом с exe есть wwwroot, а в текущем каталоге нет —
        /// переходим к exe. Отладку это не задевает.
        /// </summary>
        private static void EnsureContentRoot()
        {
            if (Directory.Exists(Path.Combine(Directory.GetCurrentDirectory(), "wwwroot")))
                return;

            var appDir = AppContext.BaseDirectory;
            if (Directory.Exists(Path.Combine(appDir, "wwwroot")))
                Directory.SetCurrentDirectory(appDir);
        }

        public static void Main(string[] args)
        {
            EnsureContentRoot();

            var builder = WebApplication.CreateBuilder(args);
            builder.Services.AddControllers();
            builder.Services.AddHttpClient();
            builder.Services.AddSingleton<CoubDownloadService>();
            builder.Services.AddSingleton<CoubTimelineService>();
            builder.Services.AddSingleton<RestoreService>();
            builder.Services.AddSingleton<MetadataService>();
            builder.Services.AddSingleton<ModelService>();

            // Хранилище: база и репозитории поверх неё. Контроллеры работают
            // только через них и о том, где лежит файл базы, не знают
            builder.Services.AddSingleton<CoubDb>();
            builder.Services.AddSingleton<BackupService>();
            builder.Services.AddSingleton<PlaylistRepository>();
            builder.Services.AddSingleton<CoubRepository>();
            builder.Services.AddSingleton<FxPresetRepository>();
            builder.Services.AddSingleton<GroupOrderRepository>();
            builder.Services.AddSingleton<SuggestionRepository>();
            builder.Services.AddSingleton<EmbeddingRepository>();
            builder.Services.AddHttpClient("Coub")
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        UseCookies = false, // критично: не даём хендлеру подмешивать свой Set-Cookie
                            // поверх ручного заголовка Cookie с remember_token
        AutomaticDecompression = System.Net.DecompressionMethods.All
    });

            builder.Services.AddCors(options =>
            {
                options.AddPolicy(ExtensionCorsPolicy, policy => policy
                    .SetIsOriginAllowed(origin =>
                        origin.StartsWith("chrome-extension://", StringComparison.Ordinal) ||
                        origin.StartsWith("moz-extension://", StringComparison.Ordinal))
                    .AllowAnyHeader()
                    .AllowAnyMethod());
            });

            var app = builder.Build();

            // Переносит старые ролики (скачанные консольным CoubDownloader в wwwroot/Coubs)
            // в новую раскладку wwwroot/Data/Coubs и переписывает пути в coub_list.json.
            // Идемпотентно — безопасно вызывать при каждом старте.
            //
            // Обязательно до DataMigrations: работает по JSON-файлам, а те после
            // перехода на базу уезжают в архив. Для уже перешедшего плеера это
            // просто «файла нет — делать нечего».
            CoubLibraryMigrator.MigrateOldPaths();

            // Схема базы, одноразовый перенос из JSON и миграции между версиями
            // плеера. Падение здесь намеренно останавливает запуск: работать
            // с данными, про которые известно, что они неверны, нельзя
            DataMigrations.Run(
                app.Services.GetRequiredService<CoubDb>(),
                Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "Data"));

            // Копия — до того, как в данных что-то поменяется за этот сеанс.
            // Ролики перекачиваются за вечер, раскладка не перекачивается ничем
            app.Services.GetRequiredService<BackupService>().EnsureRecent();

            // До UseStaticFiles: статика тоже отдаётся расширению — файлы
            // роликов и баннеров, — а без политики CORS браузер их не отдаст
            app.UseCors(ExtensionCorsPolicy);

            // Разметка и скрипты — всегда с перепроверкой у сервера.
            //
            // Без этого браузер держит их в кэше и после обновления плеера
            // продолжает крутить старый код: интерфейс от одной версии,
            // API от другой. Проверка стоит одного запроса к локальному
            // диску, а путаницу устраняет полностью.
            //
            // Файлов роликов, кадров и баннеров это не касается: они тяжёлые
            // и под своим именем не меняются — пусть кэшируются как прежде.
            // Файлы модели смыслового поиска лежат в статике, но их расширения
            // серверу незнакомы, а незнакомое он по умолчанию не отдаёт вовсе:
            // запрос к весам молча превращался бы в 404, и браузер сообщал бы,
            // что файла нет, — хотя он есть
            var contentTypes = new FileExtensionContentTypeProvider();
            contentTypes.Mappings[".onnx"] = "application/octet-stream";
            contentTypes.Mappings[".wasm"] = "application/wasm";
            contentTypes.Mappings[".mjs"] = "text/javascript";

            app.UseStaticFiles(new StaticFileOptions
            {
                ContentTypeProvider = contentTypes,
                OnPrepareResponse = context =>
                {
                    var path = context.File.Name;
                    var isCode = path.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
                              || path.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                              || path.EndsWith(".html", StringComparison.OrdinalIgnoreCase);

                    if (isCode) context.Context.Response.Headers.CacheControl = "no-cache";
                },
            });
            app.MapControllers();

            var url = "http://localhost:5000/index.html";
            try
            {

                var psi = new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                };
                Process.Start(psi);
            }
            catch
            {
                Console.WriteLine($"Не удалось открыть браузер. Перейдите вручную на {url}");
            }
            app.Run();
        }
    }
}
