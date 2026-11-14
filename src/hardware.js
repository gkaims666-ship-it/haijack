// Возможности компьютера: помещается ли модель в память и работает ли она на видеокарте.
// От этого зависит, загружать ли модель при запуске и какой набор инструкций ей давать: на процессоре
// каждая тысяча токенов запроса — это десятки секунд чтения, поэтому там включается экономный режим.

import os from 'node:os';

const GB = 2 ** 30;
const slowModels = new Set(); // модели, которые сервер держит в основном на процессоре

/** Объём памяти компьютера в байтах (LCC_RAM_BYTES — для проверки и нестандартных случаев) */
export function totalMemory() {
  return Number(process.env.LCC_RAM_BYTES) || os.totalmem();
}

/** Сервер моделей работает на этом же компьютере? Только тогда память компьютера что-то говорит о модели. */
export function isLocalHost(baseUrl) {
  try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(baseUrl).hostname); } catch { return false; }
}

/**
 * Помещается ли модель в память. Кроме самого файла нужны контекст и место для системы.
 * @returns {{fits: boolean, modelGb: number, ramGb: number}}
 */
export function memoryFit(bytes, total = totalMemory()) {
  const need = bytes * 1.1 + 1.5 * GB;
  return { fits: need <= total * 0.9, modelGb: Math.round(bytes / GB * 10) / 10, ramGb: Math.round(total / GB) };
}

/** Модель, которая заведомо поместится и будет отвечать с приемлемой скоростью без видеокарты */
export function suggestModel(total = totalMemory()) {
  const gb = total / GB;
  return gb >= 12 ? { name: 'qwen2.5-coder:7b', size: '4,7 ГБ' } : gb >= 6 ? { name: 'qwen2.5-coder:3b', size: '1,9 ГБ' } : { name: 'qwen2.5-coder:1.5b', size: '1 ГБ' };
}

export function markSlow(model, on = true) {
  if (on) slowModels.add(model); else slowModels.delete(model);
}

/**
 * Экономный режим: один агент, короткие инструкции, основные инструменты, без карты проекта.
 * Включается сам, когда модель работает на процессоре; настройка LCC_PROFILE=lite|full задаёт его явно.
 */
export function isLite(cfg) {
  if (cfg?.provider !== 'local') return false;
  const profile = String(process.env.LCC_PROFILE || '').toLowerCase();
  if (profile === 'lite') return true;
  if (profile === 'full') return false;
  return slowModels.has(cfg.model);
}

const gbText = (n) => String(n).replace('.', ',');

/** Пояснение для модели, которая не помещается в память */
export function heavyNote(model, fit) {
  const pick = suggestModel();
  return `Модель ${model} занимает ${gbText(fit.modelGb)} ГБ, а памяти в компьютере — ${fit.ramGb} ГБ. Она не помещается: компьютер начнёт использовать диск вместо памяти, `
    + `всё будет тормозить, а ответ займёт десятки минут. Модель не загружена. Выберите модель поменьше — например, ${pick.name} (${pick.size}).`;
}
