using System.Diagnostics;
using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;

namespace CoubPlayer
{
    /// <summary>
    /// Резервные копии библиотеки. Подробности — в <see cref="BackupService"/>.
    /// </summary>
    [ApiController]
    [Route("api/backups")]
    public class BackupController : ControllerBase
    {
        private readonly BackupService _backups;

        public BackupController(BackupService backups) => _backups = backups;

        [HttpGet]
        public IActionResult List() => Ok(new
        {
            folder = _backups.BackupsDir,
            items = _backups.List(),
        });

        [HttpPost]
        public IActionResult Create()
        {
            try
            {
                return Ok(_backups.Create());
            }
            catch (Exception ex)
            {
                return StatusCode(500, $"Не удалось сделать копию: {ex.Message}");
            }
        }

        /// <summary>
        /// Открывает папку с копиями в проводнике. Как и открытие папки ролика,
        /// имеет смысл только когда сервер и браузер на одной машине.
        /// </summary>
        [HttpPost("open-folder")]
        public IActionResult OpenFolder()
        {
            var folder = _backups.BackupsDir;
            if (!Directory.Exists(folder)) return NotFound("Копий ещё нет");

            try
            {
                var (file, args) = OperatingSystem.IsWindows() ? ("explorer.exe", $"\"{folder}\"")
                    : OperatingSystem.IsMacOS() ? ("open", $"\"{folder}\"")
                    : OperatingSystem.IsLinux() ? ("xdg-open", $"\"{folder}\"")
                    : (null, null);

                if (file == null) return StatusCode(501, "Не поддерживается на этой ОС");

                Process.Start(new ProcessStartInfo
                {
                    FileName = file,
                    Arguments = args,
                    UseShellExecute = true,
                });
                return Ok();
            }
            catch (Exception ex)
            {
                return StatusCode(500, $"Не удалось открыть папку: {ex.Message}");
            }
        }
    }
}
