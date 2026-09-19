namespace CoubPlayer.Requests
{
    /// <summary>
    /// Вопрос расширения «что качать для этого ролика» — см. ExtensionController.Plan.
    /// </summary>
    public class CoubPlanRequest
    {
        public string? Id { get; set; }

        /// <summary>
        /// Ответ coub.com об этом ролике, как есть, текстом. Разбирает и
        /// выбирает потоки сервер: правилам выбора качества нельзя жить
        /// в двух местах сразу.
        ///
        /// Пусто — значит расширение ещё не ходило в сеть и спрашивает только,
        /// нужно ли туда идти вообще.
        /// </summary>
        public string? Meta { get; set; }
    }
}
