using System.Diagnostics;
using CoubPlayer.Services;
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
            builder.Services.AddSingleton<CoubListService>();
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
            CoubLibraryMigrator.MigrateOldPaths();

            // До UseStaticFiles — иначе расширение не сможет прочитать
            // Data/coub_list.json, по которому оно сверяет библиотеку
            app.UseCors(ExtensionCorsPolicy);
            app.UseStaticFiles();
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
