// План работы: агент записывает шаги задачи и отмечает их по ходу. Пользователь видит список с галочками,
// а модель (особенно небольшая локальная) не теряет нить в длинной задаче.

const STATUSES = ['pending', 'in_progress', 'done'];

export const updatePlan = {
  name: 'update_plan',
  readOnly: true, // ничего не меняет на диске — подтверждение не нужно
  description: 'Записывает или обновляет план работы — список шагов с отметками. Используй для задач из трёх и более шагов: '
    + 'сначала запиши все шаги, затем при каждом вызове передавай список целиком с новыми отметками. '
    + 'Одновременно в работе (in_progress) — один шаг. Отмечай шаг выполненным (done) сразу после того, как сделал его. '
    + 'Для простых задач и вопросов план не нужен.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Все шаги плана по порядку',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Что сделать, коротко' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['items'],
  },
  run: ({ items }, ctx) => {
    if (!Array.isArray(items) || !items.length) throw new Error('items — непустой список шагов: [{"text": "...", "status": "pending"}]');
    const clean = items.slice(0, 30).map((i) => ({
      text: String(i?.text ?? i ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      status: STATUSES.includes(i?.status) ? i.status : 'pending',
    })).filter((i) => i.text);
    if (!clean.length) throw new Error('В плане нет ни одного шага с текстом');
    ctx.ui?.plan?.(clean);
    const done = clean.filter((i) => i.status === 'done').length;
    const current = clean.find((i) => i.status === 'in_progress') || clean.find((i) => i.status === 'pending');
    return `План обновлён: выполнено ${done} из ${clean.length}.${current ? ` Сейчас: ${current.text}` : ' Все шаги выполнены.'}`;
  },
};
