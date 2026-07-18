using System.Diagnostics;
using CoubPlayer.Services;
namespace CoubPlayer
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);
            builder.Services.AddControllers();
            builder.Services.AddHttpClient();
            builder.Services.AddSingleton<CoubDownloadService>();
            builder.Services.AddSingleton<CoubTimelineService>();
            builder.Services.AddSingleton<CoubListService>();
            var app = builder.Build();

            // Переносит старые ролики (скачанные консольным CoubDownloader в wwwroot/Coubs)
            // в новую раскладку wwwroot/Data/Coubs и переписывает пути в coub_list.json.
            // Идемпотентно — безопасно вызывать при каждом старте.
            CoubLibraryMigrator.MigrateOldPaths();

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