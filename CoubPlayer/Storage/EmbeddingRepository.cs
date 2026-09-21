using System.Numerics;
using Microsoft.Data.Sqlite;

namespace CoubPlayer.Storage
{
    /// <summary>Ролик и то, насколько он подошёл запросу. 1 — в точку, 0 — мимо.</summary>
    public record Match(string Id, double Score);

    /// <summary>
    /// Векторы кадров — то, на чём стоит смысловой поиск.
    ///
    /// Идея целиком: модель переводит и кадр, и фразу в числа одного и того же
    /// пространства, и близость этих чисел означает близость по смыслу. Ни
    /// названий, ни тегов при этом не нужно — «кот прыгает» находит кота,
    /// даже если ролик называется «xd228».
    ///
    /// Считает векторы браузер (сервер не умеет ни декодировать mp4, ни
    /// запускать модель), здесь они только лежат и сравниваются.
    ///
    /// Кадров у ролика несколько. Один кадр описывает коуб наполовину: за
    /// десять секунд успевает смениться сцена, а первым кадром запросто
    /// окажется затемнение или заставка. Поэтому ролик — это набор векторов,
    /// и близость к запросу считается по лучшему из них: «есть ли здесь хоть
    /// один кадр про это».
    ///
    /// Как лежат: coubs.embedding — сырые float32 подряд, little-endian,
    /// векторы кадров один за другим. Сколько их, видно по длине блоба, так
    /// что добавление кадров не меняет ни схему, ни уже записанное: ролик со
    /// старым одиночным вектором продолжает искаться наравне с остальными.
    ///
    /// Каждый вектор при записи приводится к единичной длине, поэтому
    /// косинус — это просто скалярное произведение, без делений на длины
    /// в горячем цикле.
    ///
    /// Почему перебором, а не индексом: на 8716 роликах по пять кадров запрос
    /// фразой считается 3 мс, «похожие на этот» — 13 мс (там пять векторов
    /// запроса против пяти кадров каждого ролика). Замерено, не прикинуто.
    /// HNSW и прочее начинают окупаться на сотнях тысяч; здесь они добавили бы
    /// приблизительность и зависимость, не дав ничего взамен.
    /// </summary>
    public class EmbeddingRepository
    {
        private readonly CoubDb _db;
        private readonly object _lock = new();

        /// <summary>
        /// Все векторы в памяти: читать их из базы на каждый запрос незачем.
        /// Цена — 127 МБ на 8716 роликах по пять кадров, а собирается это
        /// за 113 мс. Сбрасывается при любой записи, так что после
        /// индексации первый поиск платит эти 113 мс заново.
        ///
        /// Ids — по одной записи на ролик; Starts — где начинаются его кадры,
        /// в строках (длина на единицу больше Ids, как у любых границ).
        /// Flat — все кадры всех роликов подряд.
        /// </summary>
        private (string[] Ids, int[] Starts, float[] Flat, int Dim)? _cache;

        public EmbeddingRepository(CoubDb db) => _db = db;

        // ─── Состояние индекса ──────────────────────────────────────────────

        /// <param name="Indexed">У скольких роликов есть хоть один кадр.</param>
        /// <param name="Full">У скольких кадров столько, сколько берём сейчас.</param>
        public record Status(string? Model, int Dim, int Frames, int Total, int Indexed, int Full);

        /// <param name="frames">Сколько кадров на ролик считается полным набором.</param>
        public Status ReadStatus(int frames)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                var dim = ReadDim(connection);
                var full = BlobBytes(dim, frames);

                return new Status(
                    GetMeta(connection, MetaKeys.EmbeddingModel),
                    dim,
                    int.TryParse(GetMeta(connection, MetaKeys.EmbeddingFrames), out var f) ? f : 0,
                    Count(connection, "SELECT COUNT(*) FROM coubs;"),
                    Count(connection, "SELECT COUNT(*) FROM coubs WHERE embedding IS NOT NULL;"),
                    full == 0
                        ? 0
                        : Count(connection,
                            "SELECT COUNT(*) FROM coubs WHERE LENGTH(embedding) >= $full;",
                            ("$full", full)));
            }
        }

        /// <summary>
        /// Ролики, которым кадров не хватает: либо не разбирались вовсе, либо
        /// разобраны прошлой, менее подробной версией индекса. Второй случай
        /// важен не меньше первого — иначе после увеличения числа кадров
        /// библиотека навсегда осталась бы с тем, что успели снять раньше.
        ///
        /// Порядок — как в библиотеке: индексация идёт пачками, и при обрыве
        /// продолжить надо с того же места.
        /// </summary>
        public List<string> ReadPending(int limit, int frames)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                var full = BlobBytes(ReadDim(connection), frames);

                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT id FROM coubs WHERE embedding IS NULL OR LENGTH(embedding) < $full " +
                    "ORDER BY rowid LIMIT $limit;";
                command.Parameters.AddWithValue("$full", full);
                command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 5000));

                var ids = new List<string>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) ids.Add(reader.GetString(0));
                return ids;
            }
        }

        // ─── Запись ─────────────────────────────────────────────────────────

        public enum SaveOutcome { Ok, ModelMismatch, BadVector }

        /// <summary>
        /// Кладёт посчитанные векторы. У каждого ролика их столько, сколько
        /// кадров с него сняли; все уезжают в один блоб подряд.
        ///
        /// Модель проверяется на каждой пачке: перемешать в одной таблице числа
        /// от двух разных моделей — значит получить поиск, который иногда врёт
        /// и никогда об этом не сообщает. Первая пачка задаёт модель, дальше
        /// она должна совпадать, а сменить её можно только через Reset.
        ///
        /// Число кадров, в отличие от модели, менять можно свободно: кадры
        /// считаны одной и той же моделью, лежат в одном пространстве и
        /// сравнимы между собой независимо от того, сколько их у соседа.
        /// </summary>
        public (SaveOutcome outcome, int saved, string? expected) Save(
            string model, int dim, IReadOnlyList<(string Id, IReadOnlyList<float[]> Vectors)> items)
        {
            if (string.IsNullOrWhiteSpace(model) || dim <= 0) return (SaveOutcome.BadVector, 0, null);
            if (items.Count == 0) return (SaveOutcome.Ok, 0, null);
            if (items.Any(i => i.Vectors.Count == 0 || i.Vectors.Any(v => v.Length != dim)))
                return (SaveOutcome.BadVector, 0, null);

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var storedModel = GetMeta(connection, MetaKeys.EmbeddingModel);
                if (storedModel == null)
                {
                    SetMeta(connection, transaction, MetaKeys.EmbeddingModel, model);
                    SetMeta(connection, transaction, MetaKeys.EmbeddingDim, dim.ToString());
                }
                else if (storedModel != model)
                {
                    return (SaveOutcome.ModelMismatch, 0, storedModel);
                }

                // Сколько кадров берём сейчас — по самой подробной записи пачки
                var frames = items.Max(i => i.Vectors.Count);
                SetMeta(connection, transaction, MetaKeys.EmbeddingFrames, frames.ToString());

                var saved = 0;
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText =
                        "UPDATE coubs SET embedding = $vec WHERE id = $id;";
                    var vec = command.Parameters.Add("$vec", SqliteType.Blob);
                    var id = command.Parameters.Add("$id", SqliteType.Text);

                    foreach (var item in items)
                    {
                        vec.Value = ToBlob(item.Vectors, dim);
                        id.Value = item.Id;
                        saved += command.ExecuteNonQuery();
                    }
                }

                transaction.Commit();
                _cache = null;
                return (SaveOutcome.Ok, saved, null);
            }
        }

        /// <summary>
        /// Стирает индекс целиком. Нужен при смене модели: дописать поверх
        /// нельзя, старые числа надо именно убрать.
        /// </summary>
        public int Reset()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                int cleared;
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE coubs SET embedding = NULL WHERE embedding IS NOT NULL;";
                    cleared = command.ExecuteNonQuery();
                }

                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "DELETE FROM meta WHERE key IN ($m, $d, $f);";
                    command.Parameters.AddWithValue("$m", MetaKeys.EmbeddingModel);
                    command.Parameters.AddWithValue("$d", MetaKeys.EmbeddingDim);
                    command.Parameters.AddWithValue("$f", MetaKeys.EmbeddingFrames);
                    command.ExecuteNonQuery();
                }

                transaction.Commit();
                _cache = null;
                return cleared;
            }
        }

        // ─── Поиск ──────────────────────────────────────────────────────────

        /// <summary>
        /// Кадры одного ролика — чтобы искать похожее на него, а не на фразу.
        /// Пусто — ролик ещё не разобран.
        /// </summary>
        public List<float[]> ReadVectors(string coubId)
        {
            var (ids, starts, flat, dim) = LoadAll();
            var at = Array.IndexOf(ids, coubId);
            if (at < 0) return new();

            var result = new List<float[]>(starts[at + 1] - starts[at]);
            for (var row = starts[at]; row < starts[at + 1]; row++)
            {
                var vector = new float[dim];
                Array.Copy(flat, row * dim, vector, 0, dim);
                result.Add(vector);
            }
            return result;
        }

        /// <summary>
        /// Ближайшие к запросу ролики.
        ///
        /// Запросов может быть несколько — так ищется похожее на ролик, у
        /// которого кадров тоже несколько. Оценка ролика — лучшая пара «кадр
        /// запроса × кадр ролика»: достаточно, чтобы совпало хоть что-то.
        /// Среднее здесь было бы хуже: ролик, где нужное занимает две секунды
        /// из десяти, усреднением размывается в ничто.
        ///
        /// <paramref name="within"/> — ограничить поиск этими роликами
        /// (в плеере это открытый плейлист). null — искать по всей библиотеке.
        /// </summary>
        public List<Match> Search(
            IReadOnlyList<float[]> queries, int limit,
            IReadOnlySet<string>? within = null, string? exclude = null)
        {
            var (ids, starts, flat, dim) = LoadAll();
            if (ids.Length == 0) return new();

            var probes = queries
                .Where(q => q.Length == dim)
                .Select(Normalize)
                .ToArray();
            if (probes.Length == 0) return new();

            var best = new List<Match>();

            for (var c = 0; c < ids.Length; c++)
            {
                if (within != null && !within.Contains(ids[c])) continue;
                // Сам ролик — всегда свой ближайший сосед, и в ответе
                // «похожие на него» ему делать нечего
                if (exclude != null && ids[c] == exclude) continue;

                var top = double.NegativeInfinity;
                for (var row = starts[c]; row < starts[c + 1]; row++)
                {
                    // Кадр берём один раз и сразу прикладываем ко всем
                    // запросам: так он остаётся в кэше процессора
                    var offset = row * dim;
                    foreach (var probe in probes)
                    {
                        var score = Dot(flat, offset, probe);
                        if (score > top) top = score;
                    }
                }

                best.Add(new Match(ids[c], top));
            }

            return best
                .OrderByDescending(m => m.Score)
                .Take(Math.Clamp(limit, 1, 500))
                .ToList();
        }

        /// <summary>Поиск по одному вектору — так приходит запрос фразой.</summary>
        public List<Match> Search(
            float[] query, int limit,
            IReadOnlySet<string>? within = null, string? exclude = null)
            => Search(new[] { query }, limit, within, exclude);

        /// <summary>
        /// Скалярное произведение единичных векторов — он же косинус.
        /// Через Vector&lt;float&gt;: процессор считает по несколько чисел за такт,
        /// и на десятках миллионов умножений это разница в разы.
        /// </summary>
        private static double Dot(float[] flat, int offset, float[] probe)
        {
            var step = Vector<float>.Count;
            var sum = Vector<float>.Zero;

            var i = 0;
            for (; i + step <= probe.Length; i += step)
            {
                sum += new Vector<float>(flat, offset + i) * new Vector<float>(probe, i);
            }

            double total = Vector.Dot(sum, Vector<float>.One);
            for (; i < probe.Length; i++) total += flat[offset + i] * probe[i];
            return total;
        }

        private (string[] Ids, int[] Starts, float[] Flat, int Dim) LoadAll()
        {
            lock (_lock)
            {
                if (_cache.HasValue) return _cache.Value;

                using var connection = _db.Open();
                var dim = ReadDim(connection);
                if (dim <= 0) return (_cache = (Array.Empty<string>(), new[] { 0 }, Array.Empty<float>(), 0)).Value;

                // Размер известен заранее — читаем в готовый массив. Иначе
                // List<float> на тридцати миллионах чисел вдвое перевыделится
                // и на пике займёт лишние сто мегабайт
                var capacity = ScalarLong(connection,
                    "SELECT TOTAL(LENGTH(embedding)) FROM coubs WHERE embedding IS NOT NULL;")
                    / sizeof(float);
                var flat = new float[capacity];

                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT id, embedding FROM coubs WHERE embedding IS NOT NULL ORDER BY rowid;";

                var ids = new List<string>();
                var starts = new List<int> { 0 };
                var rows = 0;
                var vectorBytes = dim * sizeof(float);

                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var blob = (byte[])reader["embedding"];
                    // Длина не кратна вектору — его писала другая модель или
                    // блоб побился. Молча пропускаем: один плохой ряд не повод
                    // ронять поиск
                    if (blob.Length == 0 || blob.Length % vectorBytes != 0) continue;

                    var count = blob.Length / vectorBytes;
                    Buffer.BlockCopy(blob, 0, flat, rows * vectorBytes, blob.Length);
                    rows += count;

                    ids.Add(reader.GetString(0));
                    starts.Add(rows);
                }

                // Пропущенные ряды оставили хвост — он не нужен и мешал бы
                // считать память честно
                if (rows * dim != flat.Length) Array.Resize(ref flat, rows * dim);

                return (_cache = (ids.ToArray(), starts.ToArray(), flat, dim)).Value;
            }
        }

        // ─── Мелочи ─────────────────────────────────────────────────────────

        /// <summary>
        /// Сколько байт занимает полный набор кадров. Ноль — длина вектора
        /// неизвестна (индекса ещё нет), и сравнивать длины не с чем.
        /// </summary>
        private static long BlobBytes(int dim, int frames) =>
            dim <= 0 || frames <= 0 ? 0 : (long)dim * sizeof(float) * frames;

        private static int ReadDim(SqliteConnection cn) =>
            int.TryParse(GetMeta(cn, MetaKeys.EmbeddingDim), out var dim) ? dim : 0;

        /// <summary>
        /// К единичной длине. Делается один раз при записи, чтобы поиск был
        /// чистым умножением: делить на длины десятки тысяч раз за запрос —
        /// ровно та работа, которую можно не делать.
        /// </summary>
        private static float[] Normalize(float[] vector)
        {
            double sum = 0;
            foreach (var v in vector) sum += (double)v * v;

            var length = Math.Sqrt(sum);
            if (length < 1e-9) return vector; // нулевой вектор — оставляем как есть

            var result = new float[vector.Length];
            for (var i = 0; i < vector.Length; i++) result[i] = (float)(vector[i] / length);
            return result;
        }

        /// <summary>Кадры ролика одним блобом, каждый — приведённый к единице.</summary>
        private static byte[] ToBlob(IReadOnlyList<float[]> vectors, int dim)
        {
            var bytes = new byte[vectors.Count * dim * sizeof(float)];
            for (var i = 0; i < vectors.Count; i++)
            {
                Buffer.BlockCopy(
                    Normalize(vectors[i]), 0,
                    bytes, i * dim * sizeof(float),
                    dim * sizeof(float));
            }
            return bytes;
        }

        private static int Count(SqliteConnection cn, string sql, params (string Name, object Value)[] args)
        {
            using var command = cn.CreateCommand();
            command.CommandText = sql;
            foreach (var (name, value) in args) command.Parameters.AddWithValue(name, value);
            return Convert.ToInt32(command.ExecuteScalar());
        }

        private static long ScalarLong(SqliteConnection cn, string sql)
        {
            using var command = cn.CreateCommand();
            command.CommandText = sql;
            return Convert.ToInt64(command.ExecuteScalar());
        }

        private static string? GetMeta(SqliteConnection cn, string key)
        {
            using var command = cn.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $k;";
            command.Parameters.AddWithValue("$k", key);
            return command.ExecuteScalar() as string;
        }

        private static void SetMeta(SqliteConnection cn, SqliteTransaction tx, string key, string value)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText =
                "INSERT INTO meta (key, value) VALUES ($k, $v) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value;";
            command.Parameters.AddWithValue("$k", key);
            command.Parameters.AddWithValue("$v", value);
            command.ExecuteNonQuery();
        }
    }
}
