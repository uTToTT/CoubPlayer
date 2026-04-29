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