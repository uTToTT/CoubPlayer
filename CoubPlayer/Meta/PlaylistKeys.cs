namespace CoubPlayer.Meta
{
    /// <summary>
    /// Ключи записей в плейлисте. Ключ — это либо id куба, либо "id#N" для
    /// копии: при дублировании сами файлы не копируются, обе записи ссылаются
    /// на один и тот же ролик в coub_list.json.
    /// </summary>
    public static class PlaylistKeys
    {
        /// <summary>Id куба, на который ссылается запись.</summary>
        public static string BaseCoubId(string key)
        {
            var i = key.IndexOf('#');
            return i < 0 ? key : key.Substring(0, i);
        }
    }
}
