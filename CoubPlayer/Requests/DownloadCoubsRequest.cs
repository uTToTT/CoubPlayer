using System.Collections.Generic;

namespace CoubPlayer.Requests
{
    public class DownloadCoubsRequest
    {
        /// <summary>Что скачать и добавить в плейлист.</summary>
        public List<string> Urls { get; set; } = new();

        /// <summary>
        /// Порядок, которому должен следовать плейлист — обычно вся лента
        /// с сайта, от новых к старым. По нему каждый добавляемый ролик
        /// встаёт на своё место, а не просто в начало: если в плейлисте уже
        /// есть A B C E F, то D должен оказаться между C и E.
        ///
        /// Не задан — порядком считается сам список Urls, и пачка целиком
        /// ложится в начало плейлиста, сохраняя свою последовательность.
        /// </summary>
        public List<string>? Order { get; set; }
    }
}