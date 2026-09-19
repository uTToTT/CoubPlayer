using Microsoft.AspNetCore.Http;

namespace CoubPlayer.Requests
{
    /// <summary>
    /// Готовые файлы ролика, скачанные расширением в браузере —
    /// см. PlaylistsController.UploadCoub.
    /// </summary>
    public class UploadCoubRequest
    {
        public string? Id { get; set; }

        public string? Title { get; set; }

        /// <summary>Чем оказалось аудио: mp3 или m4a. Решил сервер, когда отдавал план.</summary>
        public string? AudioExt { get; set; }

        /// <summary>
        /// Порядок ленты JSON-массивом — то же, что Order в DownloadCoubsRequest,
        /// но формой сюда список не передать, поэтому строкой.
        /// </summary>
        public string? Order { get; set; }

        /// <summary>
        /// Ответ coub.com о ролике, как есть. Расширение всё равно его
        /// запрашивало, чтобы узнать ссылки на потоки, — раз он уже есть,
        /// пусть приедет сюда, иначе ролик останется без тегов и подсказки
        /// про него будут молчать до следующего обхода библиотеки.
        /// </summary>
        public string? Meta { get; set; }

        public IFormFile? Video { get; set; }

        /// <summary>У части роликов звука нет вовсе — это не ошибка.</summary>
        public IFormFile? Audio { get; set; }
    }
}
