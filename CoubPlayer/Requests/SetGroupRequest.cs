namespace CoubPlayer.Requests
{
    /// <summary>
    /// Назначение группы плейлисту или тегу. Пустое имя убирает группу.
    /// Группы нигде не заводятся отдельно — они существуют ровно до тех пор,
    /// пока на них кто-то ссылается.
    /// </summary>
    public class SetGroupRequest
    {
        /// <summary>Имя тега; для плейлиста не используется — он в маршруте.</summary>
        public string? Tag { get; set; }

        public string? Group { get; set; }
    }
}
