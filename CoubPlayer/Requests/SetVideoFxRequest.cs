namespace CoubPlayer.Requests
{
    public class SetVideoFxRequest
    {
        /// <summary>Ключ записи в плейлисте (id куба или id#N для копии).</summary>
        public string Id { get; set; } = "";

        /// <summary>Настройки постобработки видео. null или пустой объект — снять их.</summary>
        public Dictionary<string, double>? Fx { get; set; }

        /// <summary>Настройки постобработки фона (когда он настраивается отдельно).</summary>
        public Dictionary<string, double>? BgFx { get; set; }

        /// <summary>true — фон настраивается отдельно, иначе идёт вместе с видео.</summary>
        public bool BgSeparate { get; set; }
    }
}
