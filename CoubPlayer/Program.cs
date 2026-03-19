using System.Diagnostics;

namespace CoubPlayer
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            builder.Services.AddControllers();

            var app = builder.Build();

            app.UseStaticFiles();
            app.MapControllers();

            // Запускаем браузер после старта сервера
            var url = "http://localhost:5000/index.html";
            try
            {
                // .NET 6+ рекомендуемый способ
                var psi = new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true // важно, чтобы открывался системный браузер
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